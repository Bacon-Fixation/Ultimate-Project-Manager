"use strict";

const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  ensureLastKnownGoodEnv,
  markSettingsPending,
  markLastKnownGoodEnv,
  pendingSettingsState,
  recoverLastKnownGoodEnv,
} = require("../src/config/settings-recovery");

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-settings-recovery-"));
  try {
    const envPath = path.join(root, ".env");
    await fsp.writeFile(envPath, "UPM_PORT=4310\nUPM_HOST=127.0.0.1\n", "utf8");

    const seeded = await ensureLastKnownGoodEnv(envPath);
    assert.equal(seeded.created, true);
    assert.equal(
      await fsp.readFile(seeded.lastKnownGoodPath, "utf8"),
      await fsp.readFile(envPath, "utf8"),
    );

    await fsp.writeFile(envPath, "UPM_PORT=6553\nUPM_HOST=bad-host.example\n", "utf8");
    await markSettingsPending(envPath, { changed: ["host", "port"] });
    const pending = await pendingSettingsState(envPath);
    assert.equal(pending.pending, true);
    assert.equal(pending.markerMatchesCurrent, true);
    assert.deepEqual(pending.changed, ["host", "port"]);

    const recovered = await recoverLastKnownGoodEnv(envPath, {
      reason: "simulated startup failure",
    });
    assert.equal(recovered.recovered, true);
    assert.match(recovered.failedSettingsPath, /\.failed-settings-/);
    assert.equal(await fsp.readFile(envPath, "utf8"), "UPM_PORT=4310\nUPM_HOST=127.0.0.1\n");
    assert.equal(
      await fsp.readFile(recovered.failedSettingsPath, "utf8"),
      "UPM_PORT=6553\nUPM_HOST=bad-host.example\n",
    );
    assert.equal((await pendingSettingsState(envPath)).pending, false);

    await fsp.writeFile(envPath, "UPM_PORT=4400\n", "utf8");
    await markSettingsPending(envPath, { changed: ["port"] });
    const marked = await markLastKnownGoodEnv(envPath);
    assert.equal(marked.marked, true);
    assert.equal(await fsp.readFile(marked.lastKnownGoodPath, "utf8"), "UPM_PORT=4400\n");
    assert.equal((await pendingSettingsState(envPath)).pending, false);

    console.log("Settings recovery tests passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
