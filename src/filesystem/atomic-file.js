"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 100;
const RETRYABLE_CODES = new Set(["EBUSY", "EACCES", "EPERM", "EMFILE", "ENFILE", "ETXTBSY"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFileError(error) {
  return Boolean(error?.code && RETRYABLE_CODES.has(error.code));
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function retryFileOperation(operation, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? DEFAULT_RETRIES));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableFileError(error) || attempt >= retries) break;
      await delay(Math.min(1_000, retryDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

async function syncFile(target) {
  let handle = null;
  try {
    handle = await fsp.open(target, "r+");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function validateCandidate(target, validateFile) {
  if (typeof validateFile !== "function") return true;
  await validateFile(target);
  return true;
}

async function copyValidated(source, destination, options = {}) {
  await retryFileOperation(() => fsp.copyFile(source, destination), options);
  if (options.mode != null) await fsp.chmod(destination, options.mode).catch(() => {});
  await syncFile(destination).catch(() => {});
  await validateCandidate(destination, options.validateFile);
}

function tempPrefix(file) {
  const base = path.basename(file);
  return base.startsWith(".") ? base : `.${base}`;
}

function uniqueTempPath(file, label = "tmp") {
  return path.join(
    path.dirname(file),
    `${tempPrefix(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.${label}`,
  );
}

async function cleanupStaleTemps(file, options = {}) {
  const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs || 24 * 60 * 60 * 1000));
  const dir = path.dirname(file);
  const prefix = `${tempPrefix(file)}.`;
  const now = Date.now();
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const stat = await fsp.stat(fullPath).catch(() => null);
        if (stat && now - stat.mtimeMs >= maxAgeMs) {
          await fsp.rm(fullPath, { force: true }).catch(() => {});
        }
      }),
  );
}

/**
 * Safely replace a persistent file while keeping the old file in place until
 * a validated replacement is ready. On Windows, where rename-over-existing can
 * fail with EPERM/EACCES, a validated copy fallback is used rather than deleting
 * the live file first.
 */
