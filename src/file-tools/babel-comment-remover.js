"use strict";

const path = require("node:path");
const { normalizeAggressiveness, shouldPreserveComment } = require("./comment-policy");

const BABEL_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

let cachedParser;
let parserLoadAttempted = false;

function loadBabelParser() {
  if (parserLoadAttempted) return cachedParser;
  parserLoadAttempted = true;
  try {
    cachedParser = require("@babel/parser");
  } catch {
    cachedParser = null;
  }
  return cachedParser;
}

function isBabelCommentFile(filename) {
  return BABEL_EXTENSIONS.has(path.extname(String(filename || "")).toLowerCase());
}

function parserPluginsFor(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  const plugins = ["decorators-legacy"];
  if ([".js", ".cjs", ".mjs", ".jsx", ".tsx"].includes(ext)) plugins.push("jsx");
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) plugins.push("typescript");
  return plugins;
}

function parseComments(filename, source) {
  const parser = loadBabelParser();
  if (!parser) {
    return {
      ok: false,
      parserAvailable: false,
      error: "The @babel/parser dependency is not installed.",
      comments: [],
    };
  }

  try {
    const ast = parser.parse(source, {
      sourceType: "unambiguous",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      ranges: true,
      tokens: false,
      plugins: parserPluginsFor(filename),
    });
    return {
      ok: true,
      parserAvailable: true,
      errors: (ast.errors || []).map((error) => error.message),
      comments: (ast.comments || [])
        .filter((comment) => Number.isInteger(comment.start) && Number.isInteger(comment.end))
        .map((comment) => ({
          start: comment.start,
          end: comment.end,
          type: comment.type,
        }))
        .sort((a, b) => a.start - b.start),
    };
  } catch (error) {
    return {
      ok: false,
      parserAvailable: true,
      error: error.message,
      comments: [],
    };
  }
}

function preserveRemovedSegment(segment, keepLines) {
  return keepLines ? String(segment).replace(/[^\r\n]/g, "") : "";
}

function stripWithBabel(filename, source, options = {}) {
  if (!isBabelCommentFile(filename)) {
    return { supported: false, reason: "not-a-babel-comment-file" };
  }

  const parsed = parseComments(filename, source);
  if (!parsed.ok) {
    return {
      supported: true,
      ok: false,
      parserAvailable: parsed.parserAvailable,
      parserEngine: parsed.parserAvailable ? "babel-fallback" : "lexical-fallback",
      fallbackReason: parsed.error,
    };
  }

  const normalizedOptions = {
    preserveLinePositions: options.preserveLinePositions !== false,
    preserveLicenseComments: options.preserveLicenseComments !== false,
    commentAggressiveness: normalizeAggressiveness(options.commentAggressiveness),
  };

  let cursor = 0;
  let output = "";
  let commentsRemoved = 0;
  let legalCommentsPreserved = 0;
  let policyCommentsPreserved = 0;
  const preservedByCategory = {};
  const removedByCategory = {};

  for (const comment of parsed.comments) {
    if (comment.start < cursor || comment.end < comment.start) continue;
    output += source.slice(cursor, comment.start);
    const segment = source.slice(comment.start, comment.end);
    const decision = shouldPreserveComment(segment, normalizedOptions);

    if (decision.preserve) {
      output += segment;
      if (decision.category === "legal") legalCommentsPreserved += 1;
      else policyCommentsPreserved += 1;
      preservedByCategory[decision.category] = (preservedByCategory[decision.category] || 0) + 1;
    } else {
      output += preserveRemovedSegment(segment, normalizedOptions.preserveLinePositions);
      commentsRemoved += 1;
      removedByCategory[decision.category] = (removedByCategory[decision.category] || 0) + 1;
    }
    cursor = comment.end;
  }

  output += source.slice(cursor);

  return {
    supported: true,
    ok: true,
    content: output,
    commentsRemoved,
    legalCommentsPreserved,
    policyCommentsPreserved,
    commentsExamined: parsed.comments.length,
    preservedByCategory,
    removedByCategory,
    parserEngine: "babel",
    parserErrorsRecovered: parsed.errors?.length || 0,
    parserWarnings: parsed.errors || [],
    commentAggressiveness: normalizedOptions.commentAggressiveness,
  };
}

function babelParserAvailable() {
  return Boolean(loadBabelParser());
}

module.exports = {
  BABEL_EXTENSIONS,
  isBabelCommentFile,
  parserPluginsFor,
  stripWithBabel,
  babelParserAvailable,
};
