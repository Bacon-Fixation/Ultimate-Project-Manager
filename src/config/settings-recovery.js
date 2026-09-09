"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { atomicWriteFile } = require("../filesystem/atomic-file");

const LAST_KNOWN_GOOD_SUFFIX = ".last-known-good";
const PENDING_SETTINGS_SUFFIX = ".pending-settings.json";

function recoveryPaths(envPath) {
  const target = path.resolve(envPath);
  return {
    envPath: target,
    lastKnownGoodPath: `${target}${LAST_KNOWN_GOOD_SUFFIX}`,
    pendingPath: `${target}${PENDING_SETTINGS_SUFFIX}`,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readOptional(file, encoding = "utf8") {
  try {
    return await fsp.readFile(file, encoding);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureLastKnownGoodEnv(envPath) {
  const paths = recoveryPaths(envPath);
  const existing = await readOptional(paths.lastKnownGoodPath);
  if (existing !== null) {
    return { created: false, ...paths };
  }

  const current = await readOptional(paths.envPath);
  if (current === null) return { created: false, ...paths };
  await atomicWriteFile(paths.lastKnownGoodPath, current, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { created: true, ...paths };
}

async function markSettingsPending(envPath, metadata = {}) {
  const paths = recoveryPaths(envPath);
  const current = await fsp.readFile(paths.envPath);
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    envSha256: sha256(current),
    changed: Array.isArray(metadata.changed) ? [...new Set(metadata.changed.map(String))] : [],
  };
  await atomicWriteFile(paths.pendingPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { pending: true, ...paths, ...payload };
}

async function markLastKnownGoodEnv(envPath) {
  const paths = recoveryPaths(envPath);
  const current = await readOptional(paths.envPath);
  if (current === null) {
    await fsp.rm(paths.pendingPath, { force: true }).catch(() => {});
    return { marked: false, reason: "env-missing", ...paths };
  }
  await atomicWriteFile(paths.lastKnownGoodPath, current, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsp.rm(paths.pendingPath, { force: true }).catch(() => {});
  return { marked: true, envSha256: sha256(current), ...paths };
}

async function pendingSettingsState(envPath) {
  const paths = recoveryPaths(envPath);
  const raw = await readOptional(paths.pendingPath);
  if (raw === null) return { pending: false, ...paths };
  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    return { pending: false, invalidMarker: true, ...paths };
  }
  const current = await readOptional(paths.envPath, null);
  return {
    pending: true,
    markerMatchesCurrent: current !== null && pending.envSha256 === sha256(current),
    changed: Array.isArray(pending.changed) ? pending.changed.map(String) : [],
    savedAt: pending.savedAt || null,
    ...paths,
  };
}

function failedSettingsPath(envPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path.resolve(envPath)}.failed-settings-${stamp}`;
}

async function recoverLastKnownGoodEnv(envPath, options = {}) {
  const paths = recoveryPaths(envPath);
  const pending = await pendingSettingsState(envPath);
  if (!pending.pending || !pending.markerMatchesCurrent) {
    return {
      recovered: false,
      reason: pending.invalidMarker ? "invalid-pending-marker" : "no-matching-pending-settings",
      ...paths,
    };
  }

  const lastKnownGood = await readOptional(paths.lastKnownGoodPath, null);
  if (lastKnownGood === null) {
    return { recovered: false, reason: "last-known-good-missing", ...paths };
  }

  const current = await readOptional(paths.envPath, null);
  if (current !== null && sha256(current) === sha256(lastKnownGood)) {
    await fsp.rm(paths.pendingPath, { force: true }).catch(() => {});
    return { recovered: false, reason: "already-last-known-good", ...paths };
  }

  const failedPath = failedSettingsPath(paths.envPath);
  await atomicWriteFile(paths.envPath, lastKnownGood, {
    mode: 0o600,
    backup: current !== null,
    backupPath: failedPath,
    requireBackup: current !== null,
  });
  await fsp.rm(paths.pendingPath, { force: true }).catch(() => {});

  return {
    recovered: true,
    reason: String(options.reason || "startup-failure"),
    failedSettingsPath: current !== null ? failedPath : null,
    changed: pending.changed,
    savedAt: pending.savedAt,
    ...paths,
  };
}

module.exports = {
  LAST_KNOWN_GOOD_SUFFIX,
  PENDING_SETTINGS_SUFFIX,
  recoveryPaths,
  ensureLastKnownGoodEnv,
  markSettingsPending,
  markLastKnownGoodEnv,
  pendingSettingsState,
  recoverLastKnownGoodEnv,
};
