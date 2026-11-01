"use strict";

const assert = require("node:assert/strict");
const { buildLineDiff } = require("../src/diff/line-diff");

const result = buildLineDiff("alpha\nbeta\ngamma", "alpha\nbeta changed\ngamma\ndelta");
assert.equal(result.detailed, true);
assert.equal(result.counts.added, 2);
assert.equal(result.counts.deleted, 1);
assert.ok(result.lines.some((line) => line.type === "added" && line.text === "beta changed"));
assert.ok(result.lines.some((line) => line.type === "deleted" && line.text === "beta"));
assert.ok(result.lines.some((line) => line.type === "added" && line.text === "delta"));

const bounded = buildLineDiff("a\nb\nc", "x\ny\nz", { maxCells: 10_000 });
assert.equal(bounded.detailed, true);

const tooLarge = buildLineDiff(Array(120).fill("x").join("\n"), Array(120).fill("y").join("\n"), {
  maxCells: 10_000,
});
assert.equal(tooLarge.detailed, false);
assert.equal(tooLarge.reason, "diff-too-large");

console.log("Line diff tests passed.");
