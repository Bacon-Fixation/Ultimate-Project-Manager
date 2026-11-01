"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createIgnoreMatcher,
  createIncludeOverrideMatcher,
  normalizeIncludePatterns,
  readIgnoreFile,
} = require("../src/filesystem/ignore-rules");

async function main() {
  const matcher = createIgnoreMatcher({
    gitignoreText: ["dist/", "*.secret", "ignored-by-git.txt"].join("\n"),
    extraPatterns: [".env", ".env.*", "credentials.json", "logs/", "*.tmp", "!keep.tmp"],
  });

  assert.equal(matcher.ignores(".env"), true);
  assert.equal(matcher.ignores("config/.env"), true);
  assert.equal(matcher.ignores(".env.production"), true);
  assert.equal(matcher.ignores("credentials.json"), true);
  assert.equal(matcher.ignores("nested/credentials.json"), true);
  assert.equal(matcher.ignores("logs", true), true);
  assert.equal(matcher.ignores("logs/app.log"), true);
  assert.equal(matcher.ignores("temp.tmp"), true);
  assert.equal(matcher.ignores("keep.tmp"), false);
  assert.equal(matcher.ignores("dist", true), true);
  assert.equal(matcher.ignores("nested/file.secret"), true);
  assert.equal(matcher.ignores("ignored-by-git.txt"), true);
  assert.equal(matcher.ignores("src/index.js"), false);

  const includes = createIncludeOverrideMatcher([
    "dist/important.json",
    "cache/required/",
    "generated/*.json",
  ]);
  assert.equal(includes.shouldTraverse("dist"), true);
  assert.equal(includes.matches("dist/important.json"), true);
  assert.equal(includes.matches("dist/other.json"), false);
  assert.equal(includes.matches("cache/required/config.json"), true);
  assert.equal(includes.matches("generated/data.json"), true);
  assert.equal(includes.matches("generated/data.txt"), false);
  assert.deepEqual(normalizeIncludePatterns(["./dist/important.json", "!config/required/"]), [
    "dist/important.json",
    "config/required/",
  ]);
  assert.throws(() => normalizeIncludePatterns(["../outside.txt"]), /cannot traverse outside/);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-ignore-test-"));
  await fsp.writeFile(path.join(root, ".gitignore"), "cache/\n.env\n", "utf8");
  const loaded = await readIgnoreFile(root);
  assert.equal(loaded.found, true);
  assert.ok(loaded.text.includes(".env"));
  await fsp.rm(root, { recursive: true, force: true });

  console.log("Ignore rule tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
