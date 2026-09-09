"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { EventEmitter } = require("events");
const {
  ProjectBackup,
  defaultBackupFolderName,
  requireSafePathComponent,
  safeName,
} = require("../backup/project-backup");
const { normalizeIncludePatterns } = require("../filesystem/ignore-rules");
const { atomicWriteJson, readJsonRecoverable } = require("../filesystem/atomic-file");
const { discoverNodeProjects, pathKey } = require("../discovery/project-discovery");
const { Pm2Monitor, isPathInside } = require("../pm2/pm2-monitor");
const { Pm2HistoryStore } = require("../pm2/pm2-history-store");
const { readProcessLogs } = require("../pm2/pm2-log-reader");
const { DependencyInspector } = require("../dependencies/dependency-inspector");
const { buildLineDiff } = require("../diff/line-diff");
const { RecoveryService } = require("../recovery/recovery-service");
const { DeltaJournal } = require("../recovery/delta-journal");
const { ProjectLauncher } = require("../integrations/project-launcher");
const { FeaturePackService } = require("../export/feature-pack-service");
const { ProjectTaskService } = require("../tasks/project-task-service");
const { RemoteAgentClient } = require("../remote-agent/remote-agent-client");
const { RemoteAgentMonitor } = require("../remote-agent/remote-agent-monitor");
const {
  ServiceHealthMonitor,
  normalizeServiceHealthConfig,
} = require("../services/service-health-monitor");

const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 5;
const DEFAULT_SCHEDULE = Object.freeze({
  enabled: false,
  type: "daily",
  everyMinutes: 60,
  time: "02:00",
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
});

const PROJECT_EDITORS = new Set([
  "default",
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "sublime",
  "webstorm",
  "custom",
]);
const PM2_AUTO_START_SUCCESS_COOLDOWN_MS = 60_000;
const PM2_AUTO_START_FAILURE_COOLDOWN_MS = 5 * 60_000;
const PM2_DOCKER_WAIT_RETRY_MS = 10_000;

function normalizeProjectEditor(value, fallback = "default") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  return PROJECT_EDITORS.has(normalized) ? normalized : fallback;
}

function makeId() {
  return crypto.randomUUID();
}

