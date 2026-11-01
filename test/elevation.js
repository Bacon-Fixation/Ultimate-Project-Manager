"use strict";

const assert = require("node:assert/strict");
const {
  checkProcessElevation,
  createElevationChecker,
  elevatedRelaunchSupport,
} = require("../src/security/elevation");

async function main() {
  const unixRoot = await checkProcessElevation({ platform: "linux", getuid: () => 0 });
  assert.equal(unixRoot.elevated, true);
  assert.equal(unixRoot.level, "root");

  const unixUser = await checkProcessElevation({ platform: "linux", getuid: () => 1000 });
  assert.equal(unixUser.elevated, false);
  assert.equal(unixUser.level, "standard");

  const windowsAdmin = await checkProcessElevation({
    platform: "win32",
    env: {},
    execFileAsync: async () => ({ stdout: "elevated\r\n", stderr: "" }),
  });
  assert.equal(windowsAdmin.elevated, true);
  assert.equal(windowsAdmin.level, "administrator");

  let checks = 0;
  const cached = createElevationChecker({
    platform: "win32",
    cacheMs: 60_000,
    env: {},
    execFileAsync: async () => {
      checks += 1;
      return { stdout: "standard", stderr: "" };
    },
  });
  await cached();
  await cached();
  assert.equal(checks, 1);
  await cached(true);
  assert.equal(checks, 2);

  assert.equal(elevatedRelaunchSupport({ platform: "win32", packaged: true }).supported, true);
  assert.equal(elevatedRelaunchSupport({ platform: "darwin", packaged: true }).supported, true);
  assert.equal(elevatedRelaunchSupport({ platform: "linux", packaged: true }).supported, false);
  assert.match(
    elevatedRelaunchSupport({ platform: "linux", packaged: true }).reason,
    /Chromium sandboxing/,
  );
  assert.equal(elevatedRelaunchSupport({ platform: "win32", packaged: false }).supported, false);

  console.log("Elevation policy tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
