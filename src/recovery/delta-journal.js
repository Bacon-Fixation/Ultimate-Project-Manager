"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { encryptFile, decryptFile } = require("../security/backup-crypto");
const {
  atomicWriteFile,
  atomicWriteJson,
  readJsonRecoverable,
} = require("../filesystem/atomic-file");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FORMAT = "UPMDELTA1";
const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TRANSITION_BYTES = 64 * 1024 * 1024;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(file, buffer) {
  await atomicWriteFile(file, buffer, { backup: false });
}

function safeId(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function commonPrefixLength(before, after) {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) index += 1;
  return index;
}

function commonSuffixLength(before, after, prefixLength) {
  const limit = Math.min(before.length, after.length) - prefixLength;
  let count = 0;
  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count])
    count += 1;
  return count;
}

function encodeFileSide(meta, buffer) {
  if (!meta) return null;
  return {
    type: meta.type || "file",
    hash: meta.hash || (Buffer.isBuffer(buffer) ? sha256Buffer(buffer) : null),
    size: Number(meta.size || (Buffer.isBuffer(buffer) ? buffer.length : 0)),
    target: meta.target || null,
  };
}

function makePatch(beforeMeta, afterMeta, beforeBuffer, afterBuffer, options = {}) {
  const maxFileBytes = clampInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    1024,
    256 * 1024 * 1024,
  );
  const before = encodeFileSide(beforeMeta, beforeBuffer);
  const after = encodeFileSide(afterMeta, afterBuffer);
  const status = !before ? "added" : !after ? "deleted" : "modified";

  if ((before && before.type !== "file") || (after && after.type !== "file")) {
    return {
      status,
      before,
      after,
      payload: {
        kind: "metadata-only",
        reason: "non-regular-file",
      },
      payloadBytes: 0,
      reconstructable: false,
    };
  }

  if ((before && before.size > maxFileBytes) || (after && after.size > maxFileBytes)) {
    return {
      status,
      before,
      after,
      payload: {
        kind: "metadata-only",
        reason: "file-size-limit",
        maxFileBytes,
      },
      payloadBytes: 0,
      reconstructable: false,
    };
  }

  if (before && !Buffer.isBuffer(beforeBuffer)) {
    return {
      status,
      before,
      after,
      payload: { kind: "metadata-only", reason: "before-bytes-unavailable" },
      payloadBytes: 0,
      reconstructable: false,
    };
  }
  if (after && !Buffer.isBuffer(afterBuffer)) {
    return {
      status,
      before,
      after,
      payload: { kind: "metadata-only", reason: "after-bytes-unavailable" },
      payloadBytes: 0,
      reconstructable: false,
    };
  }

  const beforeBytes = beforeBuffer || Buffer.alloc(0);
  const afterBytes = afterBuffer || Buffer.alloc(0);
  const prefixBytes = before && after ? commonPrefixLength(beforeBytes, afterBytes) : 0;
  const suffixBytes =
    before && after ? commonSuffixLength(beforeBytes, afterBytes, prefixBytes) : 0;
  const beforeMiddleEnd = beforeBytes.length - suffixBytes;
  const afterMiddleEnd = afterBytes.length - suffixBytes;
  const beforeMiddle = beforeBytes.subarray(prefixBytes, Math.max(prefixBytes, beforeMiddleEnd));
  const afterMiddle = afterBytes.subarray(prefixBytes, Math.max(prefixBytes, afterMiddleEnd));

  return {
    status,
    before,
    after,
    payload: {
      kind: "binary-middle-v1",
      prefixBytes,
      suffixBytes,
      beforeMiddle: beforeMiddle.toString("base64"),
      afterMiddle: afterMiddle.toString("base64"),
    },
    payloadBytes: beforeMiddle.length + afterMiddle.length,
    reconstructable: true,
  };
}

function assertHash(side, buffer, label) {
  if (!side) {
    if (buffer !== null) throw new Error(`Delta ${label} expected the file to be absent.`);
    return;
  }
  if (!Buffer.isBuffer(buffer)) throw new Error(`Delta ${label} requires file bytes.`);
  if (buffer.length !== Number(side.size || 0))
    throw new Error(`Delta ${label} size verification failed.`);
  if (side.hash && sha256Buffer(buffer) !== side.hash)
    throw new Error(`Delta ${label} SHA-256 verification failed.`);
}

