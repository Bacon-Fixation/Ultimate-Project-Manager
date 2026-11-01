"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { FileToolsService } = require("../src/file-tools/file-tools-service");
const {
  getCommentStyle,
  parseTimestampedFilename,
  stripComments,
  isLikelyBinary,
} = require("../src/file-tools/file-tools-core");

async function main() {
  assert.equal(parseTimestampedFilename("chat-log_20260820143000.pug").outputName, "chat-log.pug");
  assert.equal(
    parseTimestampedFilename("bundle_20260820143000.min.js").outputName,
    "bundle.min.js",
  );
  assert.equal(
    parseTimestampedFilename("archive_20260820143000.tar.gz").outputName,
    "archive.tar.gz",
  );

  const stripped = stripComments(
    "app.js",
    "const url = 'https://example.com'; // remove\n/* block */\nconst x = 1;\n",
  );
  assert.equal(stripped.commentsRemoved, 2);
  assert.ok(stripped.content.includes("https://example.com"));
  assert.ok(!stripped.content.includes("remove"));

  const css = stripComments(
    "styles.css",
    "a { background: url(https://example.com/a.png); } /* remove */\n",
  );
  assert.ok(css.content.includes("https://example.com/a.png"));
  assert.ok(!css.content.includes("remove"));

  const legal = stripComments("licensed.js", "/*! Copyright Example */\n// remove\nconst x = 1;\n");
  assert.ok(legal.content.includes("Copyright Example"));
  assert.ok(!legal.content.includes("// remove"));
  assert.equal(legal.legalCommentsPreserved, 1);

  const powershell = stripComments("script.ps1", 'Write-Host "# keep" # remove\n<# block #>\n');
  assert.ok(powershell.content.includes("# keep"));
  assert.ok(!powershell.content.includes("# remove"));
  assert.equal(powershell.commentsRemoved, 2);

  const lua = stripComments("script.lua", 'print("-- keep") -- remove\n--[[ block ]]\n');
  assert.ok(lua.content.includes("-- keep"));
  assert.ok(!lua.content.includes("-- remove"));

  const batch = stripComments("run.cmd", "@echo off\nREM remove\necho keep\n:: remove too\n");
  assert.ok(!batch.content.toLowerCase().includes("rem remove"));
  assert.ok(batch.content.includes("echo keep"));

  const yaml = stripComments(
    "config.yml",
    "name: test # remove\nscript: |\n  echo # this is scalar content\nnext: ok\n",
  );
  assert.ok(!yaml.content.includes("# remove"));
  assert.ok(yaml.content.includes("echo # this is scalar content"));

  assert.equal(getCommentStyle("Dockerfile"), "hash");
  assert.equal(getCommentStyle("Makefile"), "hash");
  assert.equal(getCommentStyle("Jenkinsfile"), "c-style");
  assert.equal(getCommentStyle("main.tf"), "hcl");
  assert.equal(isLikelyBinary(Buffer.from([0x61, 0x00, 0x62])), true);
  assert.equal(isLikelyBinary(Buffer.from("plain text")), false);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-manager-file-tools-"));
  const projectRoot = path.join(root, "project");
  const dataDir = path.join(root, "data");
  const outputRoot = path.join(root, "output");
  await fsp.mkdir(path.join(projectRoot, "public", "js"), { recursive: true });
  await fsp.mkdir(path.join(projectRoot, "ignored-dir"), { recursive: true });
  await fsp.writeFile(
    path.join(projectRoot, ".gitignore"),
    "ignored-by-git.txt\nignored-dir/\n",
    "utf8",
  );
  await fsp.writeFile(path.join(projectRoot, "ignored-by-git.txt"), "ignore me\n", "utf8");
  await fsp.writeFile(path.join(projectRoot, "ignored-dir", "file.js"), "// ignore me\n", "utf8");
  await fsp.writeFile(path.join(projectRoot, ".env"), "SECRET=value\n", "utf8");
  await fsp.writeFile(path.join(projectRoot, "credentials.json"), '{"secret":true}\n', "utf8");
  await fsp.writeFile(
    path.join(projectRoot, "project-only.tmp"),
    "ignore by project config\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(projectRoot, "public", "js", "app_20260819120000.js"),
    "const version = 1; // old\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(projectRoot, "public", "js", "app_20260820120000.js"),
    "/*! @license keep */\nconst version = 2; // newest\n",
    "utf8",
  );
  await fsp.writeFile(path.join(projectRoot, "README.md"), "# test\n<!-- remove -->\n", "utf8");

  const logs = [];
  let backups = 0;
  const project = {
    id: "project-12345678",
    name: "Test Project",
    projectRoot,
    extraExcludes: ["project-only.tmp"],
  };
  const manager = {
    dataDir,
    getProject(id) {
      return id === project.id ? project : null;
    },
    async runBackup(id, options) {
      assert.equal(id, project.id);
      assert.equal(options.force, true);
      backups += 1;
      return { created: true, file: "test.tar.gz" };
    },
    async log(level, message, details) {
      logs.push({ level, message, details });
    },
  };

  const service = await new FileToolsService({ manager, dataDir }).init();
  const defaults = service.getDefaults(project.id, "pipeline");
  assert.equal(defaults.sourceRoot, projectRoot);
  assert.ok(defaults.outputRoot.includes("file-tools-output"));

  const preview = await service.preview({
    mode: "pipeline",
    projectId: project.id,
    outputRoot,
    excludes: ".env\ncredentials.json",
    respectGitignore: true,
    useProjectExcludes: true,
    copyUnversioned: true,
    copyUnsupported: true,
  });
  assert.equal(preview.summary.versionGroups, 1);
  assert.equal(preview.summary.plannedCopies, 3);
  assert.ok(preview.summary.ignoredFiles >= 3);
  assert.ok(preview.summary.ignoredDirectories >= 1);
  assert.equal(preview.summary.gitignoreRules, 2);
  assert.equal(preview.summary.projectExcludes, 1);
  assert.equal(preview.summary.additionalExcludes, 2);
  assert.equal(
    preview.operations.some((item) => item.sourceRelativePath === ".env"),
    false,
  );
  assert.equal(
    preview.operations.some((item) => item.sourceRelativePath === "credentials.json"),
    false,
  );
  assert.equal(
    preview.operations.some((item) => item.sourceRelativePath === "ignored-by-git.txt"),
    false,
  );
  assert.equal(
    preview.operations.some((item) => item.sourceRelativePath === "project-only.tmp"),
    false,
  );
  assert.equal(
    preview.operations.find((item) => item.destinationRelativePath.endsWith("app.js")).timestamp,
    "20260820120000",
  );

  const run = await service.run({
    mode: "pipeline",
    projectId: project.id,
    outputRoot,
    excludes: ".env\ncredentials.json",
    respectGitignore: true,
    useProjectExcludes: true,
    copyUnversioned: true,
    copyUnsupported: true,
    preserveLicenseComments: true,
    backupBeforeRun: true,
    writeManifest: true,
  });

  assert.equal(backups, 1);
  assert.equal(run.summary.errors, 0);
  assert.equal(run.summary.copied, 3);
  assert.ok(run.summary.commentsRemoved >= 2);
  assert.ok(run.summary.legalCommentsPreserved >= 1);
  assert.ok(run.manifestPath);
  assert.ok(logs.some((item) => item.details?.feature === "file-tools"));

  const app = await fsp.readFile(path.join(outputRoot, "public", "js", "app.js"), "utf8");
  assert.ok(app.includes("const version = 2;"));
  assert.ok(app.includes("@license"));
  assert.ok(!app.includes("newest"));
  assert.ok(!app.includes("old"));

  const readme = await fsp.readFile(path.join(outputRoot, "README.md"), "utf8");
  assert.ok(!readme.includes("remove"));

  for (const excludedPath of [
    ".env",
    "credentials.json",
    "ignored-by-git.txt",
    "project-only.tmp",
  ]) {
    const exists = await fsp
      .access(path.join(outputRoot, excludedPath))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false, `${excludedPath} should be excluded`);
  }

  const history = service.getHistory(10);
  assert.equal(history.length, 1);
  assert.equal(history[0].mode, "pipeline");
  assert.equal(history[0].projectId, project.id);

  await service.clearHistory();
  assert.equal(service.getHistory(10).length, 0);

  await fsp.rm(root, { recursive: true, force: true });
  console.log("File Tools service tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
