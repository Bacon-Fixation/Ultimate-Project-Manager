"use strict";

const AGGRESSIVENESS_LEVELS = Object.freeze(["safe", "standard", "aggressive"]);

const LEGAL_COMMENT_RE =
  /(?:@license|@preserve|copyright|spdx-license-identifier|licensed\s+under)/i;
const TOOLING_COMMENT_RE =
  /(?:\b(?:eslint|stylelint|jshint|jslint|oxlint|biome)(?:-|\s|:)|prettier-ignore|@ts-(?:ignore|expect-error|nocheck|check)|typescript-eslint|istanbul\s+ignore|c8\s+ignore|coverage\s+ignore|deno-lint-ignore|webpack(?:chunkname|mode|prefetch|preload|exports|ignore)|@vite-ignore|[#@]__PURE__|@__NO_SIDE_EFFECTS__|sourceMappingURL|sourceURL|<reference\s|<amd-(?:module|dependency)|#?region\b|#?endregion\b)/i;
const NOTE_COMMENT_RE = /\b(?:TODO|FIXME|NOTE|HACK|XXX|BUG|SECURITY|PERF|DEPRECATED)\b/i;

function normalizeAggressiveness(value, fallback = "standard") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return AGGRESSIVENESS_LEVELS.includes(normalized) ? normalized : fallback;
}

function isLegalComment(segment) {
  const text = String(segment || "");
  return LEGAL_COMMENT_RE.test(text) || /^\s*\/\*!/.test(text) || /^\s*<!--!/.test(text);
}

function isToolingComment(segment) {
  return TOOLING_COMMENT_RE.test(String(segment || ""));
}

function isDocumentationComment(segment) {
  const text = String(segment || "").trimStart();
  return (
    /^\/\*\*/.test(text) ||
    /^\/\/\//.test(text) ||
    /^\/\/!/.test(text) ||
    /^\/\*!/.test(text) ||
    /^--\s*[|^]/.test(text) ||
    /^\{-\s*[|^]/.test(text)
  );
}

function isNoteComment(segment) {
  return NOTE_COMMENT_RE.test(String(segment || ""));
}

function classifyComment(segment) {
  if (isLegalComment(segment)) return "legal";
  if (isToolingComment(segment)) return "tooling";
  if (isDocumentationComment(segment)) return "documentation";
  if (isNoteComment(segment)) return "note";
  return "ordinary";
}

function shouldPreserveComment(segment, options = {}) {
  const category = classifyComment(segment);
  const aggressiveness = normalizeAggressiveness(options.commentAggressiveness);

  if (category === "legal") {
    return {
      preserve: options.preserveLicenseComments !== false,
      category,
      reason: options.preserveLicenseComments !== false ? "legal-comment" : null,
    };
  }

  if (aggressiveness === "safe" && ["tooling", "documentation", "note"].includes(category)) {
    return {
      preserve: true,
      category,
      reason: `${category}-comment-safe-mode`,
    };
  }

  if (aggressiveness === "standard" && category === "tooling") {
    return {
      preserve: true,
      category,
      reason: "tooling-comment-standard-mode",
    };
  }

  return { preserve: false, category, reason: null };
}

module.exports = {
  AGGRESSIVENESS_LEVELS,
  normalizeAggressiveness,
  classifyComment,
  shouldPreserveComment,
  isLegalComment,
  isToolingComment,
  isDocumentationComment,
  isNoteComment,
};
