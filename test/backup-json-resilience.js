"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { ProjectBackup } = require("../src/backup/project-backup");

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-json-resilience-"));
  try {
    const projectRoot = path.join(root, "project");
    const backupDir = path.join(root, "backups");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");

    const engine = new ProjectBackup({
      projectRoot,
      backupDir,
      projectName: "JSON Resilience",
      keep: 5,
    });
    const indexFile = path.join(backupDir, ".backup-index.json");
    const first = {
      file: "JSON-Resilience_2026-08-31_01-00-00.tar.gz",
      createdAt: "2026-08-31T06:00:00.000Z",
      size: 100,
    };
    const second = {
      file: "JSON-Resilience_2026-08-31_02-00-00.tar.gz",
      createdAt: "2026-08-31T07:00:00.000Z",
      size: 200,
    };

    await engine._writeIndex([first]);

    const originalRename = fsp.rename;
    const originalSetTimeout = global.setTimeout;
    let blockedRenames = 0;
    fsp.rename = async (source, destination) => {
      if (destination === indexFile && String(source).endsWith(".tmp")) {
        blockedRenames += 1;
        const error = new Error("simulated Windows destination lock");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(source, destination);
    };
    global.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);

    try {
      await engine._writeIndex([second]);
    } finally {
      fsp.rename = originalRename;
      global.setTimeout = originalSetTimeout;
    }

    assert.ok(blockedRenames > 1, "atomic JSON replacement should retry transient EPERM errors");
    const committed = JSON.parse(await fsp.readFile(indexFile, "utf8"));
    assert.equal(committed.version, 5);
    assert.equal(committed.backups.length, 1);
    assert.equal(committed.backups[0].file, second.file);

    const lastKnownGood = JSON.parse(await fsp.readFile(`${indexFile}.bak`, "utf8"));
    assert.equal(lastKnownGood.backups[0].file, first.file);

    await fsp.writeFile(indexFile, "[1 2]\n", "utf8");
    const recoveredFromBackup = await engine._readIndex();
    assert.equal(
      recoveredFromBackup.backups[0].file,
      first.file,
      "a malformed live index should recover from the last-known-good backup",
    );

    const third = {
      file: "JSON-Resilience_2026-08-31_03-00-00.tar.gz",
      createdAt: "2026-08-31T08:00:00.000Z",
      size: 300,
    };
    const recoveryTemp = `${indexFile}.99999.${Date.now()}.tmp`;
    await fsp.writeFile(
      recoveryTemp,
      `${JSON.stringify({ version: 5, backups: [third] }, null, 2)}\n`,
      "utf8",
    );
    const now = new Date(Date.now() + 2_000);
    await fsp.utimes(recoveryTemp, now, now);
    const recoveredFromTemp = await engine._readIndex();
    assert.equal(
      recoveredFromTemp.backups[0].file,
      third.file,
      "a valid newer interrupted-write temp file should be preferred during recovery",
    );

    await fsp.rm(`${indexFile}.bak`, { force: true });
    await fsp.rm(recoveryTemp, { force: true });
    await fsp.writeFile(indexFile, "[1 2]\n", "utf8");
    const emptyFallback = await engine._readIndex();
    assert.deepEqual(emptyFallback, { version: 5, backups: [] });

    console.log("Backup JSON resilience checks passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
