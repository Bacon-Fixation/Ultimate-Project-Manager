"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  DEFAULT_PROJECT_PATTERNS,
  readIgnoreFile,
  createIgnoreMatcher,
  toPosix,
} = require("../filesystem/ignore-rules");
const { atomicWriteJson, readJsonRecoverable } = require("../filesystem/atomic-file");

const TASK_KINDS = Object.freeze(["todo", "fix", "note"]);
const TASK_FILE_NAMES = new Set([
  "todo.md",
  "todos.md",
  "task.md",
  "tasks.md",
  "roadmap.md",
  "notes.md",
  ".todo",
  ".todo.md",
  "todo.txt",
  "todos.txt",
  "tasks.txt",
]);
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonc",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".pug",
  ".vue",
  ".svelte",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".conf",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".kts",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".sql",
  ".graphql",
  ".gql",
  ".xml",
  ".svg",
]);
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const TASK_SCAN_DEFAULT_PATTERNS = Object.freeze([
  ...DEFAULT_PROJECT_PATTERNS,
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".cache/",
  "tmp/",
  "temp/",
  "logs/",
]);

function nowIso() {
  return new Date().toISOString();
}
function makeId() {
  return crypto.randomUUID();
}
function normalizeKind(value, fallback = "todo") {
  const raw = String(value || fallback)
    .trim()
    .toLowerCase();
  if (raw === "fixme" || raw === "bug") return "fix";
  return TASK_KINDS.includes(raw) ? raw : fallback;
}
function cleanTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}
function cleanDetails(value) {
  return String(value || "")
    .trim()
    .slice(0, 10000);
}
function sourceHash(parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
function markerKind(marker) {
  const value = String(marker || "").toUpperCase();
  if (["NOTE", "XXX"].includes(value)) return "note";
  if (["FIX", "FIXME", "BUG", "HACK"].includes(value)) return "fix";
  return "todo";
}
function stripCommentTail(text) {
  return String(text || "")
    .replace(/\s*(?:\*\/|-->|\}-->)\s*$/, "")
    .trim();
}
function extractCommentTask(line) {
  const text = String(line || "");
  const match =
    /(?:^|\s)(?:\/\/|\/\*+|\*+|#|<!--|--|;|\{\/\*)\s*@?(TODO|FIXME|FIX|NOTE|BUG|HACK|XXX)\b(?:\s*\([^)]*\))?\s*[:\-]?\s*(.*)$/i.exec(
      text,
    );
  if (!match) return null;
  const title = cleanTitle(stripCommentTail(match[2])) || `${match[1].toUpperCase()} marker`;
  return { kind: markerKind(match[1]), marker: match[1].toUpperCase(), title };
}
function extractChecklistTask(line) {
  const match = /^(\s*)(?:[-*+]\s+)?\[([ xX])\]\s+(.+?)\s*$/.exec(String(line || ""));
  if (!match) return null;
  let title = cleanTitle(match[3]);
  let kind = "todo";
  const prefix = /^(?:\[)?(TODO|FIXME|FIX|NOTE|BUG|HACK|XXX)(?:\])?\s*[:\-]\s*(.+)$/i.exec(title);
  if (prefix) {
    kind = markerKind(prefix[1]);
    title = cleanTitle(prefix[2]);
  }
  return {
    kind,
    title,
    completed: match[2].toLowerCase() === "x",
    depth: Math.floor(match[1].replace(/\t/g, "  ").length / 2),
  };
}
function extractTaskDocumentItem(line) {
  const checklist = extractChecklistTask(line);
  if (checklist) return checklist;
  const match =
    /^\s*(?:[-*+]\s+)?(?:\[)?(TODO|FIXME|FIX|NOTE|BUG|HACK|XXX)(?:\])?\s*[:\-]\s*(.+?)\s*$/i.exec(
      String(line || ""),
    );
  if (!match) return null;
  return {
    kind: markerKind(match[1]),
    title: cleanTitle(match[2]),
    completed: false,
    depth: 0,
  };
}
function isTaskDocument(relativePath) {
  return TASK_FILE_NAMES.has(path.basename(relativePath).toLowerCase());
}
function isTextCandidate(relativePath) {
  const base = path.basename(relativePath).toLowerCase();
  if (TASK_FILE_NAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  return TEXT_EXTENSIONS.has(path.extname(base));
}

class ProjectTaskService {
  constructor(options = {}) {
    this.file = path.resolve(
      options.file ||
        path.join(options.dataDir || path.join(process.cwd(), "data"), "project-tasks.json"),
    );
    this.maxFileBytes = Math.max(4096, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES);
    this.maxFiles = Math.max(100, Number(options.maxFiles) || DEFAULT_MAX_FILES);
    this.maxTotalBytes = Math.max(
      1024 * 1024,
      Number(options.maxTotalBytes) || DEFAULT_MAX_TOTAL_BYTES,
    );
    this.data = { version: 1, projects: {} };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const parsed = await readJsonRecoverable(this.file, null, {
      recover: true,
      throwOnMalformedUnrecovered: true,
      validator: (value) =>
        Boolean(
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          value.projects &&
          typeof value.projects === "object" &&
          !Array.isArray(value.projects),
        ),
    });
    if (parsed) this.data = { version: 1, projects: parsed.projects };
    else await this._write();
    return this;
  }

  _list(projectId) {
    const id = String(projectId || "");
    if (!Array.isArray(this.data.projects[id])) this.data.projects[id] = [];
    return this.data.projects[id];
  }

  async _write() {
    const write = this.writeChain
      .catch(() => {})
      .then(() =>
        atomicWriteJson(this.file, this.data, {
          backup: true,
          validator: (value) =>
            Boolean(
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.projects &&
              typeof value.projects === "object" &&
              !Array.isArray(value.projects),
            ),
        }),
      );
    this.writeChain = write;
    return write;
  }

  getSummary(projectId) {
    const tasks = this._list(projectId);
    const open = tasks.filter((task) => !task.completed);
    return {
      total: tasks.length,
      open: open.length,
      completed: tasks.length - open.length,
      todo: open.filter((task) => task.kind === "todo").length,
      fix: open.filter((task) => task.kind === "fix").length,
      note: open.filter((task) => task.kind === "note").length,
      discovered: tasks.filter((task) => task.origin === "scan").length,
      missingSource: tasks.filter(
        (task) => task.origin === "scan" && task.source?.present === false && !task.completed,
      ).length,
    };
  }

  getTasks(projectId, options = {}) {
    const includeCompleted = options.includeCompleted !== false;
    const kind = options.kind ? normalizeKind(options.kind, "") : "";
    return this._list(projectId)
      .filter((task) => includeCompleted || !task.completed)
      .filter((task) => !kind || task.kind === kind)
      .slice()
      .sort(
        (a, b) =>
          Number(a.completed) - Number(b.completed) ||
          String(b.updatedAt).localeCompare(String(a.updatedAt)),
      );
  }

  async addTask(projectId, input = {}) {
    const title = cleanTitle(input.title);
    if (!title) throw new Error("Task text is required.");
    const now = nowIso();
    const task = {
      id: makeId(),
      projectId: String(projectId),
      kind: normalizeKind(input.kind),
      title,
      details: cleanDetails(input.details),
      completed: Boolean(input.completed),
      completedAt: input.completed ? now : null,
      origin: "manual",
      source: null,
      sourceKey: null,
      createdAt: now,
      updatedAt: now,
    };
    this._list(projectId).push(task);
    await this._write();
    return task;
  }

  async updateTask(projectId, taskId, input = {}) {
    const task = this._list(projectId).find((item) => item.id === taskId);
    if (!task) throw new Error("Task not found.");
    if (Object.prototype.hasOwnProperty.call(input, "title")) {
      const title = cleanTitle(input.title);
      if (!title) throw new Error("Task text is required.");
      task.title = title;
      if (task.origin === "scan") task.sourceOverride = true;
    }
    if (Object.prototype.hasOwnProperty.call(input, "kind")) {
      task.kind = normalizeKind(input.kind);
      if (task.origin === "scan") task.sourceOverride = true;
    }
    if (Object.prototype.hasOwnProperty.call(input, "details"))
      task.details = cleanDetails(input.details);
    if (Object.prototype.hasOwnProperty.call(input, "completed")) {
      const completed = Boolean(input.completed);
      if (completed !== task.completed) task.completedAt = completed ? nowIso() : null;
      task.completed = completed;
    }
    task.updatedAt = nowIso();
    await this._write();
    return task;
  }

  async removeTask(projectId, taskId) {
    const tasks = this._list(projectId);
    const index = tasks.findIndex((item) => item.id === taskId);
    if (index < 0) throw new Error("Task not found.");
    const [removed] = tasks.splice(index, 1);
    await this._write();
    return removed;
  }

  async removeProject(projectId) {
    if (!Object.prototype.hasOwnProperty.call(this.data.projects, projectId)) return;
    delete this.data.projects[projectId];
    await this._write();
  }

  async scanProject(project, options = {}) {
    if (!project?.id || !project?.projectRoot) throw new Error("Project not found.");
    const root = path.resolve(project.projectRoot);
    const gitignore = await readIgnoreFile(root);
    const includeGitignored = options.includeGitignored === true;
    const matcher = createIgnoreMatcher({
      gitignoreText: includeGitignored ? "" : gitignore.text,
      extraPatterns: project.extraExcludes || [],
      defaultPatterns: TASK_SCAN_DEFAULT_PATTERNS,
    });
    const discovered = [];
    const errors = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let bytesScanned = 0;
    let scanLimitReached = false;

    const walk = async (dir, relativeDir = "") => {
      if (filesScanned >= this.maxFiles || scanLimitReached) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        errors.push({
          path: toPosix(relativeDir || "."),
          error: error.message,
        });
        return;
      }
      for (const entry of entries) {
        if (filesScanned >= this.maxFiles || scanLimitReached) break;
        const relative = toPosix(path.join(relativeDir, entry.name));
        if (matcher.ignores(relative, entry.isDirectory())) {
          filesSkipped += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          filesSkipped += 1;
          continue;
        }
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, relative);
          continue;
        }
        if (!entry.isFile() || !isTextCandidate(relative)) continue;
        let stat;
        try {
          stat = await fsp.stat(absolute);
        } catch {
          filesSkipped += 1;
          continue;
        }
        if (stat.size > this.maxFileBytes) {
          filesSkipped += 1;
          continue;
        }
        if (bytesScanned + stat.size > this.maxTotalBytes) {
          scanLimitReached = true;
          break;
        }
        let text;
        try {
          text = await fsp.readFile(absolute, "utf8");
        } catch {
          filesSkipped += 1;
          continue;
        }
        if (text.includes("\u0000")) {
          filesSkipped += 1;
          continue;
        }
        filesScanned += 1;
        bytesScanned += stat.size;
        const lines = text.split(/\r?\n/);
        const occurrences = new Map();
        lines.forEach((line, index) => {
          const taskDoc = isTaskDocument(relative);
          const found = taskDoc ? extractTaskDocumentItem(line) : extractCommentTask(line);
          if (!found || !found.title) return;
          const signature = `${found.kind}\u0000${found.title.toLowerCase()}`;
          const occurrence = (occurrences.get(signature) || 0) + 1;
          occurrences.set(signature, occurrence);
          const key = sourceHash([
            taskDoc ? "task-file" : "comment",
            relative,
            found.kind,
            found.title.toLowerCase(),
            String(occurrence),
          ]);
          discovered.push({
            sourceKey: key,
            kind: found.kind,
            title: found.title,
            completed: Boolean(found.completed),
            source: {
              type: taskDoc ? "task-file" : "comment",
              path: relative,
              line: index + 1,
              marker: taskDoc ? "CHECKLIST" : found.marker,
              depth: found.depth || 0,
              present: true,
            },
          });
        });
      }
    };

    await walk(root);
    const now = nowIso();
    const tasks = this._list(project.id);
    const existingBySource = new Map(
      tasks.filter((task) => task.sourceKey).map((task) => [task.sourceKey, task]),
    );
    const seen = new Set();
    let added = 0;
    let updated = 0;
    for (const item of discovered) {
      seen.add(item.sourceKey);
      const existing = existingBySource.get(item.sourceKey);
      if (existing) {
        if (!existing.sourceOverride) {
          existing.kind = item.kind;
          existing.title = item.title;
        }
        existing.source = { ...item.source, lastSeenAt: now };
        if (item.completed && !existing.completed) {
          existing.completed = true;
          existing.completedAt = now;
        }
        existing.updatedAt = now;
        updated += 1;
      } else {
        tasks.push({
          id: makeId(),
          projectId: String(project.id),
          kind: item.kind,
          title: item.title,
          details: "",
          completed: item.completed,
          completedAt: item.completed ? now : null,
          origin: "scan",
          sourceKey: item.sourceKey,
          source: { ...item.source, firstSeenAt: now, lastSeenAt: now },
          createdAt: now,
          updatedAt: now,
        });
        added += 1;
      }
    }
    let missing = 0;
    for (const task of tasks) {
      if (task.origin !== "scan" || !task.sourceKey || seen.has(task.sourceKey)) continue;
      if (task.source?.present !== false) {
        task.source = {
          ...(task.source || {}),
          present: false,
          lastMissingAt: now,
        };
        task.updatedAt = now;
      }
      if (!task.completed) missing += 1;
    }
    await this._write();
    return {
      scannedAt: now,
      filesScanned,
      filesSkipped,
      bytesScanned,
      includeGitignored,
      discovered: discovered.length,
      added,
      updated,
      missingSource: missing,
      errors: errors.slice(0, 50),
      truncated: filesScanned >= this.maxFiles || scanLimitReached,
      summary: this.getSummary(project.id),
      tasks: this.getTasks(project.id, {
        includeCompleted: options.includeCompleted !== false,
      }),
    };
  }
}

module.exports = {
  ProjectTaskService,
  TASK_KINDS,
  TASK_FILE_NAMES,
  extractCommentTask,
  extractChecklistTask,
  extractTaskDocumentItem,
};
