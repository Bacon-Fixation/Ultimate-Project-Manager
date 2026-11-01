"use strict";

const assert = require("node:assert/strict");
const {
  SETUP_FORMAT,
  createSetupDocument,
  validateSetupDocument,
  prepareRuntimeSettingsImport,
} = require("../src/config/setup-transfer");

function runtimeConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 4310,
    backupRoot: "",
    restoreRoot: "",
    allowRemoteDashboard: false,
    allowRemoteAdmin: false,
    allowRemoteFilesystem: false,
    trustProxy: false,
    securityHeaders: true,
    contentSecurityPolicy: true,
    jsonLimit: "2mb",
    apiRateLimitWindowMs: 60000,
    apiRateLimitMax: 300,
    writeRateLimitMax: 120,
    requestTimeoutMs: 30000,
    headersTimeoutMs: 35000,
    keepAliveTimeoutMs: 5000,
    authEnabled: true,
    authUsername: "admin",
    authPasswordHash: "secret-hash-that-must-not-export",
    sessionSecret: "session-secret-that-must-not-export",
    authSessionHours: 12,
    authCookieSecure: false,
    authMaxAttempts: 5,
    authLockoutMinutes: 15,
    backupEncryptionKey: "backup-key-that-must-not-export",
    editor: "vscode",
    editorCommand: "",
    lanAllowInsecureHttp: false,
    lanAgents: [
      {
        id: "agent-1",
        name: "Agent One",
        url: "https://192.168.1.50:4311",
        token: "agent-token-that-must-not-export",
      },
    ],
    ...overrides,
  };
}

const source = runtimeConfig();
const setup = createSetupDocument({
  runtimeConfig: source,
  appVersion: "0.9.4",
  projects: [
    {
      id: "p1",
      name: "Demo",
      projectRoot: "C:\\Projects\\Demo",
      extraIncludes: ["dist/important.json"],
    },
  ],
});

assert.equal(setup.format, SETUP_FORMAT);
assert.equal(setup.schemaVersion, 1);
assert.equal(setup.secretsIncluded, false);
assert.equal(setup.runtimeSettings.authEnabled, true);
assert.equal(setup.projects[0].extraIncludes[0], "dist/important.json");
assert.equal(setup.lanAgents[0].tokenConfigured, true);
assert.equal(Object.hasOwn(setup.lanAgents[0], "token"), false);
const serialized = JSON.stringify(setup);
assert.doesNotMatch(serialized, /secret-hash-that-must-not-export/);
assert.doesNotMatch(serialized, /session-secret-that-must-not-export/);
assert.doesNotMatch(serialized, /backup-key-that-must-not-export/);
assert.doesNotMatch(serialized, /agent-token-that-must-not-export/);
assert.equal(validateSetupDocument(setup), setup);
assert.throws(
  () => validateSetupDocument({ format: "other", schemaVersion: 1, projects: [] }),
  /not an Ultimate Project Manager setup export/,
);

const destination = runtimeConfig({
  authPasswordHash: "",
  sessionSecret: "",
  backupEncryptionKey: "",
  lanAgents: [],
});
const prepared = prepareRuntimeSettingsImport(setup, destination);
assert.equal(prepared.settings.authEnabled, false);
assert.ok(prepared.warnings.some((warning) => /Authentication was enabled/.test(warning)));
assert.ok(prepared.warnings.some((warning) => /encryption key/.test(warning)));
assert.ok(prepared.warnings.some((warning) => /LAN agent tokens/.test(warning)));

console.log("Setup transfer tests passed.");
