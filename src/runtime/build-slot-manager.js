"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { atomicWriteJson, readJsonRecoverable } = require("../filesystem/atomic-file");
const { canonicalPath, isPathInside } = require("../filesystem/path-boundary");

const METADATA_FILE = ".upm-build-slot.json";
const STATE_FILE = "state.json";
const SLOT_DIR = "slots";

function normalizeOverlayPaths(value, fallback = [".env"]) {
  const input = Array.isArray(value) ? value : fallback;
  const result = [];
  for (const item of input) {
    const normalized = String(item || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    if (!normalized) continue;
    if (
      normalized.length > 512 ||
      path.posix.isAbsolute(normalized) ||
      normalized.includes("\0") ||
      normalized.split("/").some((part) => !part || part === "." || part === "..") ||
      normalized === METADATA_FILE ||
      normalized === "node_modules" ||
      /[\x00-\x1f\x7f]/.test(normalized)
    ) {
      throw new Error(`Invalid build-slot overlay path: ${normalized || "(empty)"}`);
    }
    if (!result.includes(normalized)) result.push(normalized);
    if (result.length >= 64) break;
  }
  return result;
}

function safeComponent(value, label = "Build slot id") {
  const text = String(value || "").trim();
  if (!text || text.length > 160 || text === "." || text === ".." || /[\\/\x00-\x1f\x7f]/.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function slotIdFor(backup = {}) {
  const seed = [backup.file, backup.projectHash, backup.archiveSha256]
    .map((value) => String(value || ""))
    .join("\0");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 20);
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  return readJsonRecoverable(file, fallback, {
    recover: true,
    validator: (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
  });
}

async function fileHash(file) {
  try {
    const data = await fsp.readFile(file);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

class BuildSlotManager {
  constructor(options = {}) {
    this.root = path.resolve(options.root || path.join(process.cwd(), "data", "build-slots"));
    this.cache = new Map();
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    return this;
  }

  _projectDir(projectId) {
    return path.join(this.root, safeComponent(projectId, "Project id"));
  }

  _slotsDir(projectId) {
    return path.join(this._projectDir(projectId), SLOT_DIR);
  }

  _slotDir(projectId, slotId) {
    return path.join(this._slotsDir(projectId), safeComponent(slotId));
  }

  _slotAppRoot(projectId, slotId) {
    return path.join(this._slotDir(projectId, slotId), "app");
  }

  _stateFile(projectId) {
    return path.join(this._projectDir(projectId), STATE_FILE);
  }

  async refreshProject(projectId) {
    const projectDir = this._projectDir(projectId);
    const slotsDir = this._slotsDir(projectId);
    await fsp.mkdir(slotsDir, { recursive: true });
    const slots = [];
    for (const entry of await fsp.readdir(slotsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const slotId = entry.name;
      try {
        safeComponent(slotId);
        const slotDir = this._slotDir(projectId, slotId);
        const appRoot = path.join(slotDir, "app");
        const metadata = await readJson(path.join(slotDir, METADATA_FILE), null);
        if (!metadata || metadata.slotId !== slotId || !(await exists(appRoot))) continue;
        slots.push({ ...metadata, slotId, slotDir, appRoot });
      } catch {}
    }
    slots.sort((a, b) => new Date(b.preparedAt || 0) - new Date(a.preparedAt || 0));
    const state = await readJson(this._stateFile(projectId), {
      version: 1,
      active: { type: "source", changedAt: null },
      previous: null,
    });
    if (state.active?.type === "slot" && !slots.some((slot) => slot.slotId === state.active.slotId)) {
      state.previous = state.active;
      state.active = { type: "source", changedAt: new Date().toISOString(), recovered: true };
      await this._writeState(projectId, state);
    }
    const cached = { projectDir, slots, state };
    this.cache.set(projectId, cached);
    return cached;
  }

  async _writeState(projectId, state) {
    await fsp.mkdir(this._projectDir(projectId), { recursive: true });
    await atomicWriteJson(this._stateFile(projectId), state, {
      backup: true,
      validator: (value) => Boolean(value && value.version === 1 && value.active),
    });
  }

  _cached(projectId) {
    return this.cache.get(projectId) || {
      projectDir: this._projectDir(projectId),
      slots: [],
      state: { version: 1, active: { type: "source", changedAt: null }, previous: null },
    };
  }

  runtimeRoots(projectId) {
    return this._cached(projectId).slots.map((slot) => slot.appRoot);
  }

  forgetProject(projectId) {
    this.cache.delete(projectId);
  }

  active(project) {
    const cached = this._cached(project.id);
    const active = cached.state.active || { type: "source" };
    if (active.type !== "slot") {
      return { ...active, type: "source", root: path.resolve(project.projectRoot), slot: null };
    }
    const slot = cached.slots.find((item) => item.slotId === active.slotId);
    if (!slot) return { type: "source", root: path.resolve(project.projectRoot), slot: null };
    return { ...active, root: slot.appRoot, slot };
  }

  summary(project) {
    const cached = this._cached(project.id);
    const active = this.active(project);
    return {
      preparedCount: cached.slots.length,
      root: cached.projectDir,
      active: {
        type: active.type,
        slotId: active.slot?.slotId || null,
        backupFile: active.slot?.backupFile || null,
        backupCreatedAt: active.slot?.backupCreatedAt || null,
        root: active.root,
        changedAt: active.changedAt || null,
      },
      previous: cached.state.previous || null,
    };
  }

  list(project) {
    const cached = this._cached(project.id);
    const active = this.active(project);
    return {
      summary: this.summary(project),
      slots: cached.slots.map((slot) => ({
        ...slot,
        active: active.type === "slot" && active.slot?.slotId === slot.slotId,
      })),
    };
  }

  async prepare(project, backup, options = {}) {
    const destination = String(options.backupDestination || backup.backupDestination || "primary");
    const slotId = slotIdFor(backup);
    const slotDir = this._slotDir(project.id, slotId);
    const appRoot = path.join(slotDir, "app");
    const reset = options.reset === true;

    if (!reset && (await exists(path.join(slotDir, METADATA_FILE))) && (await exists(appRoot))) {
      await this.refreshProject(project.id);
      return { prepared: false, reused: true, slot: this._cached(project.id).slots.find((item) => item.slotId === slotId) };
    }

    const staging = `${slotDir}.prepare-${process.pid}-${Date.now()}`;
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(path.join(staging, "app"), { recursive: true });
    try {
      const restored = await options.restore(path.join(staging, "app"));
      const preparedAt = new Date().toISOString();
      const metadata = {
        version: 1,
        slotId,
        projectId: project.id,
        projectName: project.name,
        backupFile: backup.file,
        backupDestination: destination,
        backupCreatedAt: backup.createdAt || null,
        projectHash: backup.projectHash || restored.projectHash || null,
        archiveSha256: backup.archiveSha256 || null,
        preparedAt,
        fileCount: restored.fileCount ?? backup.fileCount ?? null,
        sourceBytes: restored.sourceBytes ?? backup.sourceBytes ?? null,
      };
      await atomicWriteJson(path.join(staging, METADATA_FILE), metadata, {
        backup: false,
        validator: (value) => Boolean(value && value.slotId === slotId),
      });
      await fsp.rm(slotDir, { recursive: true, force: true });
      await fsp.rename(staging, slotDir);
      await this.refreshProject(project.id);
      return {
        prepared: true,
        reused: false,
        slot: this._cached(project.id).slots.find((item) => item.slotId === slotId),
      };
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async _copyOverlay(projectRoot, appRoot, relativePath) {
    const source = path.resolve(projectRoot, ...relativePath.split("/"));
    const target = path.resolve(appRoot, ...relativePath.split("/"));
    const [canonicalProject, canonicalSource, canonicalApp, canonicalTarget] = await Promise.all([
      canonicalPath(projectRoot),
      canonicalPath(source),
      canonicalPath(appRoot),
      canonicalPath(target),
    ]);
    if (!isPathInside(canonicalProject, canonicalSource)) {
      throw new Error(`Build-slot overlay escapes the project root: ${relativePath}`);
    }
    if (!isPathInside(canonicalApp, canonicalTarget)) {
      throw new Error(`Build-slot overlay escapes the runtime slot: ${relativePath}`);
    }

    const sourceStat = await fsp.lstat(source).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    await fsp.rm(target, { recursive: true, force: true });
    if (!sourceStat) return { path: relativePath, copied: false, missing: true };
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      const realSource = await fsp.realpath(source);
      if (!isPathInside(canonicalProject, realSource)) {
        throw new Error(`Build-slot overlay symlink points outside the project root: ${relativePath}`);
      }
      const realStat = await fsp.stat(realSource);
      if (realStat.isDirectory()) await fsp.cp(realSource, target, { recursive: true, force: true });
      else if (realStat.isFile()) await fsp.copyFile(realSource, target);
      else throw new Error(`Unsupported overlay path type: ${relativePath}`);
    } else if (sourceStat.isDirectory()) {
      await fsp.cp(source, target, { recursive: true, force: true });
    } else if (sourceStat.isFile()) {
      await fsp.copyFile(source, target);
    } else {
      throw new Error(`Unsupported overlay path type: ${relativePath}`);
    }
    return { path: relativePath, copied: true, missing: false };
  }

  async synchronize(project, slot, options = {}) {
    if (!slot?.appRoot) throw new Error("Prepared build slot was not found.");
    const overlays = normalizeOverlayPaths(options.overlayPaths, project.buildSlotOverlayPaths || [".env"]);
    const copied = [];
    for (const relativePath of overlays) copied.push(await this._copyOverlay(project.projectRoot, slot.appRoot, relativePath));

    let nodeModules = { linked: false, reason: "disabled" };
    if (options.linkNodeModules !== false && project.buildSlotLinkNodeModules !== false) {
      const sourceModules = path.join(project.projectRoot, "node_modules");
      const targetModules = path.join(slot.appRoot, "node_modules");
      if (await exists(sourceModules)) {
        const targetStat = await fsp.lstat(targetModules).catch(() => null);
        if (!targetStat) {
          await fsp.symlink(sourceModules, targetModules, process.platform === "win32" ? "junction" : "dir");
          nodeModules = { linked: true, source: sourceModules };
        } else if (targetStat.isSymbolicLink()) {
          const [canonicalSourceModules, canonicalTargetModules] = await Promise.all([
            canonicalPath(sourceModules),
            canonicalPath(targetModules),
          ]);
          if (canonicalSourceModules !== canonicalTargetModules) {
            await fsp.rm(targetModules, { recursive: true, force: true });
            await fsp.symlink(
              sourceModules,
              targetModules,
              process.platform === "win32" ? "junction" : "dir",
            );
            nodeModules = { linked: true, source: sourceModules, replacedUnsafeLink: true };
          } else {
            nodeModules = { linked: true, source: sourceModules, reused: true };
          }
        } else {
          nodeModules = { linked: false, reason: "slot-has-node-modules" };
        }
      } else {
        nodeModules = { linked: false, reason: "source-node-modules-missing" };
      }
    }

    const [sourcePackageHash, sourceLockHash, slotPackageHash, slotLockHash] = await Promise.all([
      fileHash(path.join(project.projectRoot, "package.json")),
      fileHash(path.join(project.projectRoot, "package-lock.json")),
      fileHash(path.join(slot.appRoot, "package.json")),
      fileHash(path.join(slot.appRoot, "package-lock.json")),
    ]);
    const dependencyMismatch = Boolean(
      (sourcePackageHash && slotPackageHash && sourcePackageHash !== slotPackageHash) ||
        (sourceLockHash && slotLockHash && sourceLockHash !== slotLockHash),
    );
    return { overlays: copied, nodeModules, dependencyMismatch };
  }

  async setActive(project, selection) {
    await this.refreshProject(project.id);
    const cached = this._cached(project.id);
    const previous = cached.state.active || { type: "source", changedAt: null };
    let active;
    if (selection?.type === "slot") {
      const slotId = safeComponent(selection.slotId);
      const slot = cached.slots.find((item) => item.slotId === slotId);
      if (!slot) throw new Error("Prepared build slot was not found.");
      active = {
        type: "slot",
        slotId,
        backupFile: slot.backupFile,
        backupCreatedAt: slot.backupCreatedAt || null,
        changedAt: new Date().toISOString(),
      };
    } else {
      active = { type: "source", changedAt: new Date().toISOString() };
    }
    const state = { version: 1, active, previous };
    await this._writeState(project.id, state);
    await this.refreshProject(project.id);
    return this.active(project);
  }

  async delete(project, slotId) {
    await this.refreshProject(project.id);
    const active = this.active(project);
    if (active.type === "slot" && active.slot?.slotId === slotId) {
      throw new Error("The active build slot cannot be deleted. Return to the source build first.");
    }
    const target = this._slotDir(project.id, slotId);
    const canonicalRoot = await canonicalPath(this._slotsDir(project.id));
    const canonicalTarget = await canonicalPath(target);
    if (!isPathInside(canonicalRoot, canonicalTarget)) throw new Error("Invalid build slot path.");
    await fsp.rm(target, { recursive: true, force: true });
    await this.refreshProject(project.id);
    return true;
  }
}

module.exports = {
  BuildSlotManager,
  normalizeOverlayPaths,
  slotIdFor,
};