function isRemoteProject(project) {
  return project?.executionTarget === "lan";
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeTime(value, fallback = "02:00") {
  const text = String(value || "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeSchedule(input = {}, existing = null) {
  const base = existing || DEFAULT_SCHEDULE;
  const type = ["interval", "daily", "weekly"].includes(input.type)
    ? input.type
    : base.type || "daily";
  const minutesRaw = Number(input.everyMinutes ?? base.everyMinutes ?? 60);
  const rawDays = input.daysOfWeek ?? base.daysOfWeek ?? DEFAULT_SCHEDULE.daysOfWeek;
  const days = [
    ...new Set(
      (Array.isArray(rawDays) ? rawDays : [])
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    ),
  ].sort((a, b) => a - b);

  const enabled = input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled);
  if (enabled && type === "weekly" && hasOwn(input, "daysOfWeek") && days.length === 0) {
    throw new Error("A weekly schedule requires at least one weekday.");
  }

  return {
    enabled,
    type,
    everyMinutes: Number.isFinite(minutesRaw)
      ? Math.max(5, Math.min(10080, Math.floor(minutesRaw)))
      : 60,
    time: normalizeTime(input.time ?? base.time, "02:00"),
    daysOfWeek: days.length ? days : [0],
  };
}

function normalizeProject(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? "").trim();
  const projectRoot = String(input.projectRoot ?? existing?.projectRoot ?? "").trim();
  if (!name) throw new Error("Project name is required.");
  if (!projectRoot) throw new Error("Project path is required.");

  const keepRaw = Number(input.keep ?? existing?.keep ?? 10);
  const intervalRaw = Number(
    input.intervalSeconds ?? existing?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  );
  const extra = input.extraExcludes ?? existing?.extraExcludes ?? [];
  const extraIncludes = input.extraIncludes ?? existing?.extraIncludes ?? [];
  const backupDirValue = hasOwn(input, "backupDir") ? input.backupDir : existing?.backupDir;
  const backupDirSecondaryValue = hasOwn(input, "backupDirSecondary")
    ? input.backupDirSecondary
    : existing?.backupDirSecondary;
  const schedule = normalizeSchedule(input.schedule || {}, existing?.schedule || DEFAULT_SCHEDULE);
  const pm2Names = input.pm2ProcessNames ?? existing?.pm2ProcessNames ?? [];
  const id = existing?.id
    ? requireSafePathComponent(existing.id, "Project id", { maxLength: 128 })
    : makeId();
  const backupFolderName = requireSafePathComponent(
    existing?.backupFolderName || defaultBackupFolderName(name, id),
    "Project backup folder name",
  );
  const executionTarget =
    String(input.executionTarget ?? existing?.executionTarget ?? "local").toLowerCase() === "lan"
      ? "lan"
      : "local";
  const remoteAgentId =
    executionTarget === "lan"
      ? String(input.remoteAgentId ?? existing?.remoteAgentId ?? "").trim() || null
      : null;
  if (executionTarget === "lan" && !remoteAgentId)
    throw new Error("A LAN remote agent is required for a remote project.");

  return {
    id,
    name,
    backupFolderName,
    executionTarget,
    remoteAgentId,
    projectRoot: executionTarget === "lan" ? projectRoot : path.resolve(projectRoot),
    backupDir: backupDirValue
      ? executionTarget === "lan"
        ? String(backupDirValue).trim()
        : path.resolve(String(backupDirValue))
      : null,
    backupDirSecondary: backupDirSecondaryValue
      ? executionTarget === "lan"
        ? String(backupDirSecondaryValue).trim()
        : path.resolve(String(backupDirSecondaryValue))
      : null,
    keep: Number.isInteger(keepRaw) && keepRaw >= 1 && keepRaw <= 1000 ? keepRaw : 10,
    watch: input.watch === undefined ? (existing?.watch ?? true) : Boolean(input.watch),
    intervalSeconds: Number.isFinite(intervalRaw)
      ? Math.max(MIN_INTERVAL_SECONDS, Math.floor(intervalRaw))
      : DEFAULT_INTERVAL_SECONDS,
    extraExcludes: Array.isArray(extra)
      ? extra
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    extraIncludes: normalizeIncludePatterns(extraIncludes),
    schedule,
    pm2Monitoring:
      input.pm2Monitoring === undefined
        ? (existing?.pm2Monitoring ?? true)
        : Boolean(input.pm2Monitoring),
    pm2ControlsEnabled:
      executionTarget === "lan"
        ? false
        : input.pm2ControlsEnabled === undefined
          ? (existing?.pm2ControlsEnabled ?? false)
          : Boolean(input.pm2ControlsEnabled),
    pm2ProcessNames: Array.isArray(pm2Names)
      ? pm2Names
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    pm2AutoStart:
      executionTarget === "lan"
        ? false
        : input.pm2AutoStart === undefined
          ? (existing?.pm2AutoStart ?? false)
          : Boolean(input.pm2AutoStart),
    pm2WaitForDocker:
      executionTarget === "lan"
        ? false
        : input.pm2WaitForDocker === undefined
          ? (existing?.pm2WaitForDocker ?? false)
          : Boolean(input.pm2WaitForDocker),
    pm2EcosystemFile:
      String(
        input.pm2EcosystemFile ?? existing?.pm2EcosystemFile ?? "ecosystem.config.js",
      ).trim() || "ecosystem.config.js",
    pm2EcosystemAppName:
      String(input.pm2EcosystemAppName ?? existing?.pm2EcosystemAppName ?? "").trim() || null,
    editor: normalizeProjectEditor(input.editor ?? existing?.editor ?? "default"),
    repositoryUrl: String(input.repositoryUrl ?? existing?.repositoryUrl ?? "").trim() || null,
    backupEncryptionEnabled:
      input.backupEncryptionEnabled === undefined
        ? (existing?.backupEncryptionEnabled ?? false)
        : Boolean(input.backupEncryptionEnabled),
    deltaJournalEnabled:
      input.deltaJournalEnabled === undefined
        ? (existing?.deltaJournalEnabled ?? true)
        : Boolean(input.deltaJournalEnabled),
    deltaJournalRetentionDays: Math.max(
      1,
      Math.min(
        3650,
        Math.floor(
          Number(input.deltaJournalRetentionDays ?? existing?.deltaJournalRetentionDays ?? 180) ||
            180,
        ),
      ),
    ),
    deltaJournalMaxEntries: Math.max(
      1,
      Math.min(
        100000,
        Math.floor(
          Number(input.deltaJournalMaxEntries ?? existing?.deltaJournalMaxEntries ?? 1000) || 1000,
        ),
      ),
    ),
    deltaJournalMaxStorageMB: Math.max(
      16,
      Math.min(
        102400,
        Math.floor(
          Number(input.deltaJournalMaxStorageMB ?? existing?.deltaJournalMaxStorageMB ?? 1024) ||
            1024,
        ),
      ),
    ),
    deltaJournalMaxFileMB: Math.max(
      1,
      Math.min(
        256,
        Math.floor(
          Number(input.deltaJournalMaxFileMB ?? existing?.deltaJournalMaxFileMB ?? 16) || 16,
        ),
      ),
    ),
    serviceHealth: normalizeServiceHealthConfig(
      input.serviceHealth || {},
      existing?.serviceHealth || null,
    ),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function parseClock(time) {
  const [hour, minute] = normalizeTime(time).split(":").map(Number);
  return { hour, minute };
}

function computeNextScheduledAt(schedule, from = new Date()) {
  if (!schedule?.enabled) return null;
  const now = new Date(from);

  if (schedule.type === "interval") {
    return new Date(now.getTime() + schedule.everyMinutes * 60 * 1000);
  }

  const { hour, minute } = parseClock(schedule.time);
  if (schedule.type === "daily") {
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  const days = new Set(schedule.daysOfWeek || []);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (!days.has(candidate.getDay())) continue;
    if (candidate > now) return candidate;
  }

  return null;
}

function scheduleDescription(schedule) {
  if (!schedule?.enabled) return "Disabled";
  if (schedule.type === "interval")
    return `Every ${schedule.everyMinutes} minute${schedule.everyMinutes === 1 ? "" : "s"}`;
  if (schedule.type === "daily") return `Daily at ${schedule.time}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${(schedule.daysOfWeek || []).map((day) => names[day]).join(", ")} at ${schedule.time}`;
}

function serializeError(error) {
  if (!error) return {};
  return {
    error: error.message || String(error),
    errorName: error.name || null,
    errorCode: error.code || null,
    errorErrno: error.errno ?? null,
    errorSyscall: error.syscall || null,
    errorPath: error.path || null,
    errorStack: error.stack || null,
  };
}

function diagnosticRecommendation(entry = {}) {
  const text = `${entry.message || ""} ${entry.error || ""} ${entry.errorCode || ""}`.toLowerCase();
  const destination = String(entry.destination || "").toLowerCase();
  if (destination === "secondary" || /secondary|mirror/.test(text)) {
    if (/enoent|not found|no such file|cannot find|unavailable|offline|device/.test(text)) {
      return "The primary backup is safe. Reconnect or mount the secondary drive, then run Backup now; the manager will backfill missing retained mirror copies automatically.";
    }
    if (/eacces|eperm|permission|access denied/.test(text)) {
      return "The primary backup is safe. Check write permissions for the secondary destination, then run Backup now to retry mirror synchronization.";
    }
    if (/space|enospc|disk full/.test(text)) {
      return "The primary backup is safe. Free space on the secondary destination or reduce retention, then run Backup now to synchronize pending copies.";
    }
    return "The primary backup remains valid. Check the secondary destination and run Backup now after it is available; missing retained copies will be synchronized.";
  }
  if (/enospc|disk full|no space/.test(text))
    return "Free disk space on the affected destination or reduce backup retention before retrying.";
  if (/eacces|eperm|permission|access denied/.test(text))
    return "Check filesystem permissions and whether the Ultimate Project Manager account has read/write access to the affected path.";
  if (/enoent|not found|no such file|cannot find/.test(text))
    return "Confirm that the referenced file, project, drive, or directory exists and is currently mounted.";
  if (/verification|sha-256|content hash|corrupt/.test(text))
    return "Keep the failed archive for investigation, verify the source/destination storage, and create a fresh backup before relying on that copy.";
  if (/pm2/.test(text))
    return "Check PM2 availability and the matched process configuration, then refresh PM2 from the dashboard.";
  if (/npm|dependency|registry/.test(text))
    return "Check npm/network availability. Local dependency information remains usable even when registry status cannot be refreshed.";
  return "Review the detailed error context below, correct the underlying path/service condition, and retry the operation.";
}

class BackupManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    this.configFile = path.resolve(options.configFile || path.join(this.dataDir, "config.json"));
    this.activityFile = path.resolve(
      options.activityFile || path.join(this.dataDir, "activity.jsonl"),
    );
    this.runtimeBackupRoot = options.backupRoot ? path.resolve(options.backupRoot) : null;
    this.runtimeRestoreRoot = options.restoreRoot ? path.resolve(options.restoreRoot) : null;
    this.backupRoot = this.runtimeBackupRoot || path.join(this.dataDir, "backups");
    this.restoreRoot = this.runtimeRestoreRoot || path.join(this.dataDir, "restores");
    this.backupEncryptionKey = String(options.backupEncryptionKey || "");
    this.projects = new Map();
    this.runtime = new Map();
    this.maxActivity = 1000;
    this.activity = [];
    this.pm2Monitor =
      options.pm2Monitor || new Pm2Monitor({ refreshMs: options.pm2RefreshMs || 10000 });
    this.dependencyInspector =
      options.dependencyInspector ||
      new DependencyInspector({
        cacheMs: options.dependencyCacheMs || 10 * 60 * 1000,
        timeoutMs: options.dependencyTimeoutMs || 30 * 1000,
      });
    this.dependencyUpdatesRunning = new Set();
    this.diffCache = new Map();
    this.recovery = new RecoveryService({
      manager: this,
      dataDir: this.dataDir,
    });
    this.featurePacks = new FeaturePackService({ manager: this });
    this.projectTasks = new ProjectTaskService({ dataDir: this.dataDir });
    this.projectLauncher =
      options.projectLauncher ||
      new ProjectLauncher({
        defaultEditor: options.defaultEditor || "vscode",
        customEditorCommand: options.customEditorCommand || "",
      });
    this.pm2AutoStartRunning = new Set();
    this.pm2AutoStartAttempts = new Map();
    this.pm2AutoStartSuppressed = new Set();
    this.dockerRuntimeMonitor = options.dockerRuntimeMonitor || null;
    this.pm2History =
      options.pm2History ||
      new Pm2HistoryStore({
        file: options.pm2HistoryFile || path.join(this.dataDir, "pm2-history.jsonl"),
        sampleIntervalMs: options.pm2HistorySampleMs || 60000,
      });
    this.remoteAgentClient =
      options.remoteAgentClient ||
      new RemoteAgentClient({
        agents: options.remoteAgents || [],
        allowInsecureHttp: options.remoteAgentAllowInsecureHttp === true,
      });
    this.remoteAgentMonitor =
      options.remoteAgentMonitor ||
      new RemoteAgentMonitor({
        client: this.remoteAgentClient,
        refreshMs: options.pm2RefreshMs || 10000,
      });
    this.serviceHealthMonitor =
      options.serviceHealthMonitor ||
      new ServiceHealthMonitor({
        remoteProbe: async (project) => {
          const payload = await this.remoteAgentClient.serviceHealth(
            project.remoteAgentId,
            project,
          );
          return payload.health || payload.result || payload;
        },
      });
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.backupRoot, { recursive: true });
    await fsp.mkdir(this.restoreRoot, { recursive: true });
    await this.recovery.init();
    await this.projectTasks.init();
    await this._loadActivity();
    const config = await this._readConfig();
    if (!this.runtimeBackupRoot && config.backupRoot)
      this.backupRoot = this._resolveDataPath(config.backupRoot);
    if (!this.runtimeRestoreRoot && config.restoreRoot)
      this.restoreRoot = this._resolveDataPath(config.restoreRoot);
    await fsp.mkdir(this.backupRoot, { recursive: true });
    await fsp.mkdir(this.restoreRoot, { recursive: true });

    const needsMigration =
      Number(config.version || 0) < 13 ||
      !(config.projects || []).every(
        (raw) =>
          raw?.backupFolderName &&
          raw?.schedule &&
          raw?.pm2Monitoring !== undefined &&
          raw?.pm2ControlsEnabled !== undefined &&
          raw?.pm2WaitForDocker !== undefined &&
          Array.isArray(raw?.pm2ProcessNames) &&
          raw?.pm2AutoStart !== undefined &&
          raw?.pm2EcosystemFile !== undefined &&
          raw?.editor !== undefined &&
          raw?.backupDirSecondary !== undefined &&
          raw?.backupEncryptionEnabled !== undefined &&
          raw?.deltaJournalEnabled !== undefined &&
          raw?.deltaJournalRetentionDays !== undefined &&
          raw?.deltaJournalMaxEntries !== undefined &&
          raw?.deltaJournalMaxStorageMB !== undefined &&
          raw?.deltaJournalMaxFileMB !== undefined &&
          raw?.executionTarget !== undefined &&
          raw?.remoteAgentId !== undefined &&
          raw?.serviceHealth !== undefined &&
          Array.isArray(raw?.extraIncludes),
      );

    for (const raw of config.projects || []) {
      try {
        const project = normalizeProject(raw, raw);
        this._assertDestinationLayout(project);
        this.projects.set(project.id, project);
      } catch (error) {
        await this.log("error", "Failed to load project configuration.", {
          error: error.message,
          project: raw?.name,
        });
      }
    }

    if (needsMigration) await this._writeConfig();
    for (const project of this.projects.values()) this._applyAutomation(project);
    await this.pm2History.init();
    this.pm2Monitor.on("sample", (snapshot) => {
      this.pm2History.recordSnapshot(snapshot).catch(() => {});
      setImmediate(() => this._handlePm2AutoStart(snapshot).catch(() => {}));
    });
    this.pm2Monitor.on("event", (event) => {
      this.pm2History.recordEvent(event).catch(() => {});
      this._logPm2Event(event).catch(() => {});
    });
    await this.pm2Monitor.start(() =>
      [...this.projects.values()].filter((project) => !isRemoteProject(project)),
    );
    await this.remoteAgentMonitor.start(() => [...this.projects.values()].filter(isRemoteProject));
    await this.serviceHealthMonitor.start(() => [...this.projects.values()]);
    return this;
  }

  _resolveDataPath(value) {
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.dataDir, value);
  }

  async _readConfig() {
    const config = await readJsonRecoverable(this.configFile, null, {
      recover: true,
      throwOnMalformedUnrecovered: true,
      validator: (value) =>
        Boolean(
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Array.isArray(value.projects),
        ),
    });
    if (config) return config;

    const initial = {
      version: 13,
      backupRoot: "./backups",
      restoreRoot: "./restores",
      projects: [],
    };
    await this._writeConfig(initial);
    return initial;
  }

  async _writeConfig(config = null) {
    const data = config || {
      version: 13,
      backupRoot: this.backupRoot,
      restoreRoot: this.restoreRoot,
      projects: [...this.projects.values()],
    };
    await atomicWriteJson(this.configFile, data, {
      backup: true,
      validator: (value) =>
        Boolean(
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Array.isArray(value.projects),
        ),
    });
  }

  async _loadActivity() {
    try {
      const raw = await fsp.readFile(this.activityFile, "utf8");
      this.activity = raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-this.maxActivity)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async log(level, message, details = {}) {
    const entry = {
      id: makeId(),
      timestamp: new Date().toISOString(),
      level,
      message,
      ...details,
    };
    this.activity.unshift(entry);
    this.activity = this.activity.slice(0, this.maxActivity);
    await fsp.appendFile(this.activityFile, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
    this.emit("activity", entry);
    return entry;
  }

  getDiagnostics(options = {}) {
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 250));
    const projectId = options.projectId ? String(options.projectId) : null;
    const level = options.level ? String(options.level).toLowerCase() : null;
    return this.activity
      .filter((entry) => entry.level === "warning" || entry.level === "error")
      .filter(
        (entry) =>
          !projectId ||
          entry.projectId === projectId ||
          (Array.isArray(entry.projectIds) && entry.projectIds.includes(projectId)),
      )
      .filter((entry) => !level || entry.level === level)
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        operation:
          entry.operation || entry.source || entry.pm2Action || entry.pm2Event || "manager",
        recommendation: entry.recommendation || diagnosticRecommendation(entry),
      }));
  }

  getDiagnosticSummary(rangeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - Math.max(0, Number(rangeMs) || 0);
    const recent = this.activity.filter((entry) => {
      if (entry.level !== "warning" && entry.level !== "error") return false;
      const timestamp = new Date(entry.timestamp).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    return {
      warnings: recent.filter((entry) => entry.level === "warning").length,
      errors: recent.filter((entry) => entry.level === "error").length,
      total: recent.length,
    };
  }

  _backupDirFor(project, destination = "primary") {
    if (destination === "secondary") return project.backupDirSecondary || null;
    if (isRemoteProject(project)) return project.backupDir || null;
    return (
      project.backupDir ||
      path.join(
        this.backupRoot,
        project.backupFolderName || defaultBackupFolderName(project.name, project.id),
      )
    );
  }

  _backupDestinations(project) {
    const primary = this._backupDirFor(project, "primary");
    const secondary = this._backupDirFor(project, "secondary");
    const destinations = [{ key: "primary", label: "Primary", dir: primary }];
    if (secondary)
      destinations.push({
        key: "secondary",
        label: "Secondary",
        dir: secondary,
      });
    return destinations;
  }

  _journalDirFor(project) {
    return path.join(
      this.dataDir,
      "delta-journal",
      project.backupFolderName || defaultBackupFolderName(project.name, project.id),
    );
  }

  _journal(project) {
    return new DeltaJournal({
      dir: this._journalDirFor(project),
      enabled: project.deltaJournalEnabled === true,
      projectId: project.id,
      projectName: project.name,
      retentionDays: project.deltaJournalRetentionDays,
      maxEntries: project.deltaJournalMaxEntries,
      maxBytes: project.deltaJournalMaxStorageMB * 1024 * 1024,
      maxFileBytes: project.deltaJournalMaxFileMB * 1024 * 1024,
      maxTransitionBytes:
        Math.max(64, Math.min(128, project.deltaJournalMaxFileMB * 4)) * 1024 * 1024,
      encryptionEnabled: project.backupEncryptionEnabled === true,
      encryptionKey: this.backupEncryptionKey,
    });
  }

  _assertDestinationLayout(project) {
    if (isRemoteProject(project)) return;
    const projectRoot = path.resolve(project.projectRoot);
    const primary = path.resolve(this._backupDirFor(project, "primary"));
    const secondary = this._backupDirFor(project, "secondary");
    const journalRoot = path.resolve(this.dataDir, "delta-journal");
    const journalDir = path.resolve(this._journalDirFor(project));

    if (!project.backupDir && !isPathInside(this.backupRoot, primary)) {
      throw new Error("The default primary backup destination escaped the configured backup root.");
    }
    if (!isPathInside(journalRoot, journalDir) || pathKey(journalRoot) === pathKey(journalDir)) {
      throw new Error("The delta-journal destination escaped the configured data directory.");
    }
    if (pathKey(primary) === pathKey(projectRoot)) {
      throw new Error(
        "The primary backup destination cannot be the project root. Choose a dedicated backup folder.",
      );
    }
    if (secondary && pathKey(secondary) === pathKey(projectRoot)) {
      throw new Error(
        "The secondary backup destination cannot be the project root. Choose a dedicated backup folder.",
      );
    }
    if (secondary && pathKey(secondary) === pathKey(primary))
      throw new Error("Primary and secondary backup destinations must be different folders.");
  }

  _engine(project, destination = "primary") {
    if (isRemoteProject(project))
      throw new Error("Remote projects are executed by their LAN agent.");
    const backupDir = this._backupDirFor(project, destination);
    if (!backupDir) throw new Error(`Backup destination is not configured: ${destination}`);
    const allDirs = this._backupDestinations(project).map((item) => item.dir);
    return new ProjectBackup({
      projectRoot: project.projectRoot,
      backupDir,
      additionalBackupDirs: [
        ...allDirs.filter((dir) => path.resolve(dir) !== path.resolve(backupDir)),
        this._journalDirFor(project),
      ],
      projectName: project.name,
      keep: project.keep,
      extraExcludes: project.extraExcludes,
      extraIncludes: project.extraIncludes,
      encryptionEnabled: project.backupEncryptionEnabled === true,
      encryptionKey: this.backupEncryptionKey,
      projectId: project.id,
      journalEnabled: destination === "primary" && project.deltaJournalEnabled === true,
      journalDir: this._journalDirFor(project),
      journalRetentionDays: project.deltaJournalRetentionDays,
      journalMaxEntries: project.deltaJournalMaxEntries,
      journalMaxBytes: project.deltaJournalMaxStorageMB * 1024 * 1024,
      journalMaxFileBytes: project.deltaJournalMaxFileMB * 1024 * 1024,
      journalMaxTransitionBytes:
        Math.max(64, Math.min(128, project.deltaJournalMaxFileMB * 4)) * 1024 * 1024,
    });
  }

  _runtime(projectId) {
    if (!this.runtime.has(projectId)) {
      this.runtime.set(projectId, {
        watchTimer: null,
        scheduleTimer: null,
        running: false,
        lastCheckAt: null,
        lastBackupAt: null,
        lastScheduledAt: null,
        nextScheduledAt: null,
        lastResult: null,
        lastError: null,
        pm2AutoStart: null,
      });
    }
    return this.runtime.get(projectId);
  }

  _clearAutomation(projectId) {
    const runtime = this._runtime(projectId);
    if (runtime.watchTimer) clearInterval(runtime.watchTimer);
    if (runtime.scheduleTimer) clearTimeout(runtime.scheduleTimer);
    runtime.watchTimer = null;
    runtime.scheduleTimer = null;
    runtime.nextScheduledAt = null;
  }

  _applyAutomation(project) {
    this._clearAutomation(project.id);
    const runtime = this._runtime(project.id);

    if (project.watch) {
      const run = () => this.runBackup(project.id, { source: "watch" }).catch(() => {});
      runtime.watchTimer = setInterval(run, project.intervalSeconds * 1000);
      runtime.watchTimer.unref?.();
    }

    this._scheduleNext(project);
  }

  _scheduleNext(project) {
    const runtime = this._runtime(project.id);
    if (runtime.scheduleTimer) clearTimeout(runtime.scheduleTimer);
    runtime.scheduleTimer = null;
    runtime.nextScheduledAt = null;
    if (!project.schedule?.enabled) return;

    const next = computeNextScheduledAt(project.schedule);
    if (!next) return;
    runtime.nextScheduledAt = next.toISOString();
    const delay = Math.max(250, next.getTime() - Date.now());

    runtime.scheduleTimer = setTimeout(async () => {
      runtime.lastScheduledAt = new Date().toISOString();
      try {
        await this.runBackup(project.id, { source: "schedule" });
      } catch {
      } finally {
        const current = this.projects.get(project.id);
        if (current) this._scheduleNext(current);
      }
    }, delay);
    runtime.scheduleTimer.unref?.();
  }

  getProjects() {
    return [...this.projects.values()].map((project) => this.getProject(project.id));
  }

  getProjectSetup() {
    return [...this.projects.values()].map((project) => JSON.parse(JSON.stringify(project)));
  }

  _projectLocationKey(project) {
    if (isRemoteProject(project)) {
      return `lan:${project.remoteAgentId}:${String(project.projectRoot || "").toLowerCase()}`;
    }
    return `local:${pathKey(project.projectRoot)}`;
  }

  async _validateImportedProject(project) {
    this._assertDestinationLayout(project);
    if (isRemoteProject(project)) {
      await this.remoteAgentClient.validateProject(project.remoteAgentId, project);
      return;
    }
    const stat = await fsp.stat(project.projectRoot);
    if (!stat.isDirectory()) throw new Error("Project path must be a directory.");
  }

  async importProjectSetup(projects, options = {}) {
    if (!Array.isArray(projects)) throw new Error("Imported setup projects must be an array.");
    if (projects.length > 1000) throw new Error("Imported setup contains too many projects.");
    const mode = String(options.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const next = mode === "replace" ? new Map() : new Map(this.projects);
    const locations = new Map(
      [...next.values()].map((project) => [this._projectLocationKey(project), project.id]),
    );
    const result = { mode, added: [], updated: [], errors: [], applied: false };

    for (const raw of projects) {
      try {
        let existing = raw?.id ? next.get(String(raw.id)) || null : null;
        const matchedById = Boolean(existing);
        let candidate = normalizeProject(raw || {}, existing || (raw?.id ? raw : null));
        let locationKey = this._projectLocationKey(candidate);
        const locationId = locations.get(locationKey);
        if (locationId && locationId !== candidate.id) {
          if (mode === "replace")
            throw new Error("Imported setup contains duplicate project locations.");
          if (matchedById)
            throw new Error("Imported project path is already registered to another project.");
          existing = next.get(locationId) || null;
          candidate = normalizeProject(raw || {}, existing);
          locationKey = this._projectLocationKey(candidate);
        }

        await this._validateImportedProject(candidate);
        const previous = next.get(candidate.id);
        if (previous) locations.delete(this._projectLocationKey(previous));
        next.set(candidate.id, candidate);
        locations.set(locationKey, candidate.id);
        (previous || existing ? result.updated : result.added).push({
          id: candidate.id,
          name: candidate.name,
          projectRoot: candidate.projectRoot,
        });
      } catch (error) {
        result.errors.push({
          id: raw?.id || null,
          name: raw?.name || "Unnamed project",
          projectRoot: raw?.projectRoot || null,
          error: error.message,
        });
      }
    }

    if (mode === "replace" && result.errors.length) {
      result.added = [];
      result.updated = [];
      result.skippedReplace = true;
      return result;
    }
    if (!result.added.length && !result.updated.length && mode !== "replace") return result;

    for (const projectId of this.projects.keys()) {
      this._clearAutomation(projectId);
      if (!next.has(projectId)) {
        this.runtime.delete(projectId);
        this.dependencyInspector.clear(projectId);
        this.pm2AutoStartRunning.delete(projectId);
        this.pm2AutoStartAttempts.delete(projectId);
        this.pm2AutoStartSuppressed.delete(projectId);
        this.serviceHealthMonitor.forgetProject(projectId);
      }
    }
    this.projects = next;
    await this._writeConfig();
    for (const project of this.projects.values()) this._applyAutomation(project);
    await this.refreshPm2();
    for (const project of this.projects.values())
      this.serviceHealthMonitor.refreshProject(project).catch(() => {});
    result.applied = true;
    result.projectCount = this.projects.size;
    await this.log(result.errors.length ? "warning" : "info", "Project setup imported.", {
      operation: "setup-import-projects",
      mode,
      addedCount: result.added.length,
      updatedCount: result.updated.length,
      errorCount: result.errors.length,
    });
    return result;
  }

  getProject(id) {
    const project = this.projects.get(id);
    if (!project) return null;
    const runtime = this._runtime(id);
    return {
      ...project,
      backupDirResolved: isRemoteProject(project)
        ? project.backupDir || "Remote agent default"
        : this._backupDirFor(project, "primary"),
      backupDirSecondaryResolved: this._backupDirFor(project, "secondary"),
      backupDestinations: isRemoteProject(project) ? [] : this._backupDestinations(project),
      remoteAgent: isRemoteProject(project)
        ? this.remoteAgentMonitor
            .getAgentsStatus()
            .find((agent) => agent.id === project.remoteAgentId) || null
        : null,
      dockerRuntime: isRemoteProject(project)
        ? this.remoteAgentMonitor
            .getAgentsStatus()
            .find((agent) => agent.id === project.remoteAgentId)?.dockerRuntime || null
        : this.dockerRuntimeMonitor?.getCurrent?.() || null,
      backupEncryptionConfigured: isRemoteProject(project)
        ? null
        : Boolean(this.backupEncryptionKey),
      deltaJournalDir: isRemoteProject(project) ? null : this._journalDirFor(project),
      dependencySummary: this.dependencyInspector.getCachedSummary(id),
      taskSummary: this.projectTasks.getSummary(id),
      scheduleDescription: scheduleDescription(project.schedule),
      editorInfo: this.projectLauncher.effectiveEditor(project),
      pm2: isRemoteProject(project)
        ? this.remoteAgentMonitor.getProjectStatus(id)
        : this.pm2Monitor.getProjectStatus(id),
      serviceHealthStatus: this.serviceHealthMonitor.getProjectStatus(id),
      runtime: {
        running: runtime.running,
        lastCheckAt: runtime.lastCheckAt,
        lastBackupAt: runtime.lastBackupAt,
        lastScheduledAt: runtime.lastScheduledAt,
        nextScheduledAt: runtime.nextScheduledAt,
        lastResult: runtime.lastResult,
        lastError: runtime.lastError,
        pm2AutoStart: runtime.pm2AutoStart || null,
      },
    };
  }

  async refreshServiceHealth(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    return this.serviceHealthMonitor.refreshProject(project);
  }

  async _assertProjectRoot(projectRoot, excludeId = null, project = null) {
    const remote = project && isRemoteProject(project);
    if (remote) {
      await this.remoteAgentClient.validateProject(project.remoteAgentId, project);
    } else {
      const stat = await fsp.stat(projectRoot);
      if (!stat.isDirectory()) throw new Error("Project path must be a directory.");
    }
    const key = remote
      ? `${project.remoteAgentId}:${String(projectRoot).toLowerCase()}`
      : pathKey(projectRoot);
    if (
      [...this.projects.values()].some((item) => {
        if (item.id === excludeId) return false;
        if (remote)
          return (
            isRemoteProject(item) &&
            `${item.remoteAgentId}:${String(item.projectRoot).toLowerCase()}` === key
          );
        return !isRemoteProject(item) && pathKey(item.projectRoot) === key;
      })
    )
      throw new Error("That project path is already registered.");
  }

  async addProject(input) {
    const project = normalizeProject(input);
    await this._assertProjectRoot(project.projectRoot, null, project);
    this._assertDestinationLayout(project);
    this.projects.set(project.id, project);
    await this._writeConfig();
    this._applyAutomation(project);
    await this.refreshPm2();
    this.serviceHealthMonitor.refreshProject(project).catch(() => {});
    await this.log("info", `Project added: ${project.name}`, {
      projectId: project.id,
    });
    return this.getProject(project.id);
  }

  async updateProject(id, input) {
    const current = this.projects.get(id);
    if (!current) throw new Error("Project not found.");
    const updated = normalizeProject(input, current);
    await this._assertProjectRoot(updated.projectRoot, id, updated);
    this._assertDestinationLayout(updated);
    this.projects.set(id, updated);
    if (
      current.pm2AutoStart !== updated.pm2AutoStart ||
      current.pm2WaitForDocker !== updated.pm2WaitForDocker ||
      updated.pm2AutoStart !== true
    ) {
      this.pm2AutoStartSuppressed.delete(id);
      this.pm2AutoStartAttempts.delete(id);
    }
    await this._writeConfig();
    this._applyAutomation(updated);
    await this.refreshPm2();
    this.serviceHealthMonitor.refreshProject(updated).catch(() => {});

    if (updated.keep !== current.keep && !isRemoteProject(updated)) {
      for (const destination of this._backupDestinations(updated)) {
        try {
          const retention = await this._engine(updated, destination.key).prune();
          if (retention.removed.length || retention.failures.length) {
            await this.log(
              retention.failures.length ? "warning" : "info",
              `Backup retention applied: ${updated.name} (${destination.label})`,
              {
                projectId: id,
                destination: destination.key,
                operation: "backup-retention",
                keep: updated.keep,
                previousKeep: current.keep,
                removedCount: retention.removed.length,
                failures: retention.failures,
              },
            );
          }
        } catch (error) {
          await this.log(
            "warning",
            `Backup retention could not be applied immediately: ${updated.name} (${destination.label})`,
            {
              projectId: id,
              destination: destination.key,
              operation: "backup-retention",
              keep: updated.keep,
              previousKeep: current.keep,
              ...serializeError(error),
              recommendation:
                "The retention setting was saved. Restore access to the backup destination and run Backup now to retry cleanup.",
            },
          );
        }
      }
    }

    await this.log("info", `Project updated: ${updated.name}`, {
      projectId: id,
    });
    return this.getProject(id);
  }

  async removeProject(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    this._clearAutomation(id);
    this.runtime.delete(id);
    this.dependencyInspector.clear(id);
    this.pm2AutoStartRunning.delete(id);
    this.pm2AutoStartAttempts.delete(id);
    this.pm2AutoStartSuppressed.delete(id);
    this.serviceHealthMonitor.forgetProject(id);
    this.projects.delete(id);
    await this.projectTasks.removeProject(id);
    await this._writeConfig();
    await this.refreshPm2();
    await this.log("warning", `Project removed: ${project.name}`, {
      projectId: id,
    });
    return true;
  }

  getProjectTasks(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    return {
      projectId: id,
      projectName: project.name,
      summary: this.projectTasks.getSummary(id),
      tasks: this.projectTasks.getTasks(id, options),
    };
  }

  async addProjectTask(id, input = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const task = await this.projectTasks.addTask(id, input);
    await this.log("info", `Project task added: ${project.name}`, {
      projectId: id,
      operation: "project-task-add",
      taskId: task.id,
      taskKind: task.kind,
    });
    return task;
  }

  async updateProjectTask(id, taskId, input = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const task = await this.projectTasks.updateTask(id, taskId, input);
    await this.log("info", `Project task updated: ${project.name}`, {
      projectId: id,
      operation: "project-task-update",
      taskId: task.id,
      taskKind: task.kind,
      completed: task.completed,
    });
    return task;
  }

  async removeProjectTask(id, taskId) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const task = await this.projectTasks.removeTask(id, taskId);
    await this.log("info", `Project task removed: ${project.name}`, {
      projectId: id,
      operation: "project-task-remove",
      taskId: task.id,
      taskKind: task.kind,
    });
    return true;
  }

  async scanProjectTasks(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error("Source TODO/FIX/NOTE scanning is local-only for LAN remote projects.");
    const result = await this.projectTasks.scanProject(project, options);
    await this.log("info", `Project task scan completed: ${project.name}`, {
      projectId: id,
      operation: "project-task-scan",
      filesScanned: result.filesScanned,
      discovered: result.discovered,
      added: result.added,
      missingSource: result.missingSource,
    });
    return result;
  }

  async getDeltaJournal(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const journal = this._journal(project);
    const [stats, entries] = await Promise.all([
      journal.stats(),
      journal.list({
        limit: Math.max(1, Math.min(500, Number(options.limit) || 100)),
      }),
    ]);
    return {
      projectId: id,
      projectName: project.name,
      journalDir: this._journalDirFor(project),
      stats,
      entries,
    };
  }

  async pruneDeltaJournal(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const journal = this._journal(project);
    const result = await journal.prune();
    await this.log("info", `Delta journal pruned: ${project.name}`, {
      projectId: id,
      operation: "delta-journal-prune",
      removedEntries: result.removed.length,
      remainingEntries: result.remaining,
      journalBytes: result.totalBytes,
    });
    return result;
  }

  async inspectProject(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const runtime = this._runtime(id);
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.inspectProject(project.remoteAgentId, project);
      const result = payload.result || payload;
      runtime.lastCheckAt = new Date().toISOString();
      runtime.lastResult = result;
      runtime.lastError = null;
      return result;
    }
    const inspected = await this._engine(project).inspect();
    runtime.lastCheckAt = new Date().toISOString();
    runtime.lastResult = {
      created: false,
      changed: inspected.changed,
      projectHash: inspected.current.projectHash,
      fileCount: inspected.current.entries.length,
      sourceBytes: inspected.current.totalBytes,
      changes: inspected.changes,
    };
    runtime.lastError = null;
    return runtime.lastResult;
  }

  async getProjectDiff(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const cached = this.diffCache.get(id);
    if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const inspected = await this._engine(project).inspect();
    const previousFiles = inspected.previous?.files || {};
    const currentFiles = inspected.current?.files || {};
    const rows = [];

    for (const relativePath of inspected.changes.added || []) {
      rows.push({
        path: relativePath,
        status: "added",
        before: null,
        after: currentFiles[relativePath] || null,
      });
    }
    for (const relativePath of inspected.changes.modified || []) {
      rows.push({
        path: relativePath,
        status: "modified",
        before: previousFiles[relativePath] || null,
        after: currentFiles[relativePath] || null,
      });
    }
    for (const relativePath of inspected.changes.deleted || []) {
      rows.push({
        path: relativePath,
        status: "deleted",
        before: previousFiles[relativePath] || null,
        after: null,
      });
    }

    rows.sort((a, b) => a.path.localeCompare(b.path));
    const result = {
      projectId: project.id,
      projectName: project.name,
      projectRoot: project.projectRoot,
      checkedAt: new Date().toISOString(),
      changed: inspected.changed,
      current: {
        projectHash: inspected.current.projectHash,
        fileCount: inspected.current.entries.length,
        sourceBytes: inspected.current.totalBytes,
      },
      baseline: inspected.previous
        ? {
            backupFile: inspected.previous.backupFile || null,
            createdAt: inspected.previous.backupCreatedAt || null,
            projectHash: inspected.previous.projectHash || null,
            fileCount: Object.keys(previousFiles).length,
          }
        : null,
      counts: {
        added: inspected.changes.added?.length || 0,
        modified: inspected.changes.modified?.length || 0,
        deleted: inspected.changes.deleted?.length || 0,
        total: rows.length,
      },
      files: rows,
    };
    this.diffCache.set(id, { expiresAt: Date.now() + 10_000, value: result });
    return result;
  }

  async previewFeaturePack(id, options = {}) {
    return this.featurePacks.preview(id, options);
  }

  async exportFeaturePack(id, options = {}) {
    return this.featurePacks.create(id, options);
  }

  async getProjectFileDiff(id, relativePath, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const summary = await this.getProjectDiff(id);
    const relative = String(relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .trim();
    if (
      !relative ||
      relative.startsWith("/") ||
      relative.includes("\0") ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Invalid project-relative diff path.");
    }

    const item = summary.files.find((entry) => entry.path === relative);
    if (!item) throw new Error("The requested file is not part of the current project diff.");

    const maxBytes = Math.max(
      1024,
      Math.min(2 * 1024 * 1024, Number(options.maxBytes) || 512 * 1024),
    );
    const engine = this._engine(project);
    let before = {
      found: false,
      text: "",
      binary: false,
      tooLarge: false,
      size: item.before?.size ?? null,
    };
    let after = {
      found: false,
      text: "",
      binary: false,
      tooLarge: false,
      size: item.after?.size ?? null,
    };

    if (item.before && summary.baseline?.backupFile) {
      before = await engine.readBackupEntry(summary.baseline.backupFile, relative, { maxBytes });
    }

    if (item.after?.type === "file") {
      const absolute = path.resolve(project.projectRoot, ...relative.split("/"));
      const check = path.relative(project.projectRoot, absolute);
      if (check.startsWith(`..${path.sep}`) || path.isAbsolute(check))
        throw new Error("Diff path escaped the project root.");
      const stat = await fsp.stat(absolute);
      if (stat.size > maxBytes) {
        after = {
          found: true,
          text: null,
          binary: false,
          tooLarge: true,
          size: stat.size,
        };
      } else {
        const buffer = await fsp.readFile(absolute);
        const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
        after = {
          found: true,
          text: binary ? null : buffer.toString("utf8"),
          binary,
          tooLarge: false,
          size: buffer.length,
        };
      }
    } else if (item.after) {
      after = {
        found: true,
        text: null,
        binary: false,
        tooLarge: false,
        size: item.after?.size ?? 0,
        type: item.after?.type || null,
      };
    }

    const canRenderText =
      !before.binary &&
      !after.binary &&
      !before.tooLarge &&
      !after.tooLarge &&
      before.text !== null &&
      after.text !== null &&
      (item.before?.type || "file") === "file" &&
      (item.after?.type || "file") === "file";

    return {
      ...item,
      projectId: project.id,
      projectName: project.name,
      baseline: summary.baseline,
      before: { ...item.before, ...before, text: undefined },
      after: { ...item.after, ...after, text: undefined },
      textDiff: canRenderText
        ? buildLineDiff(before.text || "", after.text || "", {
            maxInputLines: options.maxInputLines,
            maxOutputLines: options.maxOutputLines,
          })
        : {
            detailed: false,
            reason:
              before.binary || after.binary
                ? "binary-file"
                : before.tooLarge || after.tooLarge
                  ? "file-too-large"
                  : "non-file-entry",
            lines: [],
          },
    };
  }

  async inspectRecovery(id, options = {}) {
    return this.recovery.inspect(id, options);
  }

  async getRecoveryCandidate(id, relativePath, selector = {}, options = {}) {
    return this.recovery.readCandidate(id, relativePath, selector, options);
  }

  async recoverFileCandidate(id, relativePath, selector = {}, options = {}) {
    return this.recovery.recoverFile(id, relativePath, selector, options);
  }

  async recoverSuggestedFiles(id, options = {}) {
    return this.recovery.recoverSuggested(id, options);
  }

  async _mirrorPrimaryBackup(project, primaryBackup) {
    const secondaryDir = this._backupDirFor(project, "secondary");
    if (!secondaryDir) return null;
    const secondary = this._engine(project, "secondary");
    return secondary.mirrorVerifiedBackup(
      primaryBackup.path || primaryBackup.archivePath,
      primaryBackup,
    );
  }

  async _checkSecondaryAvailability(project) {
    const secondaryDir = this._backupDirFor(project, "secondary");
    if (!secondaryDir) return { configured: false, available: false, reason: "not-configured" };
    const resolved = path.resolve(secondaryDir);
    const root = path.parse(resolved).root || resolved;
    try {
      await fsp.access(root);
      return { configured: true, available: true, dir: resolved, root };
    } catch (error) {
      return {
        configured: true,
        available: false,
        dir: resolved,
        root,
        reason: "root-unavailable",
        ...serializeError(error),
      };
    }
  }

  async _syncMirrorBacklog(project) {
    const availability = await this._checkSecondaryAvailability(project);
    if (!availability.configured)
      return {
        ...availability,
        copied: [],
        alreadyPresent: [],
        failures: [],
        pendingCount: 0,
      };
    if (!availability.available) {
      const primaryBackups = await this._engine(project, "primary").listBackups();
      return {
        ...availability,
        copied: [],
        alreadyPresent: [],
        failures: [],
        pendingCount: primaryBackups.length,
        deferred: true,
      };
    }

    const primaryBackups = (await this._engine(project, "primary").listBackups()).slice(
      0,
      project.keep,
    );
    let secondaryBackups;
    try {
      secondaryBackups = await this._engine(project, "secondary").listBackups();
    } catch (error) {
      return {
        ...availability,
        available: false,
        deferred: true,
        copied: [],
        alreadyPresent: [],
        failures: [{ file: null, ...serializeError(error) }],
        pendingCount: primaryBackups.length,
        ...serializeError(error),
      };
    }

    const secondaryByFile = new Map(secondaryBackups.map((item) => [item.file, item]));
    const copied = [];
    const alreadyPresent = [];
    const failures = [];

    for (const primary of primaryBackups) {
      const existing = secondaryByFile.get(primary.file);
      const healthy =
        existing &&
        existing.verificationStatus === "verified" &&
        primary.archiveSha256 &&
        existing.archiveSha256 === primary.archiveSha256;
      if (healthy) {
        alreadyPresent.push(primary.file);
        continue;
      }
      try {
        const mirror = await this._mirrorPrimaryBackup(project, primary);
        if (mirror?.copied) copied.push(primary.file);
        else alreadyPresent.push(primary.file);
      } catch (error) {
        failures.push({ file: primary.file, ...serializeError(error) });
        if (["ENOENT", "ENODEV", "EIO", "ENXIO"].includes(error.code)) break;
      }
    }

    let retention = null;
    try {
      retention = await this._engine(project, "secondary").prune();
      for (const failure of retention.failures || []) {
        failures.push({
          file: failure.file,
          operation: "retention",
          error: failure.message,
          errorCode: failure.code,
          errorPath: failure.path,
        });
      }
    } catch (error) {
      failures.push({
        file: null,
        operation: "retention",
        ...serializeError(error),
      });
    }

    const completed = new Set([...copied, ...alreadyPresent]);
    const pendingCount = primaryBackups.filter((item) => !completed.has(item.file)).length;
    return {
      ...availability,
      available: true,
      copied,
      alreadyPresent,
      failures,
      retention,
      pendingCount,
      deferred: failures.length > 0 || pendingCount > 0,
    };
  }

  async runBackup(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const runtime = this._runtime(id);
    if (runtime.running)
      return {
        created: false,
        skipped: true,
        reason: "manager-backup-already-running",
      };

    runtime.running = true;
    runtime.lastCheckAt = new Date().toISOString();
    try {
      if (isRemoteProject(project)) {
        const payload = await this.remoteAgentClient.backupProject(project.remoteAgentId, project, {
          force: options.force === true,
        });
        const result = payload.result || payload;
        runtime.lastResult = result;
        runtime.lastError =
          result.mirrorWarning || result.retentionWarning
            ? {
                message: "Remote backup completed with a destination warning.",
                at: new Date().toISOString(),
                partial: true,
                severity: "warning",
                primaryCommitted: true,
              }
            : null;
        if (result.created) runtime.lastBackupAt = new Date().toISOString();
        if (result.created || options.source !== "watch") {
          await this.log(
            result.mirrorWarning || result.retentionWarning
              ? "warning"
              : result.created
                ? "success"
                : "info",
            `${result.created ? "Remote backup completed" : "No remote changes"}: ${project.name}`,
            {
              projectId: id,
              operation: "remote-backup",
              remoteAgentId: project.remoteAgentId,
              source: options.source || "manual",
              created: result.created === true,
              destinations: result.destinations || [],
            },
          );
        }
        return result;
      }
      const primaryEngine = this._engine(project, "primary");
      const result = await primaryEngine.backupIfChanged({
        force: options.force === true,
      });
      const primaryRetentionFailures = result.retention?.failures || [];
      const primaryRetentionWarning = primaryRetentionFailures.length > 0;
      const primaryRetentionFailure = primaryRetentionFailures[0] || null;
      const destinations = [
        {
          key: "primary",
          ok: true,
          warning: primaryRetentionWarning,
          available: true,
          created: result.created,
          archivePath: result.archivePath || null,
          retention: result.retention || null,
          error: primaryRetentionFailure
            ? `Backup retention could not remove ${primaryRetentionFailure.file}: ${primaryRetentionFailure.message}`
            : null,
          errorCode: primaryRetentionFailure?.code || null,
          errorPath: primaryRetentionFailure?.path || null,
        },
      ];

      if (primaryRetentionWarning) {
        await this.log("warning", `Backup retention incomplete: ${project.name}`, {
          projectId: id,
          destination: "primary",
          operation: "backup-retention",
          source: options.source || "manual",
          keep: project.keep,
          failures: primaryRetentionFailures,
          recommendation:
            "The newest backup remains valid. Close any process holding old archives open, check antivirus/NAS permissions, and run Backup now again to retry retention.",
        });
      }

      if (this._backupDirFor(project, "secondary")) {
        const sync = await this._syncMirrorBacklog(project);
        const firstFailure = sync.failures?.[0] || null;
        const warning =
          sync.available === false || sync.pendingCount > 0 || (sync.failures?.length || 0) > 0;
        const secondaryResult = {
          key: "secondary",
          ok: true,
          optional: true,
          warning,
          available: sync.available === true,
          deferred: warning,
          created: (sync.copied?.length || 0) > 0,
          copiedCount: sync.copied?.length || 0,
          alreadyPresentCount: sync.alreadyPresent?.length || 0,
          pendingCount: sync.pendingCount || 0,
          archivePath: null,
          error:
            firstFailure?.error ||
            sync.error ||
            (sync.available === false
              ? "Secondary destination is unavailable; mirror synchronization was deferred."
              : null),
          errorCode: firstFailure?.errorCode || sync.errorCode || null,
          errorPath: firstFailure?.errorPath || sync.errorPath || sync.dir || null,
        };
        destinations.push(secondaryResult);

        if (warning) {
          await this.log("warning", `Secondary backup deferred: ${project.name}`, {
            projectId: id,
            destination: "secondary",
            operation: "mirror-sync",
            source: options.source || "manual",
            pendingCount: secondaryResult.pendingCount,
            secondaryDir: this._backupDirFor(project, "secondary"),
            error: secondaryResult.error,
            errorCode: secondaryResult.errorCode,
            errorPath: secondaryResult.errorPath,
            recommendation:
              "The primary backup remains valid. Reconnect/mount the secondary drive and run Backup now; all missing retained mirror copies will be backfilled automatically.",
          });
        } else if ((sync.copied?.length || 0) > 0 && !result.created) {
          await this.log("success", `Secondary backup backlog synchronized: ${project.name}`, {
            projectId: id,
            destination: "secondary",
            operation: "mirror-sync",
            copiedCount: sync.copied.length,
            source: options.source || "manual",
          });
        }
      }

      const mirrorWarning = destinations.some((item) => item.key === "secondary" && item.warning);
      const retentionWarning = destinations.some((item) => item.key === "primary" && item.warning);
      const anyWarning = mirrorWarning || retentionWarning;
      const enriched = {
        ...result,
        primaryCommitted: true,
        primaryHealthy: true,
        mirrorWarning,
        retentionWarning,
        destinations,
      };
      runtime.lastResult = enriched;
      runtime.lastError = anyWarning
        ? {
            message:
              destinations.find((item) => item.warning)?.error ||
              "Backup completed with a retention or mirror warning.",
            at: new Date().toISOString(),
            partial: true,
            severity: "warning",
            primaryCommitted: true,
          }
        : null;

      if (result.created) {
        runtime.lastBackupAt = new Date().toISOString();
        if (result.deltaJournal?.error) {
          await this.log(
            "warning",
            `Backup succeeded but delta journal update failed: ${project.name}`,
            {
              projectId: id,
              operation: "delta-journal",
              backupFile: path.basename(result.archivePath),
              error: result.deltaJournal.error,
              recommendation:
                "The verified backup is still valid. Review journal storage permissions/capacity before the next snapshot if persistent delta recovery is desired.",
            },
          );
        }
        await this.log(
          anyWarning ? "warning" : "success",
          `${mirrorWarning ? "Primary backup created; secondary deferred" : retentionWarning ? "Backup created; retention incomplete" : "Backup created and verified"}: ${project.name}`,
          {
            projectId: id,
            operation: "backup",
            backupFile: path.basename(result.archivePath),
            archiveSize: result.archiveSize,
            changes: result.changes,
            destinations,
            primaryCommitted: true,
            source: options.source || "manual",
            deltaJournal: result.deltaJournal || null,
            recommendation: mirrorWarning
              ? "No action is required for the primary copy. Reconnect the secondary drive when convenient and run Backup now to synchronize missing mirror copies."
              : retentionWarning
                ? "Close any process holding old backup archives open, check destination permissions, and run Backup now again to retry retention."
                : null,
          },
        );
      } else if (options.source !== "watch") {
        const copied = destinations.find((item) => item.key === "secondary")?.copiedCount || 0;
        await this.log(
          anyWarning ? "warning" : "info",
          copied
            ? `No source changes; synchronized ${copied} mirror backup${copied === 1 ? "" : "s"}: ${project.name}`
            : retentionWarning
              ? `No source changes; backup retention is still pending: ${project.name}`
              : `No changes: ${project.name}`,
          {
            projectId: id,
            operation: "backup-check",
            destinations,
            source: options.source || "manual",
            recommendation: mirrorWarning
              ? "Primary backups are current. Reconnect the optional secondary destination to clear the pending mirror warning."
              : retentionWarning
                ? "Close any process holding old backup archives open, check destination permissions, and run Backup now again to retry retention."
                : null,
          },
        );
      }
      return enriched;
    } catch (error) {
      runtime.lastError = {
        message: error.message,
        at: new Date().toISOString(),
        primaryCommitted: false,
      };
      await this.log(
        "error",
        `${isRemoteProject(project) ? "Remote backup failed" : "Primary backup failed"}: ${project.name}`,
        {
          projectId: id,
          destination: "primary",
          remoteAgentId: isRemoteProject(project) ? project.remoteAgentId : null,
          operation: isRemoteProject(project) ? "remote-backup" : "backup",
          source: options.source || "manual",
          primaryCommitted: false,
          ...serializeError(error),
        },
      );
      throw error;
    } finally {
      runtime.running = false;
    }
  }

  async listBackups(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.listBackups(project.remoteAgentId, project);
      return payload.backups || [];
    }
    const destinations = this._backupDestinations(project);
    const all = [];
    for (const destination of destinations) {
      try {
        const items = await this._engine(project, destination.key).listBackups();
        all.push({ destination, items });
      } catch (error) {
        all.push({ destination, items: [], error: error.message });
      }
    }

    const merged = new Map();
    for (const group of all) {
      for (const item of group.items) {
        if (!merged.has(item.file)) {
          merged.set(item.file, {
            ...item,
            logicalSize: item.size,
            destinations: [],
          });
        }
        const target = merged.get(item.file);
        target.destinations.push({
          key: group.destination.key,
          label: group.destination.label,
          dir: group.destination.dir,
          path: item.path,
          size: item.size,
          archiveSha256: item.archiveSha256,
          verificationStatus: item.verificationStatus,
          verifiedAt: item.verifiedAt,
          verificationMessage: item.verificationMessage,
          error: null,
        });
      }
    }

    const configured = destinations.map((item) => item.key);
    for (const item of merged.values()) {
      for (const destination of destinations) {
        if (!item.destinations.some((copy) => copy.key === destination.key)) {
          item.destinations.push({
            key: destination.key,
            label: destination.label,
            dir: destination.dir,
            path: null,
            size: 0,
            verificationStatus: "missing",
            error: "Backup copy is missing.",
          });
        }
      }
      item.copyCount = item.destinations.filter((copy) => copy.path).length;
      item.configuredCopies = configured.length;
      item.totalStoredBytes = item.destinations.reduce(
        (sum, copy) => sum + Number(copy.size || 0),
        0,
      );
      item.mirrorHealthy = item.destinations.every(
        (copy) => copy.path && copy.verificationStatus === "verified",
      );
    }
    return [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async _resolveBackupCopy(id, fileName, destinationKey = null) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    const destinations = destinationKey
      ? this._backupDestinations(project).filter((item) => item.key === destinationKey)
      : this._backupDestinations(project);
    if (!destinations.length) throw new Error("Requested backup destination is not configured.");
    let lastError = null;
    for (const destination of destinations) {
      try {
        const fullPath = await this._engine(project, destination.key).resolveBackup(fileName);
        return {
          destination,
          fullPath,
          engine: this._engine(project, destination.key),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Backup not found.");
  }

  async resolveBackup(id, fileName, destinationKey = null) {
    return (await this._resolveBackupCopy(id, fileName, destinationKey)).fullPath;
  }

  async deleteBackup(id, fileName) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.deleteBackup(
        project.remoteAgentId,
        project,
        fileName,
      );
      const results = payload.results || [];
      await this.log("info", `Remote backup deleted: ${project.name}`, {
        projectId: id,
        backupFile: fileName,
        remoteAgentId: project.remoteAgentId,
        destinations: results,
      });
      return results;
    }
    const results = [];
    for (const destination of this._backupDestinations(project)) {
      try {
        await this._engine(project, destination.key).deleteBackup(fileName);
        results.push({ key: destination.key, deleted: true });
      } catch (error) {
        if (error.code === "ENOENT" || /not found|no such file/i.test(error.message))
          results.push({ key: destination.key, deleted: false, missing: true });
        else
          results.push({
            key: destination.key,
            deleted: false,
            error: error.message,
          });
      }
    }
    const failures = results.filter((item) => item.error);
    await this.log(failures.length ? "warning" : "info", `Backup deleted: ${project.name}`, {
      projectId: id,
      backupFile: fileName,
      destinations: results,
    });
    if (failures.length === results.length)
      throw new Error(failures.map((item) => `${item.key}: ${item.error}`).join("; "));
    return results;
  }

  async verifyBackup(id, fileName) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.verifyBackup(
        project.remoteAgentId,
        project,
        fileName,
      );
      return payload.result || payload;
    }
    const copies = [];
    for (const destination of this._backupDestinations(project)) {
      try {
        const result = await this._engine(project, destination.key).verifyBackup(fileName);
        copies.push({ destination: destination.key, ...result });
      } catch (error) {
        copies.push({
          destination: destination.key,
          file: fileName,
          valid: false,
          verificationStatus: "missing",
          message: error.message,
        });
      }
    }
    const valid = copies.every((item) => item.valid);
    const preferred =
      copies.find((item) => item.destination === "primary" && item.valid) ||
      copies.find((item) => item.valid) ||
      copies[0] ||
      {};
    const result = {
      ...preferred,
      file: fileName,
      valid,
      verificationStatus: valid ? "verified" : "failed",
      message: valid
        ? `All ${copies.length} configured backup copies verified.`
        : "One or more configured backup copies failed verification or are missing.",
      copies,
    };
    await this.log(
      valid ? "success" : "error",
      `${valid ? "Backup verified" : "Backup verification failed"}: ${project.name}`,
      {
        projectId: id,
        backupFile: fileName,
        verification: result.verificationStatus,
        message: result.message,
      },
    );
    return result;
  }

  async verifyAllBackups(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.verifyAllBackups(project.remoteAgentId, project);
      return payload.results || [];
    }
    const backups = await this.listBackups(id);
    const results = [];
    for (const backup of backups) results.push(await this.verifyBackup(id, backup.file));
    const failed = results.filter((item) => !item.valid).length;
    await this.log(
      failed ? "error" : "success",
      `Verified ${results.length} logical backup${results.length === 1 ? "" : "s"} for ${project.name}${failed ? ` (${failed} failed)` : ""}.`,
      {
        projectId: id,
        verified: results.length - failed,
        failed,
      },
    );
    return results;
  }

  async restoreBackup(id, fileName, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.restoreBackup(
        project.remoteAgentId,
        project,
        fileName,
        options,
      );
      const result = payload.result || payload;
      await this.log("success", `Remote backup restored: ${project.name}`, {
        projectId: id,
        backupFile: fileName,
        remoteAgentId: project.remoteAgentId,
        destination: result.destination,
      });
      return result;
    }
    const defaultFolder = path.join(
      this.restoreRoot,
      `${safeName(project.name)}-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}`,
    );
    const destination = options.destination
      ? path.resolve(String(options.destination))
      : defaultFolder;
    const copy = await this._resolveBackupCopy(id, fileName, options.backupDestination || null);
    const result = await copy.engine.restoreBackup(fileName, destination, {
      overwrite: options.overwrite === true,
    });
    await this.log("success", `Backup restored: ${project.name}`, {
      projectId: id,
      backupFile: fileName,
      backupDestination: copy.destination.key,
      destination: result.destination,
    });
    return { ...result, backupDestination: copy.destination.key };
  }

  async inspectDependencies(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error("Dependency inspection is not yet available through the LAN remote agent.");
    const result = await this.dependencyInspector.inspect(id, project.projectRoot, {
      refresh: options.refresh === true,
    });
    if (!result.cached) {
      await this.log(
        result.registryAvailable ? "info" : "warning",
        `Dependency check: ${project.name} · ${result.summary.outdated} outdated of ${result.summary.total}`,
        {
          projectId: id,
          dependencyCheck: true,
          outdated: result.summary.outdated,
          total: result.summary.total,
          registryAvailable: result.registryAvailable,
          error: result.registryError || null,
        },
      );
    }
    return result;
  }

  async getDependencyVersions(id, packageName, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    return this.dependencyInspector.getVersions(id, project.projectRoot, packageName, {
      refresh: options.refresh === true,
      includePrerelease: options.includePrerelease === true,
    });
  }

  async updateDependency(id, packageName, version, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (this.dependencyUpdatesRunning.has(id)) {
      throw new Error(
        "Another dependency update is already running for this project. Wait for it to finish before applying another version.",
      );
    }
    this.dependencyUpdatesRunning.add(id);
    try {
      const result = await this.dependencyInspector.updateDependency(
        id,
        project.projectRoot,
        packageName,
        version,
        {
          saveMode: options.saveMode,
          runScripts: options.runScripts !== false,
          refreshVersions: options.refreshVersions === true,
        },
      );
      await this.log(
        "success",
        `Dependency updated: ${project.name} · ${result.name} → ${result.version}`,
        {
          projectId: id,
          dependencyUpdate: true,
          dependency: result.name,
          version: result.version,
          declaration: result.declaration,
          saveMode: result.saveMode,
          runScripts: result.runScripts,
        },
      );
      return result;
    } catch (error) {
      await this.log("error", `Dependency update failed: ${project.name} · ${packageName}`, {
        projectId: id,
        dependencyUpdate: true,
        dependency: packageName,
        version,
        operation: "dependency-update",
        error: error.message,
        stack: error.stack || null,
      });
      throw error;
    } finally {
      this.dependencyUpdatesRunning.delete(id);
    }
  }

  async getProjectLaunchInfo(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error("This action is local-host only for LAN remote projects.");
    return this.projectLauncher.launchInfo(project);
  }

  async openProjectInEditor(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error("This action is local-host only for LAN remote projects.");
    const result = await this.projectLauncher.openEditor(project);
    await this.log("info", `Opened project in ${result.editor.label}: ${project.name}`, {
      projectId: id,
      operation: "open-editor",
      editor: result.editor.id,
      projectRoot: project.projectRoot,
    });
    return result;
  }

  async getProjectRepository(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error("This action is local-host only for LAN remote projects.");
    return this.projectLauncher.repositoryInfo(project);
  }

  async _dockerStartGate(project, options = {}) {
    if (project.pm2WaitForDocker !== true) return { ready: true, enabled: false };
    if (!this.dockerRuntimeMonitor) {
      return {
        ready: false,
        enabled: true,
        reason: "docker-monitor-unavailable",
        message: "Docker startup gating is enabled, but Docker runtime monitoring is unavailable.",
      };
    }
    const current =
      options.refresh === false
        ? this.dockerRuntimeMonitor.getCurrent()
        : await this.dockerRuntimeMonitor.refresh();
    if (current?.daemonReady === true)
      return { ready: true, enabled: true, dockerRuntime: current };
    return {
      ready: false,
      enabled: true,
      reason: "waiting-for-docker",
      message: current?.message || "Waiting for the Docker daemon to become ready.",
      dockerRuntime: current || null,
    };
  }

  async startProjectInPm2(id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error(
        "LAN remote PM2 is read-only; start/restart controls are intentionally disabled.",
      );
    const automatic = options.automatic === true;
    if (!automatic) this.pm2AutoStartSuppressed.delete(id);
    if (project.pm2Monitoring === false)
      throw new Error("PM2 monitoring is disabled for this project.");
    if (!automatic && project.pm2ControlsEnabled !== true)
      throw new Error(
        "PM2 dashboard controls are disabled for this project. Enable them in Edit Project first.",
      );

    if (options.refresh === true) await this.refreshPm2();
    const status = this.pm2Monitor.getProjectStatus(id);
    if (!status.available) throw new Error(status.error || "PM2 is unavailable.");
    if (status.processes.some((proc) => proc.status === "online")) {
      return {
        started: false,
        skipped: true,
        reason: "already-online",
        projectId: id,
      };
    }

    const dockerGate = await this._dockerStartGate(project, { refresh: !automatic });
    if (!dockerGate.ready) {
      return {
        started: false,
        skipped: true,
        waiting: true,
        reason: dockerGate.reason,
        message: dockerGate.message,
        dockerRuntime: dockerGate.dockerRuntime || null,
        projectId: id,
      };
    }

    const stopped = status.processes.filter((proc) =>
      ["stopped", "offline"].includes(String(proc.status || "").toLowerCase()),
    );
    if (stopped.length) {
      const started = [];
      for (const proc of stopped) {
        const result = await this.pm2Monitor.executeAction(proc, "start");
        started.push({
          pm2Id: proc.id,
          processName: proc.name,
          action: result.action,
        });
      }
      await this.log(
        "info",
        `${automatic ? "PM2 auto-start" : "PM2 project start"}: ${project.name}`,
        {
          projectId: id,
          operation: automatic ? "pm2-auto-start" : "pm2-project-start",
          pm2AutoStart: automatic,
          startedProcesses: started,
        },
      );
      return {
        started: true,
        mode: "existing-processes",
        projectId: id,
        processes: started,
      };
    }

    if (status.processes.length) {
      throw new Error(
        `Matched PM2 process is ${status.processes.map((proc) => proc.status).join(", ")}; auto-start only starts stopped/offline processes and never loops errored processes.`,
      );
    }

    const result = await this.pm2Monitor.startProjectFromEcosystem(project);
    await this.log(
      "info",
      `${automatic ? "PM2 auto-start from ecosystem" : "Started project in PM2"}: ${project.name}`,
      {
        projectId: id,
        operation: automatic ? "pm2-auto-start" : "pm2-project-start",
        pm2AutoStart: automatic,
        ecosystemFile: result.ecosystemFile,
        ecosystemAppName: result.appName || null,
      },
    );
    return { started: true, mode: "ecosystem", projectId: id, ...result };
  }

  async _handlePm2AutoStart(snapshot = {}) {
    const summaries = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const now = Date.now();
    for (const summary of summaries) {
      const project = this.projects.get(summary.projectId);
      if (
        !project ||
        isRemoteProject(project) ||
        project.pm2AutoStart !== true ||
        project.pm2Monitoring === false
      )
        continue;
      if (this.pm2AutoStartSuppressed.has(project.id)) continue;
      if (!summary.available || summary.processes?.some((proc) => proc.status === "online"))
        continue;
      const statuses = (summary.processes || []).map((proc) =>
        String(proc.status || "").toLowerCase(),
      );
      if (
        statuses.some((status) =>
          ["errored", "error", "launching", "stopping", "waiting restart"].includes(status),
        )
      )
        continue;
      if (statuses.length && !statuses.some((status) => ["stopped", "offline"].includes(status)))
        continue;
      if (this.pm2AutoStartRunning.has(project.id)) continue;
      const previous = this.pm2AutoStartAttempts.get(project.id);
      if (previous && previous.nextAttemptAt > now) continue;

      this.pm2AutoStartRunning.add(project.id);
      const runtime = this._runtime(project.id);
      runtime.pm2AutoStart = {
        state: "starting",
        attemptedAt: new Date().toISOString(),
        message: null,
      };
      try {
        const result = await this.startProjectInPm2(project.id, {
          automatic: true,
          refresh: false,
        });
        const waitingForDocker = result.reason === "waiting-for-docker";
        runtime.pm2AutoStart = {
          state: waitingForDocker ? "waiting-for-docker" : result.started ? "started" : "skipped",
          attemptedAt: new Date().toISOString(),
          message: result.message || result.reason || result.mode || null,
          dockerRuntime: result.dockerRuntime || null,
        };
        this.pm2AutoStartAttempts.set(project.id, {
          nextAttemptAt:
            Date.now() +
            (waitingForDocker ? PM2_DOCKER_WAIT_RETRY_MS : PM2_AUTO_START_SUCCESS_COOLDOWN_MS),
          ok: true,
        });
      } catch (error) {
        runtime.pm2AutoStart = {
          state: "failed",
          attemptedAt: new Date().toISOString(),
          message: error.message,
        };
        this.pm2AutoStartAttempts.set(project.id, {
          nextAttemptAt: Date.now() + PM2_AUTO_START_FAILURE_COOLDOWN_MS,
          ok: false,
        });
        await this.log("warning", `PM2 auto-start failed: ${project.name}`, {
          projectId: project.id,
          operation: "pm2-auto-start",
          pm2AutoStart: true,
          ecosystemFile: project.pm2EcosystemFile,
          error: error.message,
          recommendation:
            "Confirm PM2 is installed and the configured ecosystem file exists. Auto-start will retry after its cooldown.",
        });
      } finally {
        this.pm2AutoStartRunning.delete(project.id);
      }
    }
  }

  getPm2Status() {
    return {
      ...this.pm2Monitor.getStatus(),
      remoteAgents: this.remoteAgentMonitor.getAgentsStatus(),
    };
  }

  getRemoteAgentsStatus() {
    return this.remoteAgentMonitor.getAgentsStatus();
  }

  getProjectPm2Status(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    return isRemoteProject(project)
      ? this.remoteAgentMonitor.getProjectStatus(id)
      : this.pm2Monitor.getProjectStatus(id);
  }

  async refreshPm2() {
    await Promise.all([this.pm2Monitor.refresh(), this.remoteAgentMonitor.refresh()]);
    return this.getPm2Status();
  }

  async getProjectPm2Logs(id, pm2Id, options = {}) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (project.pm2Monitoring === false)
      throw new Error("PM2 monitoring is disabled for this project.");
    if (isRemoteProject(project))
      throw new Error("PM2 log streaming is not exposed by the LAN remote agent.");

    if (options.refresh === true) await this.refreshPm2();
    const status = this.pm2Monitor.getProjectStatus(id);
    if (!status.available) throw new Error(status.error || "PM2 is unavailable.");

    const target = status.processes.find((proc) => Number(proc.id) === Number(pm2Id));
    if (!target) throw new Error("That PM2 process is not currently matched to this project.");

    const logs = await readProcessLogs(target, {
      stream: options.stream || "both",
      lines: options.lines,
      maxBytes: options.maxBytes,
    });

    return {
      projectId: id,
      projectName: project.name,
      ...logs,
    };
  }

  async _logPm2Event(event) {
    const projectIds = Array.isArray(event.projectIds) ? event.projectIds : [];
    const projectNames = projectIds.map((id) => this.projects.get(id)?.name).filter(Boolean);
    const level =
      event.severity === "error" ? "error" : event.severity === "warning" ? "warning" : "info";
    const suffix = projectNames.length ? ` (${projectNames.join(", ")})` : "";
    await this.log(level, `PM2: ${event.message}${suffix}`, {
      pm2Event: event.eventType,
      projectIds,
      unexpected: event.unexpected === true,
      plannedAction: event.plannedAction || null,
      pm2Id: event.process?.id ?? event.pm2Id ?? null,
    });
  }

  getPm2HistorySummary(range = "24h") {
    return this.pm2History.getSummary(null, range);
  }

  getProjectPm2History(id, options = {}) {
    if (!this.projects.has(id)) throw new Error("Project not found.");
    return this.pm2History.queryProject(id, options);
  }

  async clearProjectPm2History(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    await this.pm2History.clearProject(id);
    await this.log("warning", `PM2 health history cleared: ${project.name}`, {
      projectId: id,
    });
    return true;
  }

  async runPm2Action(id, pm2Id, action) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project))
      throw new Error("LAN remote PM2 is read-only; process controls are intentionally disabled.");
    if (project.pm2Monitoring === false)
      throw new Error("PM2 monitoring is disabled for this project.");
    if (project.pm2ControlsEnabled !== true)
      throw new Error(
        "PM2 dashboard controls are disabled for this project. Enable them in Edit Project first.",
      );
    const status = this.pm2Monitor.getProjectStatus(id);
    if (!status.available) throw new Error(status.error || "PM2 is unavailable.");
    const target = status.processes.find((proc) => Number(proc.id) === Number(pm2Id));
    if (!target) throw new Error("That PM2 process is not currently matched to this project.");
    const requestedAction = String(action || "")
      .trim()
      .toLowerCase();
    if (["start", "restart", "reload"].includes(requestedAction)) {
      const dockerGate = await this._dockerStartGate(project);
      if (!dockerGate.ready) {
        return {
          action: requestedAction,
          delayed: true,
          reason: dockerGate.reason,
          message: dockerGate.message,
          dockerRuntime: dockerGate.dockerRuntime || null,
          pm2Id: target.id,
          processName: target.name,
          projectId: id,
          projectPm2: status,
        };
      }
    }
    const result = await this.pm2Monitor.executeAction(target, action);
    if (result.action === "stop" && project.pm2AutoStart === true) {
      this.pm2AutoStartSuppressed.add(id);
      const runtime = this._runtime(id);
      runtime.pm2AutoStart = {
        state: "suppressed",
        attemptedAt: new Date().toISOString(),
        message:
          "Auto-start paused after a manual dashboard Stop. Use Start or toggle auto-start to re-arm it.",
      };
    } else if (["start", "restart", "reload"].includes(result.action)) {
      this.pm2AutoStartSuppressed.delete(id);
    }
    await this.log("info", `PM2 ${result.action}: ${target.name}`, {
      projectId: id,
      pm2Id: target.id,
      pm2Action: result.action,
    });
    return {
      action: result.action,
      pm2Id: target.id,
      processName: target.name,
      projectId: id,
      projectPm2: this.pm2Monitor.getProjectStatus(id),
    };
  }

  isRemoteProject(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    return isRemoteProject(project);
  }

  async getRemoteBackupDownload(id, fileName, destinationKey = null) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (!isRemoteProject(project)) throw new Error("Project is not a LAN remote project.");
    return this.remoteAgentClient.download(
      project.remoteAgentId,
      project,
      fileName,
      destinationKey,
    );
  }

  async runAllBackups(options = {}) {
    const results = [];
    for (const project of this.projects.values()) {
      try {
        const result = await this.runBackup(project.id, {
          force: options.force === true,
          source: "dashboard-all",
        });
        const destinationWarnings = (result.destinations || []).filter(
          (item) => item.warning === true,
        );
        results.push({
          projectId: project.id,
          projectName: project.name,
          ok: true,
          partial: destinationWarnings.length > 0,
          warnings: destinationWarnings,
          result,
        });
      } catch (error) {
        results.push({
          projectId: project.id,
          projectName: project.name,
          ok: false,
          error: error.message,
        });
      }
    }
    return results;
  }

  async verifyAllProjects() {
    const results = [];
    for (const project of this.projects.values()) {
      try {
        const verifications = await this.verifyAllBackups(project.id);
        results.push({
          projectId: project.id,
          projectName: project.name,
          ok: true,
          verified: verifications.length,
          failed: verifications.filter((item) => !item.valid).length,
        });
      } catch (error) {
        results.push({
          projectId: project.id,
          projectName: project.name,
          ok: false,
          error: error.message,
        });
      }
    }
    return results;
  }

  async _filesystemStats(directory) {
    try {
      await fsp.mkdir(directory, { recursive: true });
      const stat = await fsp.statfs(directory);
      const blockSize = Number(stat.bsize || 0);
      const total = blockSize * Number(stat.blocks || 0);
      const available = blockSize * Number(stat.bavail || 0);
      return {
        path: directory,
        root: path.parse(path.resolve(directory)).root || path.resolve(directory),
        totalBytes: Number.isFinite(total) ? total : null,
        availableBytes: Number.isFinite(available) ? available : null,
        usedBytes: Number.isFinite(total - available) ? total - available : null,
      };
    } catch (error) {
      return {
        path: directory,
        root: path.parse(path.resolve(directory)).root || path.resolve(directory),
        totalBytes: null,
        availableBytes: null,
        usedBytes: null,
        error: error.message,
        code: error.code || null,
      };
    }
  }

  async getProjectStorageStats(id) {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (isRemoteProject(project)) {
      const payload = await this.remoteAgentClient.storage(project.remoteAgentId, project);
      return payload.storage || payload;
    }
    const destinationStats = [];
    for (const destination of this._backupDestinations(project)) {
      try {
        const stats = await this._engine(project, destination.key).getStorageStats();
        destinationStats.push({
          key: destination.key,
          label: destination.label,
          backupDir: destination.dir,
          ...stats,
          filesystem: await this._filesystemStats(destination.dir),
        });
      } catch (error) {
        destinationStats.push({
          key: destination.key,
          label: destination.label,
          backupDir: destination.dir,
          backupCount: 0,
          totalBytes: 0,
          verifiedCount: 0,
          failedVerificationCount: 0,
          unverifiedCount: 0,
          filesystem: await this._filesystemStats(destination.dir),
          error: error.message,
        });
      }
    }

    const logical = await this.listBackups(id);
    const verifiedCount = logical.filter((item) =>
      item.destinations.every((copy) => copy.path && copy.verificationStatus === "verified"),
    ).length;
    const failedVerificationCount = logical.filter((item) =>
      item.destinations.some(
        (copy) => copy.verificationStatus === "failed" || copy.verificationStatus === "missing",
      ),
    ).length;
    const unverifiedCount = Math.max(0, logical.length - verifiedCount - failedVerificationCount);
    const totalBytes = destinationStats.reduce(
      (sum, item) => sum + Number(item.totalBytes || 0),
      0,
    );
    const copyCount = destinationStats.reduce(
      (sum, item) => sum + Number(item.backupCount || 0),
      0,
    );
    const newest = logical[0] || null;

    return {
      projectId: id,
      projectName: project.name,
      backupDir: this._backupDirFor(project, "primary"),
      backupDirSecondary: this._backupDirFor(project, "secondary"),
      backupCount: logical.length,
      copyCount,
      configuredDestinations: destinationStats.length,
      totalBytes,
      averageBytes: copyCount ? Math.round(totalBytes / copyCount) : 0,
      totalSourceBytes: logical.reduce((sum, item) => sum + Number(item.sourceBytes || 0), 0),
      latestCompressionRatio: newest?.sourceBytes > 0 ? newest.size / newest.sourceBytes : null,
      verifiedCount,
      failedVerificationCount,
      unverifiedCount,
      newestAt: newest?.createdAt || null,
      oldestAt: logical[logical.length - 1]?.createdAt || null,
      mirrorHealthy: destinationStats.length < 2 || logical.every((item) => item.mirrorHealthy),
      destinations: destinationStats,
      filesystem: destinationStats[0]?.filesystem || null,
    };
  }

  async getStorageStats() {
    const projectStats = await Promise.all(
      [...this.projects.values()].map(async (project) => {
        try {
          return await this.getProjectStorageStats(project.id);
        } catch (error) {
          return {
            projectId: project.id,
            projectName: project.name,
            backupDir: this._backupDirFor(project, "primary"),
            backupDirSecondary: this._backupDirFor(project, "secondary"),
            backupCount: 0,
            copyCount: 0,
            totalBytes: 0,
            verifiedCount: 0,
            failedVerificationCount: 0,
            unverifiedCount: 0,
            error: error.message,
          };
        }
      }),
    );

    const totalBytes = projectStats.reduce((sum, stats) => sum + Number(stats.totalBytes || 0), 0);
    const totalBackups = projectStats.reduce(
      (sum, stats) => sum + Number(stats.backupCount || 0),
      0,
    );
    const totalCopies = projectStats.reduce((sum, stats) => sum + Number(stats.copyCount || 0), 0);
    const verifiedCount = projectStats.reduce(
      (sum, stats) => sum + Number(stats.verifiedCount || 0),
      0,
    );
    const failedVerificationCount = projectStats.reduce(
      (sum, stats) => sum + Number(stats.failedVerificationCount || 0),
      0,
    );
    const unverifiedCount = projectStats.reduce(
      (sum, stats) => sum + Number(stats.unverifiedCount || 0),
      0,
    );
    const mirroredProjects = projectStats.filter((item) => item.configuredDestinations > 1).length;
    const mirrorWarnings = projectStats.filter(
      (item) => item.configuredDestinations > 1 && item.mirrorHealthy === false,
    ).length;

    return {
      totalBytes,
      totalBackups,
      totalCopies,
      verifiedCount,
      failedVerificationCount,
      unverifiedCount,
      mirroredProjects,
      mirrorWarnings,
      projectStorageErrors: projectStats.filter((item) => item.error).length,
      projects: projectStats,
      filesystem: await this._filesystemStats(this.backupRoot),
    };
  }

  async discoverProjects(parentRoots, options = {}) {
    const result = await discoverNodeProjects(parentRoots, options);
    const registered = new Set(
      [...this.projects.values()].map((project) => pathKey(project.projectRoot)),
    );
    return {
      ...result,
      projects: result.projects.map((candidate) => ({
        ...candidate,
        registered: registered.has(pathKey(candidate.projectRoot)),
      })),
    };
  }

  async registerDiscoveredProjects(candidates, defaults = {}) {
    if (!Array.isArray(candidates) || !candidates.length)
      throw new Error("Select at least one discovered project.");
    const results = { added: [], skipped: [], errors: [] };

    for (const candidate of candidates) {
      const projectRoot = String(candidate?.projectRoot || "").trim();
      if (!projectRoot) continue;
      const existing = [...this.projects.values()].find(
        (item) => pathKey(item.projectRoot) === pathKey(projectRoot),
      );
      if (existing) {
        results.skipped.push({
          projectRoot,
          reason: "already-registered",
          id: existing.id,
        });
        continue;
      }

      try {
        const project = await this.addProject({
          name: String(candidate.name || path.basename(projectRoot)),
          projectRoot,
          backupDir: null,
          keep: defaults.keep ?? 10,
          watch: defaults.watch ?? true,
          intervalSeconds: defaults.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
          extraExcludes: Array.isArray(defaults.extraExcludes) ? defaults.extraExcludes : [],
          extraIncludes: Array.isArray(defaults.extraIncludes) ? defaults.extraIncludes : [],
          schedule: defaults.schedule || DEFAULT_SCHEDULE,
        });
        results.added.push(project);
      } catch (error) {
        results.errors.push({ projectRoot, error: error.message });
      }
    }

    return results;
  }

  getActivity(limit = 100) {
    return this.activity.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
  }

  async shutdown() {
    this.pm2Monitor.stop();
    this.remoteAgentMonitor.stop();
    this.serviceHealthMonitor.stop();
    for (const projectId of this.runtime.keys()) this._clearAutomation(projectId);
    this.runtime.clear();
    await this.pm2History.shutdown();
  }
}

module.exports = {
  BackupManager,
  computeNextScheduledAt,
  normalizeProject,
  normalizeSchedule,
  scheduleDescription,
};
