"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  canonicalPath,
  isPathInside,
  isCanonicalPathInside,
  assertCanonicalPathInside,
} = require("../src/filesystem/path-boundary");

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-path-boundary-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await fsp.mkdir(allowed, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });

  try {
    assert.strictEqual(isPathInside(allowed, allowed), true);
    assert.strictEqual(isPathInside(allowed, allowed, { allowEqual: false }), false);
    assert.strictEqual(isPathInside(allowed, path.join(allowed, "child")), true);
    assert.strictEqual(isPathInside(allowed, outside), false);

    assert.strictEqual(
      await isCanonicalPathInside(allowed, path.join(allowed, "missing", "file")),
      true,
    );
    assert.strictEqual(await isCanonicalPathInside(allowed, path.join(outside, "file")), false);
    assert.strictEqual(
      await assertCanonicalPathInside([allowed], path.join(allowed, "missing", "file")),
      await canonicalPath(path.join(allowed, "missing", "file")),
    );

    const link = path.join(allowed, "escape-link");
    try {
      await fsp.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      assert.strictEqual(
        await isCanonicalPathInside(allowed, path.join(link, "secret.txt")),
        false,
      );
      await assert.rejects(
        () => assertCanonicalPathInside([allowed], path.join(link, "secret.txt"), "Candidate"),
        /Candidate is outside the configured allowed roots/,
      );
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    }

    console.log("path-boundary tests passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
