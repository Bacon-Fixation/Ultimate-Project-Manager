"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  FEATURE_PACK_SCHEMA,
  FeaturePackService,
  isLikelySensitivePath,
  renderReviewDiff,
} = require("../src/export/feature-pack-service");

function sha(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

(async () => {
  assert.equal(isLikelySensitivePath(".env"), true);
  assert.equal(isLikelySensitivePath(".env.production"), true);
  assert.equal(isLikelySensitivePath("config/credentials.json"), true);
  assert.equal(isLikelySensitivePath("certs/app.pem"), true);
  assert.equal(isLikelySensitivePath("src/index.js"), false);

  const rendered = renderReviewDiff({
    path: "src/index.js",
    status: "modified",
    baseline: { backupFile: "baseline.tar.gz" },
    textDiff: {
      detailed: true,
      lines: [
        { type: "context", text: "const a = 1;" },
        { type: "deletion", text: "const b = 2;" },
        { type: "addition", text: "const b = 3;" },
      ],
    },
  });
  assert.match(rendered, /-const b = 2;/);
  assert.match(rendered, /\+const b = 3;/);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-feature-pack-test-"));
  const output = path.join(root, "out");
  const projectRoot = path.join(root, "project");
  await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });
  const currentIndex = Buffer.from("const answer = 43;\n");
  const added = Buffer.from("module.exports = true;\n");
  await fsp.writeFile(path.join(projectRoot, "src", "index.js"), currentIndex);
  await fsp.writeFile(path.join(projectRoot, "src", "new.js"), added);
  await fsp.writeFile(path.join(projectRoot, ".env"), "SECRET=should-not-export\n");

  let stagedManifest = null;
  let stagedDeleted = null;
  let stagedIndex = null;
  let stagedEnvExists = null;
  const fakeTar = {
    async c(options, entries) {
      assert.equal(options.gzip, true);
      assert.ok(entries.includes("_upm-feature-pack.json"));
      stagedManifest = JSON.parse(
        await fsp.readFile(path.join(options.cwd, "_upm-feature-pack.json"), "utf8"),
      );
      stagedDeleted = await fsp.readFile(path.join(options.cwd, "_DELETED_FILES.txt"), "utf8");
      stagedIndex = await fsp.readFile(path.join(options.cwd, "files", "src", "index.js"), "utf8");
      stagedEnvExists = await fsp.access(path.join(options.cwd, "files", ".env")).then(
        () => true,
        () => false,
      );
      await fsp.writeFile(options.file, "fake-archive");
    },
  };

  const diff = {
    checkedAt: new Date().toISOString(),
    baseline: {
      backupFile: "baseline.tar.gz",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      projectHash: "before-hash",
    },
    current: {
      projectHash: "after-hash",
      fileCount: 3,
      sourceBytes: currentIndex.length + added.length + 24,
    },
    files: [
      {
        path: "src/index.js",
        status: "modified",
        before: { type: "file", hash: "old-index", size: 18 },
        after: {
          type: "file",
          hash: sha(currentIndex),
          size: currentIndex.length,
        },
      },
      {
        path: "src/new.js",
        status: "added",
        before: null,
        after: { type: "file", hash: sha(added), size: added.length },
      },
      {
        path: "src/removed.js",
        status: "deleted",
        before: { type: "file", hash: "removed-hash", size: 10 },
        after: null,
      },
      {
        path: ".env",
        status: "added",
        before: null,
        after: {
          type: "file",
          hash: sha(Buffer.from("SECRET=should-not-export\n")),
          size: 25,
        },
      },
    ],
  };

  const logEvents = [];
  const manager = {
    getProject(id) {
      return id === "project-1" ? { id, name: "Demo Project", projectRoot } : null;
    },
    async getProjectDiff() {
      return diff;
    },
    async getProjectFileDiff(_id, relativePath) {
      return {
        path: relativePath,
        status: diff.files.find((row) => row.path === relativePath)?.status,
        baseline: diff.baseline,
        textDiff: {
          detailed: true,
          lines: [{ type: "addition", text: `review ${relativePath}` }],
        },
      };
    },
    async log(level, message, details) {
      logEvents.push({ level, message, details });
    },
  };

  const service = new FeaturePackService({ manager, tarModule: fakeTar });
  const preview = await service.preview("project-1");
  assert.equal(preview.counts.selected, 4);
  assert.equal(preview.counts.includedRegularFiles, 2);
  assert.equal(preview.counts.deletedManifestEntries, 1);
  assert.equal(preview.counts.omittedSensitive, 1);
  assert.equal(preview.files.find((row) => row.path === ".env").omitted, true);

  const result = await service.create("project-1", {
    outputDir: output,
    packName: "Feature A",
  });
  assert.equal(result.manifest.schema, FEATURE_PACK_SCHEMA);
  assert.match(result.fileName, /^Feature-A-.*\.upmfeature\.tgz$/);
  assert.equal(await fsp.readFile(result.archivePath, "utf8"), "fake-archive");
  assert.equal(stagedManifest.schema, FEATURE_PACK_SCHEMA);
  assert.equal(stagedManifest.summary.omittedSensitive, 1);
  assert.match(stagedDeleted, /src\/removed\.js/);
  assert.equal(stagedIndex, currentIndex.toString("utf8"));
  assert.equal(stagedEnvExists, false);
  assert.equal(logEvents.at(-1).details.operation, "feature-pack-export");

  await fsp.rm(root, { recursive: true, force: true });
  console.log("Feature Pack export tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
