"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { atomicWriteFile, atomicWriteJson } = require("../filesystem/atomic-file");

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_VERSION_CACHE_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_BUFFER = 8 * 1024 * 1024;
const DEP_GROUPS = [
  ["dependencies", "production"],
  ["devDependencies", "development"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
];
const SAFE_PACKAGE_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const SAFE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await atomicWriteJson(file, value, { backup: false, allowCopyFallback: false });
}

function installedFromPackageLock(lock = {}, name) {
  if (!lock || typeof lock !== "object") return null;
  const packageEntry = lock.packages?.[`node_modules/${name}`];
  if (packageEntry?.version) return String(packageEntry.version);
  if (lock.dependencies?.[name]?.version) return String(lock.dependencies[name].version);
  return null;
}

function declaredDependencyNames(packageJson = {}) {
  return [...new Set(DEP_GROUPS.flatMap(([field]) => Object.keys(packageJson[field] || {})))];
}

function findDependencyDeclaration(packageJson = {}, name) {
  const matches = [];
  for (const [field, type] of DEP_GROUPS) {
    if (Object.prototype.hasOwnProperty.call(packageJson[field] || {}, name)) {
      matches.push({ field, type, declared: String(packageJson[field][name]) });
    }
  }
  return matches;
}

async function installedFromNodeModules(projectRoot, names) {
  const versions = {};
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(
        projectRoot,
        "node_modules",
        ...String(name).split("/"),
        "package.json",
      );
      const pkg = await readJson(file, null).catch(() => null);
      if (pkg?.version) versions[name] = String(pkg.version);
    }),
  );
  return versions;
}

function parseOutdatedJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return {};
  return JSON.parse(text.slice(start, end + 1));
}

function parseVersionsJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray !== -1 && lastArray >= firstArray) {
    const parsed = JSON.parse(text.slice(firstArray, lastArray + 1));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function windowsNpmCommand(args) {
  return `npm ${args.join(" ")}`;
}

async function runNpm(projectRoot, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const command = npmCommand();
  const execOptions = {
    cwd: projectRoot,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  };
  if (process.platform === "win32") {
    return execFileAsync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", windowsNpmCommand(args)],
      execOptions,
    );
  }
  return execFileAsync(command, args, execOptions);
}

async function runNpmOutdated(projectRoot, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const command = npmCommand();
  const args = ["outdated", "--json", "--long"];
  try {
    const { stdout, stderr } = await runNpm(projectRoot, args, timeoutMs);
    return {
      ok: true,
      data: parseOutdatedJson(stdout),
      stderr: String(stderr || "").trim(),
      command: `${command} ${args.join(" ")}`,
    };
  } catch (error) {
    try {
      const raw = String(error.stdout || "").trim();
      const data = raw ? parseOutdatedJson(raw) : null;
      if (data && typeof data === "object") {
        return {
          ok: true,
          data,
          stderr: String(error.stderr || "").trim(),
          command: `${command} ${args.join(" ")}`,
        };
      }
    } catch {}
    const text = `${error.message || ""}${error.stderr ? `\n${error.stderr}` : ""}`.trim();
    return {
      ok: false,
      data: {},
      error: text || "npm outdated failed.",
      command: `${command} ${args.join(" ")}`,
    };
  }
}

async function runNpmViewVersions(projectRoot, packageName, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!SAFE_PACKAGE_RE.test(String(packageName || "")))
    throw new Error("Invalid npm package name.");
  const args = ["view", packageName, "versions", "--json"];
  try {
    const { stdout, stderr } = await runNpm(projectRoot, args, timeoutMs);
    const versions = parseVersionsJson(stdout).filter((version) => SAFE_VERSION_RE.test(version));
    return {
      ok: true,
      versions,
      stderr: String(stderr || "").trim(),
      command: `${npmCommand()} ${args.join(" ")}`,
    };
  } catch (error) {
    const text = `${error.message || ""}${error.stderr ? `\n${error.stderr}` : ""}`.trim();
    return {
      ok: false,
      versions: [],
      error: text || `npm view ${packageName} versions failed.`,
      command: `${npmCommand()} ${args.join(" ")}`,
    };
  }
}

