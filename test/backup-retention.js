"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { ProjectBackup } = require("../src/backup/project-backup");

async function writeIndexedBackup(backupDir, file, createdAt) {
  const target = path.join(backupDir, file);
  await fsp.writeFile(target, Buffer.from(file));
  return {
    file,
    createdAt,
    size: Buffer.byteLength(file),
    projectHash: null,
    archiveSha256: null,
    verificationStatus: "unverified",
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-retention-"));
  try {
    const projectRoot = path.join(temp, "project");
    const backupDir = path.join(temp, "backups");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), "{}\n");

    const engine = new ProjectBackup({
      projectRoot,
      backupDir,
      projectName: "Retention Test",
      keep: 2,
    });

    const files = [
      ["Retention-Test_2026-08-23_01-00-00.tar.gz", "2026-08-23T06:00:00.000Z"],
      ["Retention-Test_2026-08-23_02-00-00.tar.gz", "2026-08-23T07:00:00.000Z"],
      ["Retention-Test_2026-08-23_03-00-00.tar.gz", "2026-08-23T08:00:00.000Z"],
      ["Retention-Test_2026-08-23_04-00-00.tar.gz", "2026-08-23T09:00:00.000Z"],
    ];
    const entries = [];
    for (const [file, createdAt] of files) {
      entries.push(await writeIndexedBackup(backupDir, file, createdAt));
    }
    await fsp.writeFile(
      path.join(backupDir, ".backup-index.json"),
      JSON.stringify({ version: 5, backups: entries }, null, 2),
    );

    const current = await engine.inspect();
    await fsp.writeFile(
      path.join(backupDir, ".backup-state.json"),
      JSON.stringify(
        {
          version: 5,
          projectName: "Retention-Test",
          projectRoot,
          projectHash: current.current.projectHash,
          backupFile: files[3][0],
          backupCreatedAt: files[3][1],
          encrypted: false,
          files: current.current.files,
        },
        null,
        2,
      ),
    );

    const unchanged = await engine.backupIfChanged();
    assert.equal(unchanged.created, false);
    assert.equal(unchanged.reason, "no-changes");
    assert.equal(unchanged.retention.removed.length, 2);
    assert.equal(unchanged.retention.failures.length, 0);
    assert.equal((await engine.listBackups()).length, 2);

    const lockedFile = "Retention-Test_2026-08-23_00-30-00.tar.gz";
    const lockedEntry = await writeIndexedBackup(backupDir, lockedFile, "2026-08-23T05:30:00.000Z");
    const currentIndex = JSON.parse(
      await fsp.readFile(path.join(backupDir, ".backup-index.json"), "utf8"),
    );
    currentIndex.backups.push(lockedEntry);
    await fsp.writeFile(
      path.join(backupDir, ".backup-index.json"),
      JSON.stringify(currentIndex, null, 2),
    );

    const originalUnlink = fsp.unlink;
    fsp.unlink = async (target) => {
      if (path.basename(target) === lockedFile) {
        const error = new Error("simulated Windows file lock");
        error.code = "EPERM";
        throw error;
      }
      return originalUnlink(target);
    };

    let lockedResult;
    try {
      lockedResult = await engine.prune();
    } finally {
      fsp.unlink = originalUnlink;
    }

    assert.equal(lockedResult.failures.length, 1);
    assert.equal(lockedResult.failures[0].file, lockedFile);
    assert.equal(lockedResult.satisfied, false);
    assert.equal(await fsp.stat(path.join(backupDir, lockedFile)).then(() => true), true);
    assert.equal(
      (await engine.listBackups()).some((item) => item.file === lockedFile),
      true,
      "a failed deletion must remain indexed so a later retention pass can retry it",
    );

    const txProjectRoot = path.join(temp, "transaction-project");
    const txBackupDir = path.join(temp, "transaction-backups");
    await fsp.mkdir(txProjectRoot, { recursive: true });
    await fsp.writeFile(path.join(txProjectRoot, "package.json"), "{}\n");
    await fsp.writeFile(path.join(txProjectRoot, "index.js"), "module.exports = 1;\n");
    const txEngine = new ProjectBackup({
      projectRoot: txProjectRoot,
      backupDir: txBackupDir,
      projectName: "Transaction Test",
      keep: 5,
    });
    const txFirst = await txEngine.backupIfChanged({ force: true });
    assert.equal(txFirst.created, true);
    const stateFile = path.join(txBackupDir, ".backup-state.json");
    const stateBeforeFailure = JSON.parse(await fsp.readFile(stateFile, "utf8"));

    await fsp.writeFile(path.join(txProjectRoot, "index.js"), "module.exports = 2;\n");
    const originalWriteState = txEngine._writeState.bind(txEngine);
    txEngine._writeState = async () => {
      throw new Error("simulated state commit failure");
    };
    await assert.rejects(() => txEngine.backupIfChanged(), /simulated state commit failure/);
    txEngine._writeState = originalWriteState;
    const stateAfterStateFailure = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    assert.equal(stateAfterStateFailure.backupFile, stateBeforeFailure.backupFile);
    assert.equal(
      await fsp.stat(path.join(txBackupDir, stateAfterStateFailure.backupFile)).then(
        () => true,
        () => false,
      ),
      true,
      "the previous baseline archive must still exist when state commit fails",
    );
    assert.ok(
      (await txEngine.listBackups()).length >= 2,
      "a verified archive must remain once it has been registered in the index",
    );

    await fsp.writeFile(path.join(txProjectRoot, "index.js"), "module.exports = 3;\n");
    const originalPrune = txEngine.prune.bind(txEngine);
    txEngine.prune = async () => {
      throw new Error("simulated retention failure after state commit");
    };
    await assert.rejects(
      () => txEngine.backupIfChanged(),
      /simulated retention failure after state commit/,
    );
    txEngine.prune = originalPrune;

    const stateAfterRetentionFailure = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    assert.notEqual(
      stateAfterRetentionFailure.backupFile,
      stateBeforeFailure.backupFile,
      "baseline state should advance before retention runs",
    );
    assert.equal(
      await fsp.stat(path.join(txBackupDir, stateAfterRetentionFailure.backupFile)).then(
        () => true,
        () => false,
      ),
      true,
      "the committed baseline archive must remain on disk when retention fails",
    );
    for (const backup of await txEngine.listBackups()) {
      assert.equal(
        await fsp.stat(backup.path).then(
          () => true,
          () => false,
        ),
        true,
        `indexed backup must exist on disk: ${backup.file}`,
      );
    }

    const deletedBaseline = stateAfterRetentionFailure.backupFile;
    const originalDeleteUnlink = fsp.unlink;
    let deleteAttempts = 0;
    fsp.unlink = async (target) => {
      if (path.basename(target) === deletedBaseline && deleteAttempts++ === 0) {
        const error = new Error("simulated transient Windows delete lock");
        error.code = "EPERM";
        throw error;
      }
      return originalDeleteUnlink(target);
    };
    try {
      await txEngine.deleteBackup(deletedBaseline);
    } finally {
      fsp.unlink = originalDeleteUnlink;
    }
    assert.ok(deleteAttempts >= 2, "explicit backup deletion should retry transient file locks");
    assert.equal(
      (await txEngine.listBackups()).some((item) => item.file === deletedBaseline),
      false,
      "deleted backup must be removed from the index",
    );
    const clearedState = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    assert.equal(clearedState.backupFile, null);
    assert.ok(clearedState.baselineClearedAt);
    const afterDeleteInspect = await txEngine.inspect();
    assert.equal(afterDeleteInspect.baselineArchiveMissing, true);
    assert.equal(afterDeleteInspect.changed, true);

    console.log("Backup retention tests passed.");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
