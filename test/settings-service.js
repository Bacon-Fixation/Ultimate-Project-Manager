"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseEnvText } = require("../src/config/runtime-config");
const {
  publicSettings,
  saveSettings,
  patchEnvText,
  ensureLaunchableSessionSecret,
} = require("../src/config/settings-service");
const { verifyPassword } = require("../src/security/auth-service");

function runtime(overrides = {}) {
  return {
    envLoaded: true,
    configSource: ".env",
    environmentOverrideKeys: [],
    host: "127.0.0.1",
    port: 4310,
    backupRoot: null,
    restoreRoot: null,
    allowRemoteDashboard: false,
    allowRemoteAdmin: false,
    allowRemoteFilesystem: false,
    trustProxy: false,
    jsonLimit: "2mb",
    securityHeaders: true,
    contentSecurityPolicy: true,
    apiRateLimitWindowMs: 60000,
    apiRateLimitMax: 300,
    writeRateLimitMax: 60,
    requestTimeoutMs: 120000,
    headersTimeoutMs: 65000,
    keepAliveTimeoutMs: 5000,
    authEnabled: false,
    authUsername: "admin",
    authPasswordHash: "",
    sessionSecret: "",
    authSessionHours: 12,
    authCookieSecure: false,
    authMaxAttempts: 5,
    authLockoutMinutes: 15,
    backupEncryptionKey: "",
    editor: "vscode",
    editorCommand: "",
    lanAgents: [],
    lanAllowInsecureHttp: false,
    ...overrides,
  };
}

