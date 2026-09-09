"use strict";

const fsp = require("fs/promises");
const path = require("path");
const {
  ProjectBackup,
  defaultBackupFolderName,
  requireSafePathComponent,
  safeName,
} = require("../backup/project-backup");
const { isPathInside } = require("../pm2/pm2-monitor");

async function filesystemStats(directory) {
  const target = path.resolve(String(directory));
  try {
    const stat = await fsp.statfs(target);
    const blockSize = Number(stat.bsize || 0);
    const total = blockSize * Number(stat.blocks || 0);
    const available = blockSize * Number(stat.bavail || 0);
    return {
      path: target,
      root: path.parse(target).root || target,
      totalBytes: Number.isFinite(total) ? total : null,
      availableBytes: Number.isFinite(available) ? available : null,
      usedBytes: Number.isFinite(total - available) ? total - available : null,
    };
  } catch (error) {
    return {
      path: target,
      root: path.parse(target).root || target,
      totalBytes: null,
      availableBytes: null,
      usedBytes: null,
      error: error.message,
      code: error.code || null,
    };
  }
}

class RemoteProjectExecutor {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data", "lan-agent"));
    this.backupRoot = path.resolve(options.backupRoot || path.join(this.dataDir, "backups"));
    this.restoreRoot = path.resolve(options.restoreRoot || path.join(this.dataDir, "restores"));
    this.allowedProjectRoots = (options.allowedProjectRoots || []).map((item) =>
      path.resolve(item),
    );
    if (!this.allowedProjectRoots.length)
      throw new Error(
        "UPM_AGENT_ALLOWED_PROJECT_ROOTS must contain at least one project parent folder.",
      );
    this.allowedBackupRoots = [
      ...new Set([
        this.backupRoot,
        ...(options.allowedBackupRoots || []).map((item) => path.resolve(item)),
      ]),
    ];
    this.allowedRestoreRoots = [
      ...new Set([
        this.restoreRoot,
        ...(options.allowedRestoreRoots || []).map((item) => path.resolve(item)),
      ]),
    ];
    this.encryptionKey = String(options.encryptionKey || "");
  }

  _normalize(project = {}) {
    const rawId = String(project.id || "").trim();
    const name = String(project.name || "").trim();
    const projectRoot = String(project.projectRoot || "").trim();
    if (!rawId || !name || !projectRoot)
      throw new Error("Remote project id, name, and projectRoot are required.");
    const id = requireSafePathComponent(rawId, "Remote project id", { maxLength: 128 });
    const backupFolderName = requireSafePathComponent(
      project.backupFolderName || defaultBackupFolderName(name, id),
      "Remote project backup folder name",
    );
    return {
      ...project,
      id,
      name,
      projectRoot: path.resolve(projectRoot),
      backupFolderName,
      backupDir: project.backupDir
        ? path.resolve(String(project.backupDir))
        : path.join(this.backupRoot, backupFolderName),
      backupDirSecondary: project.backupDirSecondary
        ? path.resolve(String(project.backupDirSecondary))
        : null,
      keep: Math.max(1, Math.min(1000, Number(project.keep) || 10)),
      extraExcludes: Array.isArray(project.extraExcludes) ? project.extraExcludes.map(String) : [],
      extraIncludes: Array.isArray(project.extraIncludes) ? project.extraIncludes.map(String) : [],
    };
  }

  async validate(project) {
    const p = this._normalize(project);
    if (
      this.allowedProjectRoots.length &&
      !this.allowedProjectRoots.some((root) => isPathInside(root, p.projectRoot))
    ) {
      throw new Error(`Project path is outside UPM_AGENT_ALLOWED_PROJECT_ROOTS: ${p.projectRoot}`);
    }
    const stat = await fsp.stat(p.projectRoot);
    if (!stat.isDirectory()) throw new Error("Remote project path must be a directory.");
    if (!this.allowedBackupRoots.some((root) => isPathInside(root, p.backupDir)))
      throw new Error(
        `Primary backup path is outside UPM_AGENT_ALLOWED_BACKUP_ROOTS: ${p.backupDir}`,
      );
    if (
      p.backupDirSecondary &&
      !this.allowedBackupRoots.some((root) => isPathInside(root, p.backupDirSecondary))
    )
      throw new Error(
        `Secondary backup path is outside UPM_AGENT_ALLOWED_BACKUP_ROOTS: ${p.backupDirSecondary}`,
      );
    if (isPathInside(p.projectRoot, p.backupDir))
      throw new Error("Primary backup path cannot be inside the project root.");
    if (p.backupDirSecondary && isPathInside(p.projectRoot, p.backupDirSecondary))
      throw new Error("Secondary backup path cannot be inside the project root.");
    if (p.backupDirSecondary && path.resolve(p.backupDirSecondary) === path.resolve(p.backupDir))
      throw new Error("Primary and secondary backup paths must be different.");
    const journalRoot = path.resolve(this.dataDir, "delta-journal");
    const journalDir = path.resolve(this._journalDir(p));
    if (!isPathInside(journalRoot, journalDir) || journalRoot === journalDir)
      throw new Error("Remote delta-journal path escaped the agent data directory.");
    return p;
  }

  _journalDir(p) {
    return path.join(this.dataDir, "delta-journal", p.backupFolderName);
  }

  _engine(p, destination = "primary") {
    const backupDir = destination === "secondary" ? p.backupDirSecondary : p.backupDir;
    if (!backupDir) throw new Error(`Remote backup destination is not configured: ${destination}`);
    const other = [p.backupDir, p.backupDirSecondary, this._journalDir(p)]
      .filter(Boolean)
      .filter((dir) => path.resolve(dir) !== path.resolve(backupDir));
    return new ProjectBackup({
      projectRoot: p.projectRoot,
      backupDir,
      additionalBackupDirs: other,
      projectName: p.name,
      keep: p.keep,
      extraExcludes: p.extraExcludes,
      extraIncludes: p.extraIncludes,
      encryptionEnabled: p.backupEncryptionEnabled === true,
      encryptionKey: this.encryptionKey,
      projectId: p.id,
      journalEnabled: destination === "primary" && p.deltaJournalEnabled === true,
      journalDir: this._journalDir(p),
      journalRetentionDays: p.deltaJournalRetentionDays,
      journalMaxEntries: p.deltaJournalMaxEntries,
      journalMaxBytes: Number(p.deltaJournalMaxStorageMB || 1024) * 1024 * 1024,
      journalMaxFileBytes: Number(p.deltaJournalMaxFileMB || 16) * 1024 * 1024,
      journalMaxTransitionBytes:
        Math.max(64, Math.min(128, Number(p.deltaJournalMaxFileMB || 16) * 4)) * 1024 * 1024,
    });
  }

  async inspect(project) {
    const p = await this.validate(project);
    const inspected = await this._engine(p).inspect();
    return {
      created: false,
      changed: inspected.changed,
      projectHash: inspected.current.projectHash,
      fileCount: inspected.current.entries.length,
      sourceBytes: inspected.current.totalBytes,
      changes: inspected.changes,
    };
  }

  async _syncSecondary(p) {
    if (!p.backupDirSecondary) return null;
    const primary = this._engine(p, "primary");
    const secondary = this._engine(p, "secondary");
    try {
      await fsp.mkdir(p.backupDirSecondary, { recursive: true });
      const primaryBackups = (await primary.listBackups()).slice(0, p.keep);
      const secondaryBackups = await secondary.listBackups();
      const existing = new Set(
        secondaryBackups
          .filter((item) => item.verificationStatus === "verified")
          .map((item) => item.file),
      );
      const copied = [];
      for (const backup of primaryBackups) {
        if (existing.has(backup.file)) continue;
        await secondary.mirrorVerifiedBackup(backup.path, backup);
        copied.push(backup.file);
      }
      const retention = await secondary.prune();
      return {
        available: true,
        copied,
        pendingCount: 0,
        failures: retention.failures || [],
        retention,
      };
    } catch (error) {
      return {
        available: false,
        copied: [],
        pendingCount: 1,
        failures: [
          {
            error: error.message,
            code: error.code || null,
            path: error.path || null,
          },
        ],
        error: error.message,
      };
    }
  }

  async backup(project, options = {}) {
    const p = await this.validate(project);
    await fsp.mkdir(p.backupDir, { recursive: true });
    const result = await this._engine(p).backupIfChanged({
      force: options.force === true,
    });
    const destinations = [
      {
        key: "primary",
        label: "Primary",
        ok: true,
        available: true,
        warning: Boolean(result.retention?.failures?.length),
        created: result.created,
        archivePath: result.archivePath || null,
        retention: result.retention || null,
      },
    ];
    const mirror = await this._syncSecondary(p);
    if (mirror)
      destinations.push({
        key: "secondary",
        label: "Secondary",
        ok: true,
        optional: true,
        available: mirror.available,
        warning: !mirror.available || Boolean(mirror.failures?.length) || mirror.pendingCount > 0,
        deferred: !mirror.available || mirror.pendingCount > 0,
        created: mirror.copied.length > 0,
        copiedCount: mirror.copied.length,
        pendingCount: mirror.pendingCount,
        error: mirror.error || mirror.failures?.[0]?.error || null,
      });
    return {
      ...result,
      primaryCommitted: true,
      primaryHealthy: true,
      mirrorWarning: destinations.some((d) => d.key === "secondary" && d.warning),
      retentionWarning: destinations.some((d) => d.key === "primary" && d.warning),
      destinations,
    };
  }

  async _groups(project) {
    const p = await this.validate(project);
    const defs = [{ key: "primary", label: "Primary", dir: p.backupDir }];
    if (p.backupDirSecondary)
      defs.push({
        key: "secondary",
        label: "Secondary",
        dir: p.backupDirSecondary,
      });
    const groups = [];
    for (const def of defs) {
      try {
        groups.push({
          destination: def,
          items: await this._engine(p, def.key).listBackups(),
        });
      } catch (error) {
        groups.push({ destination: def, items: [], error: error.message });
      }
    }
    return { p, defs, groups };
  }

  async listBackups(project) {
    const { defs, groups } = await this._groups(project);
    const merged = new Map();
    for (const group of groups)
      for (const item of group.items) {
        if (!merged.has(item.file))
          merged.set(item.file, {
            ...item,
            logicalSize: item.size,
            destinations: [],
          });
        merged.get(item.file).destinations.push({
          key: group.destination.key,
          label: group.destination.label,
          dir: group.destination.dir,
          path: item.path,
          size: item.size,
          archiveSha256: item.archiveSha256,
          verificationStatus: item.verificationStatus,
          verifiedAt: item.verifiedAt,
          verificationMessage: item.verificationMessage,
          error: null,
        });
      }
    for (const item of merged.values()) {
      for (const def of defs)
        if (!item.destinations.some((copy) => copy.key === def.key))
          item.destinations.push({
            key: def.key,
            label: def.label,
            dir: def.dir,
            path: null,
            size: 0,
            verificationStatus: "missing",
            error: "Backup copy is missing.",
          });
      item.copyCount = item.destinations.filter((copy) => copy.path).length;
      item.configuredCopies = defs.length;
      item.totalStoredBytes = item.destinations.reduce(
        (sum, copy) => sum + Number(copy.size || 0),
        0,
      );
      item.mirrorHealthy = item.destinations.every(
        (copy) => copy.path && copy.verificationStatus === "verified",
      );
    }
    return [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async verify(project, file) {
    const { p, defs } = await this._groups(project);
    const copies = [];
    for (const def of defs) {
      try {
        copies.push({
          destination: def.key,
          ...(await this._engine(p, def.key).verifyBackup(file)),
        });
      } catch (error) {
        copies.push({
          destination: def.key,
          file,
          valid: false,
          verificationStatus: "missing",
          message: error.message,
        });
      }
    }
    const valid = copies.every((item) => item.valid);
    const preferred =
      copies.find((item) => item.destination === "primary" && item.valid) ||
      copies.find((item) => item.valid) ||
      copies[0] ||
      {};
    return {
      ...preferred,
      file,
      valid,
      verificationStatus: valid ? "verified" : "failed",
      message: valid
        ? `All ${copies.length} configured backup copies verified.`
        : "One or more configured backup copies failed verification or are missing.",
      copies,
    };
  }

  async verifyAll(project) {
    const results = [];
    for (const backup of await this.listBackups(project))
      results.push(await this.verify(project, backup.file));
    return results;
  }

  async delete(project, file) {
    const { p, defs } = await this._groups(project);
    const results = [];
    for (const def of defs) {
      try {
        await this._engine(p, def.key).deleteBackup(file);
        results.push({ key: def.key, deleted: true });
      } catch (error) {
        if (error.code === "ENOENT" || /not found|no such file/i.test(error.message))
          results.push({ key: def.key, deleted: false, missing: true });
        else results.push({ key: def.key, deleted: false, error: error.message });
      }
    }
    return results;
  }

  async resolve(project, file, destination = null) {
    const { p, defs } = await this._groups(project);
    const choices = destination ? defs.filter((d) => d.key === destination) : defs;
    let last = null;
    for (const def of choices) {
      try {
        return {
          path: await this._engine(p, def.key).resolveBackup(file),
          destination: def.key,
        };
      } catch (error) {
        last = error;
      }
    }
    throw last || new Error("Backup not found.");
  }

  async restore(project, file, options = {}) {
    const p = await this.validate(project);
    const selected = await this.resolve(p, file, options.backupDestination || null);
    const destination = options.destination
      ? path.resolve(String(options.destination))
      : path.join(
          this.restoreRoot,
          `${safeName(p.name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        );
    if (!this.allowedRestoreRoots.some((root) => isPathInside(root, destination)))
      throw new Error(
        `Restore destination is outside UPM_AGENT_ALLOWED_RESTORE_ROOTS: ${destination}`,
      );
    const result = await this._engine(p, selected.destination).restoreBackup(file, destination, {
      overwrite: options.overwrite === true,
    });
    return { ...result, backupDestination: selected.destination };
  }

  async storage(project) {
    const { p, defs } = await this._groups(project);
    const destinations = [];
    for (const def of defs) {
      try {
        destinations.push({
          key: def.key,
          label: def.label,
          backupDir: def.dir,
          ...(await this._engine(p, def.key).getStorageStats()),
          filesystem: await filesystemStats(def.dir),
        });
      } catch (error) {
        destinations.push({
          key: def.key,
          label: def.label,
          backupDir: def.dir,
          backupCount: 0,
          totalBytes: 0,
          verifiedCount: 0,
          failedVerificationCount: 0,
          unverifiedCount: 0,
          filesystem: await filesystemStats(def.dir),
          error: error.message,
        });
      }
    }
    const logical = await this.listBackups(p);
    const totalBytes = destinations.reduce((sum, d) => sum + Number(d.totalBytes || 0), 0);
    const copyCount = destinations.reduce((sum, d) => sum + Number(d.backupCount || 0), 0);
    const verifiedCount = logical.filter((item) =>
      item.destinations.every((copy) => copy.path && copy.verificationStatus === "verified"),
    ).length;
    const failedVerificationCount = logical.filter((item) =>
      item.destinations.some((copy) => ["failed", "missing"].includes(copy.verificationStatus)),
    ).length;
    return {
      projectId: p.id,
      projectName: p.name,
      backupDir: p.backupDir,
      backupDirSecondary: p.backupDirSecondary,
      backupCount: logical.length,
      copyCount,
      configuredDestinations: defs.length,
      totalBytes,
      averageBytes: copyCount ? Math.round(totalBytes / copyCount) : 0,
      verifiedCount,
      failedVerificationCount,
      unverifiedCount: Math.max(0, logical.length - verifiedCount - failedVerificationCount),
      newestAt: logical[0]?.createdAt || null,
      oldestAt: logical[logical.length - 1]?.createdAt || null,
      mirrorHealthy: defs.length < 2 || logical.every((item) => item.mirrorHealthy),
      destinations,
    };
  }
}

module.exports = { RemoteProjectExecutor };
