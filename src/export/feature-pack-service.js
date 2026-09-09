"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const packageJson = require("../../package.json");

const FEATURE_PACK_SCHEMA = "upm-feature-pack/v1";
const DEFAULT_DIFF_FILE_LIMIT = 200;
const DEFAULT_DIFF_BYTE_LIMIT = 5 * 1024 * 1024;

function safeName(value) {
  return (
    String(value || "project")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function normalizeRelativePath(value) {
  const relative = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  if (!relative || relative.startsWith("/") || relative.includes("\0"))
    throw new Error("Invalid project-relative feature-pack path.");
  if (relative.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid project-relative feature-pack path.");
  return relative;
}

function fromPosix(root, relative) {
  return path.join(root, ...normalizeRelativePath(relative).split("/"));
}

function normalizeOptions(options = {}) {
  return {
    includeAdded: options.includeAdded !== false,
    includeModified: options.includeModified !== false,
    includeDeleted: options.includeDeleted !== false,
    includeTextDiffs: options.includeTextDiffs !== false,
    excludeSensitive: options.excludeSensitive !== false,
    packName: String(options.packName || "").trim(),
    maxDetailedDiffBytes: Math.max(
      16 * 1024,
      Math.min(2 * 1024 * 1024, Number(options.maxDetailedDiffBytes) || 512 * 1024),
    ),
    maxDiffFiles: Math.max(
      1,
      Math.min(1000, Number(options.maxDiffFiles) || DEFAULT_DIFF_FILE_LIMIT),
    ),
    maxDiffBytes: Math.max(
      128 * 1024,
      Math.min(64 * 1024 * 1024, Number(options.maxDiffBytes) || DEFAULT_DIFF_BYTE_LIMIT),
    ),
  };
}

function isLikelySensitivePath(relativePath) {
  const normalized = String(relativePath || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  const base = path.posix.basename(normalized);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (
    base === "credentials.json" ||
    base === "secrets.json" ||
    base === ".npmrc" ||
    base === ".pypirc"
  )
    return true;
  if (base === "id_rsa" || base === "id_ed25519" || base === "id_ecdsa") return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  if (/(^|\/)(secrets?|credentials?)(\/|\.|$)/.test(normalized)) return true;
  return false;
}

function selectedByStatus(item, options) {
  if (item.status === "added") return options.includeAdded;
  if (item.status === "modified") return options.includeModified;
  if (item.status === "deleted") return options.includeDeleted;
  return false;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function renderReviewDiff(detail) {
  if (!detail?.textDiff?.detailed) return null;
  const lines = detail.textDiff.lines || [];
  const body = lines
    .map((line) => {
      const marker = line.type === "addition" ? "+" : line.type === "deletion" ? "-" : " ";
      return `${marker}${line.text || ""}`;
    })
    .join("\n");
  return [
    "# Ultimate Project Manager review diff",
    `# Path: ${detail.path}`,
    `# Status: ${detail.status}`,
    `# Baseline: ${detail.baseline?.backupFile || "none"}`,
    "# This file is for review; it is not guaranteed to be directly patch-applicable.",
    `--- baseline/${detail.path}`,
    `+++ current/${detail.path}`,
    body,
    "",
  ].join("\n");
}

function featurePackReadme(manifest) {
  return [
    "Ultimate Project Manager - Export Changes Feature Pack",
    "======================================================",
    "",
    `Project: ${manifest.project.name}`,
    `Generated: ${manifest.generatedAt}`,
    `Baseline: ${manifest.baseline?.backupFile || "No previous backup baseline"}`,
    "",
    "Contents",
    "--------",
    "- files/ contains the CURRENT bytes for included added/modified regular files.",
    "- diffs/ contains bounded human-readable review diffs when requested and available.",
    "- _DELETED_FILES.txt lists included deletions relative to the baseline.",
    "- _SYMLINKS.json records changed symlink metadata; symlinks are not recreated in the pack.",
    "- _upm-feature-pack.json is the machine-readable evidence manifest.",
    "",
    "Safety",
    "------",
    "- Exporting does not modify the live project.",
    "- Likely secret files are omitted by default unless explicitly included.",
    "- Source files are SHA-256 checked while staging; export fails if they change mid-pack.",
    "- Review diffs are informational. The exact current bytes are under files/.",
    "",
    "Future compatibility",
    "--------------------",
    `Schema: ${manifest.schema}`,
    "This manifest is structured so a future import/apply workflow can validate baseline and file hashes before applying a pack.",
    "",
  ].join("\n");
}

class FeaturePackService {
  constructor({ manager, tarModule = null } = {}) {
    if (!manager) throw new Error("FeaturePackService requires a BackupManager instance.");
    this.manager = manager;
    this.tarModule = tarModule;
  }

  async preview(projectId, rawOptions = {}) {
    const project = this.manager.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    const options = normalizeOptions(rawOptions);
    const diff = await this.manager.getProjectDiff(projectId, {
      refresh: rawOptions.refresh !== false,
    });
    const rows = [];
    let estimatedBytes = 0;
    let omittedSensitive = 0;
    let includedRegularFiles = 0;
    let metadataOnly = 0;

    for (const item of diff.files || []) {
      if (!selectedByStatus(item, options)) continue;
      const sensitive = isLikelySensitivePath(item.path);
      const omitted = sensitive && options.excludeSensitive;
      const regularCurrentFile = item.status !== "deleted" && item.after?.type === "file";
      const entry = {
        ...item,
        sensitive,
        omitted,
        omittedReason: omitted ? "likely-sensitive" : null,
        packAction: omitted
          ? "omitted"
          : item.status === "deleted"
            ? "deleted-manifest"
            : regularCurrentFile
              ? "include-current-file"
              : "metadata-only",
      };
      rows.push(entry);
      if (omitted) omittedSensitive += 1;
      else if (regularCurrentFile) {
        includedRegularFiles += 1;
        estimatedBytes += Number(item.after?.size) || 0;
      } else if (item.status !== "deleted") metadataOnly += 1;
    }

    return {
      projectId: project.id,
      projectName: project.name,
      projectBackupEncryptionEnabled: project.backupEncryptionEnabled === true,
      checkedAt: diff.checkedAt,
      baseline: diff.baseline,
      current: diff.current,
      options,
      counts: {
        selected: rows.length,
        includedRegularFiles,
        deletedManifestEntries: rows.filter((row) => !row.omitted && row.status === "deleted")
          .length,
        metadataOnly,
        omittedSensitive,
      },
      estimatedBytes,
      hasExportableChanges: rows.some((row) => !row.omitted),
      files: rows,
      warnings: [
        ...(omittedSensitive
          ? [
              `${omittedSensitive} likely sensitive change${omittedSensitive === 1 ? " was" : "s were"} omitted.`,
            ]
          : []),
        ...(metadataOnly
          ? [
              `${metadataOnly} non-regular changed entr${metadataOnly === 1 ? "y is" : "ies are"} metadata-only.`,
            ]
          : []),
        ...(project.backupEncryptionEnabled === true
          ? [
              "This Feature Pack is a transport artifact and is not encrypted by the project backup-encryption setting.",
            ]
          : []),
        ...(!diff.baseline
          ? [
              "No previous successful backup baseline exists; selected current files are treated as additions.",
            ]
          : []),
      ],
    };
  }

  async create(projectId, rawOptions = {}) {
    const project = this.manager.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    const preview = await this.preview(projectId, {
      ...rawOptions,
      refresh: true,
    });
    if (!preview.hasExportableChanges) throw new Error("There are no selected changes to export.");

    const options = preview.options;
    const stageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-feature-pack-stage-"));
    const outputDir = rawOptions.outputDir
      ? path.resolve(String(rawOptions.outputDir))
      : os.tmpdir();
    await fsp.mkdir(outputDir, { recursive: true });

    const generatedAt = new Date().toISOString();
    const timestamp = generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const requestedBase = options.packName
      ? safeName(options.packName)
      : `${safeName(project.name)}-changes`;
    const fileName = `${requestedBase}-${timestamp}.upmfeature.tgz`;
    const archivePath = path.join(outputDir, fileName);
    const deleted = [];
    const symlinks = [];
    const manifestEntries = [];
    let detailedDiffsWritten = 0;
    let detailedDiffBytes = 0;

    try {
      for (const row of preview.files) {
        const manifestEntry = {
          path: row.path,
          status: row.status,
          sensitive: row.sensitive,
          included: !row.omitted,
          packAction: row.packAction,
          before: row.before || null,
          after: row.after || null,
          diffFile: null,
          verification: null,
        };

        if (row.omitted) {
          manifestEntry.reason = row.omittedReason;
          manifestEntries.push(manifestEntry);
          continue;
        }

        if (row.status === "deleted") {
          deleted.push(row.path);
        } else if (row.after?.type === "file") {
          const source = fromPosix(project.projectRoot, row.path);
          const relativeCheck = path.relative(project.projectRoot, source);
          if (relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck))
            throw new Error("Feature-pack path escaped the project root.");
          const sourceStat = await fsp.lstat(source);
          if (!sourceStat.isFile())
            throw new Error(`Source changed type while exporting feature pack: ${row.path}`);
          const destination = fromPosix(path.join(stageRoot, "files"), row.path);
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          await fsp.copyFile(source, destination);
          const stagedHash = await hashFile(destination);
          if (row.after?.hash && stagedHash !== row.after.hash) {
            const error = new Error(
              `Source changed while exporting feature pack: ${row.path}. Refresh the diff and retry.`,
            );
            error.code = "SOURCE_CHANGED_DURING_FEATURE_PACK";
            throw error;
          }
          manifestEntry.verification = {
            sha256: stagedHash,
            size: sourceStat.size,
          };
        } else if (row.after?.type === "symlink") {
          symlinks.push({
            path: row.path,
            target: row.after.target || null,
            status: row.status,
            hash: row.after.hash || null,
          });
          manifestEntry.reason = "symlink-metadata-only";
        } else {
          manifestEntry.reason = "non-regular-file-metadata-only";
        }

        if (
          options.includeTextDiffs &&
          detailedDiffsWritten < options.maxDiffFiles &&
          detailedDiffBytes < options.maxDiffBytes
        ) {
          try {
            const detail = await this.manager.getProjectFileDiff(projectId, row.path, {
              maxBytes: options.maxDetailedDiffBytes,
              maxInputLines: 20000,
              maxOutputLines: 40000,
            });
            const rendered = renderReviewDiff(detail);
            if (rendered) {
              const bytes = Buffer.byteLength(rendered);
              if (detailedDiffBytes + bytes <= options.maxDiffBytes) {
                const diffRelative = `${row.path}.diff`;
                const diffPath = fromPosix(path.join(stageRoot, "diffs"), diffRelative);
                await fsp.mkdir(path.dirname(diffPath), { recursive: true });
                await fsp.writeFile(diffPath, rendered, "utf8");
                manifestEntry.diffFile = `diffs/${diffRelative}`;
                detailedDiffsWritten += 1;
                detailedDiffBytes += bytes;
              }
            }
          } catch (error) {
            manifestEntry.diffReason = error.message;
          }
        }

        manifestEntries.push(manifestEntry);
      }

      if (deleted.length)
        await fsp.writeFile(
          path.join(stageRoot, "_DELETED_FILES.txt"),
          `${deleted.join("\n")}\n`,
          "utf8",
        );
      if (symlinks.length)
        await fsp.writeFile(
          path.join(stageRoot, "_SYMLINKS.json"),
          `${JSON.stringify(symlinks, null, 2)}\n`,
          "utf8",
        );

      const manifest = {
        schema: FEATURE_PACK_SCHEMA,
        featurePackId: crypto.randomUUID(),
        product: {
          name: "Ultimate Project Manager",
          version: packageJson.version,
        },
        generatedAt,
        project: {
          id: project.id,
          name: project.name,
          rootName: path.basename(project.projectRoot),
        },
        baseline: preview.baseline || null,
        current: preview.current || null,
        options: {
          includeAdded: options.includeAdded,
          includeModified: options.includeModified,
          includeDeleted: options.includeDeleted,
          includeTextDiffs: options.includeTextDiffs,
          excludeSensitive: options.excludeSensitive,
        },
        summary: {
          ...preview.counts,
          estimatedCurrentFileBytes: preview.estimatedBytes,
          detailedDiffsWritten,
          detailedDiffBytes,
        },
        files: manifestEntries,
        deletedFiles: deleted,
        symlinks,
        apply: {
          supportedByThisRelease: false,
          baselineProjectHash: preview.baseline?.projectHash || null,
          expectedCurrentProjectHash: preview.current?.projectHash || null,
          note: "Use this manifest for review/transport. A future importer can validate hashes before applying changes.",
        },
      };

      await fsp.writeFile(
        path.join(stageRoot, "_upm-feature-pack.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await fsp.writeFile(path.join(stageRoot, "_README.txt"), featurePackReadme(manifest), "utf8");

      const tar = this.tarModule || require("tar");
      const stageEntries = (await fsp.readdir(stageRoot)).sort();
      await tar.c({ gzip: true, cwd: stageRoot, file: archivePath, portable: true }, stageEntries);
      const archiveStat = await fsp.stat(archivePath);

      await this.manager.log("info", `Feature pack exported: ${project.name}`, {
        projectId,
        operation: "feature-pack-export",
        featurePackId: manifest.featurePackId,
        archiveFile: fileName,
        archiveBytes: archiveStat.size,
        selectedChanges: preview.counts.selected,
        omittedSensitive: preview.counts.omittedSensitive,
        includedRegularFiles: preview.counts.includedRegularFiles,
        deletedManifestEntries: preview.counts.deletedManifestEntries,
      });

      return {
        archivePath,
        fileName,
        size: archiveStat.size,
        manifest,
      };
    } finally {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  FEATURE_PACK_SCHEMA,
  FeaturePackService,
  isLikelySensitivePath,
  normalizeOptions,
  renderReviewDiff,
};
