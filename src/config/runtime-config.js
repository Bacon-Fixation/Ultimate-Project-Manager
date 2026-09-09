"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { parseAgentList } = require("../remote-agent/remote-agent-client");
const { isUsableSessionSecret } = require("../security/session-secret");

const RUNTIME_ENV_KEYS = Object.freeze([
  "UPM_HOST",
  "UPM_PORT",
  "UPM_BACKUP_ROOT",
  "UPM_RESTORE_ROOT",
  "UPM_ALLOW_REMOTE_DASHBOARD",
  "UPM_ALLOW_REMOTE_ADMIN",
  "UPM_ALLOW_REMOTE_FILESYSTEM",
  "UPM_TRUST_PROXY",
  "UPM_SECURITY_HEADERS",
  "UPM_CSP",
  "UPM_JSON_LIMIT",
  "UPM_RATE_LIMIT_WINDOW_MS",
  "UPM_RATE_LIMIT_MAX",
  "UPM_WRITE_RATE_LIMIT_MAX",
  "UPM_REQUEST_TIMEOUT_MS",
  "UPM_HEADERS_TIMEOUT_MS",
  "UPM_KEEP_ALIVE_TIMEOUT_MS",
  "UPM_AUTH_ENABLED",
  "UPM_AUTH_USERNAME",
  "UPM_AUTH_PASSWORD_HASH",
  "UPM_SESSION_SECRET",
  "UPM_AUTH_SESSION_HOURS",
  "UPM_AUTH_COOKIE_SECURE",
  "UPM_AUTH_MAX_ATTEMPTS",
  "UPM_AUTH_LOCKOUT_MINUTES",
  "UPM_BACKUP_ENCRYPTION_KEY",
  "UPM_EDITOR",
  "UPM_EDITOR_COMMAND",
  "UPM_LAN_AGENTS_JSON",
  "UPM_LAN_ALLOW_INSECURE_HTTP",
]);

const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 4310,
  allowRemoteDashboard: false,
  allowRemoteAdmin: false,
  allowRemoteFilesystem: false,
  trustProxy: false,
  jsonLimit: "2mb",
  securityHeaders: true,
  contentSecurityPolicy: true,
  apiRateLimitWindowMs: 60_000,
  apiRateLimitMax: 300,
  writeRateLimitMax: 60,
  requestTimeoutMs: 120_000,
  headersTimeoutMs: 65_000,
  keepAliveTimeoutMs: 5_000,
  authEnabled: false,
  authUsername: "admin",
  authPasswordHash: "",
  sessionSecret: "",
  authSessionHours: 12,
  authCookieSecure: false,
  authMaxAttempts: 5,
  authLockoutMinutes: 15,
  editor: "vscode",
  editorCommand: "",
  lanAllowInsecureHttp: false,
});

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(
  value,
  fallback,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function unescapeDoubleQuotedEnv(body) {
  let output = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\" || index + 1 >= body.length) {
      output += char;
      continue;
    }

    const next = body[index + 1];
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === '"') output += '"';
    else if (next === "\\") output += "\\";
    else {
      output += `\\${next}`;
    }
    index += 1;
  }
  return output;
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const body = text.slice(1, -1);
    return first === '"' ? unescapeDoubleQuotedEnv(body) : body;
  }
  return text;
}

function parseEnvText(text = "") {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let rawValue = line.slice(equals + 1).trim();
    if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      const comment = rawValue.search(/\s+#/);
      if (comment >= 0) rawValue = rawValue.slice(0, comment).trim();
    }
    result[key] = unquote(rawValue);
  }
  return result;
}

