"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { atomicWriteFile } = require("../filesystem/atomic-file");
const { hashPassword } = require("../security/auth-service");
const { ensureLastKnownGoodEnv, markSettingsPending } = require("./settings-recovery");
const { generateSessionSecret, isUsableSessionSecret } = require("../security/session-secret");
const { parseAgentList } = require("../remote-agent/remote-agent-client");
const {
  RUNTIME_ENV_KEYS,
  DEFAULTS,
  parseBoolean,
  parseInteger,
  parseEnvText,
} = require("./runtime-config");

const EDITORS = Object.freeze([
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "sublime",
  "webstorm",
  "custom",
]);
const MANAGED_ENV_KEYS = RUNTIME_ENV_KEYS;

const LIVE_APPLY_FIELDS = Object.freeze([
  "allowRemoteDashboard",
  "allowRemoteAdmin",
  "allowRemoteFilesystem",
  "trustProxy",
  "securityHeaders",
  "contentSecurityPolicy",
  "authEnabled",
  "authUsername",
  "authSessionHours",
  "authCookieSecure",
  "authMaxAttempts",
  "authLockoutMinutes",
  "authPassword",
  "sessionSecret",
  "backupEncryptionKey",
  "editor",
  "editorCommand",
  "lanAgents",
  "lanAllowInsecureHttp",
]);

const RESTART_REQUIRED_FIELDS = Object.freeze([
  "host",
  "port",
  "backupRoot",
  "restoreRoot",
  "jsonLimit",
  "apiRateLimitWindowMs",
  "apiRateLimitMax",
  "writeRateLimitMax",
  "requestTimeoutMs",
  "headersTimeoutMs",
  "keepAliveTimeoutMs",
]);

function restartFieldsForChanges(changed = []) {
  const restart = new Set(RESTART_REQUIRED_FIELDS);
  return [...new Set(changed.map(String))].filter((field) => restart.has(field));
}

const ENV_GROUPS = Object.freeze([
  {
    title: "Server",
    keys: ["UPM_HOST", "UPM_PORT", "UPM_BACKUP_ROOT", "UPM_RESTORE_ROOT"],
  },
  {
    title: "Remote access hardening",
    keys: [
      "UPM_ALLOW_REMOTE_DASHBOARD",
      "UPM_ALLOW_REMOTE_ADMIN",
      "UPM_ALLOW_REMOTE_FILESYSTEM",
      "UPM_TRUST_PROXY",
    ],
  },
  {
    title: "HTTP hardening / limits",
    keys: [
      "UPM_SECURITY_HEADERS",
      "UPM_CSP",
      "UPM_JSON_LIMIT",
      "UPM_RATE_LIMIT_WINDOW_MS",
      "UPM_RATE_LIMIT_MAX",
      "UPM_WRITE_RATE_LIMIT_MAX",
      "UPM_REQUEST_TIMEOUT_MS",
      "UPM_HEADERS_TIMEOUT_MS",
      "UPM_KEEP_ALIVE_TIMEOUT_MS",
    ],
  },
  {
    title: "Authentication",
    keys: [
      "UPM_AUTH_ENABLED",
      "UPM_AUTH_USERNAME",
      "UPM_AUTH_PASSWORD_HASH",
      "UPM_SESSION_SECRET",
      "UPM_AUTH_SESSION_HOURS",
      "UPM_AUTH_COOKIE_SECURE",
      "UPM_AUTH_MAX_ATTEMPTS",
      "UPM_AUTH_LOCKOUT_MINUTES",
    ],
  },
  {
    title: "Backup encryption",
    keys: ["UPM_BACKUP_ENCRYPTION_KEY"],
  },
  {
    title: "LAN remote agents",
    keys: ["UPM_LAN_AGENTS_JSON", "UPM_LAN_ALLOW_INSECURE_HTTP"],
  },
  {
    title: "Local editor integration",
    keys: ["UPM_EDITOR", "UPM_EDITOR_COMMAND"],
  },
]);

function quoteEnvValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text) && !text.includes("#")) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function booleanEnv(value) {
  return value === true ? "true" : "false";
}

