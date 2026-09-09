"use strict";

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const { execFile } = require("child_process");
const { EventEmitter } = require("events");
const { promisify } = require("util");
const { ProcessGpuMonitor } = require("../system/process-gpu-monitor");

const execFileAsync = promisify(execFile);
const DEFAULT_REFRESH_MS = 10000;
const COMMAND_TIMEOUT_MS = 8000;
const MAX_BUFFER = 8 * 1024 * 1024;
const PLANNED_ACTION_TTL_MS = 45 * 1000;
const ALLOWED_ACTIONS = new Set(["restart", "reload", "stop", "start", "reset"]);

function unpackedElectronPath(value, electron = Boolean(process.versions.electron)) {
  const file = String(value || "");
  if (!electron) return file;
  return file.replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
}

function pm2NodeExecutable(env = process.env, _electron = Boolean(process.versions.electron)) {
  const override = String(env.UPM_NODE_EXECUTABLE || "").trim();
  if (override) return override;
  return process.execPath;
}

function pm2NodeCandidates(env = process.env, electron = Boolean(process.versions.electron)) {
  const override = String(env.UPM_NODE_EXECUTABLE || "").trim();
  if (override) return [{ executable: override, env, asarAware: !electron }];
  if (!electron) return [{ executable: process.execPath, env, asarAware: true }];
  return [
    {
      executable: process.execPath,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      asarAware: true,
    },
    { executable: "node", env, asarAware: false },
  ];
}

function localPm2Cli() {
  try {
    return require.resolve("pm2/bin/pm2");
  } catch {
    return null;
  }
}

function commandMissing(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return (
    error?.code === "ENOENT" ||
    text.includes("cannot find module") ||
    text.includes("module_not_found") ||
    text.includes("not recognized as an internal or external command") ||
    text.includes("command not found")
  );
}

async function runLocalPm2(args, options = {}) {
  const cli = localPm2Cli();
  if (!cli) return null;
  const candidates = pm2NodeCandidates(options.env || process.env);
  for (const candidate of candidates) {
    const candidateCli = candidate.asarAware ? cli : unpackedElectronPath(cli);
    if (!candidate.asarAware && candidateCli !== cli) {
      const available = await fsp
        .access(candidateCli)
        .then(() => true)
        .catch(() => false);
      if (!available) continue;
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        candidate.executable,
        [candidateCli, ...args],
        {
          windowsHide: true,
          timeout: options.timeout || COMMAND_TIMEOUT_MS,
          maxBuffer: options.maxBuffer || MAX_BUFFER,
          cwd: options.cwd,
          env: candidate.env,
        },
      );
      return { stdout: String(stdout || ""), stderr: String(stderr || "") };
    } catch (error) {
      if (process.versions.electron && commandMissing(error)) continue;
      throw error;
    }
  }
  return null;
}

function normalizedPath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, candidate) {
  const root = normalizedPath(parent);
  const target = normalizedPath(candidate);
  if (!root || !target) return false;
  if (root === target) return true;
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function extractJsonArray(text) {
  const value = String(text || "").trim();
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start === -1 || end < start) throw new Error("PM2 returned an unexpected response.");
  return JSON.parse(value.slice(start, end + 1));
}

async function runPm2Jlist() {
  const local = await runLocalPm2(["jlist"]);
  if (local) return extractJsonArray(local.stdout);

  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "pm2 jlist"],
      { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    return extractJsonArray(stdout);
  }

  const { stdout } = await execFileAsync("pm2", ["jlist"], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return extractJsonArray(stdout);
}

