"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test");
const requested = process.argv.slice(2).filter(Boolean);
const available = fs
  .readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => entry.name)
  .sort();
const requestedNames = new Set(
  requested.map((name) => (name.endsWith(".js") ? name : `${name}.js`)),
);
const missing = [...requestedNames].filter((name) => !available.includes(name));
const tests = requestedNames.size
  ? available.filter((name) => requestedNames.has(name))
  : available;

if (missing.length) {
  console.error(`Unknown test file(s): ${missing.join(", ")}`);
  process.exitCode = 1;
} else if (!tests.length) {
  console.error("No tests found.");
  process.exitCode = 1;
} else {
  for (const name of tests) {
    console.log(`\n> test/${name}`);
    const result = spawnSync(process.execPath, [path.join(testDir, name)], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      break;
    }
  }
}
