"use strict";

const assert = require("node:assert/strict");
const { BackupManager } = require("../src/manager/backup-manager");

async function main() {
  const manager = Object.create(BackupManager.prototype);
  manager.buildSlotSwitching = new Set();
  let release;
  const pending = manager._withBuildSlotOperation(
    "p1",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    manager._withBuildSlotOperation("p1", async () => {}),
    /already in progress/,
  );
  assert.equal(await manager._withBuildSlotOperation("p2", async () => 42), 42);
  release();
  await pending;
  await assert.rejects(
    manager._withBuildSlotOperation("p1", async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  assert.equal(manager.buildSlotSwitching.size, 0);

  const project = {
    id: "p1",
    projectRoot: "/source",
    pm2Monitoring: true,
    pm2ControlsEnabled: true,
  };
  const slot = { slotId: "slot1", appRoot: "/runtime/app" };
  const active = { type: "slot", root: slot.appRoot, slot };
  manager.projects = new Map([[project.id, project]]);
  manager._projectStartGate = async () => ({ ready: true });
  let syncCount = 0;
  manager.buildSlots = {
    refreshProject: async () => {},
    active: () => active,
    list: () => ({ slots: [slot] }),
    synchronize: async () => {
      syncCount += 1;
    },
  };
  manager.pm2Monitor = {
    refresh: async () => {},
    getProjectStatus: () => ({
      available: true,
      processes: [{ status: "online", cwd: slot.appRoot }],
    }),
  };
  const result = await manager.activateBuildSlot("p1", "slot1");
  assert.equal(result.alreadyActive, true);
  assert.equal(syncCount, 0, "An already-running slot must not have its overlays rewritten");
  assert.equal(manager.buildSlotSwitching.size, 0);
  manager._projectStartGate = async () => {
    throw new Error("gate failed");
  };
  await assert.rejects(manager.activateBuildSlot("p1", "slot1"), /gate failed/);
  assert.equal(manager.buildSlotSwitching.size, 0, "Preflight errors must release the lock");
  manager.pm2Monitor.getProjectStatus = () => ({
    available: true,
    processes: [
      { status: "online", cwd: slot.appRoot },
      { status: "errored", cwd: slot.appRoot },
    ],
  });
  await assert.rejects(manager._waitForBuildOnline("p1", slot.appRoot, { attempts: 1 }), /Not all/);
  manager.pm2Monitor.getProjectStatus = () => ({
    available: true,
    processes: [
      { status: "online", cwd: slot.appRoot },
      { status: "online", cwd: slot.appRoot },
    ],
  });
  assert.equal(
    (await manager._waitForBuildOnline("p1", slot.appRoot, { attempts: 1 })).processes.length,
    2,
  );
  console.log("Build switch safety checks passed.");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