function dependencyRows(
  packageJson = {},
  packageLock = null,
  outdated = {},
  installedOverrides = {},
) {
  const byName = new Map();
  for (const [field, type] of DEP_GROUPS) {
    const group = packageJson[field] || {};
    for (const [name, declared] of Object.entries(group)) {
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          declared: String(declared),
          types: [type],
          installed: installedOverrides[name] || null,
          locked: installedFromPackageLock(packageLock, name),
        });
      } else {
        const row = byName.get(name);
        if (!row.types.includes(type)) row.types.push(type);
      }
    }
  }

  const rows = [...byName.values()].map((row) => {
    const update = outdated?.[row.name] || null;
    const current = update?.current != null ? String(update.current) : row.installed;
    const wanted = update?.wanted != null ? String(update.wanted) : null;
    const latest = update?.latest != null ? String(update.latest) : null;
    const missing = !current;
    const outdatedFlag = Boolean(update && latest && current && current !== latest);
    const wantedUpdate = Boolean(update && wanted && current && current !== wanted);
    return {
      name: row.name,
      declared: row.declared,
      types: row.types,
      current,
      locked: row.locked || null,
      wanted,
      latest,
      missing,
      outdated: outdatedFlag,
      wantedUpdate,
      homepage: update?.homepage || null,
      location: update?.location || null,
    };
  });

  rows.sort((a, b) => {
    if (a.outdated !== b.outdated) return a.outdated ? -1 : 1;
    if (a.missing !== b.missing) return a.missing ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function declarationForVersion(existingDeclaration, version, mode = "preserve") {
  if (!SAFE_VERSION_RE.test(String(version || "")))
    throw new Error("A valid published npm version is required.");
  if (mode === "exact") return version;
  if (mode === "caret") return `^${version}`;
  if (mode === "tilde") return `~${version}`;
  const existing = String(existingDeclaration || "").trim();
  if (existing.startsWith("^")) return `^${version}`;
  if (existing.startsWith("~")) return `~${version}`;
  return version;
}

function packageInstallSaveFlag(declarations = []) {
  const types = declarations.map((item) => item.type);
  if (types.includes("development")) return "--save-dev";
  if (types.includes("optional")) return "--save-optional";
  if (types.includes("peer")) return "--save-peer";
  return "--save-prod";
}

class DependencyInspector {
  constructor(options = {}) {
    this.cacheMs = Math.max(30_000, Number(options.cacheMs || DEFAULT_CACHE_MS));
    this.versionCacheMs = Math.max(
      30_000,
      Number(options.versionCacheMs || DEFAULT_VERSION_CACHE_MS),
    );
    this.timeoutMs = Math.max(5_000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
    this.runner = options.runner || runNpmOutdated;
    this.versionRunner = options.versionRunner || runNpmViewVersions;
    this.npmRunner = options.npmRunner || runNpm;
    this.cache = new Map();
    this.versionCache = new Map();
  }

  getCached(projectId) {
    const value = this.cache.get(projectId);
    return value ? structuredClone(value) : null;
  }

  getCachedSummary(projectId) {
    const value = this.cache.get(projectId);
    if (!value) return null;
    return {
      checkedAt: value.checkedAt,
      registryAvailable: value.registryAvailable,
      total: value.summary.total,
      outdated: value.summary.outdated,
      missing: value.summary.missing,
      current: value.summary.current,
      error: value.registryError || null,
    };
  }

  clear(projectId) {
    this.cache.delete(projectId);
    for (const key of this.versionCache.keys()) {
      if (key.startsWith(`${projectId}:`)) this.versionCache.delete(key);
    }
  }

  async inspect(projectId, projectRoot, options = {}) {
    const existing = this.cache.get(projectId);
    if (
      !options.refresh &&
      existing &&
      Date.now() - new Date(existing.checkedAt).getTime() < this.cacheMs
    ) {
      return { ...structuredClone(existing), cached: true };
    }

    const packageFile = path.join(projectRoot, "package.json");
    const packageJson = await readJson(packageFile, null);
    if (!packageJson) throw new Error(`package.json was not found in ${projectRoot}.`);

    const lock = await readJson(path.join(projectRoot, "package-lock.json"), null).catch(
      () => null,
    );
    const installedOverrides = await installedFromNodeModules(
      projectRoot,
      declaredDependencyNames(packageJson),
    );
    const registry = await this.runner(projectRoot, this.timeoutMs);
    const rows = dependencyRows(packageJson, lock, registry.data || {}, installedOverrides);
    for (const row of rows) {
      row.registryChecked = registry.ok === true;
      row.upToDate = registry.ok === true && !row.outdated && !row.missing;
    }
    const result = {
      projectId,
      projectRoot,
      packageName: packageJson.name || path.basename(projectRoot),
      packageVersion: packageJson.version || null,
      packageManager: packageJson.packageManager || (lock ? "npm" : null),
      checkedAt: new Date().toISOString(),
      registryAvailable: registry.ok === true,
      registryError: registry.ok ? null : registry.error,
      command: registry.command,
      cached: false,
      summary: {
        total: rows.length,
        outdated: rows.filter((item) => item.outdated).length,
        missing: rows.filter((item) => item.missing).length,
        current: rows.filter((item) => !item.outdated && !item.missing).length,
        production: rows.filter((item) => item.types.includes("production")).length,
        development: rows.filter((item) => item.types.includes("development")).length,
        optional: rows.filter((item) => item.types.includes("optional")).length,
        peer: rows.filter((item) => item.types.includes("peer")).length,
      },
      dependencies: rows,
    };
    this.cache.set(projectId, result);
    return structuredClone(result);
  }

  async getVersions(projectId, projectRoot, packageName, options = {}) {
    const name = String(packageName || "").trim();
    if (!SAFE_PACKAGE_RE.test(name)) throw new Error("Invalid npm package name.");
    const packageJson = await readJson(path.join(projectRoot, "package.json"), null);
    if (!packageJson) throw new Error(`package.json was not found in ${projectRoot}.`);
    const declarations = findDependencyDeclaration(packageJson, name);
    if (!declarations.length) throw new Error(`${name} is not declared by this project.`);

    const cacheKey = `${projectId}:${name}`;
    let cached = this.versionCache.get(cacheKey);
    if (
      options.refresh ||
      !cached ||
      Date.now() - new Date(cached.checkedAt).getTime() >= this.versionCacheMs
    ) {
      const result = await this.versionRunner(projectRoot, name, this.timeoutMs);
      if (!result.ok)
        throw new Error(result.error || `Could not load published versions for ${name}.`);
      cached = {
        projectId,
        name,
        checkedAt: new Date().toISOString(),
        command: result.command,
        versions: [...new Set(result.versions.filter((version) => SAFE_VERSION_RE.test(version)))],
      };
      this.versionCache.set(cacheKey, cached);
    }

    const includePrerelease = options.includePrerelease === true;
    const versions = cached.versions
      .filter((version) => includePrerelease || !version.includes("-"))
      .slice()
      .reverse();
    return {
      ...structuredClone(cached),
      declarations,
      includePrerelease,
      versions,
      cached: !options.refresh,
    };
  }

  async updateDependency(projectId, projectRoot, packageName, version, options = {}) {
    const name = String(packageName || "").trim();
    const selectedVersion = String(version || "").trim();
    if (!SAFE_PACKAGE_RE.test(name)) throw new Error("Invalid npm package name.");
    if (!SAFE_VERSION_RE.test(selectedVersion))
      throw new Error("A valid exact npm version is required.");

    const packageFile = path.join(projectRoot, "package.json");
    const packageJson = await readJson(packageFile, null);
    if (!packageJson) throw new Error(`package.json was not found in ${projectRoot}.`);
    const declarations = findDependencyDeclaration(packageJson, name);
    if (!declarations.length) throw new Error(`${name} is not declared by this project.`);

    const published = await this.getVersions(projectId, projectRoot, name, {
      includePrerelease: true,
      refresh: options.refreshVersions === true,
    });
    if (!published.versions.includes(selectedVersion)) {
      throw new Error(
        `${selectedVersion} was not found in the published version list for ${name}.`,
      );
    }

    const saveMode = ["preserve", "exact", "caret", "tilde"].includes(options.saveMode)
      ? options.saveMode
      : "preserve";
    const runScripts = options.runScripts !== false;
    const firstDeclaration = declarations[0].declared;
    const requestedDeclaration = declarationForVersion(firstDeclaration, selectedVersion, saveMode);
    const originalPackageText = await fsp.readFile(packageFile, "utf8");
    const saveFlag = packageInstallSaveFlag(declarations);
    const args = [
      "install",
      `${name}@${selectedVersion}`,
      saveFlag,
      "--save-exact",
      "--no-audit",
      "--no-fund",
    ];
    if (!runScripts) args.push("--ignore-scripts");

    let npmResult;
    try {
      npmResult = await this.npmRunner(projectRoot, args, Math.max(this.timeoutMs, 5 * 60 * 1000));
      const updatedPackage = await readJson(packageFile, null);
      if (!updatedPackage)
        throw new Error("npm completed but package.json could not be read afterward.");
      for (const declaration of declarations) {
        if (!updatedPackage[declaration.field]) updatedPackage[declaration.field] = {};
        updatedPackage[declaration.field][name] = declarationForVersion(
          declaration.declared,
          selectedVersion,
          saveMode,
        );
      }
      await writeJson(packageFile, updatedPackage);
    } catch (error) {
      let restoreError = null;
      try {
        await atomicWriteFile(packageFile, originalPackageText, {
          encoding: "utf8",
          backup: false,
          allowCopyFallback: false,
        });
      } catch (failure) {
        restoreError = failure;
      }
      const detail = `${error.message || ""}${error.stderr ? `\n${error.stderr}` : ""}`.trim();
      const recovery = restoreError?.recoveryTempPath
        ? ` Original package.json is preserved at ${restoreError.recoveryTempPath}.`
        : restoreError
          ? ` Restoring the original package.json also failed: ${restoreError.message}.`
          : "";
      throw new Error(
        `${detail || `npm install failed for ${name}@${selectedVersion}.`}${recovery}`,
      );
    }

    this.clear(projectId);
    const refreshed = await this.inspect(projectId, projectRoot, {
      refresh: true,
    });
    const dependency = refreshed.dependencies.find((item) => item.name === name) || null;
    return {
      projectId,
      name,
      version: selectedVersion,
      declaration: dependency?.declared || requestedDeclaration,
      saveMode,
      runScripts,
      stdout: String(npmResult?.stdout || "").trim(),
      stderr: String(npmResult?.stderr || "").trim(),
      dependency,
      checkedAt: refreshed.checkedAt,
    };
  }
}

module.exports = {
  DependencyInspector,
  declaredDependencyNames,
  declarationForVersion,
  dependencyRows,
  findDependencyDeclaration,
  installedFromNodeModules,
  installedFromPackageLock,
  parseOutdatedJson,
  parseVersionsJson,
  runNpm,
  runNpmOutdated,
  runNpmViewVersions,
};
