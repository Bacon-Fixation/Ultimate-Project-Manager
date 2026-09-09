"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "desktop", "public", "scripts", "build", "test"];
const ROOT_FILES = ["ecosystem.config.js", "ecosystem.agent.config.js", "eslint.config.js"];
const EXTENSIONS = new Set([".js", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "data",
  "coverage",
  "release",
  "release-slim",
  "release-web",
  "dist",
]);

function collect(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, output);
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(full);
  }
  return output;
}

const files = [];
for (const dir of SCAN_DIRS) collect(path.join(ROOT, dir), files);
for (const file of ROOT_FILES) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) files.push(full);
}

const unique = [...new Set(files)].sort();
if (!unique.length) throw new Error("No JavaScript files were found for syntax checking.");

for (const file of unique) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    process.stderr.write(`Syntax check failed: ${path.relative(ROOT, file)}\n`);
    if (error.stdout) process.stderr.write(String(error.stdout));
    if (error.stderr) process.stderr.write(String(error.stderr));
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log(`JavaScript syntax check passed (${unique.length} files).`);
