"use strict";

const assert = require("node:assert/strict");
const { BackupManager, normalizeProject } = require("../src/manager/backup-manager");

async function main() {
  const local = normalizeProject({
    id: "local-project",
    name: "Local Project",
    projectRoot: process.cwd(),
    pm2Monitoring: true,
    pm2ControlsEnabled: true,
    pm2AutoStart: true,
    pm2WaitForDocker: true,
    pm2RequiredContainers: ["redis", "database"],
    pm2StartupGateTimeoutSeconds: 45,
    pm2RequireElevation: true,
  });
  assert.equal(local.pm2WaitForDocker, true);
  assert.deepEqual(local.pm2RequiredContainers, ["redis", "database"]);
  assert.equal(local.pm2StartupGateTimeoutSeconds, 45);
  assert.equal(local.pm2RequireElevation, true);

  const remote = normalizeProject({
    id: "remote-project",
    name: "Remote Project",
    projectRoot: "C:\\Projects\\Remote",
    executionTarget: "lan",
    remoteAgentId: "agent-1",
    pm2WaitForDocker: true,
    pm2RequiredContainers: ["redis"],
    pm2RequireElevation: true,
  });
  assert.equal(remote.pm2WaitForDocker, false);
  assert.deepEqual(remote.pm2RequiredContainers, []);
  assert.equal(remote.pm2RequireElevation, false);

  let dockerStatus = {
    checkedAt: new Date().toISOString(),
    runtime: "Docker Desktop",
    running: true,
    daemonReady: false,
    message: "Docker Desktop is running; waiting for the Docker daemon.",
  };
  let executed = 0;
  const proc = { id: 7, name: "demo", status: "stopped" };
  const manager = Object.create(BackupManager.prototype);
  const gatedLocal = {
    ...local,
    pm2RequiredContainers: [],
    pm2RequireElevation: false,
  };
  manager.projects = new Map([[local.id, gatedLocal]]);
  manager.buildSlots = {
    active: (project) => ({ type: "source", root: project.projectRoot, slot: null }),
  };
  manager.buildSlotSwitching = new Set();
  manager.pm2AutoStartSuppressed = new Set();
  manager.pm2StartQueue = new Map();
  manager.pm2AutoStartRunning = new Set();
  manager.runtime = new Map();
  manager._runtime = BackupManager.prototype._runtime;
  manager.elevationChecker = async () => ({
    platform: process.platform,
    elevated: false,
    level: "standard",
  });
  manager.dockerRuntimeMonitor = {
    getCurrent: () => ({ ...dockerStatus }),
    refresh: async () => ({ ...dockerStatus }),
  };
  manager.pm2Monitor = {
    getProjectStatus: () => ({
      available: true,
      processes: [{ ...proc }],
    }),
    executeAction: async (_process, action) => {
      executed += 1;
      return { action };
    },
    startProjectFromEcosystem: async () => {
      throw new Error("ecosystem start should not be used for a registered stopped process");
    },
  };
  manager.refreshPm2 = async () => {};
  manager.log = async () => {};

  const delayedProjectStart = await manager.startProjectInPm2(local.id, { refresh: false });
  assert.equal(delayedProjectStart.started, false);
  assert.equal(delayedProjectStart.waiting, true);
  assert.equal(delayedProjectStart.reason, "waiting-for-docker");
  assert.equal(executed, 0);

  const delayedProcessStart = await manager.runPm2Action(local.id, proc.id, "start");
  assert.equal(delayedProcessStart.delayed, true);
  assert.equal(delayedProcessStart.reason, "waiting-for-docker");
  assert.equal(executed, 0);

  dockerStatus = {
    ...dockerStatus,
    state: "ready",
    running: true,
    daemonReady: true,
    message: "Docker Desktop daemon ready.",
  };

  const started = await manager.startProjectInPm2(local.id, { refresh: false });
  assert.equal(started.started, true);
  assert.equal(started.mode, "existing-processes");
  assert.equal(executed, 1);

  const restarted = await manager.runPm2Action(local.id, proc.id, "restart");
  assert.equal(restarted.action, "restart");
  assert.equal(restarted.delayed, undefined);
  assert.equal(executed, 2);

  manager.projects.set(local.id, {
    ...gatedLocal,
    pm2WaitForDocker: false,
    pm2RequiredContainers: ["redis", "database"],
  });
  let containersReady = false;
  manager.dockerRuntimeMonitor.inspectContainers = async (names) => ({
    ready: containersReady,
    containers: names.map((name) => ({
      name,
      found: true,
      running: true,
      healthcheck: name === "database",
      healthStatus: name === "database" ? (containersReady ? "healthy" : "starting") : null,
      ready: containersReady || name === "redis",
      status: name === "database" ? (containersReady ? "healthy" : "starting") : "running",
    })),
    message: containersReady
      ? "Docker dependencies ready."
      : "Waiting for Docker containers: database (starting).",
  });

  const containerDelayed = await manager.startProjectInPm2(local.id, { refresh: false });
  assert.equal(containerDelayed.started, false);
  assert.equal(containerDelayed.reason, "waiting-for-containers");
  assert.equal(containerDelayed.queued, true);
  assert.equal(manager.pm2StartQueue.has(local.id), true);
  assert.equal(manager._runtime(local.id).pm2StartGate.state, "waiting-for-containers");

  containersReady = true;
  await manager._handlePm2QueuedStarts({
    projects: [{ projectId: local.id, available: true, processes: [{ ...proc }] }],
  });
  assert.equal(manager.pm2StartQueue.has(local.id), false);
  assert.equal(manager._runtime(local.id).pm2StartGate, null);
  assert.equal(executed, 3);

  manager.projects.set(local.id, {
    ...gatedLocal,
    pm2WaitForDocker: false,
    pm2RequiredContainers: [],
    pm2RequireElevation: true,
  });
  const elevationDelayed = await manager.startProjectInPm2(local.id, { refresh: false });
  assert.equal(elevationDelayed.reason, "elevation-required");
  assert.equal(elevationDelayed.queued, false);
  assert.equal(manager._runtime(local.id).pm2StartGate.queued, false);
  assert.equal(executed, 3);

  manager.elevationChecker = async () => ({
    platform: process.platform,
    elevated: true,
    level: process.platform === "win32" ? "administrator" : "root",
  });
  const elevatedStart = await manager.startProjectInPm2(local.id, { refresh: false });
  assert.equal(elevatedStart.started, true);
  assert.equal(executed, 4);

  console.log("PM2 Docker/container/elevation startup gate tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