async function loadEnvFile(file, target = process.env) {
  const backupFile = `${file}.bak`;
  let recoveredFromBackup = false;

  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    try {
      await fsp.copyFile(backupFile, file, fs.constants.COPYFILE_EXCL);
      recoveredFromBackup = true;
      try {
        await fsp.chmod(file, 0o600);
      } catch {}
      text = await fsp.readFile(file, "utf8");
    } catch (recoveryError) {
      if (recoveryError.code === "EEXIST") {
        text = await fsp.readFile(file, "utf8");
      } else if (recoveryError.code === "ENOENT") {
        return {
          loaded: false,
          file,
          backupFile,
          recoveredFromBackup: false,
          keys: [],
          values: {},
        };
      } else {
        throw recoveryError;
      }
    }
  }

  const parsed = parseEnvText(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
  return {
    loaded: true,
    file,
    backupFile,
    recoveredFromBackup,
    keys: Object.keys(parsed),
    values: parsed,
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function configSourceLabel(runtimeConfig = {}) {
  const hasProcessEnvironment = Boolean(runtimeConfig.processEnvironmentKeys?.length);
  const hasOverrides = Boolean(runtimeConfig.environmentOverrideKeys?.length);
  if (runtimeConfig.envLoaded && hasOverrides)
    return runtimeConfig.envRecoveredFromBackup
      ? ".env recovered from .env.bak + process environment overrides"
      : ".env + process environment overrides";
  if (runtimeConfig.envLoaded)
    return runtimeConfig.envRecoveredFromBackup ? ".env recovered from .env.bak" : ".env";
  if (hasProcessEnvironment) return "process environment";
  return "built-in defaults";
}

async function loadRuntimeConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, "data"));
  const env = options.env || process.env;
  const envPath = path.resolve(options.envPath || path.join(rootDir, ".env"));

  const processEnvironmentKeys = RUNTIME_ENV_KEYS.filter((key) => env[key] !== undefined);
  const inheritedSessionSecret = processEnvironmentKeys.includes("UPM_SESSION_SECRET")
    ? String(env.UPM_SESSION_SECRET || "")
    : "";
  const envFile = await loadEnvFile(envPath, env);
  const ignoredInvalidEnvironmentOverrides = [];

  // A stale blank/short inherited secret must never hide a valid dashboard-managed
  // .env secret. This is especially important for Electron/PM2 restarts after a
  // session-secret rotation, where inherited environments can outlive the file.
  if (
    envFile.loaded &&
    processEnvironmentKeys.includes("UPM_SESSION_SECRET") &&
    !isUsableSessionSecret(inheritedSessionSecret) &&
    isUsableSessionSecret(envFile.values?.UPM_SESSION_SECRET)
  ) {
    env.UPM_SESSION_SECRET = envFile.values.UPM_SESSION_SECRET;
    ignoredInvalidEnvironmentOverrides.push("UPM_SESSION_SECRET");
  }

  const environmentOverrideKeys = envFile.loaded
    ? processEnvironmentKeys.filter(
        (key) => envFile.keys.includes(key) && !ignoredInvalidEnvironmentOverrides.includes(key),
      )
    : [];
  const lanAllowInsecureHttp = parseBoolean(
    env.UPM_LAN_ALLOW_INSECURE_HTTP,
    DEFAULTS.lanAllowInsecureHttp,
  );

  const config = {
    rootDir,
    dataDir,
    envPath,
    envLoaded: envFile.loaded,
    envRecoveredFromBackup: envFile.recoveredFromBackup === true,
    envBackupPath: envFile.backupFile,
    envFileKeys: envFile.keys.filter((key) => RUNTIME_ENV_KEYS.includes(key)),
    processEnvironmentKeys,
    environmentOverrideKeys,
    ignoredInvalidEnvironmentOverrides,
    host: String(firstDefined(env.UPM_HOST, DEFAULTS.host)),
    port: parseInteger(env.UPM_PORT, DEFAULTS.port, { min: 1, max: 65535 }),
    backupRoot: firstDefined(env.UPM_BACKUP_ROOT) || null,
    restoreRoot: firstDefined(env.UPM_RESTORE_ROOT) || null,
    allowRemoteDashboard: parseBoolean(
      env.UPM_ALLOW_REMOTE_DASHBOARD,
      DEFAULTS.allowRemoteDashboard,
    ),
    allowRemoteAdmin: parseBoolean(env.UPM_ALLOW_REMOTE_ADMIN, DEFAULTS.allowRemoteAdmin),
    allowRemoteFilesystem: parseBoolean(
      env.UPM_ALLOW_REMOTE_FILESYSTEM,
      DEFAULTS.allowRemoteFilesystem,
    ),
    trustProxy: parseBoolean(env.UPM_TRUST_PROXY, DEFAULTS.trustProxy),
    jsonLimit: String(firstDefined(env.UPM_JSON_LIMIT, DEFAULTS.jsonLimit)),
    securityHeaders: parseBoolean(env.UPM_SECURITY_HEADERS, DEFAULTS.securityHeaders),
    contentSecurityPolicy: parseBoolean(env.UPM_CSP, DEFAULTS.contentSecurityPolicy),
    apiRateLimitWindowMs: parseInteger(
      env.UPM_RATE_LIMIT_WINDOW_MS,
      DEFAULTS.apiRateLimitWindowMs,
      { min: 1_000, max: 3_600_000 },
    ),
    apiRateLimitMax: parseInteger(env.UPM_RATE_LIMIT_MAX, DEFAULTS.apiRateLimitMax, {
      min: 10,
      max: 100_000,
    }),
    writeRateLimitMax: parseInteger(env.UPM_WRITE_RATE_LIMIT_MAX, DEFAULTS.writeRateLimitMax, {
      min: 5,
      max: 100_000,
    }),
    requestTimeoutMs: parseInteger(env.UPM_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, {
      min: 5_000,
      max: 3_600_000,
    }),
    headersTimeoutMs: parseInteger(env.UPM_HEADERS_TIMEOUT_MS, DEFAULTS.headersTimeoutMs, {
      min: 5_000,
      max: 3_600_000,
    }),
    keepAliveTimeoutMs: parseInteger(env.UPM_KEEP_ALIVE_TIMEOUT_MS, DEFAULTS.keepAliveTimeoutMs, {
      min: 1_000,
      max: 120_000,
    }),
    authEnabled: parseBoolean(env.UPM_AUTH_ENABLED, DEFAULTS.authEnabled),
    authUsername: String(firstDefined(env.UPM_AUTH_USERNAME, DEFAULTS.authUsername)),
    authPasswordHash: String(firstDefined(env.UPM_AUTH_PASSWORD_HASH, DEFAULTS.authPasswordHash)),
    sessionSecret: String(firstDefined(env.UPM_SESSION_SECRET, DEFAULTS.sessionSecret)),
    authSessionHours: parseInteger(env.UPM_AUTH_SESSION_HOURS, DEFAULTS.authSessionHours, {
      min: 1,
      max: 168,
    }),
    authCookieSecure: parseBoolean(env.UPM_AUTH_COOKIE_SECURE, DEFAULTS.authCookieSecure),
    authMaxAttempts: parseInteger(env.UPM_AUTH_MAX_ATTEMPTS, DEFAULTS.authMaxAttempts, {
      min: 3,
      max: 100,
    }),
    authLockoutMinutes: parseInteger(env.UPM_AUTH_LOCKOUT_MINUTES, DEFAULTS.authLockoutMinutes, {
      min: 1,
      max: 1440,
    }),
    backupEncryptionKey: String(firstDefined(env.UPM_BACKUP_ENCRYPTION_KEY, "")),
    editor: String(firstDefined(env.UPM_EDITOR, DEFAULTS.editor)).trim().toLowerCase(),
    editorCommand: String(firstDefined(env.UPM_EDITOR_COMMAND, DEFAULTS.editorCommand)).trim(),
    lanAllowInsecureHttp,
    lanAgents: parseAgentList(firstDefined(env.UPM_LAN_AGENTS_JSON, ""), {
      allowInsecureHttp: lanAllowInsecureHttp,
    }),
  };

  config.configSource = configSourceLabel(config);
  return config;
}

module.exports = {
  RUNTIME_ENV_KEYS,
  DEFAULTS,
  parseBoolean,
  parseInteger,
  parseEnvText,
  loadEnvFile,
  configSourceLabel,
  loadRuntimeConfig,
};
