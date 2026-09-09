"use strict";

const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".backups",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "out",
]);

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readPackageJson(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return { __error: error.message };
  }
}

async function discoverNodeProjects(parentRoots, options = {}) {
  const roots = [
    ...new Set(
      (Array.isArray(parentRoots) ? parentRoots : [parentRoots])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((item) => path.resolve(item)),
    ),
  ];
  if (!roots.length) throw new Error("At least one parent folder is required.");

  const maxDepth = Math.max(0, Math.min(20, Math.floor(Number(options.maxDepth ?? 5))));
  const skipDirectories = new Set([
    ...DEFAULT_SKIP_DIRECTORIES,
    ...(Array.isArray(options.skipDirectories) ? options.skipDirectories.map(String) : []),
  ]);
  const discovered = [];
  const errors = [];
  const visited = new Set();

  async function walk(current, root, depth) {
    const key = pathKey(current);
    if (visited.has(key)) return;
    visited.add(key);

    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: current, error: error.message });
      return;
    }

    const packageEntry = entries.find((entry) => entry.isFile() && entry.name === "package.json");
    if (packageEntry) {
      const packageFile = path.join(current, "package.json");
      const pkg = await readPackageJson(packageFile);
      discovered.push({
        projectRoot: current,
        relativeToParent: path.relative(root, current) || ".",
        packageFile,
        name:
          typeof pkg.name === "string" && pkg.name.trim()
            ? pkg.name.trim()
            : path.basename(current),
        version: typeof pkg.version === "string" ? pkg.version : null,
        private: pkg.private === true,
        packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : null,
        description: typeof pkg.description === "string" ? pkg.description : null,
        validPackageJson: !pkg.__error,
        packageJsonError: pkg.__error || null,
      });
    }

    if (depth >= maxDepth) return;

    const directories = entries
      .filter((entry) => entry.isDirectory() && !skipDirectories.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of directories) {
      await walk(path.join(current, entry.name), root, depth + 1);
    }
  }

  for (const root of roots) {
    try {
      const stat = await fsp.stat(root);
      if (!stat.isDirectory()) {
        errors.push({ path: root, error: "Not a directory." });
        continue;
      }
      await walk(root, root, 0);
    } catch (error) {
      errors.push({ path: root, error: error.message });
    }
  }

  discovered.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
  return { roots, maxDepth, projects: discovered, errors };
}

module.exports = {
  DEFAULT_SKIP_DIRECTORIES,
  discoverNodeProjects,
  pathKey,
};
