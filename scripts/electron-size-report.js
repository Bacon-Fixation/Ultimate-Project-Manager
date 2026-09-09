"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const targets = ["release", "release-slim", "release-web"];

function bytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let number = Number(value || 0);
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024;
    unit += 1;
  }
  return `${number.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function walk(dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...walk(full));
    else if (entry.isFile()) rows.push({ path: full, size: fs.statSync(full).size });
  }
  return rows;
}

let found = false;
for (const target of targets) {
  const dir = path.join(root, target);
  const rows = walk(dir);
  if (!rows.length) continue;
  found = true;
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  console.log(`\n${target}: ${bytes(total)} across ${rows.length} files`);
  for (const row of [...rows].sort((a, b) => b.size - a.size).slice(0, 12)) {
    console.log(`  ${bytes(row.size).padStart(10)}  ${path.relative(dir, row.path)}`);
  }
}

if (!found) {
  console.log(
    "No Electron build output found. Build standard or slim first, then rerun npm run desktop:size.",
  );
}
