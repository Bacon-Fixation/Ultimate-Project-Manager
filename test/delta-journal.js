"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DeltaJournal, makePatch, applyPatch } = require("../src/recovery/delta-journal");

function meta(buffer) {
  return {
    type: "file",
    size: buffer.length,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function main() {
  const before = Buffer.from("const value = 1;\nconsole.log(value);\n");
  const after = Buffer.from("const value = 2;\nconsole.log(value);\n");
  const direct = makePatch(meta(before), meta(after), before, after, {
    maxFileBytes: 1024,
  });
  assert.equal(direct.reconstructable, true);
  assert.deepEqual(applyPatch(direct, after, "reverse"), before);
  assert.deepEqual(applyPatch(direct, before, "forward"), after);

  const added = Buffer.from("new file\n");
  const addedPatch = makePatch(null, meta(added), null, added, {
    maxFileBytes: 1024,
  });
  assert.equal(applyPatch(addedPatch, added, "reverse"), null);
  assert.deepEqual(applyPatch(addedPatch, null, "forward"), added);

  const deletedPatch = makePatch(meta(before), null, before, null, {
    maxFileBytes: 1024,
  });
  assert.deepEqual(applyPatch(deletedPatch, null, "reverse"), before);

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-delta-journal-"));
  const journal = new DeltaJournal({
    dir: temp,
    enabled: true,
    projectId: "project-1",
    projectName: "Delta Test",
    retentionDays: 365,
    maxEntries: 5,
    maxBytes: 10 * 1024 * 1024,
    maxFileBytes: 1024 * 1024,
  });
  await journal.init();

  const first = await journal.recordTransition({
    previous: {
      projectHash: "hash-before",
      backupFile: "before.tar.gz",
      backupCreatedAt: "2026-08-20T00:00:00.000Z",
      files: { "src/a.js": meta(before) },
    },
    current: { projectHash: "hash-after", files: { "src/a.js": meta(after) } },
    changes: { added: [], modified: ["src/a.js"], deleted: [] },
    backupFile: "after.tar.gz",
    backupCreatedAt: "2026-08-21T00:00:00.000Z",
    readBefore: async () => before,
    readAfter: async () => after,
  });
  assert.equal(first.created, true);
  assert.equal(first.record.reconstructableFiles, 1);
  assert(first.record.size > 0);

  const stats = await journal.stats();
  assert.equal(stats.entryCount, 1);
  assert.equal(stats.reconstructableFiles, 1);

  const history = await journal.getPathHistory("src/a.js");
  assert.equal(history.length, 1);
  assert.equal(history[0].patch.reconstructable, true);
  assert.deepEqual(applyPatch(history[0].patch, after, "reverse"), before);

  const oversized = Buffer.alloc(2048, 1);
  const smallJournal = new DeltaJournal({
    dir: path.join(temp, "small"),
    enabled: true,
    maxFileBytes: 1024,
  });
  await smallJournal.init();
  const skipped = await smallJournal.recordTransition({
    previous: {
      projectHash: "a",
      backupFile: "a.tar.gz",
      files: { "large.bin": meta(oversized) },
    },
    current: {
      projectHash: "b",
      files: {
        "large.bin": meta(Buffer.concat([oversized, Buffer.from("x")])),
      },
    },
    changes: { added: [], modified: ["large.bin"], deleted: [] },
    backupFile: "b.tar.gz",
    readBefore: async () => {
      throw new Error("should not read oversized before");
    },
    readAfter: async () => {
      throw new Error("should not read oversized after");
    },
  });
  assert.equal(skipped.record.reconstructableFiles, 0);
  assert.equal(skipped.record.skippedFiles, 1);
  const skippedHistory = await smallJournal.getPathHistory("large.bin");
  assert.equal(skippedHistory[0].patch.payload.reason, "file-size-limit");

  const pruneJournal = new DeltaJournal({
    dir: path.join(temp, "prune"),
    enabled: true,
    maxEntries: 1,
    retentionDays: 365,
    maxBytes: 10 * 1024 * 1024,
  });
  await pruneJournal.init();
  const v1 = Buffer.from("v1");
  const v2 = Buffer.from("v2");
  const v3 = Buffer.from("v3");
  await pruneJournal.recordTransition({
    previous: {
      projectHash: "p1",
      backupFile: "p1.tar.gz",
      files: { "a.txt": meta(v1) },
    },
    current: { projectHash: "p2", files: { "a.txt": meta(v2) } },
    changes: { added: [], modified: ["a.txt"], deleted: [] },
    backupFile: "p2.tar.gz",
    readBefore: async () => v1,
    readAfter: async () => v2,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  const prunedWrite = await pruneJournal.recordTransition({
    previous: {
      projectHash: "p2",
      backupFile: "p2.tar.gz",
      files: { "a.txt": meta(v2) },
    },
    current: { projectHash: "p3", files: { "a.txt": meta(v3) } },
    changes: { added: [], modified: ["a.txt"], deleted: [] },
    backupFile: "p3.tar.gz",
    readBefore: async () => v2,
    readAfter: async () => v3,
  });
  assert.equal(prunedWrite.pruned.removed.length, 1);
  assert.equal((await pruneJournal.list()).length, 1);

  const encryptedDir = path.join(temp, "encrypted");
  const encryptedJournal = new DeltaJournal({
    dir: encryptedDir,
    enabled: true,
    encryptionEnabled: true,
    encryptionKey: "delta-journal-test-key-that-is-long-enough",
  });
  await encryptedJournal.init();
  const encryptedWrite = await encryptedJournal.recordTransition({
    previous: {
      projectHash: "e1",
      backupFile: "e1.tar.gz.upmenc",
      files: { "secret.txt": meta(v1) },
    },
    current: { projectHash: "e2", files: { "secret.txt": meta(v2) } },
    changes: { added: [], modified: ["secret.txt"], deleted: [] },
    backupFile: "e2.tar.gz.upmenc",
    readBefore: async () => v1,
    readAfter: async () => v2,
  });
  assert.equal(encryptedWrite.record.encrypted, true);
  assert.match(encryptedWrite.record.file, /\.upmdelta\.gz\.upmenc$/);
  const encryptedHistory = await encryptedJournal.getPathHistory("secret.txt");
  assert.equal(encryptedHistory.length, 1);
  assert.deepEqual(applyPatch(encryptedHistory[0].patch, v2, "reverse"), v1);
  const wrongKeyJournal = new DeltaJournal({
    dir: encryptedDir,
    enabled: true,
    encryptionEnabled: true,
    encryptionKey: "different-test-key-that-is-long-enough",
  });
  const wrongKeyHistory = await wrongKeyJournal.getPathHistory("secret.txt");
  assert.equal(wrongKeyHistory[0].corrupt, true);

  const entryPath = path.join(temp, "entries", first.record.file);
  const original = await fsp.readFile(entryPath);
  const tampered = Buffer.from(original);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  await fsp.writeFile(entryPath, tampered);
  const corrupted = await journal.getPathHistory("src/a.js");
  assert.equal(corrupted[0].corrupt, true);
  await fsp.writeFile(entryPath, original);

  await fsp.rm(temp, { recursive: true, force: true });
  console.log("Delta journal tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