function applyPatch(patch, input, direction = "reverse") {
  if (!patch?.reconstructable || patch.payload?.kind !== "binary-middle-v1") {
    throw new Error(
      `Delta patch is not reconstructable (${patch?.payload?.reason || "payload unavailable"}).`,
    );
  }

  const reverse = direction !== "forward";
  const sourceSide = reverse ? patch.after : patch.before;
  const targetSide = reverse ? patch.before : patch.after;
  assertHash(sourceSide, input, reverse ? "after side" : "before side");

  if (!targetSide) return null;
  const source = input || Buffer.alloc(0);
  const prefixBytes = Number(patch.payload.prefixBytes || 0);
  const suffixBytes = Number(patch.payload.suffixBytes || 0);
  if (prefixBytes < 0 || suffixBytes < 0 || prefixBytes + suffixBytes > source.length) {
    throw new Error("Delta patch prefix/suffix bounds are invalid.");
  }

  const middle = Buffer.from(
    reverse ? patch.payload.beforeMiddle || "" : patch.payload.afterMiddle || "",
    "base64",
  );
  const prefix = source.subarray(0, prefixBytes);
  const suffix = suffixBytes ? source.subarray(source.length - suffixBytes) : Buffer.alloc(0);
  const output = Buffer.concat([prefix, middle, suffix]);
  assertHash(
    targetSide,
    output,
    reverse ? "reconstructed before side" : "reconstructed after side",
  );
  return output;
}

function contentForIntegrity(document) {
  const copy = { ...document };
  delete copy.integrity;
  return Buffer.from(JSON.stringify(copy), "utf8");
}

