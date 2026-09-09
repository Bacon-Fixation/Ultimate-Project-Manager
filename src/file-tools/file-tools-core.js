"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const ignore = require("ignore");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  createIgnoreMatcher,
  normalizePatterns,
  readIgnoreFile,
  toPosix,
} = require("../filesystem/ignore-rules");
const { normalizeAggressiveness, shouldPreserveComment } = require("./comment-policy");
const {
  stripWithBabel,
  isBabelCommentFile,
  babelParserAvailable,
} = require("./babel-comment-remover");

const TIMESTAMP_PATTERN = /^(?<name>.+)_(?<timestamp>\d{14})(?<suffix>(?:\..*)?)$/;

const C_STYLE = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".java",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".kts",
  ".php",
  ".jsonc",
  ".groovy",
  ".scala",
  ".dart",
  ".sol",
  ".proto",
]);
const BLOCK_ONLY_STYLE = new Set([".css", ".pcss"]);
const C_STYLE_PREPROCESSOR = new Set([".scss", ".sass", ".less"]);
const HASH_STYLE = new Set([
  ".py",
  ".pyw",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".env",
  ".properties",
  ".rb",
  ".rake",
  ".gemspec",
  ".pl",
  ".pm",
  ".r",
  ".graphql",
  ".gql",
  ".npmrc",
  ".editorconfig",
]);
const YAML_STYLE = new Set([".yaml", ".yml"]);
const SQL_STYLE = new Set([".sql"]);
const HTML_STYLE = new Set([".html", ".htm", ".xml", ".svg", ".md", ".markdown"]);
const PUG_STYLE = new Set([".pug", ".jade"]);
const POWERSHELL_STYLE = new Set([".ps1", ".psm1", ".psd1"]);
const LUA_STYLE = new Set([".lua"]);
const BATCH_STYLE = new Set([".bat", ".cmd"]);
const VB_STYLE = new Set([".vb", ".vbs", ".bas", ".cls"]);
const HASKELL_STYLE = new Set([".hs", ".lhs"]);
const HCL_STYLE = new Set([".tf", ".tfvars", ".hcl"]);

const HASH_FILENAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "gnumakefile",
  ".gitignore",
  ".dockerignore",
  ".npmignore",
  ".env",
]);
const C_FILENAMES = new Set(["jenkinsfile"]);

const DEFAULT_COMMENT_MAX_BYTES = 4 * 1024 * 1024;