async function readPm2DaemonPid() {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  try {
    const raw = await fsp.readFile(path.join(pm2Home, "pm2.pid"), "utf8");
    const pid = Number(String(raw).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function runPm2Action(action, id) {
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Unsupported PM2 action: ${action}`);
  const target = String(Number(id));
  if (!/^\d+$/.test(target)) throw new Error("A valid PM2 process id is required.");

  const local = await runLocalPm2([action, target], { timeout: 20_000 });
  if (local) return local;

  if (process.platform === "win32") {
    const command = `pm2 ${action} ${target}`;
    const { stdout, stderr } = await execFileAsync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", command],
      { windowsHide: true, timeout: 20_000, maxBuffer: MAX_BUFFER },
    );
    return { stdout: String(stdout || ""), stderr: String(stderr || "") };
  }

  const { stdout, stderr } = await execFileAsync("pm2", [action, target], {
    timeout: 20_000,
    maxBuffer: MAX_BUFFER,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function normalizePm2EcosystemFile(value) {
  const raw = String(value || "ecosystem.config.js")
    .trim()
    .replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || path.isAbsolute(raw))
    throw new Error("PM2 ecosystem file must be a relative project path.");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === ".." || part === "."))
    throw new Error("PM2 ecosystem file may not traverse outside the project.");
  if (parts.some((part) => /[\x00-\x1f\x7f]/.test(part)))
    throw new Error("PM2 ecosystem file contains unsupported control characters.");
  return parts.join("/");
}

function normalizePm2AppName(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length > 256 || /[\x00-\x1f\x7f]/.test(raw))
    throw new Error("PM2 ecosystem app name contains unsupported characters.");
  return raw;
}

async function runPm2StartProject(
  projectRoot,
  ecosystemFile = "ecosystem.config.js",
  appName = null,
) {
  const root = path.resolve(projectRoot);
  const relative = normalizePm2EcosystemFile(ecosystemFile);
  const target = path.resolve(root, ...relative.split("/"));
  if (!isPathInside(root, target))
    throw new Error("PM2 ecosystem file resolves outside the project.");
  const stat = await fsp.stat(target).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`PM2 ecosystem file was not found: ${relative}`);
    throw error;
  });
  if (!stat.isFile()) throw new Error(`PM2 ecosystem path is not a file: ${relative}`);

  const only = normalizePm2AppName(appName);
  const args = ["start", relative];
  if (only) args.push("--only", only);

  const local = await runLocalPm2(args, { cwd: root, timeout: 30_000 });
  if (local) return local;

  if (process.platform === "win32") {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const env = {
      ...process.env,
      UPM_PM2_PROJECT_ROOT: root,
      UPM_PM2_ECOSYSTEM_FILE: relative,
      UPM_PM2_ECOSYSTEM_APP: only || "",
    };
    const script = [
      "$pm2 = (Get-Command pm2 -ErrorAction Stop).Source",
      "Set-Location -LiteralPath $env:UPM_PM2_PROJECT_ROOT",
      "if ($env:UPM_PM2_ECOSYSTEM_APP) { & $pm2 start $env:UPM_PM2_ECOSYSTEM_FILE --only $env:UPM_PM2_ECOSYSTEM_APP } else { & $pm2 start $env:UPM_PM2_ECOSYSTEM_FILE }",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("; ");
    const { stdout, stderr } = await execFileAsync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: MAX_BUFFER,
      },
    );
    return { stdout: String(stdout || ""), stderr: String(stderr || "") };
  }

  const { stdout, stderr } = await execFileAsync("pm2", args, {
    cwd: root,
    timeout: 30_000,
    maxBuffer: MAX_BUFFER,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function unavailableFromError(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return (
    error?.code === "ENOENT" ||
    text.includes("not recognized as an internal or external command") ||
    text.includes("command not found") ||
    text.includes("cannot find the file")
  );
}

function normalizeMetricName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findAxmMetric(axmMonitor, aliases = []) {
  if (!axmMonitor || typeof axmMonitor !== "object") return null;
  const wanted = aliases.map(normalizeMetricName).filter(Boolean);
  if (!wanted.length) return null;

  for (const [name, metric] of Object.entries(axmMonitor)) {
    const normalized = normalizeMetricName(name);
    if (wanted.includes(normalized)) return metric;
  }

  for (const [name, metric] of Object.entries(axmMonitor)) {
    const normalized = normalizeMetricName(name);
    if (wanted.some((alias) => normalized.includes(alias) || alias.includes(normalized)))
      return metric;
  }

  return null;
}

function metricPrimitive(metric) {
  if (
    metric &&
    typeof metric === "object" &&
    Object.prototype.hasOwnProperty.call(metric, "value")
  ) {
    return metric.value;
  }
  return metric;
}

function metricUnit(metric) {
  if (!metric || typeof metric !== "object") return "";
  return String(metric.unit || metric.units || "")
    .trim()
    .toLowerCase();
}

function metricNumber(metric) {
  const value = metricPrimitive(metric);
  if (Number.isFinite(Number(value))) return Number(value);
  const match = String(value ?? "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function metricBytes(metric) {
  const value = metricNumber(metric);
  if (!Number.isFinite(value)) return null;

  const primitiveText = String(metricPrimitive(metric) ?? "").toLowerCase();
  const unit = `${metricUnit(metric)} ${primitiveText}`;
  const factors = [
    [/\b(?:tib|tb)\b/, 1024 ** 4],
    [/\b(?:gib|gb)\b/, 1024 ** 3],
    [/\b(?:mib|mb)\b/, 1024 ** 2],
    [/\b(?:kib|kb)\b/, 1024],
    [/\b(?:bytes?|b)\b/, 1],
  ];

  for (const [pattern, factor] of factors) {
    if (pattern.test(unit)) return Math.round(value * factor);
  }

  return value >= 1024 * 1024 ? Math.round(value) : null;
}

function metricPercent(metric) {
  const value = metricNumber(metric);
  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 100) return value;
  return null;
}

function metricMilliseconds(metric) {
  const value = metricNumber(metric);
  if (!Number.isFinite(value)) return null;
  const unit = `${metricUnit(metric)} ${String(metricPrimitive(metric) ?? "").toLowerCase()}`;
  if (/\b(?:us|µs|microseconds?)\b/.test(unit)) return value / 1000;
  if (/\b(?:s|sec|secs|seconds?)\b/.test(unit) && !/\bms\b/.test(unit)) return value * 1000;
  return value;
}

function findExactAxmMetric(axmMonitor, aliases = []) {
  if (!axmMonitor || typeof axmMonitor !== "object") return null;
  const wanted = new Set(aliases.map(normalizeMetricName).filter(Boolean));
  for (const [name, metric] of Object.entries(axmMonitor)) {
    if (wanted.has(normalizeMetricName(name))) return metric;
  }
  return null;
}

function metricRatePerSecond(metric) {
  const value = metricNumber(metric);
  if (!Number.isFinite(value)) return null;
  const unit = `${metricUnit(metric)} ${String(metricPrimitive(metric) ?? "").toLowerCase()}`;
  if (/(?:req(?:uest)?s?)?\s*\/?\s*(?:min|minute)/.test(unit) || /\brpm\b/.test(unit))
    return value / 60;
  return value;
}

function normalizeProcessCpuPercent(rawPercent, logicalCpuCount = os.cpus().length) {
  const raw = Number(rawPercent);
  if (!Number.isFinite(raw)) return null;
  const cores = Math.max(1, Number(logicalCpuCount) || 1);
  return Math.max(0, Math.min(100, raw / cores));
}

function extractAxmMetrics(raw = {}) {
  const env = raw.pm2_env || {};
  const axm = env.axm_monitor || raw.axm_monitor || {};

  let heapUsedBytes = metricBytes(
    findAxmMetric(axm, ["Used Heap Size", "Heap Used", "Heap Used Size"]),
  );
  let heapTotalBytes = metricBytes(
    findAxmMetric(axm, ["Heap Size", "Total Heap Size", "Heap Total"]),
  );
  let heapUsagePercent = metricPercent(findAxmMetric(axm, ["Heap Usage", "Heap Usage Percent"]));

  if (
    heapUsedBytes != null &&
    heapTotalBytes != null &&
    heapTotalBytes > 0 &&
    heapUsagePercent == null
  ) {
    heapUsagePercent = (heapUsedBytes / heapTotalBytes) * 100;
  }
  if (
    heapUsedBytes != null &&
    heapUsagePercent != null &&
    heapUsagePercent > 0 &&
    heapTotalBytes == null
  ) {
    heapTotalBytes = Math.round(heapUsedBytes / (heapUsagePercent / 100));
  }

  const httpRateMetric =
    findExactAxmMetric(axm, ["HTTP", "HTTP Requests", "HTTP Request Rate", "HTTP Throughput"]) ||
    findAxmMetric(axm, [
      "Requests per minute",
      "Requests/min",
      "Requests per second",
      "Requests/sec",
      "Request Rate",
    ]);
  const httpRequestsPerSecond = metricRatePerSecond(httpRateMetric);

  return {
    heapUsedBytes,
    heapTotalBytes,
    heapUsagePercent,
    eventLoopLatencyMs: metricMilliseconds(findAxmMetric(axm, ["Event Loop Latency"])),
    eventLoopLatencyP95Ms: metricMilliseconds(
      findAxmMetric(axm, ["Event Loop Latency p95", "Event Loop Latency 95", "Event Loop p95"]),
    ),
    activeHandles: metricNumber(findAxmMetric(axm, ["Active handles", "Active Handles"])),
    activeRequests: metricNumber(findAxmMetric(axm, ["Active requests", "Active Requests"])),
    httpRequestsPerSecond,
    httpRequestsPerMinute:
      httpRequestsPerSecond == null ? null : Math.max(0, httpRequestsPerSecond * 60),
    httpMeanLatencyMs: metricMilliseconds(
      findAxmMetric(axm, [
        "HTTP Mean Latency",
        "HTTP Average Latency",
        "HTTP Avg Latency",
        "HTTP Latency",
        "pmx:http:latency",
      ]),
    ),
    httpP95LatencyMs: metricMilliseconds(
      findAxmMetric(axm, ["HTTP P95 Latency", "HTTP Latency p95", "HTTP 95 Latency"]),
    ),
  };
}

function slimProcess(raw = {}, options = {}) {
  const env = raw.pm2_env || {};
  const monit = raw.monit || {};
  const startedAt = Number(env.pm_uptime || 0) || null;
  const now = Date.now();
  const status = String(env.status || "unknown");
  const axmMetrics = extractAxmMetrics(raw);
  const logicalCpuCount = Math.max(1, Number(options.logicalCpuCount) || os.cpus().length || 1);
  const cpuRawPercent = Number.isFinite(Number(monit.cpu)) ? Number(monit.cpu) : null;
  const cpuPercent = normalizeProcessCpuPercent(cpuRawPercent, logicalCpuCount);
  const gpu = options.gpu || null;

  return {
    id: Number.isInteger(raw.pm_id) ? raw.pm_id : Number(raw.pm_id),
    name: String(raw.name || env.name || `pm2-${raw.pm_id ?? "unknown"}`),
    namespace: String(env.namespace || "default"),
    status,
    pid: Number(raw.pid || 0),
    uptimeMs: startedAt && status === "online" ? Math.max(0, now - startedAt) : 0,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    restarts: Number(env.restart_time || 0),
    unstableRestarts: Number(env.unstable_restarts || 0),
    cpu: cpuPercent,
    cpuPercent,
    cpuRawPercent,
    cpuLogicalCpus: logicalCpuCount,
    memoryBytes: Number.isFinite(Number(monit.memory)) ? Number(monit.memory) : null,
    gpuPercent: Number.isFinite(Number(gpu?.gpuPercent)) ? Number(gpu.gpuPercent) : null,
    gpuRawPercent: Number.isFinite(Number(gpu?.gpuRawPercent)) ? Number(gpu.gpuRawPercent) : null,
    gpuMemoryPercent: Number.isFinite(Number(gpu?.gpuMemoryPercent))
      ? Number(gpu.gpuMemoryPercent)
      : null,
    gpuDevices: Array.isArray(gpu?.gpuDevices) ? gpu.gpuDevices.map((item) => ({ ...item })) : [],
    ...axmMetrics,
    execMode: env.exec_mode || null,
    instances: Number.isFinite(Number(env.instances)) ? Number(env.instances) : null,
    cwd: env.pm_cwd || env.cwd || null,
    script: env.pm_exec_path || null,
    outLogPath: env.pm_out_log_path || null,
    errLogPath: env.pm_err_log_path || null,
    logDateFormat: env.log_date_format || null,
    mergeLogs: env.merge_logs === true || env.combine_logs === true,
    nodeVersion: env.node_version || null,
    version: env.version || null,
  };
}

function processIdentity(processInfo = {}) {
  return `${processInfo.namespace || "default"}:${processInfo.name || "unknown"}:${Number.isFinite(Number(processInfo.id)) ? Number(processInfo.id) : "na"}`;
}

function aliasMatches(project, processInfo) {
  const aliases = (project.pm2ProcessNames || [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
  if (!aliases.length) return false;
  const name = processInfo.name.toLowerCase();
  const namespaced = `${processInfo.namespace}/${processInfo.name}`.toLowerCase();
  return aliases.includes(name) || aliases.includes(namespaced);
}

function pathMatches(project, processInfo) {
  return (
    isPathInside(project.projectRoot, processInfo.cwd) ||
    isPathInside(project.projectRoot, processInfo.script)
  );
}

function summarizeProject(project, processes, available, checkedAt, error = null) {
  const online = processes.filter((item) => item.status === "online").length;
  const stopped = processes.filter((item) => ["stopped", "stopping"].includes(item.status)).length;
  const errored = processes.filter((item) => ["errored", "error"].includes(item.status)).length;
  const other = Math.max(0, processes.length - online - stopped - errored);

  let status = "none";
  if (!available) status = "unavailable";
  else if (processes.length === 0) status = "none";
  else if (errored > 0 || online < processes.length) status = "degraded";
  else status = "online";

  return {
    projectId: project.id,
    available,
    monitored: project.pm2Monitoring !== false,
    controlsEnabled: project.pm2ControlsEnabled === true,
    status,
    total: processes.length,
    online,
    stopped,
    errored,
    other,
    checkedAt,
    error,
    processes,
  };
}

class Pm2Monitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.refreshMs = Math.max(3000, Number(options.refreshMs || DEFAULT_REFRESH_MS));
    this.runner = options.runner || runPm2Jlist;
    this.daemonPidProvider = options.daemonPidProvider || readPm2DaemonPid;
    this.actionRunner = options.actionRunner || runPm2Action;
    this.projectStartRunner = options.projectStartRunner || runPm2StartProject;
    this.gpuMonitor = options.gpuMonitor || new ProcessGpuMonitor(options.gpuOptions);
    this.logicalCpuCount = Math.max(1, Number(options.logicalCpuCount) || os.cpus().length || 1);
    this.actionDelayMs = Math.max(0, Number(options.actionDelayMs ?? 450));
    this.timer = null;
    this.projectProvider = null;
    this.refreshing = null;
    this.projects = new Map();
    this.previousProcesses = new Map();
    this.previousAssignments = new Map();
    this.plannedActions = new Map();
    this.globalStatus = {
      available: false,
      checkedAt: null,
      error: null,
      daemonPid: null,
      processCount: 0,
      online: 0,
      stopped: 0,
      errored: 0,
      other: 0,
      processes: [],
      gpu: { available: false, source: null, checkedAt: null, error: null },
    };
  }

  async start(projectProvider) {
    this.projectProvider = projectProvider;
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      ...this.globalStatus,
      processes: this.globalStatus.processes.map((item) => ({ ...item })),
    };
  }

  getProjectStatus(projectId) {
    const value = this.projects.get(projectId);
    if (!value) {
      return {
        projectId,
        available: this.globalStatus.available,
        monitored: true,
        controlsEnabled: false,
        status: this.globalStatus.available ? "none" : "unavailable",
        total: 0,
        online: 0,
        stopped: 0,
        errored: 0,
        other: 0,
        checkedAt: this.globalStatus.checkedAt,
        error: this.globalStatus.error,
        processes: [],
        gpu: { ...(this.globalStatus.gpu || {}) },
      };
    }
    return {
      ...value,
      processes: value.processes.map((item) => ({ ...item })),
    };
  }

  markPlannedAction(processInfo, action) {
    const key = processIdentity(processInfo);
    this.plannedActions.set(key, {
      action,
      expiresAt: Date.now() + PLANNED_ACTION_TTL_MS,
    });
  }

  _plannedActionFor(processInfo) {
    const key = processIdentity(processInfo);
    const planned = this.plannedActions.get(key);
    if (!planned) return null;
    if (planned.expiresAt < Date.now()) {
      this.plannedActions.delete(key);
      return null;
    }
    return planned.action;
  }

  async executeAction(processInfo, action) {
    const normalized = String(action || "").toLowerCase();
    if (!ALLOWED_ACTIONS.has(normalized))
      throw new Error("PM2 action must be restart, reload, stop, start, or reset.");
    if (!Number.isInteger(Number(processInfo?.id)))
      throw new Error("The selected PM2 process has no valid id.");
    this.markPlannedAction(processInfo, normalized);
    const key = processIdentity(processInfo);
    let result;
    try {
      result = await this.actionRunner(normalized, Number(processInfo.id));
    } catch (error) {
      this.plannedActions.delete(key);
      throw error;
    }
    if (this.actionDelayMs) await new Promise((resolve) => setTimeout(resolve, this.actionDelayMs));
    const status = await this.refresh();
    return {
      action: normalized,
      pm2Id: Number(processInfo.id),
      output: result?.stdout?.trim() || "",
      status,
    };
  }

  async startProjectFromEcosystem(project) {
    if (!project?.projectRoot)
      throw new Error("Project root is required for PM2 ecosystem startup.");
    const ecosystemFile = normalizePm2EcosystemFile(
      project.pm2EcosystemFile || "ecosystem.config.js",
    );
    const appName = normalizePm2AppName(project.pm2EcosystemAppName || null);
    const result = await this.projectStartRunner(project.projectRoot, ecosystemFile, appName);
    if (this.actionDelayMs) await new Promise((resolve) => setTimeout(resolve, this.actionDelayMs));
    await this.refresh();
    return {
      action: "start-project",
      ecosystemFile,
      appName,
      output: result?.stdout?.trim() || "",
    };
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  _emitEvent(event) {
    this.emit("event", { timestamp: new Date().toISOString(), ...event });
  }

  _detectEvents(processes, assignments, daemonPid) {
    const current = new Map(processes.map((item) => [processIdentity(item), item]));
    const previousDaemonPid = this.globalStatus.daemonPid;
    const usedPlannedKeys = new Set();

    if (previousDaemonPid && daemonPid && previousDaemonPid !== daemonPid) {
      this._emitEvent({
        eventType: "daemon-restart",
        severity: "warning",
        message: `PM2 daemon PID changed from ${previousDaemonPid} to ${daemonPid}.`,
        unexpected: true,
        daemonPid,
        previousDaemonPid,
        projectIds: [...new Set([...assignments.values()].flat())],
      });
    }

    for (const [key, proc] of current) {
      const previous = this.previousProcesses.get(key);
      if (!previous) continue;
      const plannedAction = this._plannedActionFor(proc);
      const projectIds = assignments.get(key) || this.previousAssignments.get(key) || [];
      const restartDelta = Math.max(0, Number(proc.restarts || 0) - Number(previous.restarts || 0));

      if (restartDelta > 0) {
        if (plannedAction) usedPlannedKeys.add(key);
        this._emitEvent({
          eventType: "process-restart",
          severity: plannedAction ? "info" : "warning",
          message: `${proc.name} restart counter increased by ${restartDelta}.`,
          unexpected: !plannedAction,
          plannedAction,
          process: proc,
          projectIds,
          restartDelta,
          restarts: proc.restarts,
          previousStatus: previous.status,
          status: proc.status,
        });
      }

      if (previous.status === "online" && proc.status !== "online") {
        if (plannedAction) usedPlannedKeys.add(key);
        const crashed = ["errored", "error"].includes(proc.status);
        this._emitEvent({
          eventType: crashed ? "process-crash" : "process-down",
          severity: plannedAction ? "info" : crashed ? "error" : "warning",
          message: `${proc.name} changed from online to ${proc.status}.`,
          unexpected: !plannedAction,
          plannedAction,
          process: proc,
          projectIds,
          previousStatus: previous.status,
          status: proc.status,
        });
      }

      if (previous.status !== "online" && proc.status === "online") {
        if (plannedAction) usedPlannedKeys.add(key);
        this._emitEvent({
          eventType: "process-up",
          severity: "info",
          message: `${proc.name} changed from ${previous.status} to online.`,
          unexpected: false,
          plannedAction,
          process: proc,
          projectIds,
          previousStatus: previous.status,
          status: proc.status,
        });
      }

      if (Number(proc.restarts || 0) < Number(previous.restarts || 0)) {
        if (plannedAction) usedPlannedKeys.add(key);
        this._emitEvent({
          eventType: "restart-counter-reset",
          severity: "info",
          message: `${proc.name} restart counter changed from ${previous.restarts || 0} to ${proc.restarts || 0}.`,
          unexpected: false,
          plannedAction,
          process: proc,
          projectIds,
          previousStatus: previous.status,
          status: proc.status,
        });
      }
    }

    for (const [key, previous] of this.previousProcesses) {
      if (current.has(key)) continue;
      const plannedAction = this._plannedActionFor(previous);
      if (plannedAction) usedPlannedKeys.add(key);
      this._emitEvent({
        eventType: "process-missing",
        severity: plannedAction ? "info" : "warning",
        message: `${previous.name} disappeared from the PM2 process list.`,
        unexpected: !plannedAction,
        plannedAction,
        process: previous,
        projectIds: this.previousAssignments.get(key) || [],
        previousStatus: previous.status,
        status: "missing",
      });
    }

    this.previousProcesses = current;
    this.previousAssignments = new Map(
      [...assignments.entries()].map(([key, value]) => [key, [...value]]),
    );
    for (const [key, value] of this.plannedActions) {
      if (usedPlannedKeys.has(key) || value.expiresAt < Date.now()) this.plannedActions.delete(key);
    }
  }

  async _refresh() {
    const checkedAt = new Date().toISOString();
    const projects = typeof this.projectProvider === "function" ? this.projectProvider() || [] : [];

    let rawProcesses;
    try {
      rawProcesses = await this.runner();
      if (!Array.isArray(rawProcesses)) throw new Error("PM2 process list was not an array.");
    } catch (error) {
      const unavailable = unavailableFromError(error);
      const message = unavailable
        ? "PM2 CLI is not available."
        : error.message || "Unable to query PM2.";
      this.globalStatus = {
        available: false,
        checkedAt,
        error: message,
        daemonPid: null,
        processCount: 0,
        online: 0,
        stopped: 0,
        errored: 0,
        other: 0,
        processes: [],
        gpu: this.globalStatus.gpu || {
          available: false,
          source: null,
          checkedAt: null,
          error: null,
        },
      };
      this.projects.clear();
      for (const project of projects) {
        const summary = summarizeProject(project, [], false, checkedAt, message);
        summary.gpu = { ...(this.globalStatus.gpu || {}) };
        this.projects.set(project.id, summary);
      }
      this.emit("sample", {
        checkedAt,
        global: this.getStatus(),
        projects: [...this.projects.values()],
      });
      return this.getStatus();
    }

    const daemonPid = await Promise.resolve()
      .then(() => this.daemonPidProvider())
      .catch(() => null);
    const gpuSnapshot = await Promise.resolve()
      .then(() => this.gpuMonitor.sample(rawProcesses.map((item) => Number(item.pid || 0))))
      .catch((error) => ({
        available: false,
        source: null,
        checkedAt,
        error: error.message || "Unable to query per-process GPU usage.",
        processes: new Map(),
      }));
    const processes = rawProcesses.map((raw) =>
      slimProcess(raw, {
        logicalCpuCount: this.logicalCpuCount,
        gpu: gpuSnapshot.processes?.get?.(Number(raw.pid || 0)) || null,
      }),
    );
    const online = processes.filter((item) => item.status === "online").length;
    const stopped = processes.filter((item) =>
      ["stopped", "stopping"].includes(item.status),
    ).length;
    const errored = processes.filter((item) => ["errored", "error"].includes(item.status)).length;
    const other = Math.max(0, processes.length - online - stopped - errored);

    const assigned = new Map(projects.map((project) => [project.id, []]));
    const processAssignments = new Map();
    const enabledProjects = projects.filter((project) => project.pm2Monitoring !== false);

    for (const processInfo of processes) {
      const matchedProjectIds = [];
      const explicit = enabledProjects.filter((project) => aliasMatches(project, processInfo));
      if (explicit.length) {
        for (const project of explicit) {
          assigned.get(project.id).push(processInfo);
          matchedProjectIds.push(project.id);
        }
      } else {
        const pathCandidates = enabledProjects
          .filter((project) => pathMatches(project, processInfo))
          .sort(
            (a, b) => normalizedPath(b.projectRoot).length - normalizedPath(a.projectRoot).length,
          );
        if (pathCandidates[0]) {
          assigned.get(pathCandidates[0].id).push(processInfo);
          matchedProjectIds.push(pathCandidates[0].id);
        }
      }
      processAssignments.set(processIdentity(processInfo), matchedProjectIds);
    }

    this._detectEvents(processes, processAssignments, daemonPid);

    this.globalStatus = {
      available: true,
      checkedAt,
      error: null,
      daemonPid,
      processCount: processes.length,
      online,
      stopped,
      errored,
      other,
      processes,
      gpu: {
        available: gpuSnapshot.available === true,
        source: gpuSnapshot.source || null,
        checkedAt: gpuSnapshot.checkedAt || checkedAt,
        error: gpuSnapshot.error || null,
      },
    };

    this.projects.clear();
    for (const project of projects) {
      const projectProcesses =
        project.pm2Monitoring === false ? [] : assigned.get(project.id) || [];
      const summary = summarizeProject(project, projectProcesses, true, checkedAt, null);
      summary.gpu = { ...(this.globalStatus.gpu || {}) };
      if (project.pm2Monitoring === false) summary.status = "disabled";
      this.projects.set(project.id, summary);
    }

    this.emit("sample", {
      checkedAt,
      global: this.getStatus(),
      projects: [...this.projects.values()].map((item) => ({
        ...item,
        processes: item.processes.map((proc) => ({ ...proc })),
      })),
    });
    return this.getStatus();
  }
}

module.exports = {
  ALLOWED_ACTIONS,
  Pm2Monitor,
  extractAxmMetrics,
  extractJsonArray,
  metricRatePerSecond,
  normalizeProcessCpuPercent,
  isPathInside,
  localPm2Cli,
  pm2NodeCandidates,
  pm2NodeExecutable,
  unpackedElectronPath,
  processIdentity,
  normalizePm2AppName,
  normalizePm2EcosystemFile,
  readPm2DaemonPid,
  runPm2Action,
  runPm2StartProject,
  slimProcess,
  aliasMatches,
  pathMatches,
  summarizeProject,
};
