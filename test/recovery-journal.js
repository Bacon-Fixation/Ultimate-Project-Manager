"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DeltaJournal } = require("../src/recovery/delta-journal");
const { RecoveryService } = require("../src/recovery/recovery-service");

function meta(buffer) {
  return {
    type: "file",
    size: buffer.length,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-recovery-journal-"));
  const projectRoot = path.join(temp, "project");
  const dataDir = path.join(temp, "data");
  await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });

  const oldBytes = Buffer.from('module.exports = "old-from-journal";\n');
  const midBytes = Buffer.from('module.exports = "middle-pruned-backup";\n');
  const backupBytes = Buffer.from('module.exports = "newer-retained-backup";\n');
  const liveBytes = Buffer.from('module.exports = "unbacked-live-change";\n');
  await fsp.writeFile(path.join(projectRoot, "src", "index.js"), liveBytes);

  const journal = new DeltaJournal({
    dir: path.join(dataDir, "delta-journal", "project-1"),
    enabled: true,
    projectId: "project-1",
    projectName: "Journal Recovery Test",
  });
  await journal.init();
  await journal.recordTransition({
    previous: {
      projectHash: "snapshot-old",
      backupFile: "old-pruned.tar.gz",
      backupCreatedAt: "2026-08-18T00:00:00.000Z",
      files: { "src/index.js": meta(oldBytes) },
    },
    current: {
      projectHash: "snapshot-mid",
      files: { "src/index.js": meta(midBytes) },
    },
    changes: { added: [], modified: ["src/index.js"], deleted: [] },
    backupFile: "middle-pruned.tar.gz",
    backupCreatedAt: "2026-08-19T00:00:00.000Z",
    readBefore: async () => oldBytes,
    readAfter: async () => midBytes,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  await journal.recordTransition({
    previous: {
      projectHash: "snapshot-mid",
      backupFile: "middle-pruned.tar.gz",
      backupCreatedAt: "2026-08-19T00:00:00.000Z",
      files: { "src/index.js": meta(midBytes) },
    },
    current: {
      projectHash: "snapshot-new",
      files: { "src/index.js": meta(backupBytes) },
    },
    changes: { added: [], modified: ["src/index.js"], deleted: [] },
    backupFile: "new-retained.tar.gz",
    backupCreatedAt: "2026-08-20T00:00:00.000Z",
    readBefore: async () => midBytes,
    readAfter: async () => backupBytes,
  });

  const project = {
    id: "project-1",
    name: "Journal Recovery Test",
    projectRoot,
    deltaJournalEnabled: true,
  };
  const manager = {
    dataDir,
    getProject(id) {
      return id === project.id ? project : null;
    },
    _journal() {
      return journal;
    },
    async getProjectDiff() {
      return {
        baseline: {
          backupFile: "new-retained.tar.gz",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        files: [
          {
            path: "src/index.js",
            status: "modified",
            before: meta(backupBytes),
            after: meta(liveBytes),
          },
        ],
      };
    },
    async listBackups() {
      return [
        {
          file: "new-retained.tar.gz",
          createdAt: "2026-08-20T00:00:00.000Z",
          verificationStatus: "verified",
          encrypted: false,
          changes: { added: [], modified: ["src/index.js"], deleted: [] },
          destinations: [
            {
              key: "primary",
              label: "Primary",
              path: path.join(temp, "new-retained.tar.gz"),
            },
          ],
        },
      ];
    },
    async _resolveBackupCopy() {
      return {
        destination: { key: "primary" },
        engine: {
          async readBackupEntry(_file, relativePath, options = {}) {
            if (relativePath !== "src/index.js") return { found: false };
            return {
              found: true,
              type: "File",
              size: backupBytes.length,
              binary: false,
              tooLarge: false,
              text: backupBytes.toString("utf8"),
              ...(options.returnBuffer ? { buffer: backupBytes } : {}),
            };
          },
        },
      };
    },
    async log() {},
  };

  const recovery = await new RecoveryService({ manager, dataDir }).init();
  const analysis = await recovery.inspect(project.id, { path: "src/index.js" });
  assert.equal(analysis.journal.enabled, true);
  assert.equal(analysis.journal.candidates.length, 2);
  const [middleCandidate] = analysis.journal.candidates;
  assert.equal(middleCandidate.source, "journal");
  const middlePreview = await recovery.readCandidate(project.id, "src/index.js", {
    id: middleCandidate.id,
  });
  assert.equal(middlePreview.preview, midBytes.toString("utf8"));
  const candidate = analysis.journal.candidates.find((item) => item.sha256 === meta(oldBytes).hash);
  assert.equal(candidate.source, "journal");
  assert.equal(candidate.anchorBackupFile, "new-retained.tar.gz");

  const preview = await recovery.readCandidate(project.id, "src/index.js", {
    id: candidate.id,
  });
  assert.equal(preview.preview, oldBytes.toString("utf8"));
  assert.equal(preview.sha256, meta(oldBytes).hash);

  await fsp.rm(temp, { recursive: true, force: true });
  console.log("Recovery delta-journal integration tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
