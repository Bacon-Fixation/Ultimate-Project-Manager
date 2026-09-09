"use strict";

const fsp = require("fs/promises");
const path = require("path");
const {
  scanProject,
  previewFile,
  writeSanitizedFiles,
  buildPreviewSegments,
  getRuleCatalog,
} = require("./text-sanitizer");

function safeFolderName(value) {
  const text = String(value || "project")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || "project";
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

class TextSanitizerService {
  constructor(options = {}) {
    if (!options.manager)
      throw new Error("TextSanitizerService requires a BackupManager instance.");
    this.manager = options.manager;
    this.outputRoot = path.resolve(
      options.outputRoot ||
        path.join(
          options.dataDir || this.manager.dataDir || path.join(process.cwd(), "data"),
          "file-tools-output",
        ),
    );
    this.scans = new Map();
    this.maxScans = Number(options.maxScans) || 20;
    this.maxAgeMs = Number(options.maxAgeMs) || 60 * 60 * 1000;
  }

  getMeta() {
    return {
      version: "1.4.0",
      catalog: getRuleCatalog(),
      presets: ["standard", "expanded", "invisible", "report"],
      outputBehavior: "copy-only",
    };
  }

  getDefaults(projectId = null) {
    const project = projectId ? this.manager.getProject(projectId) : null;
    if (projectId && !project) throw new Error("Project not found.");
    if (project?.executionTarget === "lan") {
      throw new Error("Text Sanitizer currently runs on local project files only.");
    }
    const projectFolder = project
      ? `${safeFolderName(project.name)}-${project.id.slice(0, 8)}`
      : "custom";
    return {
      projectId: project?.id || null,
      projectName: project?.name || null,
      sourceRoot: project?.projectRoot || "",
      outputRoot: path.join(this.outputRoot, projectFolder, "sanitizer"),
      backupBeforeRun: false,
      overwrite: true,
      writeManifest: true,
    };
  }

  _cleanScans() {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [id, scan] of this.scans) {
      if (new Date(scan.createdAt).getTime() < cutoff) this.scans.delete(id);
    }
    while (this.scans.size > this.maxScans) {
      const oldest = [...this.scans.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )[0];
      if (!oldest) break;
      this.scans.delete(oldest.id);
    }
  }

  _getScan(id) {
    this._cleanScans();
    const scan = this.scans.get(String(id || ""));
    if (!scan) {
      const error = new Error("Sanitizer scan expired or was not found. Run the scan again.");
      error.status = 404;
      throw error;
    }
    return scan;
  }

  _resolveInput(input = {}) {
    const projectId = input.projectId ? String(input.projectId) : null;
    const project = projectId ? this.manager.getProject(projectId) : null;
    if (projectId && !project) throw new Error("Project not found.");
    if (project?.executionTarget === "lan") {
      throw new Error("Text Sanitizer currently runs on local project files only.");
    }
    const defaults = this.getDefaults(projectId);
    const sourceValue = project?.projectRoot || String(input.sourceRoot || "").trim();
    if (!sourceValue) throw new Error("A project or source folder is required.");
    const outputValue = String(input.outputRoot || defaults.outputRoot || "").trim();
    if (!outputValue) throw new Error("An output folder is required.");
    const sourceRoot = path.resolve(sourceValue);
    const outputRoot = path.resolve(outputValue);
    if (samePath(sourceRoot, outputRoot)) {
      throw new Error("Source and output folders must be different.");
    }
    return {
      projectId,
      project,
      sourceRoot,
      outputRoot,
      options: input.options || {},
    };
  }

  async scan(input = {}) {
    this._cleanScans();
    const resolved = this._resolveInput(input);
    const scan = await scanProject(resolved.sourceRoot, {
      ...resolved.options,
      excludeAbsolutePaths: [resolved.outputRoot],
    });
    scan.projectId = resolved.projectId;
    scan.projectName = resolved.project?.name || null;
    scan.outputRoot = resolved.outputRoot;
    this.scans.set(scan.id, scan);
    this._cleanScans();
    await this.manager.log(
      "info",
      `Text Sanitizer scan: ${resolved.project?.name || path.basename(resolved.sourceRoot)}`,
      {
        feature: "text-sanitizer",
        projectId: resolved.projectId,
        sourceRoot: resolved.sourceRoot,
        outputRoot: resolved.outputRoot,
        filesScanned: scan.summary.filesScanned,
        filesChanged: scan.summary.filesChanged,
        totalChanges: scan.summary.totalChanges,
      },
    );
    return scan;
  }

  async preview(scanId, relativePath) {
    const scan = this._getScan(scanId);
    const preview = await previewFile(scan.root, String(relativePath || ""), scan.settings);
    return {
      relativePath: preview.relativePath,
      changed: preview.changed,
      changeCount: preview.changeCount,
      changes: preview.changes,
      nonAscii: preview.nonAscii,
      original: preview.original,
      sanitized: preview.sanitized,
      segments: buildPreviewSegments(preview.original, scan.settings),
    };
  }

  async apply(scanId, input = {}) {
    const scan = this._getScan(scanId);
    const requested = Array.isArray(input.files) ? input.files.map(String) : [];
    const allowed = new Set(
      scan.files.filter((file) => file.changed).map((file) => file.relativePath),
    );
    const selected = [...new Set(requested)].filter((file) => allowed.has(file));
    if (!selected.length) throw new Error("No changed files were selected.");

    const outputValue = String(input.outputRoot || scan.outputRoot || "").trim();
    if (!outputValue) throw new Error("An output folder is required.");
    const outputRoot = path.resolve(outputValue);
    if (samePath(scan.root, outputRoot)) {
      throw new Error("Source and output folders must be different.");
    }

    const backupBeforeRun = Boolean(input.backupBeforeRun);
    const overwrite = input.overwrite !== false;
    const writeManifest = input.writeManifest !== false;
    let projectBackup = null;
    if (backupBeforeRun && scan.projectId) {
      projectBackup = await this.manager.runBackup(scan.projectId, {
        force: true,
        source: "text-sanitizer",
      });
    }

    const selectedSet = new Set(selected);
    const expectedHashes = Object.fromEntries(
      scan.files
        .filter((file) => selectedSet.has(file.relativePath))
        .map((file) => [file.relativePath, file.hash]),
    );
    const results = await writeSanitizedFiles(scan.root, outputRoot, selected, {
      ...scan.settings,
      overwrite,
      expectedHashes,
    });
    const summary = {
      requested: selected.length,
      written: results.filter((result) => result.status === "written").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "error").length,
      stale: results.filter((result) => result.stale).length,
      totalChanges: results.reduce((sum, result) => sum + (result.changeCount || 0), 0),
    };
    // Compatibility for older front-end/API consumers that looked for `changed`.
    summary.changed = summary.written;

    let manifestPath = null;
    if (writeManifest) {
      await fsp.mkdir(outputRoot, { recursive: true });
      manifestPath = path.join(
        outputRoot,
        "_ultimate-project-manager-file-tools-sanitizer-manifest.json",
      );
      const manifest = {
        kind: "sanitizer",
        generatedAt: new Date().toISOString(),
        projectId: scan.projectId,
        projectName: scan.projectName,
        sourceRoot: scan.root,
        outputRoot,
        options: {
          overwrite,
          backupBeforeRun,
          sanitizer: scan.settings,
        },
        summary,
        backupBeforeRun: projectBackup,
        files: results,
      };
      await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    await this.manager.log(
      summary.failed ? "warning" : "success",
      `Text Sanitizer output: ${scan.projectName || path.basename(scan.root)}`,
      {
        feature: "text-sanitizer",
        projectId: scan.projectId,
        sourceRoot: scan.root,
        outputRoot,
        manifestPath,
        backupBeforeRun,
        backupCreated: Boolean(projectBackup?.created),
        ...summary,
      },
    );

    return {
      results,
      summary,
      projectBackup,
      backupBeforeRun: projectBackup,
      sourceRoot: scan.root,
      outputRoot,
      manifestPath,
    };
  }
}

module.exports = { TextSanitizerService };
