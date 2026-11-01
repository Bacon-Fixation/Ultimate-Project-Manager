"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { once } = require("events");
const { createRemoteAgentApp } = require("../src/remote-agent/server");
const { RemoteAgentClient } = require("../src/remote-agent/remote-agent-client");

class FakePm2Monitor {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.status = {
      available: true,
      checkedAt: new Date().toISOString(),
      error: null,
      daemonPid: 1234,
      processCount: 1,
      online: 1,
      stopped: 0,
      errored: 0,
      other: 0,
      processes: [
        {
          id: 7,
          name: "remote-demo",
          namespace: "default",
          status: "online",
          pid: 999,
          uptimeMs: 1000,
          restarts: 0,
          cpu: 1,
          memoryBytes: 1024,
          cwd: projectRoot,
          script: path.join(projectRoot, "index.js"),
        },
      ],
    };
  }
  async start() {
    return this;
  }
  stop() {}
  async refresh() {
    this.status.checkedAt = new Date().toISOString();
    return this.status;
  }
  getStatus() {
    return {
      ...this.status,
      processes: this.status.processes.map((item) => ({ ...item })),
    };
  }
}

class FakeDockerRuntimeMonitor {
  async start() {
    return this;
  }
  stop() {}
  getCurrent() {
    return {
      checkedAt: new Date().toISOString(),
      runtime: "Docker Desktop",
      state: "ready",
      running: true,
      daemonReady: true,
      serviceRunning: true,
      serverVersion: "test",
    };
  }
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-lan-agent-"));
  const projectsRoot = path.join(root, "projects");
  const projectRoot = path.join(projectsRoot, "demo");
  const backupRoot = path.join(root, "backups");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.writeFile(path.join(projectRoot, "package.json"), '{"name":"demo"}\n');
  await fsp.writeFile(path.join(projectRoot, "index.js"), 'console.log("hello");\n');

  const token = "a".repeat(64);

  assert.throws(
    () =>
      new RemoteAgentClient({
        agents: [
          {
            id: "insecure-lan",
            name: "Insecure LAN",
            url: "http://192.168.1.25:4311",
            token,
          },
        ],
      }),
    /uses insecure HTTP/,
  );
  const ipv6Loopback = new RemoteAgentClient({
    agents: [
      {
        id: "ipv6-loopback",
        name: "IPv6 Loopback",
        url: "http://[::1]:4311",
        token,
      },
    ],
  });
  assert.equal(ipv6Loopback.listPublic()[0].secureTransport, false);

  const explicitlyAllowedHttp = new RemoteAgentClient({
    allowInsecureHttp: true,
    agents: [
      {
        id: "trusted-lan",
        name: "Trusted LAN",
        url: "http://192.168.1.25:4311",
        token,
      },
    ],
  });
  assert.equal(explicitlyAllowedHttp.listPublic()[0].secureTransport, false);
  assert.equal(explicitlyAllowedHttp.listPublic()[0].insecureHttpAllowed, true);

  const app = createRemoteAgentApp({
    token,
    agentId: "test-agent",
    agentName: "Test Agent",
    dataDir: path.join(root, "agent-data"),
    backupRoot,
    allowedProjectRoots: [projectsRoot],
    pm2Monitor: new FakePm2Monitor(projectRoot),
    dockerRuntimeMonitor: new FakeDockerRuntimeMonitor(),
  });
  await app.locals.start();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const client = new RemoteAgentClient({
    agents: [
      {
        id: "test-agent",
        name: "Test Agent",
        url: `http://127.0.0.1:${port}`,
        token,
      },
    ],
  });
  const project = {
    id: "12345678-0000-0000-0000-000000000000",
    name: "Remote Demo",
    projectRoot,
    backupDir: null,
    backupDirSecondary: null,
    keep: 3,
    extraExcludes: [],
    pm2Monitoring: true,
    pm2ProcessNames: [],
    backupEncryptionEnabled: false,
    deltaJournalEnabled: false,
  };

  try {
    const health = await client.health("test-agent");
    assert.equal(health.health.id, "test-agent");
    assert.equal(health.dockerRuntime.daemonReady, true);

    const validation = await client.validateProject("test-agent", project);
    assert.equal(validation.ok, true);
    assert.equal(path.resolve(validation.project.projectRoot), path.resolve(projectRoot));

    project.serviceHealth = {
      enabled: false,
      intervalSeconds: 30,
      timeoutMs: 1000,
      services: [],
    };
    const serviceHealth = await client.serviceHealth("test-agent", project);
    assert.equal(serviceHealth.health.status, "disabled");

    const pm2 = await client.pm2Projects("test-agent", [project], {
      refresh: true,
    });
    assert.equal(pm2.projects.length, 1);
    assert.equal(pm2.projects[0].status, "online");
    assert.equal(pm2.projects[0].online, 1);
    assert.equal(pm2.projects[0].controlsEnabled, false);
    assert.equal(pm2.dockerRuntime.daemonReady, true);

    const first = await client.backupProject("test-agent", project, {
      force: true,
    });
    assert.equal(first.result.created, true);
    assert.equal(first.result.primaryCommitted, true);

    const second = await client.backupProject("test-agent", project);
    assert.equal(second.result.created, false);

    const listed = await client.listBackups("test-agent", project);
    assert.equal(listed.backups.length, 1);
    assert.equal(listed.backups[0].verificationStatus, "verified");

    const verify = await client.verifyBackup("test-agent", project, listed.backups[0].file);
    assert.equal(verify.result.valid, true);

    const storage = await client.storage("test-agent", project);
    assert.equal(storage.storage.backupCount, 1);
    assert.ok(storage.storage.totalBytes > 0);
    assert.ok(storage.storage.destinations[0].filesystem);
    assert.ok(storage.storage.destinations[0].filesystem.totalBytes > 0);
    assert.ok(storage.storage.destinations[0].filesystem.root);

    const download = await client.download("test-agent", project, listed.backups[0].file);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.ok(bytes.length > 0);

    await assert.rejects(
      () => client.validateProject("test-agent", { ...project, projectRoot: root }),
      /outside UPM_AGENT_ALLOWED_PROJECT_ROOTS/,
    );

    await assert.rejects(
      () =>
        client.validateProject("test-agent", {
          ...project,
          backupDirSecondary: path.join(root, "unapproved-backups"),
        }),
      /outside UPM_AGENT_ALLOWED_BACKUP_ROOTS/,
    );

    await assert.rejects(
      () =>
        client.restoreBackup("test-agent", project, listed.backups[0].file, {
          destination: path.join(root, "unapproved-restore"),
        }),
      /outside UPM_AGENT_ALLOWED_RESTORE_ROOTS/,
    );

    const badClient = new RemoteAgentClient({
      agents: [
        {
          id: "test-agent",
          name: "Test Agent",
          url: `http://127.0.0.1:${port}`,
          token: "b".repeat(64),
        },
      ],
    });
    await assert.rejects(() => badClient.health("test-agent"), /Invalid LAN agent token/);

    console.log("remote-agent tests passed");
  } finally {
    await app.locals.shutdown();
    await new Promise((resolve) => {
      server.close(resolve);
    });
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
