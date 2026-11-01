"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RUNTIME_ENV_KEYS, parseEnvText } = require("../src/config/runtime-config");
const { MANAGED_ENV_KEYS, ENV_GROUPS } = require("../src/config/settings-service");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
const runtimeConfig = fs.readFileSync(
  path.join(root, "src", "config", "runtime-config.js"),
  "utf8",
);
const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const exampleValues = parseEnvText(example);

assert.equal(fs.existsSync(path.join(root, "server.example.json")), false);
assert.equal(runtimeConfig.includes("loadLegacyServerConfig"), false);
assert.equal(runtimeConfig.includes("BACKUP_HOST"), false);
assert.equal(runtimeConfig.includes("BACKUP_PORT"), false);
assert.equal(runtimeConfig.includes("UPM_ALLOW_REMOTE_DIRECTORY_BROWSE"), false);

assert.deepEqual([...MANAGED_ENV_KEYS].sort(), [...RUNTIME_ENV_KEYS].sort());
const groupedKeys = ENV_GROUPS.flatMap((group) => group.keys);
assert.deepEqual([...groupedKeys].sort(), [...RUNTIME_ENV_KEYS].sort());
assert.equal(new Set(groupedKeys).size, groupedKeys.length);
for (const key of RUNTIME_ENV_KEYS) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(exampleValues, key),
    true,
    `.env.example is missing ${key}`,
  );
}

for (const key of [
  "UPM_ALLOW_REMOTE_DASHBOARD=false",
  "UPM_ALLOW_REMOTE_ADMIN=false",
  "UPM_ALLOW_REMOTE_FILESYSTEM=false",
  "UPM_SECURITY_HEADERS=true",
  "UPM_CSP=true",
  "UPM_RATE_LIMIT_MAX=300",
  "UPM_WRITE_RATE_LIMIT_MAX=60",
  "UPM_AUTH_ENABLED=false",
  "UPM_AUTH_USERNAME=admin",
  "UPM_AUTH_COOKIE_SECURE=false",
  "UPM_BACKUP_ENCRYPTION_KEY=",
  "UPM_EDITOR=vscode",
  "UPM_EDITOR_COMMAND=",
])
  assert.match(example, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

assert.match(index, /Content-Security-Policy/);
assert.match(index, /isPotentiallyTrustworthyRequest/);
assert.match(index, /Cross-Origin-Opener-Policy/);
assert.match(index, /Cross-site API requests are not allowed/);
assert.match(index, /requestOriginAllowed/);
assert.match(index, /trustProxy && isLoopbackAddress\(req\.socket\?\.remoteAddress/);
assert.match(index, /Remote administrative actions are disabled/);
assert.match(index, /Remote filesystem\/archive access is disabled/);
assert.match(index, /createRateLimiter/);
assert.ok(
  index.indexOf('app.use("/api", apiRateLimiter)') <
    index.indexOf('app.use("/api", express.json({ limit: serverConfig.jsonLimit }))'),
  "API rate limiting must run before JSON body parsing.",
);
assert.ok(
  index.indexOf("Cross-site API requests are not allowed.") <
    index.indexOf('app.use("/api", express.json({ limit: serverConfig.jsonLimit }))'),
  "Cross-site rejection must run before JSON body parsing.",
);
const remoteAgentServer = fs.readFileSync(
  path.join(root, "src", "remote-agent", "server.js"),
  "utf8",
);
assert.ok(
  remoteAgentServer.indexOf("createRequestLimiter(options.rateLimit || {})") <
    remoteAgentServer.indexOf('express.json({ limit: "1mb", strict: true })'),
  "LAN agent rate limiting must run before JSON body parsing.",
);
assert.ok(
  remoteAgentServer.indexOf("Invalid LAN agent token.") <
    remoteAgentServer.indexOf('express.json({ limit: "1mb", strict: true })'),
  "LAN agent authentication must run before JSON body parsing.",
);
assert.match(index, /X-Request-ID/);
assert.match(index, /Authentication required/);
assert.match(index, /\/api\/auth\/login/);
assert.match(index, /AUTH_COOKIE_REQUIRES_HTTPS/);
assert.match(index, /candidateStatus >= 400 && candidateStatus <= 599/);
const authService = fs.readFileSync(path.join(root, "src", "security", "auth-service.js"), "utf8");
assert.match(authService, /Secure authentication cookies require HTTPS/);
assert.match(index, /backupEncryptionConfigured/);
assert.match(index, /\/api\/projects\/:id\/journal/);
assert.match(index, /journal\/prune["'],\s*requireLocalFilesystemAccess/);
assert.match(index, /open-editor["'],\s*requireLocalHostAction/);
assert.match(index, /pm2\/start-project["'],\s*requireLocalFilesystemAccess/);
assert.match(index, /\/api\/settings/);
assert.match(index, /requireSettingsAccess/);
assert.match(index, /Runtime settings saved/);
const settingsService = fs.readFileSync(
  path.join(root, "src", "config", "settings-service.js"),
  "utf8",
);
assert.match(settingsService, /authPasswordConfigured/);
assert.match(settingsService, /backupEncryptionKeyConfigured/);
assert.match(settingsService, /document\.values\.UPM_AUTH_PASSWORD_HASH/);
assert.match(settingsService, /document\.values\.UPM_SESSION_SECRET/);
assert.match(settingsService, /document\.values\.UPM_BACKUP_ENCRYPTION_KEY/);
assert.match(settingsService, /environmentOverrideKeys/);

console.log("Security/config surface checks passed.");

assert.match(index, /serverConfig\.allowRemoteAdmin && auth\.enabled && req\.auth/);