async function atomicWriteFile(file, data, options = {}) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  const mode = options.mode;
  const validateFile = options.validateFile;
  const backup = options.backup === true;
  const backupPath = path.resolve(options.backupPath || `${target}.bak`);
  const temp = uniqueTempPath(target, "tmp");
  let committed = false;
  let backupValid = false;

  await fsp.mkdir(dir, { recursive: true });

  try {
    const handle = await fsp.open(temp, "wx", mode == null ? undefined : mode);
    try {
      if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
        await handle.writeFile(data);
      } else {
        await handle.writeFile(String(data), options.encoding || "utf8");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode != null) await fsp.chmod(temp, mode).catch(() => {});
    await validateCandidate(temp, validateFile);

    const destinationExists = await pathExists(target);
    if (backup && destinationExists) {
      try {
        await validateCandidate(target, validateFile);
        const backupTemp = uniqueTempPath(backupPath, "bak.tmp");
        try {
          await copyValidated(target, backupTemp, { ...options, mode, validateFile });
          try {
            await retryFileOperation(() => fsp.rename(backupTemp, backupPath), options);
          } catch (renameError) {
            if (!isRetryableFileError(renameError)) throw renameError;
            await copyValidated(backupTemp, backupPath, {
              ...options,
              mode,
              validateFile,
            });
          }
          backupValid = true;
        } finally {
          await fsp.rm(backupTemp, { force: true }).catch(() => {});
        }
      } catch (error) {
        if (options.requireBackup === true) throw error;
      }
    } else if (backup && (await pathExists(backupPath))) {
      try {
        await validateCandidate(backupPath, validateFile);
        backupValid = true;
      } catch {}
    }

    try {
      await retryFileOperation(() => fsp.rename(temp, target), options);
      committed = true;
    } catch (renameError) {
      if (!isRetryableFileError(renameError)) throw renameError;
      if (options.allowCopyFallback === false) throw renameError;
      // Never fall back to copy-over on a live persistent file unless its
      // previous contents were secured first. A failed copy can truncate the
      // destination on Windows/network filesystems just as easily as unlinking it.
      if (backup && destinationExists && !backupValid) throw renameError;
      try {
        await copyValidated(temp, target, { ...options, mode, validateFile });
        committed = true;
      } catch (copyError) {
        if (backupValid) {
          await copyValidated(backupPath, target, {
            ...options,
            mode,
            validateFile,
          }).catch(() => {});
        }
        copyError.cause ||= renameError;
        throw copyError;
      }
    }

    await validateCandidate(target, validateFile);
    if (mode != null) await fsp.chmod(target, mode).catch(() => {});
    await cleanupStaleTemps(target).catch(() => {});
    return { file: target, backupPath: backup ? backupPath : null, usedBackup: backupValid };
  } catch (error) {
    if (!committed && (await pathExists(temp))) error.recoveryTempPath ||= temp;
    throw error;
  } finally {
    if (committed) await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function readJsonFile(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

function jsonShapeError(file) {
  const error = new Error(`Invalid JSON metadata shape in ${path.basename(file)}.`);
  error.code = "EINVALIDJSONSHAPE";
  return error;
}

async function parseJsonCandidate(file, validator) {
  const value = await readJsonFile(file);
  if (typeof validator === "function" && validator(value) !== true) {
    throw jsonShapeError(file);
  }
  return value;
}

async function jsonRecoveryCandidates(file, options = {}) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  const backupPath = path.resolve(options.backupPath || `${target}.bak`);
  const tempBase = tempPrefix(target);
  const backupTempPrefix = `${tempPrefix(backupPath)}.`;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const candidates = new Set();
  if (await pathExists(backupPath)) candidates.add(backupPath);
  for (const name of names) {
    if (!name.startsWith(`${tempBase}.`) || !name.endsWith(".tmp")) continue;
    if (name.startsWith(backupTempPrefix)) continue;
    candidates.add(path.join(dir, name));
  }

  const dated = await Promise.all(
    [...candidates].map(async (candidate) => ({
      candidate,
      mtimeMs: await fsp.stat(candidate).then(
        (stat) => stat.mtimeMs,
        () => 0,
      ),
    })),
  );
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dated.map((item) => item.candidate);
}

async function readJsonRecoverable(file, fallback = null, options = {}) {
  const target = path.resolve(file);
  try {
    return await parseJsonCandidate(target, options.validator);
  } catch (error) {
    const recoverable =
      error.code === "ENOENT" || error.code === "EINVALIDJSONSHAPE" || error instanceof SyntaxError;
    if (!recoverable) throw error;
    if (options.recover !== true) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }

    for (const candidate of await jsonRecoveryCandidates(target, options)) {
      try {
        return await parseJsonCandidate(candidate, options.validator);
      } catch (candidateError) {
        const candidateRecoverable =
          candidateError.code === "ENOENT" ||
          candidateError.code === "EINVALIDJSONSHAPE" ||
          candidateError instanceof SyntaxError;
        if (!candidateRecoverable) throw candidateError;
      }
    }
    if (error.code !== "ENOENT" && options.throwOnMalformedUnrecovered === true) {
      throw error;
    }
    return fallback;
  }
}

async function atomicWriteJson(file, value, options = {}) {
  const serialized = `${JSON.stringify(value, null, options.space ?? 2)}\n`;
  const validator = options.validator;
  return atomicWriteFile(file, serialized, {
    ...options,
    encoding: "utf8",
    validateFile: async (candidate) => {
      const parsed = await readJsonFile(candidate);
      if (typeof validator === "function" && validator(parsed) !== true) throw jsonShapeError(file);
    },
  });
}

module.exports = {
  RETRYABLE_CODES,
  atomicWriteFile,
  atomicWriteJson,
  cleanupStaleTemps,
  isRetryableFileError,
  pathExists,
  readJsonFile,
  readJsonRecoverable,
  retryFileOperation,
};
