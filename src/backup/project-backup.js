"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const tar = require("tar");
const { encryptFile, decryptFile, isEncryptedFile } = require("../security/backup-crypto");
const { createIgnoreMatcher, createIncludeOverrideMatcher } = require("../filesystem/ignore-rules");
const {
  atomicWriteJson,
  isRetryableFileError,
  readJsonRecoverable,
  retryFileOperation,
} = require("../filesystem/atomic-file");
const { DeltaJournal } = require("../recovery/delta-journal");

let TAR_MAJOR = 7;
try {
  TAR_MAJOR = Number.parseInt(require("tar/package.json").version, 10) || 7;
} catch {}

const DEFAULT_KEEP = 10;
const DEFAULT_FULL_HASH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DELETE_RETRY_COUNT = 5;
const DELETE_RETRY_DELAY_MS = 125;
const RETRYABLE_DELETE_CODES = new Set(["EBUSY", "EACCES", "EPERM", "EMFILE", "ENFILE"]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function safeName(value) {
  return (
    String(value || "project")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function defaultBackupFolderName(name, id) {
  const suffix = `-${String(id || "").slice(0, 8)}`;
  const maxNameLength = Math.max(1, 255 - suffix.length);
  return `${safeName(name).slice(0, maxNameLength)}${suffix}`;
}

function requireSafePathComponent(value, label = "Path component", options = {}) {
  const text = String(value ?? "").trim();
  const maxLength = Math.max(1, Math.min(255, Number(options.maxLength) || 255));
  if (!text) throw new Error(`${label} is required.`);
  if (
    text === "." ||
    text === ".." ||
    text.length > maxLength ||
    /[\/\\\u0000-\u001f\u007f]/.test(text) ||
    !/^[A-Za-z0-9._-]+$/.test(text)
  ) {
    throw new Error(
      `${label} must be a single safe path component using only letters, numbers, dot, underscore, or dash.`,
    );
  }
  return text;
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unlinkWithRetry(target) {
  let lastError = null;
  for (let attempt = 0; attempt <= DELETE_RETRY_COUNT; attempt += 1) {
    try {
      await fsp.unlink(target);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      lastError = error;
      if (!RETRYABLE_DELETE_CODES.has(error.code) || attempt >= DELETE_RETRY_COUNT) break;
      if (error.code === "EPERM" || error.code === "EACCES") {
        await fsp.chmod(target, 0o666).catch(() => {});
      }
      await delay(DELETE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

async function replaceArchiveFromTemp(tempPath, targetPath) {
  try {
    await retryFileOperation(() => fsp.rename(tempPath, targetPath), {
      retries: 5,
      retryDelayMs: 125,
    });
    return;
  } catch (error) {
    if (!isRetryableFileError(error) && error.code !== "EEXIST") throw error;
  }

  const rollbackPath = `${targetPath}.${process.pid}.${Date.now()}.replace.rollback`;
  let movedExisting = false;
  try {
    if (await exists(targetPath)) {
      await retryFileOperation(() => fsp.rename(targetPath, rollbackPath), {
        retries: 5,
        retryDelayMs: 125,
      });
      movedExisting = true;
    }
    await retryFileOperation(() => fsp.rename(tempPath, targetPath), {
      retries: 5,
      retryDelayMs: 125,
    });
    if (movedExisting) await fsp.rm(rollbackPath, { force: true }).catch(() => {});
  } catch (error) {
    if (movedExisting && !(await exists(targetPath))) {
      await retryFileOperation(() => fsp.rename(rollbackPath, targetPath), {
        retries: 5,
        retryDelayMs: 125,
      }).catch(() => {});
    }
    throw error;
  }
}

async function readJson(file, fallback = null, options = {}) {
  return readJsonRecoverable(file, fallback, options);
}

async function writeJsonAtomic(file, value) {
  await atomicWriteJson(file, value, {
    backup: true,
    validator: (candidate) => candidate !== undefined,
  });
}

async function readGitignore(projectRoot) {
  try {
    return await fsp.readFile(path.join(projectRoot, ".gitignore"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function relativeIfInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".") return "";
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return toPosix(relative);
}

function buildIgnoreMatcher({
  projectRoot,
  backupDir,
  backupDirs = [],
  gitignoreText,
  extraExcludes = [],
  extraIncludes = [],
}) {
  const protectedPatterns = [".git/"];
  const protectedBackupDirs = [backupDir, ...(Array.isArray(backupDirs) ? backupDirs : [])].filter(
    Boolean,
  );
  for (const protectedDir of protectedBackupDirs) {
    const backupRelative = relativeIfInside(projectRoot, protectedDir);
    if (backupRelative) protectedPatterns.push(`${backupRelative.replace(/\/$/, "")}/`);
  }

  const base = createIgnoreMatcher({
    gitignoreText,
    defaultPatterns: [],
    extraPatterns: Array.isArray(extraExcludes) ? extraExcludes.map(String).filter(Boolean) : [],
  });
  const protectedMatcher = createIgnoreMatcher({
    gitignoreText: "",
    defaultPatterns: [],
    extraPatterns: protectedPatterns,
  });
  const includes = createIncludeOverrideMatcher(extraIncludes);

  return {
    engine: `${base.engine}+include-overrides`,
    patterns: [
      ...base.patterns,
      ...includes.patterns.map((pattern) => `FORCE:${pattern}`),
      ...protectedPatterns,
    ],
    ignores(relativePath, isDirectory = false) {
      if (protectedMatcher.ignores(relativePath, isDirectory)) return true;
      if (includes.matches(relativePath, isDirectory)) return false;
      if (isDirectory && includes.shouldTraverse(relativePath)) return false;
      return base.ignores(relativePath, isDirectory);
    },
  };
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function scanProject(projectRoot, matcher, options = {}) {
  const entries = [];
  const files = {};
  let totalBytes = 0;
  let hashedFiles = 0;
  let reusedHashes = 0;
  const cachedFiles = options.cachedFiles || {};
  const forceHash = options.forceHash === true;

  async function walk(currentDir) {
    const dirEntries = await fsp.readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      const absolute = path.join(currentDir, entry.name);
      const relative = toPosix(path.relative(projectRoot, absolute));
      if (!relative) continue;

      if (entry.isDirectory()) {
        if (matcher.ignores(`${relative}/`)) continue;
        await walk(absolute);
        continue;
      }

      if (matcher.ignores(relative)) continue;

      const stat = await fsp.lstat(absolute);
      if (entry.isSymbolicLink()) {
        const target = await fsp.readlink(absolute);
        const hash = crypto.createHash("sha256").update(`symlink\0${target}`).digest("hex");
        entries.push(relative);
        files[relative] = {
          type: "symlink",
          hash,
          target,
          size: 0,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        };
        continue;
      }

      if (!entry.isFile()) continue;
      const cached = cachedFiles[relative];
      const canReuse =
        !forceHash &&
        cached?.type === "file" &&
        typeof cached.hash === "string" &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs;
      const hash = canReuse ? cached.hash : await hashFile(absolute);
      if (canReuse) reusedHashes += 1;
      else hashedFiles += 1;
      entries.push(relative);
      files[relative] = {
        type: "file",
        hash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
      totalBytes += stat.size;
    }
  }

  await walk(projectRoot);
  entries.sort();

  return {
    entries,
    files,
    projectHash: projectHashFromFiles(files),
    totalBytes,
    scanStats: { hashedFiles, reusedHashes, forceHash },
  };
}

function projectHashFromFiles(files = {}) {
  const entries = Object.keys(files).sort();
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((relative) => [relative, files[relative].type, files[relative].hash]),
      ),
    )
    .digest("hex");
}

function diffFiles(previousFiles = {}, currentFiles = {}) {
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [relative, current] of Object.entries(currentFiles)) {
    const previous = previousFiles[relative];
    if (!previous) added.push(relative);
    else if (previous.hash !== current.hash || previous.type !== current.type)
      modified.push(relative);
  }

  for (const relative of Object.keys(previousFiles)) {
    if (!currentFiles[relative]) deleted.push(relative);
  }

  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}

function fromPosix(root, relative) {
  return path.join(root, ...String(relative).split("/").filter(Boolean));
}

function snapshotMismatchDetails(expectedFiles = {}, actualFiles = {}) {
  const diff = diffFiles(expectedFiles, actualFiles);
  const parts = [];
  if (diff.deleted.length) parts.push(`missing: ${diff.deleted.slice(0, 5).join(", ")}`);
  if (diff.added.length) parts.push(`extra: ${diff.added.slice(0, 5).join(", ")}`);
  if (diff.modified.length) parts.push(`modified: ${diff.modified.slice(0, 5).join(", ")}`);
  return parts.join("; ") || "hashes differ but no individual file difference was identified";
}

async function createStableSnapshot({ projectRoot, backupDir, entries }) {
  const stagingRoot = await fsp.mkdtemp(path.join(backupDir, ".snapshot-"));
  const files = {};
  let totalBytes = 0;

  try {
    for (const relative of entries) {
      const source = fromPosix(projectRoot, relative);
      const destination = fromPosix(stagingRoot, relative);
      await fsp.mkdir(path.dirname(destination), { recursive: true });

      let stat;
      try {
        stat = await fsp.lstat(source);
      } catch (error) {
        error.message = `Source changed while preparing snapshot (${relative}): ${error.message}`;
        throw error;
      }

      if (stat.isSymbolicLink()) {
        const target = await fsp.readlink(source);
        let symlinkType;
        if (process.platform === "win32") {
          try {
            const followed = await fsp.stat(source);
            symlinkType = followed.isDirectory() ? "dir" : "file";
          } catch {
            symlinkType = "file";
          }
        }
        await fsp.symlink(target, destination, symlinkType);
        files[relative] = {
          type: "symlink",
          hash: crypto.createHash("sha256").update(`symlink\0${target}`).digest("hex"),
          target,
          size: 0,
        };
        continue;
      }

      if (!stat.isFile()) {
        const error = new Error(`Source entry changed type while preparing snapshot: ${relative}`);
        error.code = "SOURCE_CHANGED_DURING_SNAPSHOT";
        throw error;
      }

      try {
        await fsp.copyFile(source, destination);
      } catch (error) {
        error.message = `Could not copy source file into the stable snapshot (${relative}): ${error.message}`;
        throw error;
      }

      await fsp.chmod(destination, stat.mode).catch(() => {});
      await fsp.utimes(destination, stat.atime, stat.mtime).catch(() => {});

      const copiedStat = await fsp.stat(destination);
      const hash = await hashFile(destination);
      files[relative] = { type: "file", hash, size: copiedStat.size };
      totalBytes += copiedStat.size;
    }

    const snapshotEntries = Object.keys(files).sort();
    return {
      stagingRoot,
      snapshot: {
        entries: snapshotEntries,
        files,
        projectHash: projectHashFromFiles(files),
        totalBytes,
      },
    };
  } catch (error) {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function isSnapshotRaceError(error) {
  return ["ENOENT", "ENOTDIR", "EISDIR", "SOURCE_CHANGED_DURING_SNAPSHOT"].includes(error?.code);
}

async function createArchive({ projectRoot, archivePath, entries }) {
  if (!entries.length)
    throw new Error("No files are eligible for backup after ignore rules were applied.");
  await tar.create({ gzip: true, cwd: projectRoot, file: archivePath, portable: true }, entries);
}

function isBackupName(name, prefix) {
  const supported = name.endsWith(".tar.gz") || name.endsWith(".tar.gz.upmenc");
  return name.startsWith(`${prefix}_`) && supported && !name.includes("/") && !name.includes("\\");
}

function normalizeArchivePath(value) {
  let normalized = String(value || "").replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function assertSafeArchivePath(value) {
  const normalized = normalizeArchivePath(value);
  if (!normalized) throw new Error("Archive contains an empty entry path.");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Archive contains an absolute path: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Archive contains a parent traversal path: ${value}`);
  }
  return normalized;
}

function assertSafeLinkTarget(entryPath, linkPath) {
  const target = String(linkPath || "").replace(/\\/g, "/");
  if (!target) return;
  if (target.startsWith("/") || /^[a-zA-Z]:/.test(target)) {
    throw new Error(`Archive link ${entryPath} points to an absolute target.`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`Archive link ${entryPath} points outside the restore folder.`);
  }
}

async function inspectArchive(archivePath) {
  const files = {};
  const hardLinks = [];
  const pending = [];
  const seenPaths = new Set();
  const handledEntries = new WeakSet();
  let validationError = null;

  const handleEntry = (entry) => {
    if (handledEntries.has(entry)) return;
    handledEntries.add(entry);

    if (validationError) {
      entry.resume();
      return;
    }

    let relative;
    try {
      relative = assertSafeArchivePath(entry.path);
      if (seenPaths.has(relative)) throw new Error(`Archive contains duplicate entry: ${relative}`);
      seenPaths.add(relative);
    } catch (error) {
      validationError = error;
      entry.resume();
      return;
    }

    const type = String(entry.type || "");
    if (type === "Directory" || type === "GNUDumpDir") {
      entry.resume();
      return;
    }

    if (type === "SymbolicLink") {
      try {
        assertSafeLinkTarget(relative, entry.linkpath);
        const target = String(entry.linkpath || "");
        files[relative] = {
          type: "symlink",
          hash: crypto.createHash("sha256").update(`symlink\0${target}`).digest("hex"),
          target,
          size: 0,
        };
      } catch (error) {
        validationError = error;
      }
      entry.resume();
      return;
    }

    if (type === "Link") {
      try {
        const target = assertSafeArchivePath(entry.linkpath);
        hardLinks.push({ relative, target });
      } catch (error) {
        validationError = error;
      }
      entry.resume();
      return;
    }

    if (!["File", "OldFile", "ContiguousFile"].includes(type)) {
      validationError = new Error(
        `Archive contains unsupported entry type ${type || "unknown"} at ${relative}.`,
      );
      entry.resume();
      return;
    }

    const promise = new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      let size = 0;
      entry.on("data", (chunk) => {
        hash.update(chunk);
        size += chunk.length;
      });
      entry.on("error", reject);
      entry.on("end", () => {
        files[relative] = { type: "file", hash: hash.digest("hex"), size };
        resolve();
      });
    });
    pending.push(promise);
  };

  const listOptions = { file: archivePath, strict: true };
  if (TAR_MAJOR >= 7) {
    listOptions.noResume = true;
    listOptions.onReadEntry = handleEntry;
  } else {
    listOptions.onentry = handleEntry;
  }
  await tar.list(listOptions);

  await Promise.all(pending);
  if (validationError) throw validationError;

  const unresolved = [...hardLinks];
  let passes = unresolved.length + 1;
  while (unresolved.length && passes > 0) {
    passes -= 1;
    for (let i = unresolved.length - 1; i >= 0; i -= 1) {
      const item = unresolved[i];
      const target = files[item.target];
      if (!target || target.type !== "file") continue;
      files[item.relative] = {
        type: "file",
        hash: target.hash,
        size: target.size,
      };
      unresolved.splice(i, 1);
    }
  }
  if (unresolved.length) {
    throw new Error(`Archive contains unresolved hard link: ${unresolved[0].relative}`);
  }

  const entries = Object.keys(files).sort();
  const totalBytes = entries.reduce((sum, relative) => sum + (files[relative].size || 0), 0);
  return {
    files,
    entries,
    fileCount: entries.length,
    totalBytes,
    projectHash: projectHashFromFiles(files),
  };
}

async function directoryHasEntries(directory) {
  try {
    const entries = await fsp.readdir(directory);
    return entries.length > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

class ProjectBackup {
  constructor(options = {}) {
    if (!options.projectRoot) throw new Error("projectRoot is required.");
    if (!options.backupDir) throw new Error("backupDir is required.");

    this.projectRoot = path.resolve(options.projectRoot);
    this.backupDir = path.resolve(options.backupDir);
    this.keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : DEFAULT_KEEP;
    this.extraExcludes = Array.isArray(options.extraExcludes) ? options.extraExcludes : [];
    this.extraIncludes = Array.isArray(options.extraIncludes) ? options.extraIncludes : [];
    this.additionalBackupDirs = Array.isArray(options.additionalBackupDirs)
      ? options.additionalBackupDirs.map((dir) => path.resolve(dir))
      : [];
    this.projectName = safeName(options.projectName || path.basename(this.projectRoot));
    this.encryptionEnabled = options.encryptionEnabled === true;
    this.encryptionKey = String(options.encryptionKey || "");
    this.deltaJournal =
      options.journalEnabled === true && options.journalDir
        ? new DeltaJournal({
            dir: options.journalDir,
            enabled: true,
            projectId: options.projectId || null,
            projectName: this.projectName,
            retentionDays: options.journalRetentionDays,
            maxEntries: options.journalMaxEntries,
            maxBytes: options.journalMaxBytes,
            maxFileBytes: options.journalMaxFileBytes,
            maxTransitionBytes: options.journalMaxTransitionBytes,
            encryptionEnabled: this.encryptionEnabled,
            encryptionKey: this.encryptionKey,
          })
        : null;
    this.stateFile = path.join(this.backupDir, ".backup-state.json");
    this.indexFile = path.join(this.backupDir, ".backup-index.json");
    this.scanCacheFile = path.join(this.backupDir, ".scan-cache.json");
    this.fullHashIntervalMs = Math.max(
      60_000,
      Number(options.fullHashIntervalMs || DEFAULT_FULL_HASH_INTERVAL_MS),
    );
    this._running = false;
  }

  async ensureReady() {
    const stat = await fsp.stat(this.projectRoot);
    if (!stat.isDirectory())
      throw new Error(`Project root is not a directory: ${this.projectRoot}`);
    await fsp.mkdir(this.backupDir, { recursive: true });
    await this.deltaJournal?.init();
  }

  _assertEncryptionReady() {
    if (this.encryptionEnabled && this.encryptionKey.length < 16) {
      throw new Error(
        "Backup encryption is enabled for this project, but UPM_BACKUP_ENCRYPTION_KEY is missing or shorter than 16 characters.",
      );
    }
  }

  async _prepareReadableArchive(fullPath, metadata = {}) {
    const encrypted =
      metadata.encrypted === true ||
      fullPath.endsWith(".upmenc") ||
      (await isEncryptedFile(fullPath));
    if (!encrypted) return { path: fullPath, encrypted: false, cleanup: async () => {} };
    if (this.encryptionKey.length < 16)
      throw new Error("This backup is encrypted, but UPM_BACKUP_ENCRYPTION_KEY is unavailable.");
    const tempPath = path.join(
      this.backupDir,
      `.decrypt-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tar.gz`,
    );
    await decryptFile(fullPath, tempPath, this.encryptionKey);
    return {
      path: tempPath,
      encrypted: true,
      cleanup: async () => fsp.rm(tempPath, { force: true }).catch(() => {}),
    };
  }

  async _inspectStoredArchive(fullPath, metadata = {}) {
    const readable = await this._prepareReadableArchive(fullPath, metadata);
    try {
      const [snapshot, plaintextArchiveSha256] = await Promise.all([
        inspectArchive(readable.path),
        hashFile(readable.path),
      ]);
      return {
        snapshot,
        plaintextArchiveSha256,
        encrypted: readable.encrypted,
      };
    } finally {
      await readable.cleanup();
    }
  }

  async inspect() {
    await this.ensureReady();
    const matcher = buildIgnoreMatcher({
      projectRoot: this.projectRoot,
      backupDir: this.backupDir,
      backupDirs: this.additionalBackupDirs,
      gitignoreText: await readGitignore(this.projectRoot),
      extraExcludes: this.extraExcludes,
      extraIncludes: this.extraIncludes,
    });

    const scanCache = await readJson(this.scanCacheFile, null, {
      recover: true,
      validator: (value) => Boolean(value && typeof value === "object"),
    });
    const lastFullHashAt = Number(scanCache?.lastFullHashAt || 0);
    const forceHash = !lastFullHashAt || Date.now() - lastFullHashAt >= this.fullHashIntervalMs;
    const current = await scanProject(this.projectRoot, matcher, {
      cachedFiles: scanCache?.files || {},
      forceHash,
    });
    await writeJsonAtomic(this.scanCacheFile, {
      version: 1,
      projectRoot: this.projectRoot,
      checkedAt: new Date().toISOString(),
      lastFullHashAt: forceHash ? Date.now() : lastFullHashAt,
      files: current.files,
    });
    const previous = await readJson(this.stateFile, null, {
      recover: true,
      validator: (value) => Boolean(value && typeof value === "object"),
    });
    const changes = diffFiles(previous?.files || {}, current.files);
    const encryptionChanged =
      Boolean(previous) && Boolean(previous.encrypted) !== this.encryptionEnabled;
    const baselineArchiveMissing =
      Boolean(previous) &&
      (!previous.backupFile ||
        !(await exists(path.join(this.backupDir, path.basename(previous.backupFile)))));
    return {
      current,
      previous,
      changes,
      encryptionChanged,
      baselineArchiveMissing,
      changed:
        !previous ||
        previous.projectHash !== current.projectHash ||
        encryptionChanged ||
        baselineArchiveMissing,
    };
  }

  async _readIndex() {
    return readJson(
      this.indexFile,
      { version: 5, backups: [] },
      {
        recover: true,
        validator: (value) =>
          Boolean(value && typeof value === "object" && Array.isArray(value.backups)),
      },
    );
  }

  async listBackups() {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const index = await this._readIndex();
    const indexed = new Map((index?.backups || []).map((item) => [item.file, item]));
    const names = await fsp.readdir(this.backupDir);
    const results = [];

    for (const name of names) {
      if (!indexed.has(name) && !isBackupName(name, this.projectName)) continue;
      const absolute = path.join(this.backupDir, name);
      const stat = await fsp.stat(absolute);
      if (!stat.isFile()) continue;
      const metadata = indexed.get(name) || {};
      results.push({
        file: name,
        path: absolute,
        size: stat.size,
        createdAt:
          metadata.createdAt || stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
        projectHash: metadata.projectHash || null,
        archiveSha256: metadata.archiveSha256 || null,
        fileCount: metadata.fileCount ?? null,
        sourceBytes: metadata.sourceBytes ?? null,
        forced: metadata.forced === true,
        changes: metadata.changes || null,
        verificationStatus: metadata.verificationStatus || "unverified",
        verifiedAt: metadata.verifiedAt || null,
        verificationMessage: metadata.verificationMessage || null,
        sourceDriftedDuringSnapshot: metadata.sourceDriftedDuringSnapshot === true,
        mirroredFrom: metadata.mirroredFrom || null,
        mirroredAt: metadata.mirroredAt || null,
        encrypted: metadata.encrypted === true || name.endsWith(".upmenc"),
        encryptionFormat:
          metadata.encryptionFormat || (name.endsWith(".upmenc") ? "UPMENC1" : null),
        encryptionCipher:
          metadata.encryptionCipher || (name.endsWith(".upmenc") ? "aes-256-gcm" : null),
        plaintextArchiveSha256: metadata.plaintextArchiveSha256 || null,
      });
    }

    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results;
  }

  async _writeIndex(backups) {
    await writeJsonAtomic(this.indexFile, { version: 5, backups });
  }

  async _writeState(state) {
    await writeJsonAtomic(this.stateFile, state);
  }

  async _updateIndexEntry(fileName, patch) {
    const backups = await this.listBackups();
    const updated = backups.map((item) => {
      const plain = { ...item };
      delete plain.path;
      return item.file === fileName ? { ...plain, ...patch } : plain;
    });
    await this._writeIndex(updated);
  }

  async prune() {
    const backups = await this.listBackups();
    const candidates = backups.slice(this.keep);
    const removed = [];
    const removedFiles = new Set();
    const failures = [];

    for (const item of candidates) {
      try {
        await unlinkWithRetry(item.path);
        removed.push(item.path);
        removedFiles.add(item.file);
      } catch (error) {
        failures.push({
          file: item.file,
          path: item.path,
          code: error.code || null,
          message: error.message,
        });
      }
    }

    const remaining = backups
      .filter((item) => !removedFiles.has(item.file))
      .map(({ path: _path, ...item }) => item);
    await this._writeIndex(remaining);

    return {
      keep: this.keep,
      totalBefore: backups.length,
      totalAfter: remaining.length,
      removed,
      failures,
      satisfied: remaining.length <= this.keep,
    };
  }

  async backupIfChanged(options = {}) {
    if (this._running)
      return {
        created: false,
        skipped: true,
        reason: "backup-already-running",
      };
    this._running = true;

    try {
      this._assertEncryptionReady();
      const force = options.force === true;
      const { current, previous, changes, changed, baselineArchiveMissing } = await this.inspect();
      if (!force && previous && !changed) {
        const retention = await this.prune();
        return {
          created: false,
          skipped: true,
          reason: "no-changes",
          projectHash: current.projectHash,
          fileCount: current.entries.length,
          sourceBytes: current.totalBytes,
          changes,
          removed: retention.removed,
          retention,
        };
      }

      const stamp = timestampForFilename();
      const suffix = this.encryptionEnabled ? ".tar.gz.upmenc" : ".tar.gz";
      let archivePath = path.join(this.backupDir, `${this.projectName}_${stamp}${suffix}`);
      if (await exists(archivePath))
        archivePath = path.join(
          this.backupDir,
          `${this.projectName}_${stamp}_${Date.now()}${suffix}`,
        );

      let stagingRoot = null;
      let plainArchivePath = null;
      let archiveRegistered = false;
      try {
        let staged;
        let snapshotSource = current;
        const snapshotAttempts = 3;
        for (let attempt = 1; attempt <= snapshotAttempts; attempt += 1) {
          try {
            staged = await createStableSnapshot({
              projectRoot: this.projectRoot,
              backupDir: this.backupDir,
              entries: snapshotSource.entries,
            });
            break;
          } catch (error) {
            if (attempt >= snapshotAttempts || !isSnapshotRaceError(error)) throw error;
            snapshotSource = (await this.inspect()).current;
          }
        }
        stagingRoot = staged.stagingRoot;
        const snapshot = staged.snapshot;
        const snapshotChanges = diffFiles(previous?.files || {}, snapshot.files);

        plainArchivePath = this.encryptionEnabled
          ? path.join(
              this.backupDir,
              `.encrypt-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tar.gz`,
            )
          : archivePath;
        await createArchive({
          projectRoot: stagingRoot,
          archivePath: plainArchivePath,
          entries: snapshot.entries,
        });

        const archiveSnapshot = await inspectArchive(plainArchivePath);
        if (archiveSnapshot.projectHash !== snapshot.projectHash) {
          const details = snapshotMismatchDetails(snapshot.files, archiveSnapshot.files);
          throw new Error(
            `Created archive failed content verification against the stable snapshot (${details}).`,
          );
        }

        const plaintextArchiveSha256 = await hashFile(plainArchivePath);
        if (this.encryptionEnabled) {
          await encryptFile(plainArchivePath, archivePath, this.encryptionKey);
          const encryptedVerification = await this._inspectStoredArchive(archivePath, {
            encrypted: true,
          });
          if (
            encryptedVerification.snapshot.projectHash !== snapshot.projectHash ||
            encryptedVerification.plaintextArchiveSha256 !== plaintextArchiveSha256
          ) {
            throw new Error("Encrypted backup failed post-encryption content verification.");
          }
          await fsp.rm(plainArchivePath, { force: true });
          plainArchivePath = null;
        }

        const archiveSha256 = await hashFile(archivePath);
        const archiveStat = await fsp.stat(archivePath);
        const createdAt = new Date().toISOString();
        const sourceDriftedDuringSnapshot = snapshot.projectHash !== current.projectHash;

        let deltaJournal = null;
        if (
          this.deltaJournal &&
          previous?.projectHash &&
          previous.projectHash !== snapshot.projectHash
        ) {
          try {
            deltaJournal = await this.deltaJournal.recordTransition({
              previous,
              current: snapshot,
              changes: snapshotChanges,
              backupFile: path.basename(archivePath),
              backupCreatedAt: createdAt,
              readBefore: async (relativePath, maxBytes) => {
                if (!previous.backupFile) return null;
                const entry = await this.readBackupEntry(previous.backupFile, relativePath, {
                  maxBytes,
                  returnBuffer: true,
                });
                if (!entry.found || entry.tooLarge || !Buffer.isBuffer(entry.buffer)) return null;
                return entry.buffer;
              },
              readAfter: async (relativePath, maxBytes) => {
                const target = fromPosix(stagingRoot, relativePath);
                const stat = await fsp.stat(target);
                if (!stat.isFile() || stat.size > maxBytes) return null;
                return fsp.readFile(target);
              },
            });
          } catch (error) {
            deltaJournal = { created: false, error: error.message };
          }
        }

        const existing = await this.listBackups();
        const entry = {
          file: path.basename(archivePath),
          size: archiveStat.size,
          createdAt,
          projectHash: snapshot.projectHash,
          archiveSha256,
          plaintextArchiveSha256,
          encrypted: this.encryptionEnabled,
          encryptionFormat: this.encryptionEnabled ? "UPMENC1" : null,
          encryptionCipher: this.encryptionEnabled ? "aes-256-gcm" : null,
          fileCount: snapshot.entries.length,
          sourceBytes: snapshot.totalBytes,
          forced: force,
          changes: snapshotChanges,
          sourceDriftedDuringSnapshot,
          verificationStatus: "verified",
          deltaJournal: deltaJournal?.created
            ? {
                id: deltaJournal.record?.id || null,
                created: true,
                retained: deltaJournal.retained !== false,
              }
            : deltaJournal || null,
          verifiedAt: createdAt,
          verificationMessage: sourceDriftedDuringSnapshot
            ? "Archive matched the stable snapshot. One or more live source files changed while the snapshot was being prepared; the archived copy is the recorded baseline."
            : "Archive contents matched the stable snapshot at creation.",
        };
        const merged = [
          entry,
          ...existing
            .filter((item) => item.file !== entry.file)
            .map(({ path: _path, ...item }) => item),
        ];
        await this._writeIndex(merged);
        archiveRegistered = true;

        await this._writeState({
          version: 5,
          projectName: this.projectName,
          projectRoot: this.projectRoot,
          projectHash: snapshot.projectHash,
          backupFile: path.basename(archivePath),
          backupCreatedAt: createdAt,
          encrypted: this.encryptionEnabled,
          files: snapshot.files,
        });

        const retention = await this.prune();

        return {
          created: true,
          skipped: false,
          archivePath,
          archiveSize: archiveStat.size,
          archiveSha256,
          plaintextArchiveSha256,
          encrypted: this.encryptionEnabled,
          encryptionFormat: this.encryptionEnabled ? "UPMENC1" : null,
          projectHash: snapshot.projectHash,
          fileCount: snapshot.entries.length,
          sourceBytes: snapshot.totalBytes,
          changes: snapshotChanges,
          sourceDriftedDuringSnapshot,
          firstBackup: !previous,
          recoveredMissingBaseline: baselineArchiveMissing,
          verified: true,
          deltaJournal,
          removed: retention.removed,
          retention,
        };
      } catch (error) {
        if (!archiveRegistered) await fsp.unlink(archivePath).catch(() => {});
        if (plainArchivePath && path.resolve(plainArchivePath) !== path.resolve(archivePath)) {
          await fsp.rm(plainArchivePath, { force: true }).catch(() => {});
        }
        throw error;
      } finally {
        if (plainArchivePath && path.resolve(plainArchivePath) !== path.resolve(archivePath)) {
          await fsp.rm(plainArchivePath, { force: true }).catch(() => {});
        }
        if (stagingRoot) {
          await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
        }
      }
    } finally {
      this._running = false;
    }
  }

  async mirrorVerifiedBackup(sourceArchivePath, sourceMetadata = {}) {
    await this.ensureReady();
    const sourcePath = path.resolve(sourceArchivePath);
    const fileName = path.basename(sourcePath);
    if (!fileName.endsWith(".tar.gz") && !fileName.endsWith(".tar.gz.upmenc"))
      throw new Error("Mirror source must be a supported backup archive.");
    if (!(await exists(sourcePath))) throw new Error("Mirror source backup does not exist.");

    const targetPath = path.join(this.backupDir, fileName);
    if (path.resolve(targetPath) === sourcePath)
      throw new Error("Mirror destination resolves to the source archive.");

    const expectedSha = sourceMetadata.archiveSha256 || (await hashFile(sourcePath));
    const expectedProjectHash = sourceMetadata.projectHash || null;
    const existing = await this.listBackups();
    const existingItem = existing.find((item) => item.file === fileName);
    if (
      existingItem &&
      existingItem.archiveSha256 === expectedSha &&
      existingItem.verificationStatus === "verified"
    ) {
      const onDiskSha = await hashFile(targetPath).catch(() => null);
      if (onDiskSha === expectedSha) {
        return {
          copied: false,
          alreadyPresent: true,
          file: fileName,
          archivePath: targetPath,
          archiveSha256: expectedSha,
          valid: true,
        };
      }
    }

    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.mirror.tmp`;
    try {
      await fsp.copyFile(sourcePath, tempPath);
      const copiedSha = await hashFile(tempPath);
      const inspected = await this._inspectStoredArchive(tempPath, {
        encrypted: sourceMetadata.encrypted === true || fileName.endsWith(".upmenc"),
      });
      const snapshot = inspected.snapshot;
      const plaintextArchiveSha256 = inspected.plaintextArchiveSha256;
      if (copiedSha !== expectedSha)
        throw new Error("Secondary backup copy failed SHA-256 verification.");
      if (expectedProjectHash && snapshot.projectHash !== expectedProjectHash) {
        throw new Error("Secondary backup copy failed content-hash verification.");
      }

      await replaceArchiveFromTemp(tempPath, targetPath);

      const stat = await fsp.stat(targetPath);
      const now = new Date().toISOString();
      const entry = {
        file: fileName,
        size: stat.size,
        createdAt: sourceMetadata.createdAt || now,
        projectHash: expectedProjectHash || snapshot.projectHash,
        archiveSha256: copiedSha,
        plaintextArchiveSha256: sourceMetadata.plaintextArchiveSha256 || plaintextArchiveSha256,
        encrypted: sourceMetadata.encrypted === true || fileName.endsWith(".upmenc"),
        encryptionFormat:
          sourceMetadata.encryptionFormat || (fileName.endsWith(".upmenc") ? "UPMENC1" : null),
        encryptionCipher:
          sourceMetadata.encryptionCipher || (fileName.endsWith(".upmenc") ? "aes-256-gcm" : null),
        fileCount: sourceMetadata.fileCount ?? snapshot.fileCount,
        sourceBytes: sourceMetadata.sourceBytes ?? snapshot.totalBytes,
        forced: sourceMetadata.forced === true,
        changes: sourceMetadata.changes || null,
        sourceDriftedDuringSnapshot: sourceMetadata.sourceDriftedDuringSnapshot === true,
        verificationStatus: "verified",
        verifiedAt: now,
        verificationMessage:
          "Archive was copied from the primary destination and passed content and SHA-256 verification.",
        mirroredFrom: sourcePath,
        mirroredAt: now,
      };
      const merged = [
        entry,
        ...existing
          .filter((item) => item.file !== fileName)
          .map(({ path: _path, ...item }) => item),
      ];
      await this._writeIndex(merged);
      await writeJsonAtomic(this.stateFile, {
        version: 5,
        projectName: this.projectName,
        projectRoot: this.projectRoot,
        projectHash: entry.projectHash,
        backupFile: fileName,
        backupCreatedAt: entry.createdAt,
        encrypted: entry.encrypted === true,
        files: snapshot.files,
      });
      const retention = await this.prune();
      return {
        copied: true,
        alreadyPresent: false,
        file: fileName,
        archivePath: targetPath,
        archiveSha256: copiedSha,
        projectHash: entry.projectHash,
        valid: true,
        removed: retention.removed,
        retention,
      };
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async verifyBackup(fileName) {
    const fullPath = await this.resolveBackup(fileName);
    const backups = await this.listBackups();
    const metadata = backups.find((item) => item.file === fileName) || {};
    const verifiedAt = new Date().toISOString();

    try {
      const archiveSha256 = await hashFile(fullPath);
      const inspected = await this._inspectStoredArchive(fullPath, metadata);
      const snapshot = inspected.snapshot;
      const plaintextArchiveSha256 = inspected.plaintextArchiveSha256;

      const contentHashMatch = metadata.projectHash
        ? snapshot.projectHash === metadata.projectHash
        : null;
      const archiveHashMatch = metadata.archiveSha256
        ? archiveSha256 === metadata.archiveSha256
        : null;
      const plaintextHashMatch = metadata.plaintextArchiveSha256
        ? plaintextArchiveSha256 === metadata.plaintextArchiveSha256
        : null;
      const valid =
        contentHashMatch !== false && archiveHashMatch !== false && plaintextHashMatch !== false;
      const baselineCreated = !metadata.archiveSha256;
      const message = !valid
        ? "Integrity verification failed."
        : baselineCreated
          ? "Archive is structurally valid; a SHA-256 archive baseline was recorded."
          : "Archive passed structural, content, and SHA-256 verification.";

      await this._updateIndexEntry(fileName, {
        archiveSha256: metadata.archiveSha256 || archiveSha256,
        plaintextArchiveSha256: metadata.plaintextArchiveSha256 || plaintextArchiveSha256,
        encrypted: inspected.encrypted,
        verificationStatus: valid ? "verified" : "failed",
        verifiedAt,
        verificationMessage: message,
      });

      return {
        file: fileName,
        valid,
        verifiedAt,
        verificationStatus: valid ? "verified" : "failed",
        message,
        archiveSha256,
        expectedArchiveSha256: metadata.archiveSha256 || null,
        archiveHashMatch,
        plaintextArchiveSha256,
        expectedPlaintextArchiveSha256: metadata.plaintextArchiveSha256 || null,
        plaintextHashMatch,
        encrypted: inspected.encrypted,
        projectHash: snapshot.projectHash,
        expectedProjectHash: metadata.projectHash || null,
        contentHashMatch,
        fileCount: snapshot.fileCount,
        sourceBytes: snapshot.totalBytes,
        baselineCreated,
      };
    } catch (error) {
      await this._updateIndexEntry(fileName, {
        verificationStatus: "failed",
        verifiedAt,
        verificationMessage: error.message,
      }).catch(() => {});
      return {
        file: fileName,
        valid: false,
        verifiedAt,
        verificationStatus: "failed",
        message: error.message,
      };
    }
  }

  async verifyAllBackups() {
    const backups = await this.listBackups();
    const results = [];
    for (const backup of backups) {
      results.push(await this.verifyBackup(backup.file));
    }
    return results;
  }

  async readBackupEntry(fileName, relativePath, options = {}) {
    const fullPath = await this.resolveBackup(fileName);
    const metadata = (await this.listBackups()).find((item) => item.file === fileName) || {};
    const readable = await this._prepareReadableArchive(fullPath, metadata);
    const normalized = toPosix(String(relativePath || "").trim()).replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
      throw new Error("A valid relative backup path is required.");
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Invalid backup entry path.");
    }

    const maxCeiling = options.returnBuffer === true ? 32 * 1024 * 1024 : 5 * 1024 * 1024;
    const maxBytes = Math.max(1024, Math.min(maxCeiling, Number(options.maxBytes) || 512 * 1024));
    let found = false;
    let entryType = null;
    let declaredSize = null;
    let bytesRead = 0;
    let tooLarge = false;
    const chunks = [];

    try {
      await tar.list({
        file: readable.path,
        strict: true,
        onentry(entry) {
          const entryPath = String(entry.path || "")
            .replace(/\\/g, "/")
            .replace(/^\.\//, "");
          if (entryPath !== normalized) {
            entry.resume();
            return;
          }

          found = true;
          entryType = entry.type || null;
          declaredSize = Number(entry.size || 0);
          if (!["File", "OldFile"].includes(entryType)) {
            entry.resume();
            return;
          }
          if (declaredSize > maxBytes) tooLarge = true;

          entry.on("data", (chunk) => {
            bytesRead += chunk.length;
            if (bytesRead > maxBytes) {
              tooLarge = true;
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
        },
      });
    } finally {
      await readable.cleanup();
    }

    if (!found) return { found: false, relativePath: normalized };
    if (!["File", "OldFile"].includes(entryType)) {
      return {
        found: true,
        relativePath: normalized,
        type: entryType,
        text: null,
        binary: false,
        tooLarge: false,
        size: declaredSize,
      };
    }
    if (tooLarge) {
      return {
        found: true,
        relativePath: normalized,
        type: entryType,
        text: null,
        binary: false,
        tooLarge: true,
        size: declaredSize ?? bytesRead,
      };
    }

    const buffer = Buffer.concat(chunks);
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    const binary = sample.includes(0);
    return {
      found: true,
      relativePath: normalized,
      type: entryType,
      size: buffer.length,
      tooLarge: false,
      binary,
      text: binary ? null : buffer.toString("utf8"),
      ...(options.returnBuffer === true ? { buffer } : {}),
    };
  }

  async restoreBackup(fileName, destination, options = {}) {
    if (!destination) throw new Error("Restore destination is required.");
    const fullPath = await this.resolveBackup(fileName);
    const metadata = (await this.listBackups()).find((item) => item.file === fileName) || {};
    const target = path.resolve(destination);
    if (relativeIfInside(this.projectRoot, target) !== null) {
      throw new Error(
        "Refusing to restore into the registered project tree. Choose a separate restore folder.",
      );
    }
    if (relativeIfInside(this.backupDir, target) !== null) {
      throw new Error(
        "Refusing to restore into the project backup directory. Choose a separate restore folder.",
      );
    }

    const verification = await this.verifyBackup(fileName);
    if (!verification.valid) {
      throw new Error(`Backup failed integrity verification: ${verification.message}`);
    }

    const overwrite = options.overwrite === true;
    if (!overwrite && (await directoryHasEntries(target))) {
      throw new Error(
        "Restore destination is not empty. Choose an empty folder or enable overwrite.",
      );
    }

    await fsp.mkdir(target, { recursive: true });
    const readable = await this._prepareReadableArchive(fullPath, metadata);
    try {
      await tar.extract({
        file: readable.path,
        cwd: target,
        strict: true,
        preservePaths: false,
      });
    } finally {
      await readable.cleanup();
    }

    return {
      restored: true,
      file: fileName,
      destination: target,
      fileCount: verification.fileCount,
      sourceBytes: verification.sourceBytes,
      verifiedAt: verification.verifiedAt,
    };
  }

  async getStorageStats() {
    const backups = await this.listBackups();
    const totalBytes = backups.reduce((sum, item) => sum + Number(item.size || 0), 0);
    const sourceBytes = backups.reduce((sum, item) => sum + Number(item.sourceBytes || 0), 0);
    const verified = backups.filter((item) => item.verificationStatus === "verified").length;
    const failed = backups.filter((item) => item.verificationStatus === "failed").length;
    const newest = backups[0] || null;
    const oldest = backups[backups.length - 1] || null;

    return {
      backupCount: backups.length,
      totalBytes,
      averageBytes: backups.length ? Math.round(totalBytes / backups.length) : 0,
      totalSourceBytes: sourceBytes,
      overallCompressionRatio: sourceBytes > 0 ? totalBytes / sourceBytes : null,
      latestCompressionRatio: newest?.sourceBytes > 0 ? newest.size / newest.sourceBytes : null,
      verifiedCount: verified,
      failedVerificationCount: failed,
      unverifiedCount: Math.max(0, backups.length - verified - failed),
      newestAt: newest?.createdAt || null,
      oldestAt: oldest?.createdAt || null,
    };
  }

  async deleteBackup(fileName) {
    if (!(await this._isManagedBackupName(fileName))) throw new Error("Invalid backup filename.");
    const target = path.join(this.backupDir, fileName);
    const relative = path.relative(this.backupDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Invalid backup path.");

    const state = await readJson(this.stateFile, null, {
      recover: true,
      validator: (value) => Boolean(value && typeof value === "object"),
    });

    await unlinkWithRetry(target);
    const backups = (await this.listBackups()).filter((item) => item.file !== fileName);
    await this._writeIndex(backups.map(({ path: _path, ...item }) => item));

    if (state?.backupFile === fileName) {
      await this._writeState({
        version: 5,
        projectName: this.projectName,
        projectRoot: this.projectRoot,
        projectHash: null,
        backupFile: null,
        backupCreatedAt: null,
        encrypted: this.encryptionEnabled,
        files: {},
        baselineClearedAt: new Date().toISOString(),
      });
    }
    return true;
  }

  async _isManagedBackupName(fileName) {
    if (
      !fileName ||
      path.basename(fileName) !== fileName ||
      (!fileName.endsWith(".tar.gz") && !fileName.endsWith(".tar.gz.upmenc"))
    )
      return false;
    if (isBackupName(fileName, this.projectName)) return true;
    const index = await this._readIndex();
    return (index?.backups || []).some((item) => item.file === fileName);
  }

  async resolveBackup(fileName) {
    if (!(await this._isManagedBackupName(fileName))) throw new Error("Invalid backup filename.");
    const fullPath = path.join(this.backupDir, fileName);
    if (!(await exists(fullPath))) throw new Error("Backup not found.");
    return fullPath;
  }
}

module.exports = {
  ProjectBackup,
  assertSafeArchivePath,
  buildIgnoreMatcher,
  createStableSnapshot,
  defaultBackupFolderName,
  diffFiles,
  inspectArchive,
  projectHashFromFiles,
  requireSafePathComponent,
  safeName,
  scanProject,
};
