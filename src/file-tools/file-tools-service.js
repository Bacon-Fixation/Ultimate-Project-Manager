"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { atomicWriteFile } = require("../filesystem/atomic-file");
const {
  prepareLatestPlan,
  prepareCommentPlan,
  preparePipelinePlan,
  prepareInventoryPlan,
  executeOperations,
  summarizeResults,
  writeManifest,
  getCommentStyle,
  stripComments,
  isLikelyBinary,
  babelParserAvailable,
  DEFAULT_COMMENT_MAX_BYTES,
} = require("./file-tools-core");
const { AGGRESSIVENESS_LEVELS, normalizeAggressiveness } = require("./comment-policy");

const WORKFLOWS = Object.freeze({
  latest: {
    id: "latest",
    label: "Latest File Parser",
    description:
      "Select the newest _YYYYMMDDHHmmss version in each file group and write a clean filename tree.",
  },
  comments: {
    id: "comments",
    label: "Comment Remover",
    description:
      "Create a separate copy with supported source comments removed while preserving the source tree.",
  },
  pipeline: {
    id: "pipeline",
    label: "Latest + Comment Cleanup",
    description:
      "Select newest timestamped files first, then clean supported comments in the same output pass.",
  },
  inventory: {
    id: "inventory",
    label: "Inventory + Duplicate Finder",
    description:
      "Create a SHA-256 file inventory and identify exact duplicate files without modifying source files.",
  },
});

function safeFolderName(value) {
  const text = String(value || "project")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || "project";
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function parseExcludes(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(/[\r\n,]+/);
  return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
  };
}

class FileToolsService {
  constructor(options = {}) {
    if (!options.manager) throw new Error("FileToolsService requires a BackupManager instance.");
    this.manager = options.manager;
    this.dataDir = path.resolve(
      options.dataDir || this.manager.dataDir || path.join(process.cwd(), "data"),
    );
    this.outputRoot = path.resolve(
      options.outputRoot || path.join(this.dataDir, "file-tools-output"),
    );
    this.historyFile = path.resolve(
      options.historyFile || path.join(this.dataDir, "file-tools-history.jsonl"),
    );
    this.maxHistory = clamp(options.maxHistory, 10, 5000, 500);
    this.history = [];
    this.running = new Map();
  }

  async init() {
    await fsp.mkdir(this.outputRoot, { recursive: true });
    await this._loadHistory();
    return this;
  }