function normalizeHost(value) {
  const host = String(value ?? "").trim();
  if (!host || host.length > 255 || /[\s/\\]/.test(host))
    throw new Error("Host must be a hostname or bind address without spaces or path characters.");
  return host;
}

function normalizePathSetting(value) {
  const text = String(value ?? "").trim();
  if (text.length > 4096) throw new Error("Configured path is too long.");
  if (text.includes("\0")) throw new Error("Configured paths cannot contain NUL characters.");
  return text;
}

function normalizeJsonLimit(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^\d+(?:\.\d+)?(?:b|kb|mb|gb)?$/.test(text))
    throw new Error("JSON limit must look like 512kb, 2mb, or 1048576.");
  return text;
}

function publicLanAgents(agents = []) {
  return (Array.isArray(agents) ? agents : []).map((agent) => ({
    id: String(agent?.id || ""),
    name: String(agent?.name || agent?.id || ""),
    url: String(agent?.url || ""),
    tokenConfigured: Boolean(agent?.token),
    secureTransport: /^https:\/\//i.test(String(agent?.url || "")),
  }));
}

function currentSettings(runtimeConfig) {
  return {
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    backupRoot: runtimeConfig.backupRoot || "",
    restoreRoot: runtimeConfig.restoreRoot || "",
    allowRemoteDashboard: runtimeConfig.allowRemoteDashboard,
    allowRemoteAdmin: runtimeConfig.allowRemoteAdmin,
    allowRemoteFilesystem: runtimeConfig.allowRemoteFilesystem,
    trustProxy: runtimeConfig.trustProxy,
    securityHeaders: runtimeConfig.securityHeaders,
    contentSecurityPolicy: runtimeConfig.contentSecurityPolicy,
    jsonLimit: runtimeConfig.jsonLimit,
    apiRateLimitWindowMs: runtimeConfig.apiRateLimitWindowMs,
    apiRateLimitMax: runtimeConfig.apiRateLimitMax,
    writeRateLimitMax: runtimeConfig.writeRateLimitMax,
    requestTimeoutMs: runtimeConfig.requestTimeoutMs,
    headersTimeoutMs: runtimeConfig.headersTimeoutMs,
    keepAliveTimeoutMs: runtimeConfig.keepAliveTimeoutMs,
    authEnabled: runtimeConfig.authEnabled,
    authUsername: runtimeConfig.authUsername,
    authSessionHours: runtimeConfig.authSessionHours,
    authCookieSecure: runtimeConfig.authCookieSecure,
    authMaxAttempts: runtimeConfig.authMaxAttempts,
    authLockoutMinutes: runtimeConfig.authLockoutMinutes,
    editor: runtimeConfig.editor,
    editorCommand: runtimeConfig.editorCommand,
    lanAllowInsecureHttp: runtimeConfig.lanAllowInsecureHttp === true,
  };
}

function publicSettings(runtimeConfig) {
  return {
    settings: currentSettings(runtimeConfig),
    secrets: {
      authPasswordConfigured: Boolean(runtimeConfig.authPasswordHash),
      sessionSecretConfigured: Boolean(runtimeConfig.sessionSecret),
      backupEncryptionKeyConfigured: Boolean(runtimeConfig.backupEncryptionKey),
    },
    source: runtimeConfig.configSource || (runtimeConfig.envLoaded ? ".env" : "built-in defaults"),
    envExists: runtimeConfig.envLoaded,
    environmentOverrides: [...(runtimeConfig.environmentOverrideKeys || [])],
    ignoredInvalidEnvironmentOverrides: [
      ...(runtimeConfig.ignoredInvalidEnvironmentOverrides || []),
    ],
    restartRequiredAfterSave: true,
    conditionalRestartSupported: true,
    restartRequiredFields: [...RESTART_REQUIRED_FIELDS],
    liveApplySupported: true,
    lastKnownGoodRecoverySupported: true,
    editors: EDITORS,
    lanAgents: publicLanAgents(runtimeConfig.lanAgents),
  };
}

