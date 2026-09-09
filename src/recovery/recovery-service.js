"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { applyPatch } = require("./delta-journal");

const execFileAsync = promisify(execFile);
const DEFAULT_BACKUP_CANDIDATES = 12;
const DEFAULT_GIT_CANDIDATES = 20;
const MAX_HISTORY_CANDIDATES = 50;
const DEFAULT_PREVIEW_BYTES = 512 * 1024;
const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;

function normalizeRelativePath(value) {
  const relative = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  if (!relative || relative.startsWith("/") || relative.includes("\0") || /[\r\n]/.test(relative)) {
    throw new Error("A valid project-relative file path is required.");
  }
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Recovery path must stay inside the registered project.");
  }
  if (relative.includes(":"))
    throw new Error("Recovery paths containing a colon are not supported.");
  return relative;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isLikelyBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function safeFolderName(value) {
  return (
    String(value || "project")
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "") || "project"
  );
}

function candidateId(prefix, value) {
  return `${prefix}:${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function gitUnavailable(error) {
  return (
    error?.code === "ENOENT" ||
    /not a git repository|unknown revision|bad revision/i.test(
      String(error?.stderr || error?.message || ""),
    )
  );
}

class RecoveryService {
  constructor(options = {}) {
    if (!options.manager) throw new Error("RecoveryService requires a BackupManager instance.");
    this.manager = options.manager;
    this.dataDir = path.resolve(
      options.dataDir || this.manager.dataDir || path.join(process.cwd(), "data"),
    );
    this.recoveryRoot = path.resolve(options.recoveryRoot || path.join(this.dataDir, "recovery"));
    this.gitTimeoutMs = clampInteger(options.gitTimeoutMs, 12000, 1000, 60000);
  }

  async init() {
    return this;
  }

  _project(projectId) {
    const project = this.manager.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    return project;
  }

  _workspaceRoot(project) {
    const candidates = [
      this.recoveryRoot,
      project.backupDirResolved ? path.join(project.backupDirResolved, "_recovery") : null,
      path.join(os.tmpdir(), "ultimate-project-manager-recovery"),
    ]
      .filter(Boolean)
      .map((item) => path.resolve(item));
    return (
      candidates.find((candidate) => !isInside(project.projectRoot, candidate)) ||
      path.resolve(os.tmpdir(), "ultimate-project-manager-recovery")
    );
  }

  async _execGit(projectRoot, args, options = {}) {
    const maxBuffer = clampInteger(options.maxBuffer, 4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
    return execFileAsync("git", args, {
      cwd: projectRoot,
      windowsHide: true,
      timeout: this.gitTimeoutMs,
      maxBuffer,
      encoding: options.encoding === null ? null : "utf8",
    });
  }

  async _gitStatus(projectRoot) {
    try {
      const { stdout } = await this._execGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
      if (String(stdout).trim() !== "true")
        return { available: false, reason: "not-a-git-work-tree" };
      const [branch, head] = await Promise.all([
        this._execGit(projectRoot, ["branch", "--show-current"])
          .then((result) => String(result.stdout).trim())
          .catch(() => ""),
        this._execGit(projectRoot, ["rev-parse", "HEAD"])
          .then((result) => String(result.stdout).trim())
          .catch(() => ""),
      ]);
      return {
        available: true,
        branch: branch || null,
        head: /^[0-9a-f]{40}$/i.test(head) ? head : null,
      };
    } catch (error) {
      return {
        available: false,
        reason: gitUnavailable(error) ? "git-unavailable-or-not-repository" : "git-error",
        error: error.message,
      };
    }
  }

  async _currentFile(project, relativePath, maxBytes = DEFAULT_PREVIEW_BYTES) {
    const absolute = path.resolve(project.projectRoot, ...relativePath.split("/"));
    const check = path.relative(project.projectRoot, absolute);
    if (check.startsWith(`..${path.sep}`) || path.isAbsolute(check))
      throw new Error("Recovery path escaped the project root.");
    try {
      const stat = await fsp.lstat(absolute);
      if (!stat.isFile())
        return {
          exists: true,
          type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
          size: stat.size,
        };
      if (stat.size > maxBytes)
        return { exists: true, type: "file", size: stat.size, tooLarge: true };
      const buffer = await fsp.readFile(absolute);
      return {
        exists: true,
        type: "file",
        size: buffer.length,
        sha256: hashBuffer(buffer),
        binary: isLikelyBinary(buffer),
        tooLarge: false,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false, type: "missing", size: 0 };
      throw error;
    }
  }

  async _backupCandidates(projectId, relativePath, limit) {
    const backups = (await this.manager.listBackups(projectId)).slice(0, limit);
    const candidates = [];
    for (const backup of backups) {
      const copies = (backup.destinations || []).filter((copy) => copy.path && !copy.error);
      if (!copies.length) continue;
      let found = null;
      let usedCopy = null;
      for (const copy of copies) {
        try {
          const resolved = await this.manager._resolveBackupCopy(projectId, backup.file, copy.key);
          const entry = await resolved.engine.readBackupEntry(backup.file, relativePath, {
            maxBytes: 1024,
          });
          if (entry.found) {
            found = entry;
            usedCopy = copy;
            break;
          }
        } catch {}
      }
      if (!found) continue;
      const changeKind = backup.changes?.added?.includes(relativePath)
        ? "added"
        : backup.changes?.modified?.includes(relativePath)
          ? "modified"
          : backup.changes?.deleted?.includes(relativePath)
            ? "deleted"
            : null;
      candidates.push({
        id: candidateId("backup", `${backup.file}:${usedCopy?.key || "primary"}:${relativePath}`),
        source: "backup",
        exact: true,
        confidence: backup.verificationStatus === "verified" ? "verified" : "historical",
        backupFile: backup.file,
        backupDestination: usedCopy?.key || "primary",
        createdAt: backup.createdAt || null,
        encrypted: backup.encrypted === true,
        verificationStatus: backup.verificationStatus || null,
        size: found.size ?? null,
        entryType: found.type || "File",
        changeKind,
        label: `${backup.file}${usedCopy?.label ? ` · ${usedCopy.label}` : ""}`,
      });
    }
    return candidates;
  }

  async _gitCandidates(project, relativePath, limit) {
    const status = await this._gitStatus(project.projectRoot);
    if (!status.available) return { status, candidates: [] };
    try {
      const marker = "@@@UPM@@@";
      const format = `${marker}%H%x1f%aI%x1f%an%x1f%ae%x1f%s`;
      const { stdout } = await this._execGit(
        project.projectRoot,
        [
          "log",
          "--all",
          "--follow",
          `-n${limit}`,
          `--format=${format}`,
          "--name-status",
          "--",
          relativePath,
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const blocks = [];
      let current = null;
      for (const rawLine of String(stdout).split(/\r?\n/)) {
        if (rawLine.startsWith(marker)) {
          if (current) blocks.push(current);
          const [commit, authoredAt, author, email, ...subjectParts] = rawLine
            .slice(marker.length)
            .split("\x1f");
          current = {
            commit,
            authoredAt,
            author,
            email,
            subject: subjectParts.join("\x1f"),
            changes: [],
          };
          continue;
        }
        if (current && rawLine.trim()) current.changes.push(rawLine);
      }
      if (current) blocks.push(current);

      const candidates = [];
      const seenBlobs = new Set();
      let historicalPath = relativePath;
      for (const block of blocks) {
        const commit = block.commit;
        if (!/^[0-9a-f]{40}$/i.test(commit || "")) continue;
        const pathAtCommit = historicalPath;
        const spec = `${commit}:${pathAtCommit}`;
        try {
          const [{ stdout: blobOut }, { stdout: sizeOut }] = await Promise.all([
            this._execGit(project.projectRoot, ["rev-parse", spec]),
            this._execGit(project.projectRoot, ["cat-file", "-s", spec]),
          ]);
          const blob = String(blobOut).trim();
          const size = Number(String(sizeOut).trim());
          if (/^[0-9a-f]{40}$/i.test(blob) && !seenBlobs.has(blob)) {
            seenBlobs.add(blob);
            candidates.push({
              id: candidateId("git", `${commit}:${blob}:${pathAtCommit}`),
              source: "git",
              exact: true,
              confidence: "git-object",
              commit,
              shortCommit: commit.slice(0, 10),
              blob,
              historicalPath: pathAtCommit,
              renamed: pathAtCommit !== relativePath,
              authoredAt: block.authoredAt || null,
              author: block.author || null,
              email: block.email || null,
              subject: block.subject || "",
              size: Number.isFinite(size) ? size : null,
              label: `${commit.slice(0, 10)} · ${block.subject || "(no subject)"}${pathAtCommit !== relativePath ? ` · ${pathAtCommit}` : ""}`,
            });
          }
        } catch {}

        for (const change of block.changes) {
          const fields = change.split("\t");
          if (!fields[0]?.startsWith("R") || fields.length < 3) continue;
          const oldPath = String(fields[1] || "").replace(/\\/g, "/");
          const newPath = String(fields[2] || "").replace(/\\/g, "/");
          if (newPath === historicalPath) {
            historicalPath = oldPath;
            break;
          }
        }
      }
      return { status, candidates };
    } catch (error) {
      return { status: { ...status, error: error.message }, candidates: [] };
    }
  }

  async _journalCandidates(
    projectId,
    project,
    relativePath,
    current,
    backupCandidates,
    options = {},
  ) {
    const journal = this.manager._journal?.(project);
    if (!journal || project.deltaJournalEnabled !== true) {
      return {
        enabled: false,
        stats: null,
        candidates: [],
        errors: [],
        buffers: new Map(),
      };
    }

    const stats = await journal.stats();
    if (!stats.enabled || !stats.entryCount) {
      return {
        enabled: stats.enabled,
        stats,
        candidates: [],
        errors: [],
        buffers: new Map(),
      };
    }

    const history = await journal.getPathHistory(relativePath, {
      limit: clampInteger(options.maxJournal, 200, 1, 1000),
    });
    const errors = history
      .filter((item) => item.corrupt)
      .map((item) => ({
        journalEntryId: item.record?.id || null,
        error: item.error || "Journal entry could not be verified.",
      }));
    const usable = history.filter((item) => item.patch && !item.corrupt);
    if (!usable.length)
      return {
        enabled: true,
        stats,
        candidates: [],
        errors,
        buffers: new Map(),
      };

    const anchors = [];
    if (current?.exists === false) {
      anchors.push({
        source: "live-missing",
        buffer: null,
        hash: null,
        createdAt: new Date().toISOString(),
      });
    } else if (
      current?.exists &&
      current.type === "file" &&
      !current.tooLarge &&
      Number(current.size || 0) <= MAX_RECOVERY_BYTES
    ) {
      try {
        const absolute = path.join(project.projectRoot, ...relativePath.split("/"));
        const buffer = await fsp.readFile(absolute);
        if (!current.sha256 || hashBuffer(buffer) === current.sha256) {
          anchors.push({
            source: "live",
            buffer,
            hash: hashBuffer(buffer),
            createdAt: new Date().toISOString(),
          });
        }
      } catch {}
    }

    for (const candidate of backupCandidates || []) {
      try {
        const recovered = await this._readBackupCandidate(
          projectId,
          relativePath,
          candidate,
          MAX_RECOVERY_BYTES,
        );
        if (recovered.tooLarge || !recovered.buffer) continue;
        anchors.push({
          source: "backup",
          buffer: recovered.buffer,
          hash: hashBuffer(recovered.buffer),
          createdAt: candidate.createdAt || null,
          candidate,
        });
      } catch {}
    }

    const matchesSide = (side, anchor) =>
      side
        ? Buffer.isBuffer(anchor.buffer) && (!side.hash || side.hash === anchor.hash)
        : anchor.buffer === null;

    let selected = null;
    for (const anchor of anchors) {
      const index = usable.findIndex((item) => matchesSide(item.patch.after, anchor));
      if (index < 0) continue;
      if (!selected || index < selected.index) selected = { anchor, index };
    }
    if (!selected) {
      return {
        enabled: true,
        stats,
        candidates: [],
        errors: [
          ...errors,
          {
            error: "No live or retained-backup anchor matched the journal chain for this file.",
          },
        ],
        buffers: new Map(),
      };
    }

    const candidates = [];
    const buffers = new Map();
    const seenHashes = new Set();
    let state = selected.anchor.buffer;

    for (let index = selected.index; index < usable.length; index += 1) {
      const item = usable[index];
      const patch = item.patch;
      if (
        !matchesSide(patch.after, {
          buffer: state,
          hash: Buffer.isBuffer(state) ? hashBuffer(state) : null,
        })
      )
        break;
      if (!patch.reconstructable) {
        errors.push({
          journalEntryId: item.record?.id || null,
          path: relativePath,
          error: `Journal chain stopped at metadata-only patch (${patch.payload?.reason || "unavailable"}).`,
        });
        break;
      }

      let before;
      try {
        before = applyPatch(patch, state, "reverse");
      } catch (error) {
        errors.push({
          journalEntryId: item.record?.id || null,
          path: relativePath,
          error: error.message,
        });
        break;
      }

      if (patch.before?.type === "file" && Buffer.isBuffer(before)) {
        const sha256 = hashBuffer(before);
        if (!seenHashes.has(sha256)) {
          seenHashes.add(sha256);
          const id = candidateId("journal", `${item.record.id}:${relativePath}:${sha256}`);
          const candidate = {
            id,
            source: "journal",
            exact: true,
            confidence: "verified-delta-chain",
            journalEntryId: item.record.id,
            journalFile: item.record.file,
            createdAt: item.document?.from?.createdAt || item.record.createdAt || null,
            transitionCreatedAt: item.record.createdAt || null,
            fromProjectHash:
              item.document?.from?.projectHash || item.record.fromProjectHash || null,
            toProjectHash: item.document?.to?.projectHash || item.record.toProjectHash || null,
            anchorSource: selected.anchor.source,
            anchorBackupFile: selected.anchor.candidate?.backupFile || null,
            size: before.length,
            sha256,
            label: `Delta journal · ${item.record.id}`,
          };
          candidates.push(candidate);
          if (options.includeBuffers === true) buffers.set(id, before);
        }
      }
      state = before;
    }

    return { enabled: true, stats, candidates, errors, buffers };
  }

  async inspect(projectId, options = {}) {
    const project = this._project(projectId);
    const backupLimit = clampInteger(
      options.maxBackups,
      DEFAULT_BACKUP_CANDIDATES,
      1,
      MAX_HISTORY_CANDIDATES,
    );
    const gitLimit = clampInteger(
      options.maxGit,
      DEFAULT_GIT_CANDIDATES,
      1,
      MAX_HISTORY_CANDIDATES,
    );
    let relativePath = options.path ? normalizeRelativePath(options.path) : null;
    const diff = await this.manager.getProjectDiff(projectId, {
      refresh: options.refresh === true,
    });
    const suggestions = (diff.files || [])
      .filter((item) => item.status === "deleted" || item.status === "modified")
      .map((item) => ({
        path: item.path,
        status: item.status,
        before: item.before,
        after: item.after,
      }));
    if (!relativePath && suggestions.length) relativePath = suggestions[0].path;

    const base = {
      projectId,
      projectName: project.name,
      projectRoot: project.projectRoot,
      recoveryRoot: this._workspaceRoot(project),
      checkedAt: new Date().toISOString(),
      baseline: diff.baseline || null,
      suggestions,
      path: relativePath,
      current: null,
      backupCandidates: [],
      journal: {
        enabled: project.deltaJournalEnabled === true,
        stats: null,
        candidates: [],
        errors: [],
      },
      git: { available: false, candidates: [] },
      recommended: null,
      warnings: [
        "Recovery is read-only against the live project. Recovered files are written to data/recovery for manual review.",
        "Ultimate Project Manager never invents missing source text; candidates must come from retained backup bytes, verified delta journal replay, or Git objects.",
      ],
    };
    if (!relativePath) return base;

    const [current, backupCandidates, gitResult] = await Promise.all([
      this._currentFile(project, relativePath),
      this._backupCandidates(projectId, relativePath, backupLimit),
      this._gitCandidates(project, relativePath, gitLimit),
    ]);
    const journalResult = await this._journalCandidates(
      projectId,
      project,
      relativePath,
      current,
      backupCandidates,
      {
        maxJournal: options.maxJournal,
      },
    );
    const recommended =
      [...backupCandidates, ...journalResult.candidates, ...gitResult.candidates].sort((a, b) => {
        const aTime = new Date(a.createdAt || a.authoredAt || 0).getTime() || 0;
        const bTime = new Date(b.createdAt || b.authoredAt || 0).getTime() || 0;
        if (bTime !== aTime) return bTime - aTime;
        const aTrust =
          a.source === "backup" && a.verificationStatus === "verified"
            ? 3
            : a.source === "journal"
              ? 2
              : a.source === "git"
                ? 1
                : 0;
        const bTrust =
          b.source === "backup" && b.verificationStatus === "verified"
            ? 3
            : b.source === "journal"
              ? 2
              : b.source === "git"
                ? 1
                : 0;
        return bTrust - aTrust;
      })[0] || null;

    return {
      ...base,
      current,
      backupCandidates,
      journal: {
        enabled: journalResult.enabled,
        stats: journalResult.stats,
        candidates: journalResult.candidates,
        errors: journalResult.errors,
      },
      git: { ...gitResult.status, candidates: gitResult.candidates },
      recommended,
    };
  }

  async _readBackupCandidate(projectId, relativePath, candidate, maxBytes) {
    const resolved = await this.manager._resolveBackupCopy(
      projectId,
      candidate.backupFile,
      candidate.backupDestination || null,
    );
    const entry = await resolved.engine.readBackupEntry(candidate.backupFile, relativePath, {
      maxBytes,
      returnBuffer: true,
    });
    if (!entry.found) throw new Error("The selected backup no longer contains that file.");
    if (!["File", "OldFile"].includes(entry.type || "File"))
      throw new Error(
        `The selected backup entry is not a regular file (${entry.type || "unknown"}).`,
      );
    if (entry.tooLarge)
      return {
        found: true,
        tooLarge: true,
        size: entry.size,
        buffer: null,
        binary: false,
      };
    const buffer = Buffer.isBuffer(entry.buffer)
      ? entry.buffer
      : Buffer.from(entry.text || "", "utf8");
    return {
      found: true,
      tooLarge: false,
      size: buffer.length,
      buffer,
      binary: entry.binary === true,
    };
  }

  async _readGitCandidate(project, relativePath, candidate, maxBytes) {
    if (!/^[0-9a-f]{40}$/i.test(candidate.commit || ""))
      throw new Error("Invalid Git recovery commit.");
    const candidatePath = normalizeRelativePath(candidate.historicalPath || relativePath);
    const spec = `${candidate.commit}:${candidatePath}`;
    const { stdout: sizeOut } = await this._execGit(project.projectRoot, ["cat-file", "-s", spec]);
    const size = Number(String(sizeOut).trim());
    if (Number.isFinite(size) && size > maxBytes)
      return { found: true, tooLarge: true, size, buffer: null, binary: false };
    const { stdout } = await this._execGit(project.projectRoot, ["cat-file", "blob", spec], {
      encoding: null,
      maxBuffer: Math.max(maxBytes + 64 * 1024, 1024 * 1024),
    });
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
    return {
      found: true,
      tooLarge: false,
      size: buffer.length,
      buffer,
      binary: isLikelyBinary(buffer),
    };
  }

  async _blameSummary(project, relativePath, commit, lineLimit = 500) {
    if (!/^[0-9a-f]{40}$/i.test(commit || "")) return null;
    try {
      const { stdout } = await this._execGit(
        project.projectRoot,
        [
          "blame",
          "--line-porcelain",
          `-L1,${clampInteger(lineLimit, 500, 1, 2000)}`,
          commit,
          "--",
          relativePath,
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const commits = new Map();
      const authors = new Map();
      let currentCommit = null;
      let lineCount = 0;
      for (const line of String(stdout).split(/\r?\n/)) {
        const header = /^([0-9a-f]{40})\s/.exec(line);
        if (header) {
          currentCommit = header[1];
          commits.set(currentCommit, (commits.get(currentCommit) || 0) + 1);
          lineCount += 1;
          continue;
        }
        if (currentCommit && line.startsWith("author ")) {
          const author = line.slice(7).trim();
          authors.set(author, (authors.get(author) || 0) + 1);
        }
      }
      return {
        analyzedLines: lineCount,
        commits: [...commits.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([sha, lines]) => ({
            sha,
            shortCommit: sha.slice(0, 10),
            lines,
          })),
        authors: [...authors.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([author, lines]) => ({ author, lines })),
      };
    } catch {
      return null;
    }
  }

  async readCandidate(projectId, relativePathInput, selector = {}, options = {}) {
    const project = this._project(projectId);
    const relativePath = normalizeRelativePath(relativePathInput);
    const maxBytes = clampInteger(
      options.maxBytes,
      DEFAULT_PREVIEW_BYTES,
      1024,
      MAX_RECOVERY_BYTES,
    );
    const analysis = await this.inspect(projectId, {
      path: relativePath,
      maxBackups: options.maxBackups,
      maxGit: options.maxGit,
      maxJournal: options.maxJournal,
    });
    const all = [
      ...analysis.backupCandidates,
      ...(analysis.journal?.candidates || []),
      ...(analysis.git.candidates || []),
    ];
    let candidate = null;
    if (selector.id) candidate = all.find((item) => item.id === selector.id);
    if (!candidate && selector.source === "backup" && selector.backupFile) {
      candidate = analysis.backupCandidates.find(
        (item) =>
          item.backupFile === selector.backupFile &&
          (!selector.backupDestination || item.backupDestination === selector.backupDestination),
      );
    }
    if (!candidate && selector.source === "journal" && selector.journalEntryId) {
      candidate = (analysis.journal?.candidates || []).find(
        (item) => item.journalEntryId === selector.journalEntryId,
      );
    }
    if (!candidate && selector.source === "git" && selector.commit) {
      candidate = (analysis.git.candidates || []).find((item) => item.commit === selector.commit);
    }
    if (
      !candidate &&
      (selector.id || selector.backupFile || selector.journalEntryId || selector.commit)
    )
      throw new Error(
        "The selected recovery candidate is no longer available. Refresh recovery analysis and choose another candidate.",
      );
    if (!candidate) candidate = analysis.recommended;
    if (!candidate) throw new Error("No recoverable historical candidate was found for this file.");

    let recovered;
    if (candidate.source === "backup") {
      recovered = await this._readBackupCandidate(projectId, relativePath, candidate, maxBytes);
    } else if (candidate.source === "journal") {
      const replay = await this._journalCandidates(
        projectId,
        project,
        relativePath,
        analysis.current,
        analysis.backupCandidates,
        {
          maxJournal: options.maxJournal,
          includeBuffers: true,
        },
      );
      const buffer = replay.buffers.get(candidate.id);
      if (!buffer)
        throw new Error(
          "The selected journal candidate could no longer be reconstructed from an available verified anchor.",
        );
      if (buffer.length > maxBytes)
        recovered = {
          found: true,
          tooLarge: true,
          size: buffer.length,
          buffer: null,
          binary: false,
        };
      else
        recovered = {
          found: true,
          tooLarge: false,
          size: buffer.length,
          buffer,
          binary: isLikelyBinary(buffer),
        };
    } else {
      recovered = await this._readGitCandidate(project, relativePath, candidate, maxBytes);
    }
    const buffer = recovered.buffer;
    const preview = buffer && !recovered.binary ? buffer.toString("utf8") : null;
    const blame =
      candidate.source === "git" && options.includeBlame !== false
        ? await this._blameSummary(
            project,
            candidate.historicalPath || relativePath,
            candidate.commit,
            options.blameLines,
          )
        : null;

    return {
      projectId,
      projectName: project.name,
      path: relativePath,
      candidate,
      size: recovered.size,
      sha256: buffer ? hashBuffer(buffer) : null,
      binary: recovered.binary === true,
      binaryUnavailable: recovered.binaryUnavailable === true,
      tooLarge: recovered.tooLarge === true,
      preview,
      blame,
    };
  }

  async _readCandidateBuffer(projectId, relativePath, selector = {}, options = {}) {
    const project = this._project(projectId);
    const analysis = await this.inspect(projectId, {
      path: relativePath,
      maxBackups: options.maxBackups,
      maxGit: options.maxGit,
      maxJournal: options.maxJournal,
    });
    const all = [
      ...analysis.backupCandidates,
      ...(analysis.journal?.candidates || []),
      ...(analysis.git.candidates || []),
    ];
    let candidate = selector.id ? all.find((item) => item.id === selector.id) : null;
    if (!candidate && selector.source === "backup" && selector.backupFile)
      candidate = analysis.backupCandidates.find((item) => item.backupFile === selector.backupFile);
    if (!candidate && selector.source === "journal" && selector.journalEntryId)
      candidate = (analysis.journal?.candidates || []).find(
        (item) => item.journalEntryId === selector.journalEntryId,
      );
    if (!candidate && selector.source === "git" && selector.commit)
      candidate = (analysis.git.candidates || []).find((item) => item.commit === selector.commit);
    if (
      !candidate &&
      (selector.id || selector.backupFile || selector.journalEntryId || selector.commit)
    )
      throw new Error(
        "The selected recovery candidate is no longer available. Refresh recovery analysis and choose another candidate.",
      );
    if (!candidate) candidate = analysis.recommended;
    if (!candidate) throw new Error("No recoverable historical candidate was found for this file.");
    const maxBytes = clampInteger(options.maxBytes, MAX_RECOVERY_BYTES, 1024, MAX_RECOVERY_BYTES);
    let result;
    if (candidate.source === "backup") {
      result = await this._readBackupCandidate(projectId, relativePath, candidate, maxBytes);
    } else if (candidate.source === "journal") {
      const replay = await this._journalCandidates(
        projectId,
        project,
        relativePath,
        analysis.current,
        analysis.backupCandidates,
        {
          maxJournal: options.maxJournal,
          includeBuffers: true,
        },
      );
      const buffer = replay.buffers.get(candidate.id);
      if (!buffer)
        throw new Error(
          "The selected journal candidate could no longer be reconstructed from an available verified anchor.",
        );
      result = {
        found: true,
        tooLarge: buffer.length > maxBytes,
        size: buffer.length,
        buffer: buffer.length > maxBytes ? null : buffer,
        binary: isLikelyBinary(buffer),
      };
    } else {
      result = await this._readGitCandidate(project, relativePath, candidate, maxBytes);
    }
    if (result.tooLarge)
      throw new Error(
        `Recovery candidate exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB safety ceiling.`,
      );
    if (!result.buffer) throw new Error("Recovery candidate bytes are unavailable.");
    return { candidate, buffer: result.buffer, binary: result.binary === true };
  }

  async recoverFile(projectId, relativePathInput, selector = {}, options = {}) {
    const project = this._project(projectId);
    const relativePath = normalizeRelativePath(relativePathInput);
    const recovered = await this._readCandidateBuffer(projectId, relativePath, selector, options);
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}-${crypto.randomBytes(3).toString("hex")}`;
    const workspace = path.join(
      this._workspaceRoot(project),
      `${safeFolderName(project.name)}-${projectId.slice(0, 8)}`,
      runId,
    );
    const destination = path.join(workspace, ...relativePath.split("/"));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, recovered.buffer);
    const report = {
      version: 1,
      type: "ultimate-project-manager-recovery",
      runId,
      createdAt: new Date().toISOString(),
      projectId,
      projectName: project.name,
      projectRoot: project.projectRoot,
      workspace,
      files: [
        {
          path: relativePath,
          destination,
          size: recovered.buffer.length,
          sha256: hashBuffer(recovered.buffer),
          binary: recovered.binary,
          candidate: recovered.candidate,
        },
      ],
      safety: {
        liveProjectModified: false,
        evidenceOnly: true,
      },
    };
    const reportPath = path.join(workspace, "_upm-recovery-report.json");
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    await this.manager.log(
      "warning",
      `Last-resort recovery candidate exported: ${project.name} · ${relativePath}`,
      {
        projectId,
        operation: "recovery-export",
        recoveryRunId: runId,
        recoverySource: recovered.candidate.source,
        recoveryPath: relativePath,
        recoveryWorkspace: workspace,
        recoveryReport: reportPath,
        liveProjectModified: false,
      },
    );
    return { ...report, reportPath };
  }

  async recoverSuggested(projectId, options = {}) {
    const project = this._project(projectId);
    const analysis = await this.inspect(projectId, {
      refresh: options.refresh === true,
    });
    const requested =
      Array.isArray(options.paths) && options.paths.length
        ? options.paths.map(normalizeRelativePath)
        : analysis.suggestions.map((item) => item.path);
    const unique = [...new Set(requested)].slice(0, clampInteger(options.maxFiles, 100, 1, 500));
    if (!unique.length)
      throw new Error("No modified or deleted files are currently suggested for recovery.");

    const runId = `${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}-${crypto.randomBytes(3).toString("hex")}`;
    const workspace = path.join(
      this._workspaceRoot(project),
      `${safeFolderName(project.name)}-${projectId.slice(0, 8)}`,
      runId,
    );
    const files = [];
    const errors = [];
    for (const relativePath of unique) {
      try {
        const recovered = await this._readCandidateBuffer(projectId, relativePath, {}, options);
        const destination = path.join(workspace, ...relativePath.split("/"));
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.writeFile(destination, recovered.buffer);
        files.push({
          path: relativePath,
          destination,
          size: recovered.buffer.length,
          sha256: hashBuffer(recovered.buffer),
          binary: recovered.binary,
          candidate: recovered.candidate,
        });
      } catch (error) {
        errors.push({ path: relativePath, error: error.message });
      }
    }
    await fsp.mkdir(workspace, { recursive: true });
    const report = {
      version: 1,
      type: "ultimate-project-manager-recovery",
      runId,
      createdAt: new Date().toISOString(),
      projectId,
      projectName: project.name,
      projectRoot: project.projectRoot,
      workspace,
      files,
      errors,
      requestedFiles: unique.length,
      recoveredFiles: files.length,
      failedFiles: errors.length,
      safety: { liveProjectModified: false, evidenceOnly: true },
    };
    const reportPath = path.join(workspace, "_upm-recovery-report.json");
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    await this.manager.log(
      errors.length ? "warning" : "success",
      `Last-resort recovery workspace created: ${project.name} · ${files.length}/${unique.length} file(s)`,
      {
        projectId,
        operation: "recovery-batch",
        recoveryRunId: runId,
        recoveryWorkspace: workspace,
        recoveryReport: reportPath,
        recoveredFiles: files.length,
        failedFiles: errors.length,
        liveProjectModified: false,
      },
    );
    return { ...report, reportPath };
  }
}

module.exports = {
  RecoveryService,
  normalizeRelativePath,
  hashBuffer,
  isLikelyBinary,
};
