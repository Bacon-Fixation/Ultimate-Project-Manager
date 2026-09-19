"use strict";

const fsp = require("fs/promises");
const path = require("path");

function comparablePath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, candidate, options = {}) {
  const parentPath = comparablePath(parent);
  const candidatePath = comparablePath(candidate);
  const relative = path.relative(parentPath, candidatePath);
  if (!relative) return options.allowEqual !== false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalPath(value) {
  const absolute = path.resolve(String(value));
  let probe = absolute;
  const missing = [];

  while (true) {
    try {
      const real = await fsp.realpath(probe);
      return path.resolve(real, ...missing);
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function isCanonicalPathInside(parent, candidate, options = {}) {
  const [canonicalParent, canonicalCandidate] = await Promise.all([
    canonicalPath(parent),
    canonicalPath(candidate),
  ]);
  return isPathInside(canonicalParent, canonicalCandidate, options);
}

async function assertCanonicalPathInside(roots, candidate, label = "Path") {
  const canonicalCandidate = await canonicalPath(candidate);
  for (const root of roots || []) {
    const canonicalRoot = await canonicalPath(root);
    if (isPathInside(canonicalRoot, canonicalCandidate)) return canonicalCandidate;
  }
  throw new Error(`${label} is outside the configured allowed roots: ${path.resolve(candidate)}`);
}

module.exports = {
  comparablePath,
  isPathInside,
  canonicalPath,
  isCanonicalPathInside,
  assertCanonicalPathInside,
};