  async _loadHistory() {
    try {
      const raw = await fsp.readFile(this.historyFile, "utf8");
      this.history = raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-this.maxHistory)
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.history = [];
    }
  }

  async _recordHistory(entry) {
    this.history.unshift(entry);
    this.history = this.history.slice(0, this.maxHistory);
    await fsp.mkdir(path.dirname(this.historyFile), { recursive: true });
    const lines = [...this.history]
      .reverse()
      .map((item) => JSON.stringify(item))
      .join("\n");
    await atomicWriteFile(this.historyFile, lines ? `${lines}\n` : "", {
      encoding: "utf8",
      backup: true,
    }).catch(() => {});
    return entry;
  }

  getHistory(limit = 50) {
    return this.history.slice(0, clamp(limit, 1, 500, 50));
  }

  async clearHistory() {
    this.history = [];
    await fsp.rm(this.historyFile, { force: true }).catch(() => {});
  }

  getMeta() {
    return {
      workflows: Object.values(WORKFLOWS),
      outputRoot: this.outputRoot,
      running: [...this.running.values()],
      supportedCommentStyles: [
        {
          style: "c-style",
          label: "C-style",
          examples:
            "JS/TS, Java, C/C++, C#, Go, Rust, Swift, Kotlin, PHP, JSONC, Groovy, Scala, Dart, Solidity, Proto",
        },
        {
          style: "block-only",
          label: "Block-only",
          examples: "CSS and PostCSS /* */ comments without unsafe // stripping",
        },
        {
          style: "hash",
          label: "Hash comments",
          examples:
            "Python, shell, Ruby, Perl, R, TOML, INI, ENV/config, GraphQL, Dockerfile/Makefile",
        },
        {
          style: "yaml",
          label: "YAML",
          examples: "Quote-aware # comments with block-scalar protection",
        },
        {
          style: "powershell",
          label: "PowerShell",
          examples: "# line comments and <# #> blocks",
        },
        {
          style: "lua",
          label: "Lua",
          examples: "-- line comments and --[[ ]] blocks",
        },
        {
          style: "batch",
          label: "Batch/CMD",
          examples: "REM and :: comment lines",
        },
        {
          style: "vb",
          label: "VB/VBS",
          examples: "' line comments and REM statements",
        },
        {
          style: "haskell",
          label: "Haskell",
          examples: "-- line comments and {- -} blocks",
        },
        {
          style: "hcl",
          label: "HCL/Terraform",
          examples: "#, //, and /* */ comments",
        },
        {
          style: "html",
          label: "Markup comments",
          examples: "HTML, XML, SVG, Markdown HTML comments",
        },
        {
          style: "pug",
          label: "Pug/Jade",
          examples: "Indented // and //- comment blocks",
        },
        {
          style: "sql",
          label: "SQL",
          examples: "-- line comments and /* */ blocks",
        },
      ],
      defaultCommentMaxBytes: DEFAULT_COMMENT_MAX_BYTES,
      commentAggressivenessLevels: [
        {
          id: "safe",
          label: "Safe",
          description:
            "Remove ordinary comments while keeping legal notices, documentation/JSDoc, TODO/FIXME/NOTE comments, and tooling/compiler directives.",
        },
        {
          id: "standard",
          label: "Standard",
          description:
            "Remove ordinary and documentation/note comments while keeping legal notices and tooling/compiler directives.",
        },
        {
          id: "aggressive",
          label: "Aggressive",
          description:
            "Remove all comments except legal/license comments when legal preservation remains enabled.",
        },
      ],
      babel: {
        available: babelParserAvailable(),
        preferredFor: [".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"],
      },
      warning:
        "JavaScript/TypeScript comment cleanup prefers @babel/parser for syntax-aware comment ranges and falls back to the lexical scanners when parsing is unavailable or fails. Other supported languages use their dedicated lexical scanners. Output is always written to a separate tree.",
    };
  }

  getDefaults(projectId = null, mode = "pipeline") {
    const workflow = WORKFLOWS[mode] ? mode : "pipeline";
    const project = projectId ? this.manager.getProject(projectId) : null;
    const projectFolder = project
      ? `${safeFolderName(project.name)}-${project.id.slice(0, 8)}`
      : "custom";

    return {
      projectId: project?.id || null,
      projectName: project?.name || null,
      sourceRoot: project?.projectRoot || "",
      outputRoot: path.join(this.outputRoot, projectFolder, workflow),
      mode: workflow,
    };
  }

  _normalizeInput(input = {}) {
    const mode = WORKFLOWS[input.mode] ? input.mode : "pipeline";
    const project = input.projectId ? this.manager.getProject(input.projectId) : null;
    if (input.projectId && !project) throw new Error("Project not found.");

    const defaults = this.getDefaults(project?.id || null, mode);
    const sourceRoot = path.resolve(String(input.sourceRoot || defaults.sourceRoot || "").trim());
    if (!String(input.sourceRoot || defaults.sourceRoot || "").trim())
      throw new Error("A source folder is required.");

    const outputRoot = path.resolve(String(input.outputRoot || defaults.outputRoot || "").trim());
    if (!String(input.outputRoot || defaults.outputRoot || "").trim())
      throw new Error("An output folder is required.");
    if (sourceRoot === outputRoot) throw new Error("Source and output folders must be different.");

    const useProjectExcludes = input.useProjectExcludes !== false;
    const projectExcludes =
      useProjectExcludes && project?.extraExcludes ? parseExcludes(project.extraExcludes) : [];
    const additionalExcludes = parseExcludes(input.excludes);
    const includePatterns = parseExcludes(input.includes);

    return {
      mode,
      project,
      projectId: project?.id || null,
      sourceRoot,
      outputRoot,
      excludes: [...new Set([...projectExcludes, ...additionalExcludes])],
      additionalExcludes,
      includePatterns,
      minFileBytes: clamp(input.minFileBytes, 0, 1024 * 1024 * 1024 * 1024, 0),
      maxFileBytes: clamp(input.maxFileBytes, 0, 1024 * 1024 * 1024 * 1024, 0),
      projectExcludes,
      useProjectExcludes,
      respectGitignore: input.respectGitignore !== false,
      copyUnversioned: Boolean(input.copyUnversioned),
      copyUnsupported: input.copyUnsupported !== false,
      preserveLinePositions: input.preserveLinePositions !== false,
      preserveLicenseComments: input.preserveLicenseComments !== false,
      commentAggressiveness: normalizeAggressiveness(input.commentAggressiveness),
      maxCommentFileBytes: clamp(
        input.maxCommentFileBytes,
        64 * 1024,
        32 * 1024 * 1024,
        DEFAULT_COMMENT_MAX_BYTES,
      ),
      overwrite: input.overwrite !== false,
      dryRun: Boolean(input.dryRun),
      writeManifest: mode === "inventory" ? true : input.writeManifest !== false,
      backupBeforeRun: Boolean(input.backupBeforeRun),
      previewLimit: clamp(input.previewLimit, 10, 1000, 200),
    };
  }

  async _prepare(options) {
    if (options.mode === "latest") {
      return prepareLatestPlan({
        sourceRoot: options.sourceRoot,
        outputRoot: options.outputRoot,
        copyUnversioned: options.copyUnversioned,
        excludes: options.excludes,
        respectGitignore: options.respectGitignore,
        includes: options.includePatterns,
        minFileBytes: options.minFileBytes,
        maxFileBytes: options.maxFileBytes,
      });
    }

    if (options.mode === "comments") {
      return prepareCommentPlan({
        sourceRoot: options.sourceRoot,
        outputRoot: options.outputRoot,
        excludes: options.excludes,
        copyUnsupported: options.copyUnsupported,
        respectGitignore: options.respectGitignore,
        includes: options.includePatterns,
        minFileBytes: options.minFileBytes,
        maxFileBytes: options.maxFileBytes,
      });
    }

    if (options.mode === "inventory") {
      return prepareInventoryPlan({
        sourceRoot: options.sourceRoot,
        outputRoot: options.outputRoot,
        excludes: options.excludes,
        respectGitignore: options.respectGitignore,
        includes: options.includePatterns,
        minFileBytes: options.minFileBytes,
        maxFileBytes: options.maxFileBytes,
      });
    }

    return preparePipelinePlan({
      sourceRoot: options.sourceRoot,
      outputRoot: options.outputRoot,
      copyUnversioned: options.copyUnversioned,
      copyUnsupported: options.copyUnsupported,
      excludes: options.excludes,
      respectGitignore: options.respectGitignore,
      includes: options.includePatterns,
      minFileBytes: options.minFileBytes,
      maxFileBytes: options.maxFileBytes,
    });
  }

  async _operationStats(operations) {
    let sourceBytes = 0;
    let supportedCommentFiles = 0;
    let unsupportedCommentFiles = 0;

    for (const operation of operations) {
      const stat = await fsp.stat(operation.sourcePath).catch(() => null);
      if (stat?.isFile()) sourceBytes += Number(stat.size || 0);
      if (getCommentStyle(path.basename(operation.sourcePath))) supportedCommentFiles += 1;
      else unsupportedCommentFiles += 1;
    }

    return { sourceBytes, supportedCommentFiles, unsupportedCommentFiles };
  }

  async _commentPreviewStats(operations, options) {
    if (!["comments", "pipeline"].includes(options.mode))
      return { summary: {}, details: new Map() };

    const details = new Map();
    const maxAnalyze = Math.min(operations.length, options.previewLimit, 100);
    const maxAnalyzeBytes = 32 * 1024 * 1024;
    let analyzedBytes = 0;
    const summary = {
      commentPreviewFilesAnalyzed: 0,
      commentPreviewBytesAnalyzed: 0,
      commentsWouldRemove: 0,
      legalCommentsWouldPreserve: 0,
      policyCommentsWouldPreserve: 0,
      babelPreviewFiles: 0,
      lexicalPreviewFiles: 0,
      lexicalFallbackPreviewFiles: 0,
      commentPreviewSkippedLarge: 0,
      commentPreviewSkippedBinary: 0,
      commentPreviewTruncated: operations.length > maxAnalyze,
    };

    for (const operation of operations.slice(0, maxAnalyze)) {
      const style = getCommentStyle(path.basename(operation.sourcePath));
      if (!style) continue;
      const stat = await fsp.stat(operation.sourcePath).catch(() => null);
      if (!stat?.isFile()) continue;
      if (stat.size > options.maxCommentFileBytes) {
        summary.commentPreviewSkippedLarge += 1;
        continue;
      }
      if (analyzedBytes + stat.size > maxAnalyzeBytes) {
        summary.commentPreviewTruncated = true;
        break;
      }
      const sourceBuffer = await fsp.readFile(operation.sourcePath).catch(() => null);
      if (!sourceBuffer) continue;
      if (isLikelyBinary(sourceBuffer)) {
        summary.commentPreviewSkippedBinary += 1;
        continue;
      }

      analyzedBytes += stat.size;
      summary.commentPreviewBytesAnalyzed = analyzedBytes;
      const cleaned = stripComments(
        path.basename(operation.sourcePath),
        sourceBuffer.toString("utf8"),
        {
          preserveLinePositions: options.preserveLinePositions,
          preserveLicenseComments: options.preserveLicenseComments,
          commentAggressiveness: options.commentAggressiveness,
        },
      );
      const detail = {
        commentsWouldRemove: cleaned.commentsRemoved || 0,
        legalCommentsWouldPreserve: cleaned.legalCommentsPreserved || 0,
        policyCommentsWouldPreserve: cleaned.policyCommentsPreserved || 0,
        parserEngine: cleaned.parserEngine || "lexical",
        parserFallbackReason: cleaned.parserFallbackReason || null,
      };
      details.set(operation.sourcePath, detail);
      summary.commentPreviewFilesAnalyzed += 1;
      summary.commentsWouldRemove += detail.commentsWouldRemove;
      summary.legalCommentsWouldPreserve += detail.legalCommentsWouldPreserve;
      summary.policyCommentsWouldPreserve += detail.policyCommentsWouldPreserve;
      if (detail.parserEngine === "babel") summary.babelPreviewFiles += 1;
      else if (detail.parserEngine === "lexical-fallback") summary.lexicalFallbackPreviewFiles += 1;
      else summary.lexicalPreviewFiles += 1;
    }

    return { summary, details };
  }

  _planSummary(plan, options, operationStats) {
    const base = {
      workflow: options.mode,
      plannedCopies: plan.operations.length,
      sourceBytes: operationStats.sourceBytes,
      supportedCommentFiles: operationStats.supportedCommentFiles,
      unsupportedCommentFiles: operationStats.unsupportedCommentFiles,
      ignoredDirectories: plan.ignoredDirectories?.length || 0,
      ignoredFiles: plan.ignoredFiles?.length || 0,
      filteredFiles: plan.filteredFiles?.length || 0,
      includePatterns: options.includePatterns.length,
      gitignoreRules: plan.gitignore?.patternCount || 0,
      additionalExcludes: options.additionalExcludes.length,
      projectExcludes: options.projectExcludes.length,
    };

    if (options.mode === "inventory") {
      return {
        ...base,
        plannedCopies: 0,
        filesFound: plan.operations.length,
        inventoryBytes: plan.totalBytes || 0,
        duplicateGroups: plan.duplicateGroups?.length || 0,
        duplicateFiles: plan.duplicateFiles || 0,
      };
    }

    if (options.mode === "comments") {
      return {
        ...base,
        filesFound: plan.files.length,
        supportedFiles: plan.supported,
        unsupportedFiles: plan.unsupported,
      };
    }

    return {
      ...base,
      timestampedFiles: plan.timestampedCount,
      versionGroups: plan.groups.size,
      unversionedFiles: plan.unversionedCount,
      collisions: plan.collisions.length,
    };
  }

  _warnings(plan, options) {
    const warnings = [];
    const relativeOutput = path.relative(options.sourceRoot, options.outputRoot);
    if (relativeOutput && !relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)) {
      warnings.push(
        "The output folder is inside the source tree. It will be excluded automatically from future scans.",
      );
    }
    if (!plan.operations.length) warnings.push("No files matched the current workflow/options.");
    if (options.includePatterns.length)
      warnings.push(
        `${options.includePatterns.length} include pattern(s) are filtering the source scan.`,
      );
    if (options.mode === "inventory" && (plan.duplicateGroups?.length || 0) > 0)
      warnings.push(
        `${plan.duplicateGroups.length} exact duplicate group(s) were found by SHA-256.`,
      );
    if ((options.mode === "latest" || options.mode === "pipeline") && plan.timestampedCount === 0) {
      warnings.push("No _YYYYMMDDHHmmss timestamped filenames were found.");
    }
    if (
      (options.mode === "latest" || options.mode === "pipeline") &&
      !options.copyUnversioned &&
      plan.unversionedCount > 0
    ) {
      warnings.push(`${plan.unversionedCount} unversioned file(s) will be ignored.`);
    }
    if ((options.mode === "comments" || options.mode === "pipeline") && !options.copyUnsupported) {
      const unsupported =
        options.mode === "comments"
          ? plan.unsupported
          : plan.operations.filter((item) => !getCommentStyle(path.basename(item.sourcePath)))
              .length;
      if (unsupported) warnings.push(`${unsupported} unsupported file(s) will not be copied.`);
    }
    if (options.respectGitignore && !plan.gitignore?.found)
      warnings.push(
        "Respect .gitignore is enabled, but no .gitignore was found at the selected source root.",
      );
    if (options.useProjectExcludes && options.projectId && options.projectExcludes.length)
      warnings.push(
        `${options.projectExcludes.length} project-level exclude pattern(s) are also being applied.`,
      );
    if (options.backupBeforeRun && !options.projectId)
      warnings.push(
        "Backup before processing requires a registered project context and will be skipped for this custom-folder run.",
      );
    if (options.mode === "comments" || options.mode === "pipeline") {
      warnings.push(
        `Comment removal aggressiveness is ${options.commentAggressiveness}. JavaScript/TypeScript uses @babel/parser when available; other languages use dedicated lexical scanners.`,
      );
      if (!babelParserAvailable())
        warnings.push(
          "@babel/parser is not currently available, so JavaScript/TypeScript will use the lexical fallback until dependencies are installed.",
        );
      if (options.commentAggressiveness === "aggressive")
        warnings.push(
          "Aggressive mode removes semantic tooling comments such as TypeScript/ESLint/coverage/bundler directives. Use preview before applying the output.",
        );
    }
    return warnings;
  }

  async preview(input = {}) {
    const options = this._normalizeInput(input);
    const plan = await this._prepare(options);
    const operationStats = await this._operationStats(plan.operations);
    const commentPreview = await this._commentPreviewStats(plan.operations, options);
    const summary = {
      ...this._planSummary(plan, options, operationStats),
      ...commentPreview.summary,
    };

    return {
      ok: true,
      preview: true,
      mode: options.mode,
      projectId: options.projectId,
      projectName: options.project?.name || null,
      sourceRoot: options.sourceRoot,
      outputRoot: options.outputRoot,
      options: {
        excludes: plan.excludes || options.excludes,
        copyUnversioned: options.copyUnversioned,
        copyUnsupported: options.copyUnsupported,
        respectGitignore: options.respectGitignore,
        useProjectExcludes: options.useProjectExcludes,
        projectExcludes: options.projectExcludes,
        additionalExcludes: options.additionalExcludes,
        includePatterns: options.includePatterns,
        minFileBytes: options.minFileBytes,
        maxFileBytes: options.maxFileBytes,
        preserveLinePositions: options.preserveLinePositions,
        preserveLicenseComments: options.preserveLicenseComments,
        commentAggressiveness: options.commentAggressiveness,
        maxCommentFileBytes: options.maxCommentFileBytes,
        overwrite: options.overwrite,
        dryRun: options.dryRun,
        writeManifest: options.writeManifest,
        backupBeforeRun: options.backupBeforeRun,
      },
      summary,
      warnings: this._warnings(plan, options),
      collisions: (plan.collisions || []).slice(0, options.previewLimit),
      duplicateGroups: (plan.duplicateGroups || []).slice(0, options.previewLimit),
      ignored: {
        files: (plan.ignoredFiles || []).slice(0, options.previewLimit),
        directories: (plan.ignoredDirectories || []).slice(0, options.previewLimit),
        filtered: (plan.filteredFiles || []).slice(0, options.previewLimit),
        truncated:
          (plan.ignoredFiles || []).length > options.previewLimit ||
          (plan.ignoredDirectories || []).length > options.previewLimit ||
          (plan.filteredFiles || []).length > options.previewLimit,
        gitignore: plan.gitignore || null,
      },
      operations: plan.operations.slice(0, options.previewLimit).map((item) => ({
        type: item.type,
        sourceRelativePath: item.sourceRelativePath,
        destinationRelativePath: item.destinationRelativePath,
        timestamp: item.timestamp || null,
        versionsFound: item.versionsFound || 1,
        commentStyle: item.commentStyle || getCommentStyle(path.basename(item.sourcePath)),
        size: item.size ?? null,
        sha256: item.sha256 || null,
        olderVersions: (item.olderVersions || []).slice(0, 20),
        ...(commentPreview.details.get(item.sourcePath) || {}),
      })),
      truncated: plan.operations.length > options.previewLimit,
    };
  }

  async run(input = {}) {
    const options = this._normalizeInput(input);
    const outputKey =
      process.platform === "win32" ? options.outputRoot.toLowerCase() : options.outputRoot;
    const conflictingRun = [...this.running.values()].find((item) => item.outputKey === outputKey);
    if (conflictingRun)
      throw new Error(
        `Another File Tools run is already writing to this output folder (run ${conflictingRun.id}).`,
      );
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const running = {
      id: runId,
      mode: options.mode,
      projectId: options.projectId,
      projectName: options.project?.name || null,
      sourceRoot: options.sourceRoot,
      outputRoot: options.outputRoot,
      outputKey,
      startedAt,
    };
    this.running.set(runId, running);

    let backupResult = null;
    try {
      const plan = await this._prepare(options);
      const operationStats = await this._operationStats(plan.operations);
      const planSummary = this._planSummary(plan, options, operationStats);
      const warnings = this._warnings(plan, options);

      if (options.backupBeforeRun && options.projectId && !options.dryRun) {
        backupResult = await this.manager.runBackup(options.projectId, {
          force: true,
          source: "file-tools",
        });
      }

      const cleanComments = options.mode === "comments" || options.mode === "pipeline";
      const results =
        options.mode === "inventory"
          ? plan.operations.map((item) => ({
              ...item,
              status: options.dryRun ? "dry-run" : "inventoried",
            }))
          : await executeOperations({
              operations: plan.operations,
              overwrite: options.overwrite,
              dryRun: options.dryRun,
              preserveLinePositions: options.preserveLinePositions,
              preserveLicenseComments: options.preserveLicenseComments,
              commentAggressiveness: options.commentAggressiveness,
              maxCommentFileBytes: options.maxCommentFileBytes,
              cleanComments,
            });

      const resultSummary = summarizeResults(results);
      if (options.mode === "inventory") resultSummary.inventoried = results.length;
      const summary = { ...planSummary, ...resultSummary };
      let manifestPath = null;

      if (options.writeManifest) {
        const suffix = options.dryRun ? ".dry-run.json" : ".json";
        manifestPath = await writeManifest({
          outputRoot: options.outputRoot,
          name: `_ultimate-project-manager-file-tools-${options.mode}-manifest${suffix}`,
          kind: options.mode,
          options: {
            projectId: options.projectId,
            sourceRoot: options.sourceRoot,
            outputRoot: options.outputRoot,
            excludes: plan.excludes || options.excludes,
            copyUnversioned: options.copyUnversioned,
            copyUnsupported: options.copyUnsupported,
            respectGitignore: options.respectGitignore,
            useProjectExcludes: options.useProjectExcludes,
            projectExcludes: options.projectExcludes,
            additionalExcludes: options.additionalExcludes,
            includePatterns: options.includePatterns,
            minFileBytes: options.minFileBytes,
            maxFileBytes: options.maxFileBytes,
            preserveLinePositions: options.preserveLinePositions,
            preserveLicenseComments: options.preserveLicenseComments,
            commentAggressiveness: options.commentAggressiveness,
            maxCommentFileBytes: options.maxCommentFileBytes,
            overwrite: options.overwrite,
            dryRun: options.dryRun,
            backupBeforeRun: options.backupBeforeRun,
          },
          summary,
          results,
          extra: {
            runId,
            warnings,
            backupBeforeRun: backupResult,
            collisions: plan.collisions || [],
            ignoredFiles: (plan.ignoredFiles || []).slice(0, 500),
            ignoredDirectories: (plan.ignoredDirectories || []).slice(0, 500),
            gitignore: plan.gitignore || null,
            duplicateGroups: (plan.duplicateGroups || []).slice(0, 500),
          },
        });
      }

      const finishedAt = new Date().toISOString();
      const entry = {
        id: runId,
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        status: resultSummary.errors ? "warning" : "success",
        mode: options.mode,
        projectId: options.projectId,
        projectName: options.project?.name || null,
        sourceRoot: options.sourceRoot,
        outputRoot: options.outputRoot,
        dryRun: options.dryRun,
        commentAggressiveness: options.commentAggressiveness,
        backupBeforeRun: options.backupBeforeRun,
        backupCreated: Boolean(backupResult?.created),
        manifestPath,
        summary,
        warnings,
      };
      await this._recordHistory(entry);

      await this.manager.log(
        resultSummary.errors ? "warning" : "success",
        `File Tools ${WORKFLOWS[options.mode].label}: ${options.project?.name || path.basename(options.sourceRoot)}`,
        {
          feature: "file-tools",
          runId,
          projectId: options.projectId,
          workflow: options.mode,
          commentAggressiveness: options.commentAggressiveness,
          sourceRoot: options.sourceRoot,
          outputRoot: options.outputRoot,
          manifestPath,
          ...summary,
        },
      );

      return {
        ok: resultSummary.errors === 0,
        runId,
        mode: options.mode,
        projectId: options.projectId,
        projectName: options.project?.name || null,
        sourceRoot: options.sourceRoot,
        outputRoot: options.outputRoot,
        summary,
        warnings,
        backupBeforeRun: backupResult,
        manifestPath,
        duplicateGroups: (plan.duplicateGroups || []).slice(0, options.previewLimit),
        results: results.slice(0, options.previewLimit),
        truncated: results.length > options.previewLimit,
        historyEntry: entry,
      };
    } catch (error) {
      const entry = {
        id: runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        status: "error",
        mode: options.mode,
        projectId: options.projectId,
        projectName: options.project?.name || null,
        sourceRoot: options.sourceRoot,
        outputRoot: options.outputRoot,
        error: serializeError(error),
      };
      await this._recordHistory(entry);
      await this.manager
        .log(
          "error",
          `File Tools failed: ${options.project?.name || path.basename(options.sourceRoot)}`,
          {
            feature: "file-tools",
            runId,
            projectId: options.projectId,
            workflow: options.mode,
            sourceRoot: options.sourceRoot,
            outputRoot: options.outputRoot,
            error: error.message,
            errorCode: error.code || null,
          },
        )
        .catch(() => {});
      throw error;
    } finally {
      this.running.delete(runId);
    }
  }
}

module.exports = { FileToolsService, WORKFLOWS, parseExcludes };
