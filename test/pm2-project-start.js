"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  Pm2Monitor,
  normalizePm2EcosystemFile,
  normalizePm2AppName,
  pathMatches,
} = require("../src/pm2/pm2-monitor");

async function main() {
  assert.equal(normalizePm2EcosystemFile("ecosystem.config.js"), "ecosystem.config.js");
  assert.equal(normalizePm2EcosystemFile("config/ecosystem.js"), "config/ecosystem.js");
  assert.throws(() => normalizePm2EcosystemFile("../ecosystem.config.js"));
  assert.equal(
    normalizePm2EcosystemFile("config files/ecosystem config.js"),
    "config files/ecosystem config.js",
  );
  assert.equal(normalizePm2AppName("Ultimate_Project_Manager"), "Ultimate_Project_Manager");
  assert.equal(normalizePm2AppName("My App & Worker"), "My App & Worker");
  assert.equal(
    pathMatches(
      { projectRoot: "/srv/live", pm2RuntimeRoots: ["/srv/runtime/build-a"] },
      { cwd: "/srv/runtime/build-a", script: "/srv/runtime/build-a/app.js" },
    ),
    true,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "upm-pm2-start-"));
  await fs.writeFile(path.join(root, "ecosystem.config.js"), "module.exports = { apps: [] };\n");
  const calls = [];
  const deleted = [];
  const monitor = new Pm2Monitor({
    refreshMs: 60_000,
    actionDelayMs: 0,
    runner: async () => [],
    daemonPidProvider: async () => 123,
    deleteRunner: async (id) => {
      deleted.push(id);
      return { stdout: "deleted" };
    },
    projectStartRunner: async (projectRoot, ecosystemFile, appName) => {
      calls.push({ projectRoot, ecosystemFile, appName });
      return { stdout: "started" };
    },
  });

  await monitor.start(() => []);
  try {
    const result = await monitor.startProjectFromEcosystem({
      id: "p1",
      projectRoot: root,
      pm2EcosystemFile: "ecosystem.config.js",
      pm2EcosystemAppName: "Ultimate_Project_Manager",
    });
    assert.equal(result.action, "start-project");
    assert.equal(result.appName, "Ultimate_Project_Manager");
    assert.deepEqual(calls[0], {
      projectRoot: root,
      ecosystemFile: "ecosystem.config.js",
      appName: "Ultimate_Project_Manager",
    });
    const removed = await monitor.deleteProcess({
      id: 42,
      name: "slot-test",
      namespace: "default",
    });
    assert.equal(removed.action, "delete");
    assert.deepEqual(deleted, [42]);
    console.log("PM2 project start test passed.");
  } finally {
    monitor.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