class DeltaJournal {
  constructor(options = {}) {
    if (!options.dir) throw new Error("DeltaJournal requires dir.");
    this.dir = path.resolve(options.dir);
    this.enabled = options.enabled !== false;
    this.retentionDays = clampInteger(options.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650);
    this.maxEntries = clampInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 100000);
    this.maxBytes = clampInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      1024 * 1024,
      100 * 1024 * 1024 * 1024,
    );
    this.maxFileBytes = clampInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      1024,
      256 * 1024 * 1024,
    );
    this.maxTransitionBytes = clampInteger(
      options.maxTransitionBytes,
      DEFAULT_MAX_TRANSITION_BYTES,
      1024 * 1024,
      1024 * 1024 * 1024,
    );
    this.projectId = options.projectId || null;
    this.projectName = options.projectName || null;
    this.encryptionEnabled = options.encryptionEnabled === true;
    this.encryptionKey = String(options.encryptionKey || "");
    this.indexFile = path.join(this.dir, "index.json");
    this.entriesDir = path.join(this.dir, "entries");
  }

  async init() {
    if (!this.enabled) return this;
    await fsp.mkdir(this.entriesDir, { recursive: true });
    if (!(await exists(this.indexFile))) await this._writeIndex({ version: 1, entries: [] });
    return this;
  }

  async _readIndex() {
    return readJsonRecoverable(
      this.indexFile,
      { version: 1, entries: [] },
      {
        recover: true,
        throwOnMalformedUnrecovered: true,
        validator: (value) =>
          Boolean(value && typeof value === "object" && Array.isArray(value.entries)),
      },
    );
  }

  async _writeIndex(index) {
    await atomicWriteJson(this.indexFile, index, {
      backup: true,
      validator: (value) =>
        Boolean(value && typeof value === "object" && Array.isArray(value.entries)),
    });
  }

  async _readEntry(record) {
    const file = path.join(this.entriesDir, path.basename(record.file));
    const stored = await fsp.readFile(file);
    const storedSha256 = sha256Buffer(stored);
    if (record.sha256 && record.sha256 !== storedSha256)
      throw new Error(`Delta journal entry failed stored SHA-256 verification: ${record.file}`);
    let compressed = stored;
    let decryptedTemp = null;
    if (record.encrypted === true || record.file.endsWith(".upmenc")) {
      if (this.encryptionKey.length < 16)
        throw new Error(
          "This delta journal entry is encrypted, but UPM_BACKUP_ENCRYPTION_KEY is unavailable.",
        );
      decryptedTemp = path.join(
        this.dir,
        `.decrypt-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.upmdelta.gz`,
      );
      try {
        await decryptFile(file, decryptedTemp, this.encryptionKey);
        compressed = await fsp.readFile(decryptedTemp);
      } finally {
        await fsp.rm(decryptedTemp, { force: true }).catch(() => {});
      }
    }
    const raw = await gunzip(compressed);
    const document = JSON.parse(raw.toString("utf8"));
    if (document.format !== FORMAT)
      throw new Error(`Unsupported delta journal format: ${document.format || "unknown"}`);
    const expectedContentHash = document.integrity?.contentSha256;
    if (
      expectedContentHash &&
      sha256Buffer(contentForIntegrity(document)) !== expectedContentHash
    ) {
      throw new Error(`Delta journal entry failed content SHA-256 verification: ${record.file}`);
    }
    return document;
  }

  async recordTransition(options = {}) {
    if (!this.enabled) return { created: false, reason: "disabled" };
    if (this.encryptionEnabled && this.encryptionKey.length < 16)
      throw new Error(
        "Delta journal encryption follows backup encryption, but UPM_BACKUP_ENCRYPTION_KEY is unavailable.",
      );
    await this.init();
    const previous = options.previous || null;
    const current = options.current || null;
    const changes = options.changes || { added: [], modified: [], deleted: [] };
    if (
      !previous?.projectHash ||
      !current?.projectHash ||
      previous.projectHash === current.projectHash
    ) {
      return { created: false, reason: "no-transition" };
    }

    const changedPaths = [
      ...(changes.added || []).map((relativePath) => ({
        relativePath,
        status: "added",
      })),
      ...(changes.modified || []).map((relativePath) => ({
        relativePath,
        status: "modified",
      })),
      ...(changes.deleted || []).map((relativePath) => ({
        relativePath,
        status: "deleted",
      })),
    ].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const patches = [];
    let payloadBytes = 0;
    let reconstructableFiles = 0;
    let skippedFiles = 0;

    for (const item of changedPaths) {
      const beforeMeta = previous.files?.[item.relativePath] || null;
      const afterMeta = current.files?.[item.relativePath] || null;
      let beforeBuffer = null;
      let afterBuffer = null;
      let readError = null;

      try {
        if (beforeMeta?.type === "file" && Number(beforeMeta.size || 0) <= this.maxFileBytes)
          beforeBuffer = await options.readBefore?.(item.relativePath, this.maxFileBytes);
        if (afterMeta?.type === "file" && Number(afterMeta.size || 0) <= this.maxFileBytes)
          afterBuffer = await options.readAfter?.(item.relativePath, this.maxFileBytes);
      } catch (error) {
        readError = error;
      }

      let patch = makePatch(beforeMeta, afterMeta, beforeBuffer, afterBuffer, {
        maxFileBytes: this.maxFileBytes,
      });
      if (readError) {
        patch = {
          ...patch,
          reconstructable: false,
          payloadBytes: 0,
          payload: {
            kind: "metadata-only",
            reason: "source-read-failed",
            error: readError.message,
          },
        };
      }

      if (patch.reconstructable && payloadBytes + patch.payloadBytes > this.maxTransitionBytes) {
        patch = {
          ...patch,
          reconstructable: false,
          payloadBytes: 0,
          payload: {
            kind: "metadata-only",
            reason: "transition-payload-limit",
            maxTransitionBytes: this.maxTransitionBytes,
          },
        };
      }

      if (patch.reconstructable) {
        payloadBytes += patch.payloadBytes;
        reconstructableFiles += 1;
      } else {
        skippedFiles += 1;
      }
      patches.push({ path: item.relativePath, ...patch });
    }

    const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const document = {
      format: FORMAT,
      version: 1,
      id,
      createdAt,
      projectId: this.projectId,
      projectName: this.projectName,
      from: {
        projectHash: previous.projectHash,
        backupFile: previous.backupFile || null,
        createdAt: previous.backupCreatedAt || null,
      },
      to: {
        projectHash: current.projectHash,
        backupFile: options.backupFile || null,
        createdAt: options.backupCreatedAt || createdAt,
      },
      changes: {
        added: [...(changes.added || [])],
        modified: [...(changes.modified || [])],
        deleted: [...(changes.deleted || [])],
      },
      summary: {
        changedFiles: patches.length,
        reconstructableFiles,
        skippedFiles,
        uncompressedPatchBytes: payloadBytes,
      },
      patches,
    };
    document.integrity = {
      contentSha256: sha256Buffer(contentForIntegrity(document)),
    };
    const compressed = await gzip(Buffer.from(JSON.stringify(document), "utf8"), { level: 9 });
    const fileName = `${safeId(id)}.upmdelta.gz${this.encryptionEnabled ? ".upmenc" : ""}`;
    const targetPath = path.join(this.entriesDir, fileName);
    if (this.encryptionEnabled) {
      const plainTemp = path.join(
        this.dir,
        `.encrypt-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.upmdelta.gz`,
      );
      try {
        await writeAtomic(plainTemp, compressed);
        await encryptFile(plainTemp, targetPath, this.encryptionKey);
      } finally {
        await fsp.rm(plainTemp, { force: true }).catch(() => {});
      }
    } else {
      await writeAtomic(targetPath, compressed);
    }
    const stored = await fsp.readFile(targetPath);

    const index = await this._readIndex();
    const record = {
      id,
      file: fileName,
      createdAt,
      fromProjectHash: document.from.projectHash,
      toProjectHash: document.to.projectHash,
      fromBackupFile: document.from.backupFile,
      toBackupFile: document.to.backupFile,
      changedFiles: patches.length,
      reconstructableFiles,
      skippedFiles,
      uncompressedPatchBytes: payloadBytes,
      size: stored.length,
      sha256: sha256Buffer(stored),
      encrypted: this.encryptionEnabled,
    };
    index.entries = [record, ...(index.entries || []).filter((item) => item.id !== id)];
    await this._writeIndex(index);
    const pruned = await this.prune();
    return {
      created: true,
      retained: !pruned.removed.includes(id),
      record,
      pruned,
    };
  }

  async list(options = {}) {
    if (!this.enabled) return [];
    await this.init();
    const index = await this._readIndex();
    const limit = clampInteger(options.limit, this.maxEntries, 1, this.maxEntries);
    return (index.entries || []).slice(0, limit);
  }

  async getEntry(id) {
    const index = await this._readIndex();
    const record = (index.entries || []).find((item) => item.id === id);
    if (!record) throw new Error("Delta journal entry not found.");
    return this._readEntry(record);
  }

  async getPathHistory(relativePath, options = {}) {
    if (!this.enabled) return [];
    const limit = clampInteger(options.limit, 200, 1, 2000);
    const records = await this.list({ limit: Math.max(limit, 1) });
    const history = [];
    for (const record of records) {
      let document;
      try {
        document = await this._readEntry(record);
      } catch (error) {
        history.push({
          record,
          path: relativePath,
          corrupt: true,
          error: error.message,
          patch: null,
        });
        continue;
      }
      const patch = document.patches.find((item) => item.path === relativePath);
      if (!patch) continue;
      history.push({
        record,
        document: {
          id: document.id,
          createdAt: document.createdAt,
          from: document.from,
          to: document.to,
        },
        path: relativePath,
        patch,
      });
      if (history.length >= limit) break;
    }
    return history;
  }

  async prune() {
    if (!this.enabled) return { removed: [], remaining: 0, totalBytes: 0 };
    await this.init();
    const index = await this._readIndex();
    const now = Date.now();
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const entries = [...(index.entries || [])].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );
    const keep = [];
    const remove = [];
    let totalBytes = 0;

    for (const entry of entries) {
      const created = new Date(entry.createdAt).getTime();
      const expired = Number.isFinite(created) && created < cutoff;
      const exceedsEntries = keep.length >= this.maxEntries;
      const exceedsBytes = totalBytes + Number(entry.size || 0) > this.maxBytes;
      if (expired || exceedsEntries || exceedsBytes) remove.push(entry);
      else {
        keep.push(entry);
        totalBytes += Number(entry.size || 0);
      }
    }

    for (const entry of remove)
      await fsp
        .rm(path.join(this.entriesDir, path.basename(entry.file)), {
          force: true,
        })
        .catch(() => {});
    if (remove.length) await this._writeIndex({ version: 1, entries: keep });
    return {
      removed: remove.map((item) => item.id),
      remaining: keep.length,
      totalBytes,
    };
  }

  async stats() {
    if (!this.enabled) {
      return {
        enabled: false,
        entryCount: 0,
        totalBytes: 0,
        reconstructableFiles: 0,
        skippedFiles: 0,
        newestAt: null,
        oldestAt: null,
        retentionDays: this.retentionDays,
        maxEntries: this.maxEntries,
        maxBytes: this.maxBytes,
        maxFileBytes: this.maxFileBytes,
        encryptionEnabled: this.encryptionEnabled,
      };
    }
    const entries = await this.list({ limit: this.maxEntries });
    return {
      enabled: true,
      entryCount: entries.length,
      totalBytes: entries.reduce((sum, item) => sum + Number(item.size || 0), 0),
      reconstructableFiles: entries.reduce(
        (sum, item) => sum + Number(item.reconstructableFiles || 0),
        0,
      ),
      skippedFiles: entries.reduce((sum, item) => sum + Number(item.skippedFiles || 0), 0),
      newestAt: entries[0]?.createdAt || null,
      oldestAt: entries[entries.length - 1]?.createdAt || null,
      retentionDays: this.retentionDays,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      maxFileBytes: this.maxFileBytes,
      encryptionEnabled: this.encryptionEnabled,
    };
  }
}

module.exports = {
  DeltaJournal,
  FORMAT,
  makePatch,
  applyPatch,
  sha256Buffer,
};