(async () => {
  const patched = patchEnvText("CUSTOM_VALUE=keep-me\nUPM_PORT=4310\n", {
    UPM_PORT: "4400",
    UPM_HOST: "0.0.0.0",
  });
  assert.match(patched, /CUSTOM_VALUE=keep-me/);
  assert.match(patched, /UPM_PORT=4400/);
  assert.match(patched, /UPM_HOST=0\.0\.0\.0/);

  const windowsPathPatch = patchEnvText("", {
    UPM_BACKUP_ROOT: "C:\\temp backups",
    UPM_RESTORE_ROOT: "D:\\new restores",
  });
  const windowsPathValues = parseEnvText(windowsPathPatch);
  assert.equal(windowsPathValues.UPM_BACKUP_ROOT, "C:\\temp backups");
  assert.equal(windowsPathValues.UPM_RESTORE_ROOT, "D:\\new restores");

  const safe = publicSettings(
    runtime({
      authPasswordHash: "scrypt$secret$secret",
      sessionSecret: "x".repeat(40),
      backupEncryptionKey: "super-secret-encryption-key",
      lanAgents: [
        {
          id: "workstation-2",
          name: "Workstation 2",
          url: "http://192.168.1.25:4311",
          token: "a".repeat(40),
        },
      ],
    }),
  );
  assert.equal(safe.secrets.authPasswordConfigured, true);
  assert.equal(safe.secrets.sessionSecretConfigured, true);
  assert.equal(safe.secrets.backupEncryptionKeyConfigured, true);
  assert.equal(JSON.stringify(safe).includes("super-secret-encryption-key"), false);
  assert.equal(JSON.stringify(safe).includes("scrypt$secret"), false);
  assert.equal(JSON.stringify(safe).includes("a".repeat(40)), false);
  assert.equal(safe.lanAgents.length, 1);
  assert.deepEqual(safe.lanAgents[0], {
    id: "workstation-2",
    name: "Workstation 2",
    url: "http://192.168.1.25:4311",
    tokenConfigured: true,
    secureTransport: false,
  });
  assert.equal(safe.source, ".env");
  assert.deepEqual(safe.environmentOverrides, []);

  const overrideState = publicSettings(
    runtime({
      configSource: ".env + process environment overrides",
      environmentOverrideKeys: ["UPM_PORT"],
    }),
  );
  assert.equal(overrideState.source, ".env + process environment overrides");
  assert.deepEqual(overrideState.environmentOverrides, ["UPM_PORT"]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "upm-settings-"));
  const envPath = path.join(dir, ".env");
  await fs.writeFile(
    envPath,
    "CUSTOM_VALUE=preserved\nUPM_HOST=127.0.0.1\nUPM_PORT=4310\n",
    "utf8",
  );

  const encryptionKey = crypto.randomBytes(32).toString("base64url");
  const result = await saveSettings({
    envPath,
    runtimeConfig: runtime(),
    input: {
      host: "0.0.0.0",
      port: 4311,
      backupRoot: "",
      restoreRoot: "",
      allowRemoteDashboard: true,
      allowRemoteAdmin: false,
      allowRemoteFilesystem: false,
      trustProxy: false,
      securityHeaders: true,
      contentSecurityPolicy: true,
      jsonLimit: "2mb",
      apiRateLimitWindowMs: 60000,
      apiRateLimitMax: 300,
      writeRateLimitMax: 60,
      requestTimeoutMs: 120000,
      headersTimeoutMs: 65000,
      keepAliveTimeoutMs: 5000,
      authEnabled: true,
      authUsername: "bacon",
      authSessionHours: 12,
      authCookieSecure: false,
      authMaxAttempts: 5,
      authLockoutMinutes: 15,
      editor: "vscode",
      editorCommand: "",
      lanAllowInsecureHttp: true,
    },
    secrets: {
      newAuthPassword: "correct-horse-battery-staple",
      confirmAuthPassword: "correct-horse-battery-staple",
      rotateSessionSecret: true,
      newBackupEncryptionKey: encryptionKey,
      lanAgentsJson: JSON.stringify([
        {
          id: "workstation-3",
          name: "Workstation 3",
          url: "http://192.168.1.26:4311",
          token: "b".repeat(40),
        },
      ]),
    },
  });

  assert.equal(result.saved, true);
  assert.equal(result.restartRequired, true);
  assert.ok(result.restartFields.includes("host"));
  assert.ok(result.restartFields.includes("port"));
  assert.ok(result.liveApplyFields.includes("backupEncryptionKey"));
  assert.ok(result.liveApplyFields.includes("sessionSecret"));
  const text = await fs.readFile(envPath, "utf8");
  const values = parseEnvText(text);
  assert.equal(values.CUSTOM_VALUE, "preserved");
  assert.equal(values.UPM_HOST, "0.0.0.0");
  assert.equal(values.UPM_PORT, "4311");
  assert.equal(values.UPM_AUTH_ENABLED, "true");
  assert.equal(values.UPM_AUTH_USERNAME, "bacon");
  assert.match(values.UPM_SESSION_SECRET, /^[a-f0-9]{96}$/);
  assert.equal(result.sessionSecretRotated, true);
  assert.equal(values.UPM_BACKUP_ENCRYPTION_KEY, encryptionKey);
  assert.equal(JSON.parse(values.UPM_LAN_AGENTS_JSON)[0].id, "workstation-3");
  assert.equal(values.UPM_LAN_ALLOW_INSECURE_HTTP, "true");
  assert.ok(result.warnings.some((warning) => /Insecure HTTP/.test(warning)));
  assert.equal(result.lanAgents[0].id, "workstation-3");
  assert.equal(JSON.stringify(result.lanAgents).includes("b".repeat(40)), false);
  assert.equal(
    await verifyPassword("correct-horse-battery-staple", values.UPM_AUTH_PASSWORD_HASH),
    true,
  );
  assert.equal(text.includes("correct-horse-battery-staple"), false);

  const authChangeEnvPath = path.join(dir, "auth-change.env");
  const originalAuthSecret = "d".repeat(96);
  await fs.writeFile(
    authChangeEnvPath,
    [
      "UPM_AUTH_ENABLED=true",
      "UPM_AUTH_USERNAME=admin",
      `UPM_AUTH_PASSWORD_HASH=${values.UPM_AUTH_PASSWORD_HASH}`,
      `UPM_SESSION_SECRET=${originalAuthSecret}`,
    ].join("\n"),
    "utf8",
  );
  const passwordChange = await saveSettings({
    envPath: authChangeEnvPath,
    runtimeConfig: runtime({
      authEnabled: true,
      authPasswordHash: values.UPM_AUTH_PASSWORD_HASH,
      sessionSecret: originalAuthSecret,
    }),
    input: { authEnabled: true, authUsername: "admin" },
    secrets: {
      newAuthPassword: "a-new-password-for-session-invalidation",
      confirmAuthPassword: "a-new-password-for-session-invalidation",
    },
  });
  const passwordChangeValues = parseEnvText(await fs.readFile(authChangeEnvPath, "utf8"));
  assert.equal(passwordChange.sessionSecretRotated, true);
  assert.notEqual(passwordChangeValues.UPM_SESSION_SECRET, originalAuthSecret);
  assert.ok(passwordChange.warnings.some((warning) => /sessions were invalidated/i.test(warning)));

  const secretBeforeUsernameChange = passwordChangeValues.UPM_SESSION_SECRET;
  const usernameChange = await saveSettings({
    envPath: authChangeEnvPath,
    runtimeConfig: runtime({
      authEnabled: true,
      authUsername: "admin",
      authPasswordHash: passwordChangeValues.UPM_AUTH_PASSWORD_HASH,
      sessionSecret: secretBeforeUsernameChange,
    }),
    input: { authEnabled: true, authUsername: "renamed-admin" },
    secrets: {},
  });
  const usernameChangeValues = parseEnvText(await fs.readFile(authChangeEnvPath, "utf8"));
  assert.equal(usernameChange.sessionSecretRotated, true);
  assert.notEqual(usernameChangeValues.UPM_SESSION_SECRET, secretBeforeUsernameChange);

  const brokenEnvPath = path.join(dir, "broken-session.env");
  await fs.writeFile(
    brokenEnvPath,
    [
      "UPM_AUTH_ENABLED=true",
      "UPM_AUTH_PASSWORD_HASH=scrypt$placeholder$placeholder",
      "UPM_SESSION_SECRET=short",
    ].join("\n"),
    "utf8",
  );
  const repair = await ensureLaunchableSessionSecret({
    envPath: brokenEnvPath,
    runtimeConfig: runtime({
      authEnabled: true,
      authPasswordHash: "scrypt$placeholder$placeholder",
      sessionSecret: "short",
    }),
  });
  assert.equal(repair.repaired, true);
  const repairedValues = parseEnvText(await fs.readFile(brokenEnvPath, "utf8"));
  assert.match(repairedValues.UPM_SESSION_SECRET, /^[a-f0-9]{96}$/);

  await assert.rejects(
    () =>
      saveSettings({
        envPath: path.join(dir, "bad.env"),
        runtimeConfig: runtime(),
        input: { ...runtime(), authEnabled: true },
        secrets: {},
      }),
    /Authentication cannot be enabled/,
  );

  await assert.rejects(
    () =>
      saveSettings({
        envPath: path.join(dir, "unsafe-remote.env"),
        runtimeConfig: runtime(),
        input: {
          ...runtime(),
          allowRemoteDashboard: true,
          allowRemoteAdmin: true,
          authEnabled: false,
        },
        secrets: {},
      }),
    /Authentication must be enabled/,
  );

  await assert.rejects(
    () =>
      saveSettings({
        envPath: path.join(dir, "insecure-agent.env"),
        runtimeConfig: runtime(),
        input: { ...runtime(), lanAllowInsecureHttp: false },
        secrets: {
          lanAgentsJson: JSON.stringify([
            {
              id: "lan-http",
              url: "http://192.168.1.50:4311",
              token: "c".repeat(40),
            },
          ]),
        },
      }),
    /uses insecure HTTP/,
  );

  await assert.rejects(
    () =>
      saveSettings({
        envPath: path.join(dir, "bad-agent.env"),
        runtimeConfig: runtime(),
        input: { ...runtime() },
        secrets: { lanAgentsJson: '[{"id":"bad","url":"http://127.0.0.1:4311","token":"short"}]' },
      }),
    /token must be at least 32 characters/,
  );

  assert.equal(
    await fs.readFile(`${envPath}.bak`, "utf8").then(
      () => true,
      () => false,
    ),
    true,
  );

  await fs.rm(dir, { recursive: true, force: true });
  console.log("Settings service tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
