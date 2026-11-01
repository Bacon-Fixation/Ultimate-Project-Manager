"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  BuildSlotManager,
  normalizeOverlayPaths,
  slotIdFor,
} = require("../src/runtime/build-slot-manager");

async function main() {
  assert.deepEqual(normalizeOverlayPaths(undefined), [".env"]);
  assert.deepEqual(normalizeOverlayPaths([".env", "config.json", ".env"]), [".env", "config.json"]);
  assert.throws(() => normalizeOverlayPaths(["../secret"]));
  assert.throws(() => normalizeOverlayPaths(["node_modules"]));
  for (const unsafe of ["node_modules/pkg", "NODE_MODULES/pkg", "C:/config", "file:stream"])
    assert.throws(() => normalizeOverlayPaths([unsafe]));
  assert.equal(slotIdFor({ file: "a.tar.gz", projectHash: "abc" }).length, 20);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-build-slots-"));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  await fsp.mkdir(path.join(sourceRoot, "node_modules", "example"), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, ".env"), "TOKEN=current\n");
  await fsp.writeFile(path.join(sourceRoot, "config.json"), '{"current":true}\n');
  await fsp.writeFile(path.join(sourceRoot, "package.json"), '{"name":"live","version":"2.0.0"}\n');
  await fsp.writeFile(
    path.join(sourceRoot, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{}}\n',
  );

  const project = {
    id: "project-1",
    name: "Build Slot Test",
    projectRoot: sourceRoot,
    buildSlotOverlayPaths: [".env", "config.json"],
    buildSlotLinkNodeModules: true,
  };
  const backup = {
    file: "Build-Slot-Test_2026-09-16_00-00-00.tar.gz",
    projectHash: "backup-hash",
    archiveSha256: "archive-hash",
    createdAt: "2026-09-16T05:00:00.000Z",
    fileCount: 3,
    sourceBytes: 1234,
  };

  const manager = new BuildSlotManager({ root: runtimeRoot });
  await manager.init();
  await manager.refreshProject(project.id);
  try {
    const prepared = await manager.prepare(project, backup, {
      backupDestination: "primary",
      restore: async (destination) => {
        await fsp.mkdir(destination, { recursive: true });
        await fsp.writeFile(path.join(destination, ".env"), "TOKEN=backup\n");
        await fsp.writeFile(path.join(destination, "config.json"), '{"current":false}\n');
        await fsp.writeFile(path.join(destination, "app.js"), "console.log('backup');\n");
        await fsp.writeFile(
          path.join(destination, "package.json"),
          '{"name":"old","version":"1.0.0"}\n',
        );
        return { fileCount: 4, sourceBytes: 2222 };
      },
    });
    assert.equal(prepared.prepared, true);
    assert.ok(prepared.slot?.appRoot);
    assert.equal((await manager.list(project)).slots.length, 1);

    const synced = await manager.synchronize(project, prepared.slot);
    assert.equal(
      await fsp.readFile(path.join(prepared.slot.appRoot, ".env"), "utf8"),
      "TOKEN=current\n",
    );
    assert.equal(
      await fsp.readFile(path.join(prepared.slot.appRoot, "config.json"), "utf8"),
      '{"current":true}\n',
    );
    assert.equal(synced.dependencyMismatch, true);
    assert.equal(synced.nodeModules.linked, true);
    const modulesStat = await fsp.lstat(path.join(prepared.slot.appRoot, "node_modules"));
    assert.equal(modulesStat.isSymbolicLink(), true);

    // A nested link must not escape the source tree or survive into a runtime slot.
    if (process.platform !== "win32") {
      const overlaySource = path.join(sourceRoot, "settings");
      const overlayTarget = path.join(prepared.slot.appRoot, "settings");
      await fsp.mkdir(overlaySource);
      await fsp.mkdir(overlayTarget);
      await fsp.writeFile(path.join(overlayTarget, "keep.txt"), "previous");
      await fsp.symlink(root, path.join(overlaySource, "outside"), "dir");
      await assert.rejects(
        manager.synchronize(project, prepared.slot, { overlayPaths: ["settings"] }),
        /nested symlinks/i,
      );
      assert.equal(await fsp.readFile(path.join(overlayTarget, "keep.txt"), "utf8"), "previous");
    }

    const active = await manager.setActive(project, { type: "slot", slotId: prepared.slot.slotId });
    assert.equal(active.type, "slot");
    assert.equal(active.slot.slotId, prepared.slot.slotId);
    assert.deepEqual(manager.runtimeRoots(project.id), [prepared.slot.appRoot]);

    await assert.rejects(() => manager.delete(project, prepared.slot.slotId), /active build slot/i);
    const source = await manager.setActive(project, { type: "source" });
    assert.equal(source.type, "source");
    await manager.delete(project, prepared.slot.slotId);
    assert.equal((await manager.refreshProject(project.id)).slots.length, 0);

    console.log("Build slot manager checks passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
