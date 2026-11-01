"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ProjectBackup } = require("../src/backup/project-backup");

async function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-mirror-reliability-"));
  const projectRoot = path.join(temp, "project");
  const primaryDir = path.join(temp, "primary");
  const secondaryDir = path.join(temp, "secondary");
  try {
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");
    await fsp.writeFile(path.join(projectRoot, "index.js"), "module.exports = 1;\n", "utf8");

    const primary = new ProjectBackup({
      projectRoot,
      backupDir: primaryDir,
      projectName: "Mirror Test",
      keep: 5,
    });
    const secondary = new ProjectBackup({
      projectRoot,
      backupDir: secondaryDir,
      projectName: "Mirror Test",
      keep: 5,
    });

    const created = await primary.backupIfChanged({ force: true });
    assert.equal(created.created, true);
    const metadata = (await primary.listBackups()).find(
      (item) => item.file === path.basename(created.archivePath),
    );
    assert.ok(metadata);

    const firstMirror = await secondary.mirrorVerifiedBackup(created.archivePath, metadata);
    assert.equal(firstMirror.copied, true);
    const target = firstMirror.archivePath;
    assert.equal(await sha256(target), metadata.archiveSha256);

    // Simulate stale "verified" metadata plus a damaged/missing destination.
    await fsp.writeFile(target, "corrupted secondary archive", "utf8");
    assert.notEqual(await sha256(target), metadata.archiveSha256);

    const originalRename = fsp.rename;
    fsp.rename = async (source, destination) => {
      const destinationExists = await fsp.stat(destination).then(
        () => true,
        () => false,
      );
      if (path.resolve(destination) === path.resolve(target) && destinationExists) {
        const error = new Error("simulated Windows rename-over-existing lock");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(source, destination);
    };

    let repaired;
    try {
      repaired = await secondary.mirrorVerifiedBackup(created.archivePath, metadata);
    } finally {
      fsp.rename = originalRename;
    }

    assert.equal(repaired.copied, true);
    assert.equal(repaired.alreadyPresent, false);
    assert.equal(await sha256(target), metadata.archiveSha256);
    assert.equal(
      (await secondary.listBackups()).find((item) => item.file === metadata.file)?.archiveSha256,
      metadata.archiveSha256,
    );

    console.log("Backup mirror reliability tests passed.");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
