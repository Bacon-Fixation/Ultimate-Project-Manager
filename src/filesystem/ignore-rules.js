"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

let ignoreFactory = null;
try {
  ignoreFactory = require("ignore");
} catch {
  ignoreFactory = null;
}

const DEFAULT_PROJECT_PATTERNS = Object.freeze([".git/", "node_modules/", ".idea/", ".vscode/"]);

function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function normalizePatterns(patterns) {
  const input = Array.isArray(patterns) ? patterns : String(patterns || "").split(/\r?\n/);

  return input.map((value) => String(value || "").trim()).filter(Boolean);
}

function normalizeIncludePatterns(patterns) {
  return normalizePatterns(patterns).map((value) => {
    let normalized = toPosix(value).trim();
    if (normalized.startsWith("!")) normalized = normalized.slice(1).trim();
    normalized = normalized.replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0"))
      throw new Error("Backup include overrides cannot be empty or contain NUL characters.");
    if (normalized.split("/").some((part) => part === ".."))
      throw new Error(`Backup include override cannot traverse outside the project: ${value}`);
    return normalized;
  });
}

async function readIgnoreFile(root, filename = ".gitignore") {
  const file = path.join(path.resolve(root), filename);
  try {
    const text = await fsp.readFile(file, "utf8");
    return {
      found: true,
      file,
      text,
      patterns: text.split(/\r?\n/),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        found: false,
        file,
        text: "",
        patterns: [],
      };
    }
    throw error;
  }
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globFragment(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegex(char);
  }
  return out;
}

function compileFallbackPattern(rawPattern) {
  let raw = String(rawPattern || "").trim();
  if (!raw || raw.startsWith("#")) return null;

  let negated = false;
  if (raw.startsWith("!")) {
    negated = true;
    raw = raw.slice(1);
  }
  if (!raw) return null;

  const directoryOnly = raw.endsWith("/");
  if (directoryOnly) raw = raw.replace(/\/+$/, "");

  const anchored = raw.startsWith("/");
  if (anchored) raw = raw.replace(/^\/+/, "");

  const hasSlash = raw.includes("/");
  const fragment = globFragment(raw);

  let source;
  if (anchored || hasSlash) {
    source = `^${fragment}${directoryOnly ? "(?:/.*)?" : "(?:$|/.*$)"}`;
  } else {
    source = `(?:^|/)${fragment}${directoryOnly ? "(?:/.*)?$" : "(?:$|/.*$)"}`;
  }

  return {
    negated,
    regex: new RegExp(source),
    raw: rawPattern,
  };
}

function createFallbackMatcher(patterns) {
  const rules = patterns.map(compileFallbackPattern).filter(Boolean);

  return {
    ignores(relativePath, isDirectory = false) {
      let relative = toPosix(relativePath).replace(/^\/+/, "");
      if (!relative) return false;
      if (isDirectory && !relative.endsWith("/")) relative += "/";

      let ignored = false;
      for (const rule of rules) {
        if (rule.regex.test(relative)) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

function staticPrefixForPattern(pattern) {
  const wildcardIndex = pattern.search(/[?*]/);
  const prefix = wildcardIndex >= 0 ? pattern.slice(0, wildcardIndex) : pattern;
  return prefix.replace(/\/+$/, "");
}

function compileIncludePattern(rawPattern) {
  const raw = String(rawPattern || "")
    .trim()
    .replace(/^\/+/, "");
  const directoryHint = raw.endsWith("/");
  const clean = raw.replace(/\/+$/, "");
  const hasGlob = /[?*]/.test(clean);
  const staticPrefix = staticPrefixForPattern(clean);
  const regex = hasGlob
    ? new RegExp(`^${globFragment(clean)}${directoryHint ? "(?:/.*)?$" : "$"}`)
    : null;
  return { raw, clean, directoryHint, hasGlob, staticPrefix, regex };
}

function createIncludeOverrideMatcher(patterns = []) {
  const normalized = normalizeIncludePatterns(patterns);
  const rules = normalized.map(compileIncludePattern);

  function cleanRelative(relativePath) {
    return toPosix(relativePath).replace(/^\/+|\/+$/g, "");
  }

  return {
    patterns: normalized,
    matches(relativePath, isDirectory = false) {
      const relative = cleanRelative(relativePath);
      if (!relative) return false;
      for (const rule of rules) {
        if (!rule.clean) continue;
        if (!rule.hasGlob) {
          if (relative === rule.clean) return true;
          if (relative.startsWith(`${rule.clean}/`)) return true;
          continue;
        }
        if (rule.regex.test(relative)) return true;
        if (isDirectory && rule.directoryHint && rule.regex.test(`${relative}/`)) return true;
      }
      return false;
    },
    shouldTraverse(relativePath) {
      const relative = cleanRelative(relativePath);
      if (!relative) return rules.length > 0;
      if (this.matches(relative, true)) return true;
      for (const rule of rules) {
        const prefix = rule.staticPrefix;
        if (!prefix) return true;
        if (
          prefix === relative ||
          prefix.startsWith(`${relative}/`) ||
          relative.startsWith(`${prefix}/`)
        )
          return true;
      }
      return false;
    },
  };
}

function createIgnoreMatcher({
  gitignoreText = "",
  extraPatterns = [],
  defaultPatterns = DEFAULT_PROJECT_PATTERNS,
} = {}) {
  const defaults = normalizePatterns(defaultPatterns);
  const extras = normalizePatterns(extraPatterns);
  const gitignorePatterns = String(gitignoreText || "").split(/\r?\n/);
  const allPatterns = [...gitignorePatterns, ...defaults, ...extras];

  if (ignoreFactory) {
    const matcher = ignoreFactory();
    if (gitignoreText) matcher.add(gitignoreText);
    if (defaults.length) matcher.add(defaults);
    if (extras.length) matcher.add(extras);
    return {
      engine: "ignore-package",
      patterns: allPatterns,
      ignores(relativePath, isDirectory = false) {
        let relative = toPosix(relativePath).replace(/^\/+/, "");
        if (!relative) return false;
        if (isDirectory && !relative.endsWith("/")) relative += "/";
        return matcher.ignores(relative);
      },
    };
  }

  const fallback = createFallbackMatcher(allPatterns);
  return {
    engine: "fallback",
    patterns: allPatterns,
    ignores: fallback.ignores,
  };
}

module.exports = {
  DEFAULT_PROJECT_PATTERNS,
  toPosix,
  normalizePatterns,
  normalizeIncludePatterns,
  readIgnoreFile,
  createIgnoreMatcher,
  createIncludeOverrideMatcher,
};
