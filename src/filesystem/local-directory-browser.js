"use strict";

const path = require("path");
const os = require("os");
const fsp = require("fs/promises");

function uniqueLocations(locations) {
  const seen = new Set();
  const output = [];
  for (const item of locations) {
    if (!item?.path) continue;
    const key = process.platform === "win32" ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function assertAbsoluteDirectoryPath(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("A directory path is required.");
  if (!path.isAbsolute(input)) throw new Error("Directory path must be absolute.");
  return path.resolve(input);
}

class LocalDirectoryBrowser {
  constructor(options = {}) {
    this.rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd();
    this.backupRoot = options.backupRoot ? path.resolve(options.backupRoot) : null;
    this.restoreRoot = options.restoreRoot ? path.resolve(options.restoreRoot) : null;
  }

  async getWindowsDrives() {
    if (process.platform !== "win32") return [];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const checks = await Promise.all(
      letters.map(async (letter) => {
        const drive = `${letter}:\\`;
        try {
          const stat = await fsp.stat(drive);
          return stat.isDirectory()
            ? { name: `${letter}: drive`, path: drive, kind: "drive" }
            : null;
        } catch {
          return null;
        }
      }),
    );
    return checks.filter(Boolean);
  }

  async getRoots() {
    const home = os.homedir();
    const locations = [
      home ? { name: "Home", path: path.resolve(home), kind: "home" } : null,
      { name: "Ultimate Project Manager", path: this.rootDir, kind: "manager" },
      this.backupRoot ? { name: "Backup root", path: this.backupRoot, kind: "backup" } : null,
      this.restoreRoot ? { name: "Restore root", path: this.restoreRoot, kind: "restore" } : null,
      {
        name: "Current filesystem root",
        path: path.parse(process.cwd()).root,
        kind: "root",
      },
      ...(await this.getWindowsDrives()),
    ].filter(Boolean);

    const existing = [];
    for (const location of uniqueLocations(locations)) {
      try {
        const stat = await fsp.stat(location.path);
        if (stat.isDirectory()) existing.push(location);
      } catch {}
    }
    return existing;
  }

  async browse(directoryPath, options = {}) {
    const roots = await this.getRoots();
    if (!directoryPath) {
      return {
        platform: process.platform,
        currentPath: null,
        parentPath: null,
        roots,
        directories: [],
      };
    }

    const currentPath = assertAbsoluteDirectoryPath(directoryPath);
    const stat = await fsp.stat(currentPath).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`Directory does not exist: ${currentPath}`);
      throw error;
    });
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${currentPath}`);

    const showHidden = Boolean(options.showHidden);
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => showHidden || !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name),
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      );

    const parsed = path.parse(currentPath);
    const parent = path.dirname(currentPath);
    const parentPath = parent !== currentPath && currentPath !== parsed.root ? parent : null;

    return {
      platform: process.platform,
      currentPath,
      parentPath,
      roots,
      directories,
    };
  }

  async createDirectory(parentPath, name) {
    const parent = assertAbsoluteDirectoryPath(parentPath);
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Folder name is required.");
    if (cleanName === "." || cleanName === ".." || /[\\/]/.test(cleanName)) {
      throw new Error("Folder name cannot contain path separators.");
    }
    if (process.platform === "win32" && /[<>:"|?*]/.test(cleanName)) {
      throw new Error("Folder name contains characters that are invalid on Windows.");
    }

    const parentStat = await fsp.stat(parent);
    if (!parentStat.isDirectory()) throw new Error("Parent path is not a directory.");
    const target = path.join(parent, cleanName);
    await fsp.mkdir(target, { recursive: false });
    return { path: target };
  }
}

module.exports = { LocalDirectoryBrowser, assertAbsoluteDirectoryPath };
