"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const {
  LocalDirectoryBrowser,
  assertAbsoluteDirectoryPath,
} = require("../src/filesystem/local-directory-browser");

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-manager-browser-"));
  const root = path.join(temp, "root with spaces");
  await fsp.mkdir(path.join(root, "alpha"), { recursive: true });
  await fsp.mkdir(path.join(root, "Beta"), { recursive: true });
  await fsp.mkdir(path.join(root, ".hidden"), { recursive: true });
  await fsp.writeFile(path.join(root, "file.txt"), "not a directory", "utf8");

  const browser = new LocalDirectoryBrowser({
    rootDir: temp,
    backupRoot: root,
    restoreRoot: temp,
  });
  const hiddenOff = await browser.browse(root);
  assert.deepStrictEqual(
    hiddenOff.directories.map((item) => item.name),
    ["alpha", "Beta"],
  );
  assert(!hiddenOff.directories.some((item) => item.name === "file.txt"));
  assert(!hiddenOff.directories.some((item) => item.name === ".hidden"));

  const hiddenOn = await browser.browse(root, { showHidden: true });
  assert(hiddenOn.directories.some((item) => item.name === ".hidden"));

  const created = await browser.createDirectory(root, "new destination");
  assert.strictEqual(created.path, path.join(root, "new destination"));
  assert((await fsp.stat(created.path)).isDirectory());

  await assert.rejects(() => browser.createDirectory(root, "../escape"), /path separators/i);
  assert.throws(() => assertAbsoluteDirectoryPath("relative/path"), /absolute/i);

  const rootView = await browser.browse(null);
  assert.strictEqual(rootView.currentPath, null);
  assert(Array.isArray(rootView.roots));

  await fsp.rm(temp, { recursive: true, force: true });
  console.log("Local directory browser tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
