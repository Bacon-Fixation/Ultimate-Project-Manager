"use strict";

const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { parseEnvText, loadRuntimeConfig } = require("../src/config/runtime-config");
const { normalizeAgentDefinition } = require("../src/remote-agent/remote-agent-client");

async function main() {
  const parsed = parseEnvText(
    'UPM_HOST=0.0.0.0\nUPM_PORT="4400"\n# comment\nUPM_ALLOW_REMOTE_ADMIN=true\n',
  );
  assert.equal(parsed.UPM_HOST, "0.0.0.0");
  assert.equal(parsed.UPM_PORT, "4400");
  assert.equal(parsed.UPM_ALLOW_REMOTE_ADMIN, "true");

  const windowsPaths = parseEnvText(
    [
      'TEMP_PATH="C:\\\\temp folder"',
      'NEW_PATH="C:\\\\new folder"',
      'PROGRAMS="C:\\\\Program Files\\\\Microsoft VS Code"',
      'PROJECTS="D:\\\\My Projects\\\\Bacons Helper"',
    ].join("\n"),
  );
  assert.equal(windowsPaths.TEMP_PATH, "C:\\temp folder");
  assert.equal(windowsPaths.NEW_PATH, "C:\\new folder");
  assert.equal(windowsPaths.PROGRAMS, "C:\\Program Files\\Microsoft VS Code");
  assert.equal(windowsPaths.PROJECTS, "D:\\My Projects\\Bacons Helper");

  const agentToken = "x".repeat(32);
  assert.equal(
    normalizeAgentDefinition({
      id: "primary-agent",
      url: "https://agent.example.test/",
      token: agentToken,
    }).url,
    "https://agent.example.test",
  );
  assert.throws(
    () =>
      normalizeAgentDefinition({
        id: "path-agent",
        url: "https://agent.example.test/upm",
        token: agentToken,
      }),
    /must not contain a path/i,
  );
  assert.throws(
    () =>
      normalizeAgentDefinition({
        id: "credential-agent",
        url: "https://user:secret@agent.example.test",
        token: agentToken,
      }),
    /embedded credentials/i,
  );
  assert.throws(
    () =>
      normalizeAgentDefinition({
        id: "query-agent",
        url: "https://agent.example.test/?target=other",
        token: agentToken,
      }),
    /query string or fragment/i,
  );

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-config-"));
  const dataDir = path.join(root, "data");
  await fsp.mkdir(dataDir, { recursive: true });

  await fsp.writeFile(
    path.join(dataDir, "server.json"),
    JSON.stringify({
      host: "0.0.0.0",
      port: 4444,
      allowRemoteDirectoryBrowse: true,
    }),
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, ".env"),
    [
      "UPM_HOST=127.0.0.1",
      "UPM_PORT=4555",
      "UPM_ALLOW_REMOTE_DASHBOARD=false",
      "UPM_ALLOW_REMOTE_ADMIN=false",
      "UPM_ALLOW_REMOTE_FILESYSTEM=false",
      "UPM_AUTH_ENABLED=true",
      "UPM_AUTH_USERNAME=test-admin",
      "UPM_AUTH_PASSWORD_HASH=scrypt$abc$def",
      "UPM_SESSION_SECRET=0123456789abcdef0123456789abcdef",
      "UPM_BACKUP_ENCRYPTION_KEY=unit-test-encryption-key",
      "UPM_EDITOR=cursor",
      "UPM_EDITOR_COMMAND=C:\\Tools\\editor.exe",
    ].join("\n"),
    "utf8",
  );

  const config = await loadRuntimeConfig({ rootDir: root, dataDir, env: {} });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4555);
  assert.equal(config.allowRemoteDashboard, false);
  assert.equal(config.allowRemoteAdmin, false);
  assert.equal(config.allowRemoteFilesystem, false);
  assert.equal(config.authEnabled, true);
  assert.equal(config.authUsername, "test-admin");
  assert.equal(config.authPasswordHash, "scrypt$abc$def");
  assert.equal(config.backupEncryptionKey, "unit-test-encryption-key");
  assert.equal(config.editor, "cursor");
  assert.equal(config.editorCommand, "C:\\Tools\\editor.exe");
  assert.equal(config.envLoaded, true);
  assert.equal(config.configSource, ".env");
  assert.deepEqual(config.environmentOverrideKeys, []);
  assert.equal(Object.hasOwn(config, "legacyServerConfigLoaded"), false);

  const overridden = await loadRuntimeConfig({
    rootDir: root,
    dataDir,
    env: { UPM_PORT: "4666" },
  });
  assert.equal(overridden.port, 4666);
  assert.equal(overridden.configSource, ".env + process environment overrides");
  assert.deepEqual(overridden.environmentOverrideKeys, ["UPM_PORT"]);

  const invalidInheritedSession = await loadRuntimeConfig({
    rootDir: root,
    dataDir,
    env: { UPM_SESSION_SECRET: "short" },
  });
  assert.equal(invalidInheritedSession.sessionSecret, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(invalidInheritedSession.environmentOverrideKeys, []);
  assert.deepEqual(invalidInheritedSession.ignoredInvalidEnvironmentOverrides, [
    "UPM_SESSION_SECRET",
  ]);
  assert.equal(invalidInheritedSession.configSource, ".env");

  const envPath = path.join(root, ".env");
  const envBackupPath = `${envPath}.bak`;
  await fsp.copyFile(envPath, envBackupPath);
  await fsp.rm(envPath);
  const recovered = await loadRuntimeConfig({
    rootDir: root,
    dataDir,
    env: {},
  });
  assert.equal(recovered.envLoaded, true);
  assert.equal(recovered.envRecoveredFromBackup, true);
  assert.equal(recovered.configSource, ".env recovered from .env.bak");
  assert.equal(recovered.port, 4555);
  assert.equal(
    await fsp.readFile(envPath, "utf8").then(
      () => true,
      () => false,
    ),
    true,
  );

  await fsp.rm(envPath);
  await fsp.rm(envBackupPath);
  const defaultsOnly = await loadRuntimeConfig({
    rootDir: root,
    dataDir,
    env: {},
  });
  assert.equal(defaultsOnly.host, "127.0.0.1");
  assert.equal(defaultsOnly.port, 4310);
  assert.equal(defaultsOnly.allowRemoteDashboard, false);
  assert.equal(defaultsOnly.configSource, "built-in defaults");

  await fsp.rm(root, { recursive: true, force: true });
  console.log("Runtime config tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