function normalizePath(value) {
  return path.resolve(String(value || "").trim());
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function parseTimestampedFilename(filename) {
  const match = filename.match(TIMESTAMP_PATTERN);
  if (!match?.groups) return null;
  const { name, timestamp, suffix = "" } = match.groups;
  return { name, timestamp, suffix, outputName: `${name}${suffix}` };
}

function getCommentStyle(filename) {
  const base = path.basename(filename).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (C_FILENAMES.has(base) || base.startsWith("jenkinsfile.")) return "c-style";
  if (
    HASH_FILENAMES.has(base) ||
    base.startsWith(".env.") ||
    base.startsWith("dockerfile.") ||
    base.startsWith("containerfile.")
  )
    return "hash";
  if (C_STYLE.has(ext)) return "c-style";
  if (BLOCK_ONLY_STYLE.has(ext)) return "block-only";
  if (C_STYLE_PREPROCESSOR.has(ext)) return "c-style";
  if (YAML_STYLE.has(ext)) return "yaml";
  if (HASH_STYLE.has(ext)) return "hash";
  if (SQL_STYLE.has(ext)) return "sql";
  if (HTML_STYLE.has(ext)) return "html";
  if (PUG_STYLE.has(ext)) return "pug";
  if (POWERSHELL_STYLE.has(ext)) return "powershell";
  if (LUA_STYLE.has(ext)) return "lua";
  if (BATCH_STYLE.has(ext)) return "batch";
  if (VB_STYLE.has(ext)) return "vb";
  if (HASKELL_STYLE.has(ext)) return "haskell";
  if (HCL_STYLE.has(ext)) return "hcl";
  return null;
}

function preserveRemovedSegment(segment, keepLines) {
  return keepLines ? String(segment).replace(/[^\r\n]/g, "") : "";
}

function processCommentSegment(segment, options = {}) {
  const decision = shouldPreserveComment(segment, options);
  if (decision.preserve) {
    return {
      content: segment,
      commentsRemoved: 0,
      legalCommentsPreserved: decision.category === "legal" ? 1 : 0,
      policyCommentsPreserved: decision.category === "legal" ? 0 : 1,
      category: decision.category,
    };
  }
  return {
    content: preserveRemovedSegment(segment, options.preserveLinePositions !== false),
    commentsRemoved: 1,
    legalCommentsPreserved: 0,
    policyCommentsPreserved: 0,
    category: decision.category,
  };
}

async function scanFiles({
  sourceRoot,
  outputRoot,
  excludes = [],
  respectGitignore = true,
  includes = [],
  minFileBytes = 0,
  maxFileBytes = 0,
} = {}) {
  const source = normalizePath(sourceRoot);
  const output = normalizePath(outputRoot);
  if (source === output) throw new Error("Source and output directories must be different.");

  const stat = await fsp.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Source directory does not exist: ${source}`);

  const extraPatterns = normalizePatterns(excludes);
  if (isInside(source, output)) {
    const outputRelative = toPosix(path.relative(source, output)).replace(/\/$/, "");
    if (outputRelative) extraPatterns.push(`${outputRelative}/`);
  }

  const gitignore = respectGitignore
    ? await readIgnoreFile(source, ".gitignore")
    : {
        found: false,
        file: path.join(source, ".gitignore"),
        text: "",
        patterns: [],
      };

  const matcher = createIgnoreMatcher({
    gitignoreText: respectGitignore ? gitignore.text : "",
    extraPatterns,
  });
  const includePatterns = normalizePatterns(includes).filter(
    (pattern) => !String(pattern).startsWith("!"),
  );
  const includeMatcher = includePatterns.length ? ignore().add(includePatterns) : null;
  const minBytes = Math.max(0, Number(minFileBytes) || 0);
  const maxBytes = Math.max(0, Number(maxFileBytes) || 0);

  const files = [];
  const ignoredDirectories = [];
  const ignoredFiles = [];
  const filteredFiles = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(source, full));

      if (entry.isDirectory()) {
        if (matcher.ignores(relative, true)) {
          ignoredDirectories.push(relative);
          continue;
        }
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (matcher.ignores(relative, false)) {
        ignoredFiles.push(relative);
        continue;
      }
      const stat = await fsp.stat(full);
      if (includeMatcher && !includeMatcher.ignores(relative)) {
        filteredFiles.push(relative);
        continue;
      }
      if (stat.size < minBytes || (maxBytes > 0 && stat.size > maxBytes)) {
        filteredFiles.push(relative);
        continue;
      }

      files.push({
        filename: entry.name,
        sourcePath: full,
        relativePath: relative,
        relativeDirectory: toPosix(path.relative(source, dir)),
        size: stat.size,
      });
    }
  }

  await walk(source);
  return {
    sourceRoot: source,
    outputRoot: output,
    files,
    excludes: [...new Set(extraPatterns)],
    ignoredDirectories,
    ignoredFiles,
    filteredFiles,
    includePatterns,
    minFileBytes: minBytes,
    maxFileBytes: maxBytes,
    ignoreEngine: matcher.engine,
    respectGitignore: Boolean(respectGitignore),
    gitignore: {
      found: Boolean(gitignore.found),
      path: gitignore.file,
      patternCount: gitignore.patterns.filter(
        (line) => String(line).trim() && !String(line).trim().startsWith("#"),
      ).length,
    },
  };
}

function newest(items) {
  return items.reduce(
    (best, item) => (!best || Number(item.timestamp) > Number(best.timestamp) ? item : best),
    null,
  );
}

async function prepareLatestPlan({
  sourceRoot,
  outputRoot,
  copyUnversioned = false,
  excludes = [],
  respectGitignore = true,
  includes = [],
  minFileBytes = 0,
  maxFileBytes = 0,
}) {
  const scan = await scanFiles({
    sourceRoot,
    outputRoot,
    excludes,
    respectGitignore,
    includes,
    minFileBytes,
    maxFileBytes,
  });
  const groups = new Map();
  const unversioned = [];
  let timestampedCount = 0;

  for (const file of scan.files) {
    const parsed = parseTimestampedFilename(file.filename);
    if (!parsed) {
      unversioned.push(file);
      continue;
    }
    timestampedCount++;
    const item = { ...file, ...parsed };
    const key = path.posix.join(file.relativeDirectory || "", parsed.outputName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const operations = [];
  const collisions = [];

  for (const [key, versions] of groups) {
    const selected = newest(versions);
    const destinationPath = path.join(
      scan.outputRoot,
      ...selected.relativeDirectory.split("/").filter(Boolean),
      selected.outputName,
    );
    operations.push({
      type: "timestamped",
      groupKey: key,
      sourcePath: selected.sourcePath,
      sourceRelativePath: selected.relativePath,
      destinationPath,
      destinationRelativePath: toPosix(path.relative(scan.outputRoot, destinationPath)),
      timestamp: selected.timestamp,
      versionsFound: versions.length,
      olderVersions: versions
        .filter((v) => v.sourcePath !== selected.sourcePath)
        .map((v) => v.relativePath),
    });
  }

  if (copyUnversioned) {
    for (const file of unversioned) {
      const destinationPath = path.join(scan.outputRoot, ...file.relativePath.split("/"));
      const conflict = operations.find(
        (op) => path.normalize(op.destinationPath) === path.normalize(destinationPath),
      );
      if (conflict) {
        collisions.push({
          destinationRelativePath: file.relativePath,
          resolution: "timestamped-wins",
        });
        continue;
      }
      operations.push({
        type: "unversioned",
        sourcePath: file.sourcePath,
        sourceRelativePath: file.relativePath,
        destinationPath,
        destinationRelativePath: file.relativePath,
        timestamp: null,
        versionsFound: 1,
        olderVersions: [],
      });
    }
  }

  operations.sort((a, b) => a.destinationRelativePath.localeCompare(b.destinationRelativePath));
  return {
    ...scan,
    groups,
    operations,
    collisions,
    timestampedCount,
    unversionedCount: unversioned.length,
  };
}

function stripCStyle(source, options = {}) {
  let out = "";
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;
  let i = 0;
  let quote = null;

  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1] || "";

    if (quote) {
      out += c;
      if (c === "\\" && n) {
        out += n;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && n === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      const segment = source.slice(start, i);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      out += action.content;
      continue;
    }

    if (c === "/" && n === "*") {
      const start = i;
      i += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      const segment = source.slice(start, i);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      out += action.content;
      continue;
    }

    out += c;
    i++;
  }

  return {
    content: out,
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripDelimited(source, open, close, options = {}) {
  let out = "";
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(open, cursor);
    if (start < 0) {
      out += source.slice(cursor);
      break;
    }
    out += source.slice(cursor, start);
    const end = source.indexOf(close, start + open.length);
    const finish = end < 0 ? source.length : end + close.length;
    const segment = source.slice(start, finish);
    const action = processCommentSegment(segment, options);
    removed += action.commentsRemoved;
    preservedLegal += action.legalCommentsPreserved;
    preservedPolicy += action.policyCommentsPreserved;
    out += action.content;
    cursor = finish;
  }

  return {
    content: out,
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripHash(source, options = {}) {
  const parts = source.split(/(\r?\n)/);
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;

  for (let x = 0; x < parts.length; x += 2) {
    const line = parts[x] || "";
    if (x === 0 && line.startsWith("#!")) continue;

    let quote = null;
    let escaped = false;
    let cut = -1;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\" && quote) {
        escaped = true;
        continue;
      }
      if ((c === '"' || c === "'") && (!quote || quote === c)) {
        quote = quote === c ? null : c;
        continue;
      }
      if (c === "#" && !quote) {
        cut = i;
        break;
      }
    }

    if (cut >= 0) {
      const segment = line.slice(cut);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (!action.content) parts[x] = line.slice(0, cut);
    }
  }

  return {
    content: parts.join(""),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function lineIndent(line) {
  return (line.match(/^\s*/) || [""])[0].replace(/\t/g, "    ").length;
}

function stripYaml(source, options = {}) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const output = [];
  let blockIndent = null;
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;

  for (const line of lines) {
    const indent = lineIndent(line);
    const trimmed = line.trim();

    if (blockIndent !== null) {
      if (!trimmed || indent > blockIndent) {
        output.push(line);
        continue;
      }
      blockIndent = null;
    }

    const scalarMatch = line.match(/^\s*(?:[^#][^:]*:\s*|[-?]\s*)[>|][+-]?\d?(?:\s+#.*)?\s*$/);
    if (scalarMatch) blockIndent = indent;

    const cleaned = stripHash(line, options);
    removed += cleaned.commentsRemoved;
    preservedLegal += cleaned.legalCommentsPreserved || 0;
    preservedPolicy += cleaned.policyCommentsPreserved || 0;
    output.push(cleaned.content);
  }

  return {
    content: output.join(newline),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripSql(source, options = {}) {
  const block = stripDelimited(source, "/*", "*/", options);
  const parts = block.content.split(/(\r?\n)/);
  let removed = block.commentsRemoved;
  let preservedLegal = block.legalCommentsPreserved || 0;
  let preservedPolicy = block.policyCommentsPreserved || 0;

  for (let x = 0; x < parts.length; x += 2) {
    const line = parts[x] || "";
    let quote = null;
    let cut = -1;

    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if ((c === '"' || c === "'") && (!quote || quote === c)) {
        quote = quote === c ? null : c;
        continue;
      }
      if (!quote && c === "-" && line[i + 1] === "-") {
        cut = i;
        break;
      }
    }

    if (cut >= 0) {
      const segment = line.slice(cut);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (!action.content) parts[x] = line.slice(0, cut);
    }
  }

  return {
    content: parts.join(""),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripPug(source, options = {}) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const out = [];
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;
  let skipIndent = null;
  let preservingBlock = false;

  for (const line of lines) {
    const match = line.match(/^(\s*)\/\/-?(?:\s|$)/);
    if (match) {
      const action = processCommentSegment(line, options);
      skipIndent = match[1].replace(/\t/g, "    ").length;
      preservingBlock = Boolean(action.content);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (action.content) out.push(line);
      else out.push(options.preserveLinePositions !== false ? "" : null);
      continue;
    }

    if (skipIndent !== null) {
      if (!line.trim()) {
        out.push(preservingBlock || options.preserveLinePositions !== false ? line : null);
        continue;
      }
      const indent = lineIndent(line);
      if (indent > skipIndent) {
        out.push(preservingBlock ? line : options.preserveLinePositions !== false ? "" : null);
        continue;
      }
      skipIndent = null;
      preservingBlock = false;
    }

    out.push(line);
  }

  return {
    content: out.filter((value) => value !== null).join(newline),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripLua(source, options = {}) {
  const block = stripDelimited(source, "--[[", "]]", options);
  const parts = block.content.split(/(\r?\n)/);
  let removed = block.commentsRemoved;
  let preservedLegal = block.legalCommentsPreserved || 0;
  let preservedPolicy = block.policyCommentsPreserved || 0;

  for (let x = 0; x < parts.length; x += 2) {
    const line = parts[x] || "";
    let quote = null;
    let escaped = false;
    let cut = -1;
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\" && quote) {
        escaped = true;
        continue;
      }
      if ((c === '"' || c === "'") && (!quote || quote === c)) {
        quote = quote === c ? null : c;
        continue;
      }
      if (!quote && c === "-" && line[i + 1] === "-") {
        cut = i;
        break;
      }
    }
    if (cut >= 0) {
      const segment = line.slice(cut);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (!action.content) parts[x] = line.slice(0, cut);
    }
  }
  return {
    content: parts.join(""),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripPowerShell(source, options = {}) {
  const block = stripDelimited(source, "<#", "#>", options);
  const line = stripHash(block.content, options);
  return {
    content: line.content,
    commentsRemoved: block.commentsRemoved + line.commentsRemoved,
    legalCommentsPreserved:
      (block.legalCommentsPreserved || 0) + (line.legalCommentsPreserved || 0),
    policyCommentsPreserved:
      (block.policyCommentsPreserved || 0) + (line.policyCommentsPreserved || 0),
  };
}

function stripHcl(source, options = {}) {
  const c = stripCStyle(source, options);
  const hash = stripHash(c.content, options);
  return {
    content: hash.content,
    commentsRemoved: c.commentsRemoved + hash.commentsRemoved,
    legalCommentsPreserved: (c.legalCommentsPreserved || 0) + (hash.legalCommentsPreserved || 0),
    policyCommentsPreserved: (c.policyCommentsPreserved || 0) + (hash.policyCommentsPreserved || 0),
  };
}

function stripHaskell(source, options = {}) {
  const block = stripDelimited(source, "{-", "-}", options);
  const parts = block.content.split(/(\r?\n)/);
  let removed = block.commentsRemoved;
  let preservedLegal = block.legalCommentsPreserved || 0;
  let preservedPolicy = block.policyCommentsPreserved || 0;
  for (let x = 0; x < parts.length; x += 2) {
    const line = parts[x] || "";
    let quote = null;
    let cut = -1;
    for (let i = 0; i < line.length - 1; i++) {
      const c = line[i];
      if ((c === '"' || c === "'") && (!quote || quote === c)) {
        quote = quote === c ? null : c;
        continue;
      }
      if (!quote && c === "-" && line[i + 1] === "-") {
        cut = i;
        break;
      }
    }
    if (cut >= 0) {
      const segment = line.slice(cut);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (!action.content) parts[x] = line.slice(0, cut);
    }
  }
  return {
    content: parts.join(""),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripBatch(source, options = {}) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;
  const out = lines
    .map((line) => {
      const trimmed = line.trimStart();
      if (!/^(?:::|rem(?:\s|\.|$))/i.test(trimmed)) return line;
      const action = processCommentSegment(trimmed, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (action.content) return line;
      return options.preserveLinePositions !== false ? "" : null;
    })
    .filter((line) => line !== null);
  return {
    content: out.join(newline),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripVb(source, options = {}) {
  const parts = source.split(/(\r?\n)/);
  let removed = 0;
  let preservedLegal = 0;
  let preservedPolicy = 0;
  for (let x = 0; x < parts.length; x += 2) {
    const line = parts[x] || "";
    const trimmed = line.trimStart();
    if (/^rem(?:\s|$)/i.test(trimmed)) {
      const action = processCommentSegment(trimmed, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (!action.content) parts[x] = line.slice(0, line.length - trimmed.length);
      continue;
    }
    let inString = false;
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inString && line[i + 1] === '"') {
          i++;
          continue;
        }
        inString = !inString;
        continue;
      }
      if (!inString && line[i] === "'") {
        cut = i;
        break;
      }
    }
    if (cut >= 0) {
      const segment = line.slice(cut);
      const action = processCommentSegment(segment, options);
      removed += action.commentsRemoved;
      preservedLegal += action.legalCommentsPreserved;
      preservedPolicy += action.policyCommentsPreserved;
      if (!action.content) parts[x] = line.slice(0, cut);
    }
  }
  return {
    content: parts.join(""),
    commentsRemoved: removed,
    legalCommentsPreserved: preservedLegal,
    policyCommentsPreserved: preservedPolicy,
  };
}

function stripComments(filename, source, options = {}) {
  const normalizedOptions = {
    preserveLinePositions: options.preserveLinePositions !== false,
    preserveLicenseComments: options.preserveLicenseComments !== false,
    commentAggressiveness: normalizeAggressiveness(options.commentAggressiveness),
  };
  const style = getCommentStyle(filename);
  if (!style) {
    return {
      content: source,
      commentsRemoved: 0,
      legalCommentsPreserved: 0,
      policyCommentsPreserved: 0,
      commentStyle: null,
      commentAggressiveness: normalizedOptions.commentAggressiveness,
      parserEngine: null,
      supported: false,
    };
  }

  let babelFallbackReason = null;
  if (isBabelCommentFile(filename)) {
    const babelResult = stripWithBabel(filename, source, normalizedOptions);
    if (babelResult.ok) {
      return {
        ...babelResult,
        commentStyle: style,
        supported: true,
      };
    }
    babelFallbackReason = babelResult.fallbackReason || "Babel parser could not parse this file.";
  }

  let result;
  if (style === "c-style") result = stripCStyle(source, normalizedOptions);
  if (style === "block-only") result = stripDelimited(source, "/*", "*/", normalizedOptions);
  if (style === "hash") result = stripHash(source, normalizedOptions);
  if (style === "yaml") result = stripYaml(source, normalizedOptions);
  if (style === "sql") result = stripSql(source, normalizedOptions);
  if (style === "html") result = stripDelimited(source, "<!--", "-->", normalizedOptions);
  if (style === "pug") result = stripPug(source, normalizedOptions);
  if (style === "powershell") result = stripPowerShell(source, normalizedOptions);
  if (style === "lua") result = stripLua(source, normalizedOptions);
  if (style === "batch") result = stripBatch(source, normalizedOptions);
  if (style === "vb") result = stripVb(source, normalizedOptions);
  if (style === "haskell") result = stripHaskell(source, normalizedOptions);
  if (style === "hcl") result = stripHcl(source, normalizedOptions);

  return {
    ...result,
    policyCommentsPreserved: result?.policyCommentsPreserved || 0,
    commentStyle: style,
    commentAggressiveness: normalizedOptions.commentAggressiveness,
    parserEngine: babelFallbackReason ? "lexical-fallback" : "lexical",
    parserFallbackReason: babelFallbackReason,
    supported: true,
  };
}

async function prepareCommentPlan({
  sourceRoot,
  outputRoot,
  excludes = [],
  copyUnsupported = true,
  respectGitignore = true,
  includes = [],
  minFileBytes = 0,
  maxFileBytes = 0,
}) {
  const scan = await scanFiles({
    sourceRoot,
    outputRoot,
    excludes,
    respectGitignore,
    includes,
    minFileBytes,
    maxFileBytes,
  });
  const operations = [];
  let supported = 0;
  let unsupported = 0;

  for (const file of scan.files) {
    const style = getCommentStyle(file.filename);
    if (style) supported++;
    else unsupported++;
    if (!style && !copyUnsupported) continue;
    operations.push({
      type: style ? "comment-clean" : "unchanged-copy",
      commentStyle: style,
      sourcePath: file.sourcePath,
      sourceRelativePath: file.relativePath,
      destinationPath: path.join(scan.outputRoot, ...file.relativePath.split("/")),
      destinationRelativePath: file.relativePath,
    });
  }

  return { ...scan, operations, supported, unsupported };
}

function isLikelyBinary(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (!sample.length) return false;

  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.15;
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function prepareInventoryPlan(options = {}) {
  const scan = await scanFiles(options);
  const operations = [];
  const duplicateMap = new Map();
  for (const file of scan.files) {
    const sha256 = await hashFileSha256(file.sourcePath);
    const item = {
      type: "inventory",
      sourcePath: file.sourcePath,
      sourceRelativePath: file.relativePath,
      destinationPath: null,
      destinationRelativePath: null,
      size: file.size,
      sha256,
      commentStyle: getCommentStyle(file.filename),
    };
    operations.push(item);
    const key = `${file.size}:${sha256}`;
    if (!duplicateMap.has(key)) duplicateMap.set(key, []);
    duplicateMap.get(key).push(file.relativePath);
  }
  const duplicateGroups = [...duplicateMap.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  return {
    ...scan,
    operations,
    duplicateGroups,
    duplicateFiles: duplicateGroups.reduce((sum, group) => sum + group.length, 0),
    totalBytes: operations.reduce((sum, item) => sum + Number(item.size || 0), 0),
  };
}

async function executeOperations({
  operations,
  overwrite = true,
  dryRun = false,
  preserveLinePositions = true,
  preserveLicenseComments = true,
  commentAggressiveness = "standard",
  maxCommentFileBytes = DEFAULT_COMMENT_MAX_BYTES,
  cleanComments = false,
}) {
  const results = [];
  const maxBytes = Math.max(
    64 * 1024,
    Math.min(32 * 1024 * 1024, Number(maxCommentFileBytes) || DEFAULT_COMMENT_MAX_BYTES),
  );

  for (const op of operations) {
    const result = {
      ...op,
      status: dryRun ? "dry-run" : "pending",
      commentsRemoved: 0,
      legalCommentsPreserved: 0,
    };
    if (dryRun) {
      results.push(result);
      continue;
    }

    try {
      const exists = await fsp
        .access(op.destinationPath)
        .then(() => true)
        .catch(() => false);
      if (!overwrite && exists) {
        result.status = "skipped";
        result.reason = "destination-exists";
        results.push(result);
        continue;
      }

      await fsp.mkdir(path.dirname(op.destinationPath), { recursive: true });
      const style = getCommentStyle(path.basename(op.sourcePath));

      if (cleanComments && style) {
        const stat = await fsp.stat(op.sourcePath);
        if (stat.size > maxBytes) {
          await fsp.copyFile(op.sourcePath, op.destinationPath);
          result.commentStyle = style;
          result.reason = "comment-file-too-large-copied-unchanged";
          result.sourceBytes = stat.size;
        } else {
          const sourceBuffer = await fsp.readFile(op.sourcePath);
          if (isLikelyBinary(sourceBuffer)) {
            await fsp.copyFile(op.sourcePath, op.destinationPath);
            result.commentStyle = null;
            result.reason = "binary-detected-copied-unchanged";
          } else {
            const source = sourceBuffer.toString("utf8");
            const cleaned = stripComments(path.basename(op.sourcePath), source, {
              preserveLinePositions,
              preserveLicenseComments,
              commentAggressiveness,
            });
            await fsp.writeFile(op.destinationPath, cleaned.content, "utf8");
            result.commentsRemoved = cleaned.commentsRemoved;
            result.legalCommentsPreserved = cleaned.legalCommentsPreserved || 0;
            result.policyCommentsPreserved = cleaned.policyCommentsPreserved || 0;
            result.commentStyle = cleaned.commentStyle;
            result.commentAggressiveness = cleaned.commentAggressiveness;
            result.parserEngine = cleaned.parserEngine || null;
            result.parserFallbackReason = cleaned.parserFallbackReason || null;
            result.parserErrorsRecovered = cleaned.parserErrorsRecovered || 0;
          }
        }
      } else {
        await fsp.copyFile(op.sourcePath, op.destinationPath);
      }
      result.status = "copied";
    } catch (error) {
      result.status = "error";
      result.error = error.message;
    }
    results.push(result);
  }

  return results;
}

async function preparePipelinePlan(options) {
  const plan = await prepareLatestPlan(options);
  const copyUnsupported = options.copyUnsupported !== false;
  plan.operations = plan.operations.filter(
    (op) => copyUnsupported || getCommentStyle(path.basename(op.sourcePath)),
  );
  return plan;
}

function summarizeResults(results) {
  return {
    copied: results.filter((result) => result.status === "copied").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    errors: results.filter((result) => result.status === "error").length,
    dryRun: results.filter((result) => result.status === "dry-run").length,
    commentsRemoved: results.reduce((total, result) => total + (result.commentsRemoved || 0), 0),
    legalCommentsPreserved: results.reduce(
      (total, result) => total + (result.legalCommentsPreserved || 0),
      0,
    ),
    policyCommentsPreserved: results.reduce(
      (total, result) => total + (result.policyCommentsPreserved || 0),
      0,
    ),
    babelParsedFiles: results.filter((result) => result.parserEngine === "babel").length,
    lexicalFallbackFiles: results.filter((result) => result.parserEngine === "lexical-fallback")
      .length,
    copiedUnchangedForSafety: results.filter((result) =>
      /copied-unchanged$/.test(result.reason || ""),
    ).length,
  };
}

async function writeManifest({ outputRoot, name, kind, options, summary, results, extra = {} }) {
  const manifestPath = path.join(normalizePath(outputRoot), name);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = {
    kind,
    generatedAt: new Date().toISOString(),
    options,
    summary,
    ...extra,
    files: results.map((result) => ({
      status: result.status,
      type: result.type,
      source: result.sourceRelativePath,
      destination: result.destinationRelativePath,
      timestamp: result.timestamp || null,
      versionsFound: result.versionsFound || 1,
      commentsRemoved: result.commentsRemoved || 0,
      legalCommentsPreserved: result.legalCommentsPreserved || 0,
      policyCommentsPreserved: result.policyCommentsPreserved || 0,
      commentStyle: result.commentStyle || null,
      commentAggressiveness: result.commentAggressiveness || null,
      parserEngine: result.parserEngine || null,
      parserFallbackReason: result.parserFallbackReason || null,
      parserErrorsRecovered: result.parserErrorsRecovered || 0,
      size: result.size ?? null,
      sha256: result.sha256 || null,
      reason: result.reason || null,
      error: result.error || null,
    })),
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifestPath;
}

function directorySuggestions(rawInput, defaultPath = process.cwd(), limit = 30) {
  const value = String(rawInput || "").trim();
  if (!value) return [path.resolve(defaultPath) + path.sep];
  let expanded = value;
  if (expanded.startsWith("~")) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) expanded = expanded === "~" ? home : path.join(home, expanded.slice(2));
  }
  const absolute = path.resolve(expanded);
  const trailing = /[\\/]$/.test(expanded);
  const dir = trailing ? absolute : path.dirname(absolute);
  const partial = trailing ? "" : path.basename(absolute).toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(partial))
    .map((entry) => path.join(dir, entry.name) + path.sep)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

module.exports = {
  TIMESTAMP_PATTERN,
  DEFAULT_COMMENT_MAX_BYTES,
  parseTimestampedFilename,
  getCommentStyle,
  stripComments,
  scanFiles,
  prepareLatestPlan,
  prepareCommentPlan,
  preparePipelinePlan,
  prepareInventoryPlan,
  hashFileSha256,
  executeOperations,
  summarizeResults,
  writeManifest,
  directorySuggestions,
  isLikelyBinary,
  babelParserAvailable,
};