async function readEnvDocument(envPath) {
  try {
    const text = await fsp.readFile(envPath, "utf8");
    return { exists: true, text, values: parseEnvText(text) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, text: "", values: {} };
    throw error;
  }
}

function patchEnvText(originalText, updates) {
  const lines = String(originalText || "").split(/\r?\n/);
  const seen = new Set();
  const output = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${quoteEnvValue(updates[match[1]])}`;
  });

  const missing = MANAGED_ENV_KEYS.filter(
    (key) => Object.prototype.hasOwnProperty.call(updates, key) && !seen.has(key),
  );
  if (missing.length) {
    while (output.length && output[output.length - 1] === "") output.pop();
    output.push("", "# Updated by Ultimate Project Manager dashboard/setup");
    for (const key of missing) output.push(`${key}=${quoteEnvValue(updates[key])}`);
  }
  return `${output.join("\n").replace(/\n+$/g, "")}\n`;
}

async function atomicWriteEnv(envPath, text) {
  await atomicWriteFile(envPath, text, {
    encoding: "utf8",
    mode: 0o600,
    backup: true,
    backupPath: `${envPath}.bak`,
  });
}

function validateAndMapSettings(input = {}, current = {}) {
  const next = {};
  const changed = [];
  const set = (property, envKey, value) => {
    next[envKey] = value;
    if (String(current[property] ?? "") !== String(value ?? "")) changed.push(property);
  };

  set("host", "UPM_HOST", normalizeHost(input.host ?? current.host ?? DEFAULTS.host));
  set(
    "port",
    "UPM_PORT",
    String(
      parseInteger(input.port, current.port ?? DEFAULTS.port, {
        min: 1,
        max: 65535,
      }),
    ),
  );
  set(
    "backupRoot",
    "UPM_BACKUP_ROOT",
    normalizePathSetting(input.backupRoot ?? current.backupRoot ?? ""),
  );
  set(
    "restoreRoot",
    "UPM_RESTORE_ROOT",
    normalizePathSetting(input.restoreRoot ?? current.restoreRoot ?? ""),
  );

  const booleanFields = [
    ["allowRemoteDashboard", "UPM_ALLOW_REMOTE_DASHBOARD"],
    ["allowRemoteAdmin", "UPM_ALLOW_REMOTE_ADMIN"],
    ["allowRemoteFilesystem", "UPM_ALLOW_REMOTE_FILESYSTEM"],
    ["trustProxy", "UPM_TRUST_PROXY"],
    ["securityHeaders", "UPM_SECURITY_HEADERS"],
    ["contentSecurityPolicy", "UPM_CSP"],
    ["authEnabled", "UPM_AUTH_ENABLED"],
    ["authCookieSecure", "UPM_AUTH_COOKIE_SECURE"],
    ["lanAllowInsecureHttp", "UPM_LAN_ALLOW_INSECURE_HTTP"],
  ];
  for (const [property, envKey] of booleanFields) {
    const fallback = Boolean(current[property]);
    set(property, envKey, booleanEnv(parseBoolean(input[property], fallback)));
  }

  set(
    "jsonLimit",
    "UPM_JSON_LIMIT",
    normalizeJsonLimit(input.jsonLimit ?? current.jsonLimit ?? DEFAULTS.jsonLimit),
  );

  const integerFields = [
    ["apiRateLimitWindowMs", "UPM_RATE_LIMIT_WINDOW_MS", 1_000, 3_600_000],
    ["apiRateLimitMax", "UPM_RATE_LIMIT_MAX", 10, 100_000],
    ["writeRateLimitMax", "UPM_WRITE_RATE_LIMIT_MAX", 5, 100_000],
    ["requestTimeoutMs", "UPM_REQUEST_TIMEOUT_MS", 5_000, 3_600_000],
    ["headersTimeoutMs", "UPM_HEADERS_TIMEOUT_MS", 5_000, 3_600_000],
    ["keepAliveTimeoutMs", "UPM_KEEP_ALIVE_TIMEOUT_MS", 1_000, 120_000],
    ["authSessionHours", "UPM_AUTH_SESSION_HOURS", 1, 168],
    ["authMaxAttempts", "UPM_AUTH_MAX_ATTEMPTS", 3, 100],
    ["authLockoutMinutes", "UPM_AUTH_LOCKOUT_MINUTES", 1, 1440],
  ];
  for (const [property, envKey, min, max] of integerFields) {
    const fallback = Number(current[property]) || DEFAULTS[property];
    set(property, envKey, String(parseInteger(input[property], fallback, { min, max })));
  }

  const username = String(
    input.authUsername ?? current.authUsername ?? DEFAULTS.authUsername,
  ).trim();
  if (!username || username.length > 128 || /[\r\n\0]/.test(username))
    throw new Error("Authentication username must be 1-128 characters.");
  set("authUsername", "UPM_AUTH_USERNAME", username);

  const editor = String(input.editor ?? current.editor ?? DEFAULTS.editor)
    .trim()
    .toLowerCase();
  if (!EDITORS.includes(editor)) throw new Error(`Editor must be one of: ${EDITORS.join(", ")}.`);
  set("editor", "UPM_EDITOR", editor);
  set(
    "editorCommand",
    "UPM_EDITOR_COMMAND",
    String(input.editorCommand ?? current.editorCommand ?? "").trim(),
  );

  const warnings = [];
  const remoteDashboard = parseBoolean(next.UPM_ALLOW_REMOTE_DASHBOARD, false);
  const remoteAdmin = parseBoolean(next.UPM_ALLOW_REMOTE_ADMIN, false);
  const remoteFilesystem = parseBoolean(next.UPM_ALLOW_REMOTE_FILESYSTEM, false);
  const authEnabled = parseBoolean(next.UPM_AUTH_ENABLED, false);

  if ((remoteAdmin || remoteFilesystem) && !authEnabled) {
    throw new Error(
      "Authentication must be enabled before remote admin or remote filesystem access can be enabled.",
    );
  }
  if (remoteDashboard && !authEnabled) {
    warnings.push(
      "Remote dashboard access is enabled without authentication. Read-only remote responses will redact local filesystem paths.",
    );
  }
  if (
    parseBoolean(next.UPM_ALLOW_REMOTE_ADMIN, false) &&
    !parseBoolean(next.UPM_ALLOW_REMOTE_DASHBOARD, false)
  ) {
    warnings.push(
      "Remote admin is enabled but remote dashboard access is disabled; remote admin will remain unreachable until dashboard access is enabled.",
    );
  }
  if (
    parseBoolean(next.UPM_ALLOW_REMOTE_FILESYSTEM, false) &&
    !parseBoolean(next.UPM_ALLOW_REMOTE_DASHBOARD, false)
  ) {
    warnings.push(
      "Remote filesystem access is enabled but remote dashboard access is disabled; remote filesystem APIs will remain unreachable until dashboard access is enabled.",
    );
  }
  if (
    parseBoolean(next.UPM_AUTH_COOKIE_SECURE, false) &&
    (next.UPM_HOST === "0.0.0.0" || next.UPM_HOST === "::")
  ) {
    warnings.push(
      "Secure authentication cookies require HTTPS. Plain HTTP LAN access will not retain the login cookie.",
    );
  }
  if (parseBoolean(next.UPM_LAN_ALLOW_INSECURE_HTTP, false)) {
    warnings.push(
      "Insecure HTTP is enabled for non-loopback LAN agents. Bearer tokens can be intercepted on an untrusted network; HTTPS is recommended.",
    );
  }
  if (editor === "custom" && !next.UPM_EDITOR_COMMAND)
    warnings.push("Custom editor is selected but UPM_EDITOR_COMMAND is empty.");

  return { envUpdates: next, changed, warnings };
}

async function saveSettings({ envPath, runtimeConfig, input = {}, secrets = {} }) {
  const current = currentSettings(runtimeConfig);
  const document = await readEnvDocument(envPath);
  const { envUpdates, changed, warnings } = validateAndMapSettings(input, current);

  if (runtimeConfig.environmentOverrideKeys?.length) {
    warnings.push(
      `Parent process environment values currently override .env for: ${runtimeConfig.environmentOverrideKeys.join(", ")}. Remove those external overrides before expecting dashboard-saved values for those keys to take effect.`,
    );
  }

  envUpdates.UPM_AUTH_PASSWORD_HASH =
    document.values.UPM_AUTH_PASSWORD_HASH || runtimeConfig.authPasswordHash || "";
  envUpdates.UPM_SESSION_SECRET =
    document.values.UPM_SESSION_SECRET || runtimeConfig.sessionSecret || "";
  envUpdates.UPM_BACKUP_ENCRYPTION_KEY =
    document.values.UPM_BACKUP_ENCRYPTION_KEY || runtimeConfig.backupEncryptionKey || "";
  envUpdates.UPM_LAN_AGENTS_JSON =
    document.values.UPM_LAN_AGENTS_JSON ||
    (runtimeConfig.lanAgents?.length ? JSON.stringify(runtimeConfig.lanAgents) : "");

  const replacementAgentsJson = String(secrets.lanAgentsJson || "").trim();
  const clearLanAgents = secrets.clearLanAgents === true;
  if (replacementAgentsJson && clearLanAgents)
    throw new Error("Choose either replacement LAN agent JSON or remove all agents, not both.");
  if (replacementAgentsJson) {
    const agents = parseAgentList(replacementAgentsJson, {
      allowInsecureHttp: parseBoolean(envUpdates.UPM_LAN_ALLOW_INSECURE_HTTP, false),
    });
    envUpdates.UPM_LAN_AGENTS_JSON = JSON.stringify(agents);
    changed.push("lanAgents");
  } else if (clearLanAgents) {
    envUpdates.UPM_LAN_AGENTS_JSON = "";
    changed.push("lanAgents");
  }

  if (envUpdates.UPM_LAN_AGENTS_JSON) {
    parseAgentList(envUpdates.UPM_LAN_AGENTS_JSON, {
      allowInsecureHttp: parseBoolean(envUpdates.UPM_LAN_ALLOW_INSECURE_HTTP, false),
    });
  }

  const newPassword = String(secrets.newAuthPassword || "");
  if (newPassword) {
    if (newPassword !== String(secrets.confirmAuthPassword || ""))
      throw new Error("New authentication password and confirmation do not match.");
    envUpdates.UPM_AUTH_PASSWORD_HASH = await hashPassword(newPassword);
    changed.push("authPassword");
  }

  const rotateSessionSecret = secrets.rotateSessionSecret === true;
  if (rotateSessionSecret) {
    envUpdates.UPM_SESSION_SECRET = generateSessionSecret();
    changed.push("sessionSecret");
    if (runtimeConfig.environmentOverrideKeys?.includes("UPM_SESSION_SECRET")) {
      warnings.push(
        "Session secret rotated in .env, but a valid parent-process UPM_SESSION_SECRET currently overrides the file. Remove that external override before restart for the rotated secret to become active.",
      );
    }
  } else if (!isUsableSessionSecret(envUpdates.UPM_SESSION_SECRET)) {
    envUpdates.UPM_SESSION_SECRET = generateSessionSecret();
    changed.push("sessionSecret");
    warnings.push(
      "The stored session secret was missing or invalid and has been regenerated to keep authentication launchable.",
    );
  }

  const encryptionKey = String(secrets.newBackupEncryptionKey || "");
  if (encryptionKey) {
    if (encryptionKey.length < 24)
      throw new Error("Backup encryption key must be at least 24 characters.");
    envUpdates.UPM_BACKUP_ENCRYPTION_KEY = encryptionKey;
    changed.push("backupEncryptionKey");
  }

  if (parseBoolean(envUpdates.UPM_AUTH_ENABLED, false) && !envUpdates.UPM_AUTH_PASSWORD_HASH) {
    throw new Error(
      "Authentication cannot be enabled until an authentication password is configured.",
    );
  }

  const output = document.exists
    ? patchEnvText(document.text, envUpdates)
    : renderCanonicalEnv(envUpdates);
  await ensureLastKnownGoodEnv(envPath);
  await atomicWriteEnv(envPath, output);

  const verifiedDocument = await readEnvDocument(envPath);
  if (verifiedDocument.values.UPM_SESSION_SECRET !== envUpdates.UPM_SESSION_SECRET) {
    throw new Error(
      "Session secret write verification failed. The previous .env backup was preserved; review .env/.env.bak before restarting.",
    );
  }
  if (!isUsableSessionSecret(verifiedDocument.values.UPM_SESSION_SECRET)) {
    throw new Error(
      "Session secret validation failed after saving. Ultimate Project Manager will not recommend a restart with an unusable authentication secret.",
    );
  }

  const uniqueChanged = [...new Set(changed)];
  const restartFields = restartFieldsForChanges(uniqueChanged);
  await markSettingsPending(envPath, { changed: uniqueChanged });

  return {
    saved: true,
    envPath,
    changed: uniqueChanged,
    warnings,
    liveApplyFields: uniqueChanged.filter((field) => LIVE_APPLY_FIELDS.includes(field)),
    restartFields,
    restartRequired: restartFields.length > 0,
    sessionSecretRotated: rotateSessionSecret,
    secrets: {
      authPasswordConfigured: Boolean(envUpdates.UPM_AUTH_PASSWORD_HASH),
      sessionSecretConfigured: Boolean(envUpdates.UPM_SESSION_SECRET),
      backupEncryptionKeyConfigured: Boolean(envUpdates.UPM_BACKUP_ENCRYPTION_KEY),
    },
    lanAgents: publicLanAgents(
      envUpdates.UPM_LAN_AGENTS_JSON
        ? parseAgentList(envUpdates.UPM_LAN_AGENTS_JSON, {
            allowInsecureHttp: parseBoolean(envUpdates.UPM_LAN_ALLOW_INSECURE_HTTP, false),
          })
        : [],
    ),
  };
}

async function ensureLaunchableSessionSecret({ envPath, runtimeConfig }) {
  if (!runtimeConfig?.authEnabled || isUsableSessionSecret(runtimeConfig.sessionSecret)) {
    return { repaired: false, reason: null };
  }

  const document = await readEnvDocument(envPath);
  if (!document.exists) {
    return {
      repaired: false,
      reason:
        "Authentication is enabled with an invalid session secret, and no .env file is available for automatic repair.",
    };
  }

  const sessionSecret = generateSessionSecret();
  const output = patchEnvText(document.text, { UPM_SESSION_SECRET: sessionSecret });
  await atomicWriteEnv(envPath, output);
  const verified = await readEnvDocument(envPath);
  if (
    verified.values.UPM_SESSION_SECRET !== sessionSecret ||
    !isUsableSessionSecret(sessionSecret)
  ) {
    throw new Error("Automatic session-secret repair could not be verified.");
  }
  return {
    repaired: true,
    reason: "Invalid session secret was regenerated in .env so authentication can start safely.",
  };
}

function renderCanonicalEnv(values = {}) {
  const lines = [
    "# Ultimate Project Manager runtime configuration",
    "# Generated by npm run setup",
    "",
  ];
  for (const group of ENV_GROUPS) {
    lines.push(
      `# -----------------------------------------------------------------------------`,
      `# ${group.title}`,
      "# -----------------------------------------------------------------------------",
    );
    for (const key of group.keys) lines.push(`${key}=${quoteEnvValue(values[key] ?? "")}`);
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/g, "")}\n`;
}

module.exports = {
  EDITORS,
  MANAGED_ENV_KEYS,
  LIVE_APPLY_FIELDS,
  RESTART_REQUIRED_FIELDS,
  restartFieldsForChanges,
  ENV_GROUPS,
  quoteEnvValue,
  publicLanAgents,
  publicSettings,
  currentSettings,
  readEnvDocument,
  patchEnvText,
  atomicWriteEnv,
  validateAndMapSettings,
  saveSettings,
  ensureLaunchableSessionSecret,
  renderCanonicalEnv,
};
