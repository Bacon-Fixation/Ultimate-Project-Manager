"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  sanitizeText,
  buildPreviewSegments,
  getRuleCatalog,
  scanProject,
  writeSanitizedFiles,
} = require("../src/file-tools/text-sanitizer");
const { TextSanitizerService } = require("../src/file-tools/text-sanitizer-service");

async function exists(filePath) {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function main() {
  const input = 'const msg = “Hello”—world…; const hidden = "A\u200BB"; const cafe = "café";';
  const sanitized = sanitizeText(input);
  assert.match(sanitized.text, /"Hello"-world\.\.\./);
  assert.match(sanitized.text, /"AB"/);
  assert.match(sanitized.text, /café/);

  const expanded = sanitizeText("Ｆｏｏ → bar", { replaceCompatibility: true });
  assert.strictEqual(expanded.text, "Foo -> bar");

  const semanticSafe = sanitizeText("x ≡ y ∧ z; ½ cup");
  assert.strictEqual(semanticSafe.text, "x ≡ y ∧ z; ½ cup");
  const semanticEnabled = sanitizeText("x ≡ y ∧ z; ½ cup", { replaceAmbiguous: true });
  assert.strictEqual(semanticEnabled.text, "x === y && z; 1/2 cup");

  const previewChanges = buildPreviewSegments("plain\n“quoted”").filter(
    (segment) => segment.type !== "unchanged",
  );
  assert.deepStrictEqual(
    previewChanges.map(({ line, column, changeIndex }) => ({ line, column, changeIndex })),
    [
      { line: 2, column: 1, changeIndex: 0 },
      { line: 2, column: 8, changeIndex: 1 },
    ],
  );

  const catalog = getRuleCatalog();
  assert.ok(catalog.counts.replacementCharacters >= 290);
  assert.ok(catalog.counts.invisibleClasses >= 17);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-text-sanitizer-"));
  const source = path.join(root, "sample.js");
  const output = path.join(root, "..", `${path.basename(root)}-output`);
  await fsp.writeFile(source, "const value = “before”; // café\u200B\n", "utf8");
  const scan = await scanProject(root);
  const finding = scan.files.find((item) => item.relativePath === "sample.js");
  assert.ok(finding?.changed);

  const [written] = await writeSanitizedFiles(root, output, ["sample.js"], {
    ...scan.settings,
    overwrite: true,
    expectedHashes: { "sample.js": finding.hash },
  });
  assert.strictEqual(written.ok, true);
  assert.strictEqual(written.status, "written");
  assert.match(await fsp.readFile(path.join(output, "sample.js"), "utf8"), /"before"/);
  // Copy-oriented sanitizer output must leave the source untouched.
  assert.match(await fsp.readFile(source, "utf8"), /“before”/);

  const [skipped] = await writeSanitizedFiles(root, output, ["sample.js"], {
    ...scan.settings,
    overwrite: false,
    expectedHashes: { "sample.js": finding.hash },
  });
  assert.strictEqual(skipped.status, "skipped");
  assert.strictEqual(skipped.reason, "destination-exists");

  await fsp.writeFile(source, "const value = “service”;\n", "utf8");
  const logs = [];
  let projectBackups = 0;
  const dataDir = path.join(root, "manager-data");
  const manager = {
    dataDir,
    getProject(id) {
      if (id !== "project-1") return null;
      return { id, name: "Sanitizer Test", projectRoot: root, executionTarget: "local" };
    },
    async runBackup() {
      projectBackups += 1;
      return { created: true, file: "backup.tar.gz" };
    },
    async log(level, message, meta) {
      logs.push({ level, message, meta });
    },
  };
  const service = new TextSanitizerService({ manager, dataDir });
  const defaults = service.getDefaults("project-1");
  assert.ok(defaults.outputRoot.includes("file-tools-output"));
  assert.strictEqual(path.basename(defaults.outputRoot), "sanitizer");
  const serviceOutput = path.join(root, "sanitizer-output");
  const serviceScan = await service.scan({
    projectId: "project-1",
    outputRoot: serviceOutput,
    options: {},
  });
  const serviceFinding = serviceScan.files.find((item) => item.relativePath === "sample.js");
  assert.ok(serviceFinding?.changed);
  const servicePreview = await service.preview(serviceScan.id, "sample.js");
  assert.ok(servicePreview.segments.some((segment) => segment.type === "replace"));
  const originalBeforeRun = await fsp.readFile(source, "utf8");
  const result = await service.apply(serviceScan.id, {
    files: ["sample.js"],
    outputRoot: serviceOutput,
    overwrite: true,
    writeManifest: true,
    backupBeforeRun: true,
  });
  assert.strictEqual(result.summary.written, 1);
  assert.strictEqual(result.summary.failed, 0);
  assert.strictEqual(projectBackups, 1);
  assert.strictEqual(await fsp.readFile(source, "utf8"), originalBeforeRun);
  assert.match(await fsp.readFile(path.join(serviceOutput, "sample.js"), "utf8"), /"service"/);
  assert.ok(result.manifestPath);
  assert.ok(await exists(result.manifestPath));
  assert.strictEqual(await exists(`${source}.sanitizer-backup`), false);
  assert.ok(logs.some((entry) => entry.meta?.feature === "text-sanitizer"));
  assert.ok(logs.some((entry) => entry.meta?.outputRoot === serviceOutput));

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(output, { recursive: true, force: true });
  console.log("Text Sanitizer tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
