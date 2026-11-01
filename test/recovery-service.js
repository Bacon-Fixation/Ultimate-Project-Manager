"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { RecoveryService, normalizeRelativePath } = require("../src/recovery/recovery-service");

async function main() {
  assert.strictEqual(normalizeRelativePath("src\\index.js"), "src/index.js");
  assert.throws(() => normalizeRelativePath("../secret.txt"));
  assert.throws(() => normalizeRelativePath("C:evil.txt"));

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-recovery-"));
  const projectRoot = path.join(temp, "project");
  const dataDir = path.join(temp, "data");
  await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });
  const currentText = 'module.exports = "current";\n';
  const backupText = 'module.exports = "backup";\n';
  await fsp.writeFile(path.join(projectRoot, "src", "index.js"), currentText);

  let gitAvailable = true;
  try {
    execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "recovery@example.test"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Recovery Test"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    await fsp.writeFile(path.join(projectRoot, "src", "index.js"), 'module.exports = "git-old";\n');
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial recovery version"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    await fsp.writeFile(path.join(projectRoot, "src", "index.js"), currentText);
  } catch {
    gitAvailable = false;
    await fsp.writeFile(path.join(projectRoot, "src", "index.js"), currentText);
  }

  const logEntries = [];
  const manager = {
    dataDir,
    getProject(id) {
      return id === "project-1" ? { id, name: "Recovery Test", projectRoot } : null;
    },
    async getProjectDiff() {
      return {
        baseline: {
          backupFile: "backup-one.tar.gz",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        files: [
          {
            path: "src/index.js",
            status: "modified",
            before: { size: backupText.length },
            after: { size: currentText.length },
          },
        ],
      };
    },
    async listBackups() {
      return [
        {
          file: "backup-one.tar.gz",
          createdAt: "2026-08-20T00:00:00.000Z",
          verificationStatus: "verified",
          encrypted: false,
          changes: { added: [], modified: ["src/index.js"], deleted: [] },
          destinations: [
            {
              key: "primary",
              label: "Primary",
              path: path.join(temp, "backup-one.tar.gz"),
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
            const buffer = Buffer.from(backupText);
            return {
              found: true,
              type: "File",
              size: buffer.length,
              binary: false,
              tooLarge: false,
              text: backupText,
              ...(options.returnBuffer ? { buffer } : {}),
            };
          },
        },
      };
    },
    async log(level, message, details) {
      logEntries.push({ level, message, ...details });
    },
  };

  const recovery = await new RecoveryService({ manager, dataDir }).init();
  const analysis = await recovery.inspect("project-1", {
    path: "src/index.js",
  });
  assert.strictEqual(analysis.backupCandidates.length, 1);
  assert(["backup", "git"].includes(analysis.recommended.source));
  assert.strictEqual(analysis.suggestions.length, 1);
  if (gitAvailable)
    assert(analysis.git.candidates.length >= 1, "expected at least one Git recovery candidate");

  const preview = await recovery.readCandidate("project-1", "src/index.js", {
    id: analysis.backupCandidates[0].id,
  });
  assert.strictEqual(preview.preview, backupText);
  assert.strictEqual(preview.candidate.source, "backup");

  if (gitAvailable) {
    const gitCandidate = analysis.git.candidates[0];
    const gitPreview = await recovery.readCandidate("project-1", "src/index.js", {
      id: gitCandidate.id,
    });
    assert.strictEqual(gitPreview.preview, 'module.exports = "git-old";\n');
    assert(gitPreview.blame === null || gitPreview.blame.analyzedLines >= 1);
  }

  const exported = await recovery.recoverFile("project-1", "src/index.js", {
    id: analysis.backupCandidates[0].id,
  });
  const recoveredText = await fsp.readFile(exported.files[0].destination, "utf8");
  assert.strictEqual(recoveredText, backupText);
  assert.strictEqual(
    await fsp.readFile(path.join(projectRoot, "src", "index.js"), "utf8"),
    currentText,
    "live project must remain untouched",
  );
  assert.strictEqual(exported.safety.liveProjectModified, false);
  assert(logEntries.some((entry) => entry.operation === "recovery-export"));

  const batch = await recovery.recoverSuggested("project-1");
  assert.strictEqual(batch.recoveredFiles, 1);
  assert.strictEqual(batch.failedFiles, 0);
  const batchText = await fsp.readFile(batch.files[0].destination, "utf8");
  assert([backupText, 'module.exports = "git-old";\n'].includes(batchText));

  await fsp.rm(temp, { recursive: true, force: true });
  console.log("Recovery service tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
