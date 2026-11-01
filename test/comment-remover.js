"use strict";

const assert = require("node:assert/strict");
const { stripComments, babelParserAvailable } = require("../src/file-tools/file-tools-core");
const { classifyComment, normalizeAggressiveness } = require("../src/file-tools/comment-policy");

assert.equal(normalizeAggressiveness("SAFE"), "safe");
assert.equal(normalizeAggressiveness("not-valid"), "standard");
assert.equal(classifyComment("// TODO: revisit this"), "note");
assert.equal(classifyComment("// eslint-disable-next-line no-console"), "tooling");
assert.equal(classifyComment("/** public API docs */"), "documentation");
assert.equal(classifyComment("/*! Copyright Example */"), "legal");

assert.equal(
  babelParserAvailable(),
  true,
  "@babel/parser should be installed as a runtime dependency",
);

const source = [
  "#!/usr/bin/env node",
  "/*! Copyright Example */",
  "/** Public API documentation */",
  "// TODO: explain why this exists",
  "// eslint-disable-next-line no-console",
  'const url = "https://example.com/a//b"; // ordinary trailing comment',
  "const matcher = /https?:\\/\\/example\\.com/; /* ordinary block */",
  "console.log(url, matcher);",
  "",
].join("\n");

const safe = stripComments("app.js", source, {
  commentAggressiveness: "safe",
  preserveLicenseComments: true,
});
assert.equal(safe.parserEngine, "babel");
assert.ok(safe.content.includes("Copyright Example"));
assert.ok(safe.content.includes("Public API documentation"));
assert.ok(safe.content.includes("TODO:"));
assert.ok(safe.content.includes("eslint-disable-next-line"));
assert.ok(!safe.content.includes("ordinary trailing comment"));
assert.ok(!safe.content.includes("ordinary block"));
assert.ok(safe.content.includes("https://example.com/a//b"));
assert.ok(safe.content.includes("/https?:\\/\\/example\\.com/"));
assert.equal(safe.commentsRemoved, 2);
assert.equal(safe.legalCommentsPreserved, 1);
assert.equal(safe.policyCommentsPreserved, 3);

const standard = stripComments("app.js", source, {
  commentAggressiveness: "standard",
  preserveLicenseComments: true,
});
assert.equal(standard.parserEngine, "babel");
assert.ok(standard.content.includes("Copyright Example"));
assert.ok(!standard.content.includes("Public API documentation"));
assert.ok(!standard.content.includes("TODO:"));
assert.ok(standard.content.includes("eslint-disable-next-line"));
assert.equal(standard.policyCommentsPreserved, 1);

const aggressive = stripComments("app.js", source, {
  commentAggressiveness: "aggressive",
  preserveLicenseComments: true,
});
assert.equal(aggressive.parserEngine, "babel");
assert.ok(aggressive.content.includes("Copyright Example"));
assert.ok(!aggressive.content.includes("eslint-disable-next-line"));
assert.ok(!aggressive.content.includes("Public API documentation"));
assert.ok(!aggressive.content.includes("TODO:"));

const maximum = stripComments("app.js", source, {
  commentAggressiveness: "aggressive",
  preserveLicenseComments: false,
});
assert.equal(maximum.parserEngine, "babel");
assert.ok(!maximum.content.includes("Copyright Example"));

const tsx = stripComments(
  "component.tsx",
  [
    "type Props = { value: string };",
    "/** component docs */",
    "export const Component = ({ value }: Props) => <div>{value}</div>; // remove",
  ].join("\n"),
  {
    commentAggressiveness: "standard",
  },
);
assert.equal(tsx.parserEngine, "babel");
assert.ok(tsx.content.includes("<div>{value}</div>"));
assert.ok(!tsx.content.includes("component docs"));
assert.ok(!tsx.content.includes("// remove"));

console.log("Babel-aware comment remover tests passed.");
