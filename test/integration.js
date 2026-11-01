"use strict";

const assert = require("assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  BackupManager,
  computeNextScheduledAt,
  normalizeProject,
} = require("../src/manager/backup-manager");
const { ProjectBackup } = require("../src/backup/project-backup");
const { RemoteProjectExecutor } = require("../src/remote-agent/remote-project-executor");

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-integration-test-"));
  const projectRoot = path.join(root, "projects", "sample");
  const nestedRoot = path.join(root, "projects", "nested", "child");
  const fakeNodeModules = path.join(root, "projects", "sample", "node_modules", "ignored-package");
  const dataDir = path.join(root, "manager-data");
  const secondaryBackupDir = path.join(root, "secondary-backups");
  await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fsp.mkdir(nestedRoot, { recursive: true });
  await fsp.mkdir(fakeNodeModules, { recursive: true });

  await fsp.writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "sample-project", version: "1.0.0" }, null, 2),
  );
  await fsp.writeFile(path.join(projectRoot, ".gitignore"), "ignored.txt\nnode_modules/\n");
  await fsp.writeFile(path.join(projectRoot, "src", "index.js"), 'console.log("one");\n');
  await fsp.writeFile(path.join(projectRoot, "ignored.txt"), "ignore me\n");
  await fsp.writeFile(
    path.join(nestedRoot, "package.json"),
    JSON.stringify({ name: "nested-child" }),
  );
  await fsp.writeFile(
    path.join(fakeNodeModules, "package.json"),
    JSON.stringify({ name: "must-not-discover" }),
  );

  const manager = new BackupManager({ dataDir });
  await manager.init();

  try {
    const longNameProject = normalizeProject({
      name: "x".repeat(400),
      projectRoot,
    });
    assert.ok(longNameProject.backupFolderName.length <= 255);
    assert.match(longNameProject.backupFolderName, /-[A-Fa-f0-9-]{8}$/);

    const unsafeFolderImport = await manager.importProjectSetup([
      {
        id: "unsafe-folder-import",
        name: "Unsafe Folder Import",
        projectRoot,
        backupFolderName: "../escaped-backups",
      },
    ]);
    assert.equal(unsafeFolderImport.applied, false);
    assert.equal(unsafeFolderImport.errors.length, 1);
    assert.match(unsafeFolderImport.errors[0].error, /safe path component/i);

    const unsafeIdImport = await manager.importProjectSetup([
      {
        id: "../unsafe-id",
        name: "Unsafe Id Import",
        projectRoot,
      },
    ]);
    assert.equal(unsafeIdImport.applied, false);
    assert.equal(unsafeIdImport.errors.length, 1);
    assert.match(unsafeIdImport.errors[0].error, /safe path component/i);

    const agentExecutor = new RemoteProjectExecutor({
      dataDir: path.join(root, "agent-data"),
      backupRoot: path.join(root, "agent-backups"),
      restoreRoot: path.join(root, "agent-restores"),
      allowedProjectRoots: [path.join(root, "projects")],
    });
    await assert.rejects(
      () =>
        agentExecutor.validate({
          id: "remote-project",
          name: "Remote Project",
          projectRoot,
          backupFolderName: "../../escaped-journal",
        }),
      /safe path component/i,
    );

    const project = await manager.addProject({
      name: "Sample Project",
      projectRoot,
      keep: 2,
      watch: false,
      schedule: { enabled: false },
      backupDirSecondary: secondaryBackupDir,
    });

    const first = await manager.runBackup(project.id, { source: "test" });
    assert.equal(first.created, true);
    assert.equal(first.verified, true);
    assert.equal(
      await fileExists(first.archivePath),
      true,
      "a successful unencrypted backup must remain on disk after verification",
    );

    const unchanged = await manager.runBackup(project.id, { source: "test" });
    assert.equal(unchanged.created, false);
    assert.equal(unchanged.reason, "no-changes");

    await fsp.writeFile(path.join(projectRoot, "ignored.txt"), "changed but ignored\n");
    const ignoredOnly = await manager.runBackup(project.id, { source: "test" });
    assert.equal(ignoredOnly.created, false);

    await fsp.writeFile(path.join(projectRoot, "src", "index.js"), 'console.log("two");\n');
    const second = await manager.runBackup(project.id, { source: "test" });
    assert.equal(second.created, true);

    let backups = await manager.listBackups(project.id);
    assert.equal(backups.length, 2);
    assert.ok(backups.every((backup) => backup.verificationStatus === "verified"));
    assert.ok(
      backups.every((backup) => backup.copyCount === 2 && backup.mirrorHealthy),
      "each logical backup should have two verified copies",
    );
    assert.ok(
      backups.every((backup) =>
        backup.destinations.some(
          (copy) => copy.key === "secondary" && copy.verificationStatus === "verified",
        ),
      ),
    );

    const verify = await manager.verifyBackup(project.id, backups[0].file);
    assert.equal(verify.valid, true);
    assert.equal(verify.contentHashMatch, true);
    assert.equal(verify.archiveHashMatch, true);

    const restoreDir = path.join(root, "restored");
    const restored = await manager.restoreBackup(project.id, backups[0].file, {
      destination: restoreDir,
    });
    assert.equal(restored.restored, true);
    assert.equal(
      await fsp.readFile(path.join(restoreDir, "src", "index.js"), "utf8"),
      'console.log("two");\n',
    );
    assert.equal(await fileExists(path.join(restoreDir, "ignored.txt")), false);

    const restoreEscapeLink = path.join(root, "restore-escape-link");
    try {
      await fsp.symlink(
        projectRoot,
        restoreEscapeLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        () =>
          manager.restoreBackup(project.id, backups[0].file, {
            destination: restoreEscapeLink,
            overwrite: true,
          }),
        /Refusing to restore into the registered project tree/,
      );
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    }

    const storage = await manager.getStorageStats();
    assert.equal(storage.totalBackups, 2);
    assert.equal(storage.totalCopies, 4);
    assert.ok(storage.totalBytes > 0);
    assert.equal(storage.verifiedCount, 2);
    assert.equal(storage.mirroredProjects, 1);
    assert.equal(storage.mirrorWarnings, 0);

    const beforeRenameDir = manager.getProject(project.id).backupDirResolved;
    await manager.updateProject(project.id, { name: "Renamed Sample Project" });
    const renamed = manager.getProject(project.id);
    assert.equal(
      renamed.backupDirResolved,
      beforeRenameDir,
      "renaming a project must not move its default backup directory",
    );
    assert.equal(
      (await manager.listBackups(project.id)).length,
      2,
      "renaming a project must preserve backup history",
    );

    const discovery = await manager.discoverProjects([path.join(root, "projects")], {
      maxDepth: 5,
    });
    const discoveredNames = discovery.projects.map((item) => item.name);
    assert.ok(discoveredNames.includes("sample-project"));
    assert.ok(discoveredNames.includes("nested-child"));
    assert.ok(!discoveredNames.includes("must-not-discover"));
    assert.equal(
      discovery.projects.find((item) => item.name === "sample-project").registered,
      true,
    );

    await fsp.writeFile(path.join(projectRoot, "src", "index.js"), 'console.log("three");\n');
    const third = await manager.runBackup(project.id, { source: "test" });
    assert.equal(third.created, true);
    backups = await manager.listBackups(project.id);
    assert.equal(backups.length, 2, "retention should keep only the newest two backups");

    const corruptTarget = backups[0];
    await fsp.appendFile(corruptTarget.path, Buffer.from("intentional-corruption"));
    const corruptVerify = await manager.verifyBackup(project.id, corruptTarget.file);
    assert.equal(corruptVerify.valid, false, "archive SHA-256 should detect appended corruption");

    const volatileRoot = path.join(root, "projects", "volatile");
    const volatileBackupDir = path.join(root, "volatile-backups");
    await fsp.mkdir(volatileRoot, { recursive: true });
    await fsp.writeFile(
      path.join(volatileRoot, "package.json"),
      JSON.stringify({ name: "volatile-project" }),
    );
    await fsp.writeFile(path.join(volatileRoot, "live.log"), "before\n");

    const volatileEngine = new ProjectBackup({
      projectRoot: volatileRoot,
      backupDir: volatileBackupDir,
      projectName: "Volatile Project",
      keep: 2,
    });
    const originalInspect = volatileEngine.inspect.bind(volatileEngine);
    let mutateAfterInspect = true;
    volatileEngine.inspect = async () => {
      const inspected = await originalInspect();
      if (mutateAfterInspect) {
        mutateAfterInspect = false;
        await fsp.writeFile(path.join(volatileRoot, "live.log"), "after inspect\n");
      }
      return inspected;
    };

    const volatileBackup = await volatileEngine.backupIfChanged();
    assert.equal(volatileBackup.created, true);
    assert.equal(volatileBackup.verified, true);
    assert.equal(volatileBackup.sourceDriftedDuringSnapshot, true);
    const volatileVerify = await volatileEngine.verifyBackup(
      path.basename(volatileBackup.archivePath),
    );
    assert.equal(volatileVerify.valid, true);
    const volatileUnchanged = await volatileEngine.backupIfChanged();
    assert.equal(volatileUnchanged.created, false);
    assert.equal(volatileUnchanged.reason, "no-changes");

    const missingBaselineRoot = path.join(root, "projects", "missing-baseline");
    const missingBaselineBackupDir = path.join(root, "missing-baseline-backups");
    await fsp.mkdir(missingBaselineRoot, { recursive: true });
    await fsp.writeFile(
      path.join(missingBaselineRoot, "package.json"),
      JSON.stringify({ name: "missing-baseline-project" }),
    );
    await fsp.writeFile(path.join(missingBaselineRoot, "source.txt"), "stable\n");

    const missingBaselineEngine = new ProjectBackup({
      projectRoot: missingBaselineRoot,
      backupDir: missingBaselineBackupDir,
      projectName: "Missing Baseline Project",
      keep: 2,
    });
    const baseline = await missingBaselineEngine.backupIfChanged();
    assert.equal(baseline.created, true);
    await fsp.unlink(baseline.archivePath);
    const rebuiltBaseline = await missingBaselineEngine.backupIfChanged();
    assert.equal(
      rebuiltBaseline.created,
      true,
      "a missing archive referenced by backup state must be rebuilt even when source files are unchanged",
    );
    assert.equal(rebuiltBaseline.recoveredMissingBaseline, true);
    assert.equal(await fileExists(rebuiltBaseline.archivePath), true);

    const now = new Date(2026, 7, 19, 10, 0, 0, 0);
    const daily = computeNextScheduledAt({ enabled: true, type: "daily", time: "11:30" }, now);
    assert.equal(daily.getHours(), 11);
    assert.equal(daily.getMinutes(), 30);
    assert.equal(daily.getDate(), now.getDate());

    console.log("Integration test passed.");
  } finally {
    await manager.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
