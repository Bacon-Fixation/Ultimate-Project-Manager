"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  atomicWriteFile,
  atomicWriteJson,
  readJsonRecoverable,
} = require("../src/filesystem/atomic-file");

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-atomic-file-"));
  try {
    const jsonFile = path.join(root, "state.json");
    await atomicWriteJson(jsonFile, { version: 1, value: "first" }, { backup: true });

    const originalRename = fsp.rename;
    const originalSetTimeout = global.setTimeout;
    let blockedRenames = 0;
    fsp.rename = async (source, destination) => {
      if (destination === jsonFile && String(source).endsWith(".tmp")) {
        blockedRenames += 1;
        const error = new Error("simulated Windows destination lock");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(source, destination);
    };
    global.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
    try {
      await atomicWriteJson(jsonFile, { version: 1, value: "second" }, { backup: true });
    } finally {
      fsp.rename = originalRename;
      global.setTimeout = originalSetTimeout;
    }

    assert.ok(blockedRenames > 1, "retryable Windows replacement errors should be retried");
    assert.equal(JSON.parse(await fsp.readFile(jsonFile, "utf8")).value, "second");
    assert.equal(JSON.parse(await fsp.readFile(`${jsonFile}.bak`, "utf8")).value, "first");

    await fsp.writeFile(jsonFile, "{bad json", "utf8");
    const recovered = await readJsonRecoverable(jsonFile, null, {
      recover: true,
      validator: (value) => value?.version === 1,
    });
    assert.equal(
      recovered.value,
      "first",
      "the last-known-good backup should recover malformed JSON",
    );

    const protectedFile = path.join(root, "protected.txt");
    await fsp.writeFile(protectedFile, "keep", "utf8");
    fsp.rename = async (source, destination) => {
      if (destination === protectedFile && String(source).endsWith(".tmp")) {
        const error = new Error("simulated lock");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(source, destination);
    };
    global.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
    let blockedError = null;
    try {
      await atomicWriteFile(protectedFile, "replace", {
        backup: false,
        allowCopyFallback: false,
        retries: 1,
      });
    } catch (error) {
      blockedError = error;
    } finally {
      fsp.rename = originalRename;
      global.setTimeout = originalSetTimeout;
    }
    assert.equal(await fsp.readFile(protectedFile, "utf8"), "keep");
    assert.equal(blockedError?.code, "EPERM");
    assert.ok(
      blockedError?.recoveryTempPath,
      "failed non-destructive writes should retain a recovery temp path",
    );
    await fsp.rm(blockedError.recoveryTempPath, { force: true });

    console.log("Atomic file reliability tests passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
