"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { DesktopSettingsStore, sanitizeSettings } = require("../desktop/desktop-settings");

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-desktop-settings-"));
  try {
    assert.deepStrictEqual(sanitizeSettings({}), {
      closeToTray: true,
      launchAtLogin: false,
      notifications: true,
      remoteConnections: [],
    });
    assert.deepStrictEqual(
      sanitizeSettings({ closeToTray: false, launchAtLogin: true, notifications: false }),
      {
        closeToTray: false,
        launchAtLogin: true,
        notifications: false,
        remoteConnections: [],
      },
    );

    const store = new DesktopSettingsStore(root);
    assert.deepStrictEqual(await store.load(), {
      closeToTray: true,
      launchAtLogin: false,
      notifications: true,
      remoteConnections: [],
    });

    await store.update({
      closeToTray: false,
      launchAtLogin: true,
      notifications: false,
      remoteConnections: [
        {
          id: "workshop",
          name: "Workshop PC",
          url: "http://192.168.1.50:4310",
          rememberSession: true,
        },
      ],
    });
    const beforeFailedWrite = store.get();
    const originalFilePath = store.filePath;
    store.filePath = root;
    await assert.rejects(() => store.update({ notifications: true }));
    assert.deepStrictEqual(store.get(), beforeFailedWrite);
    store.filePath = originalFilePath;

    const reloaded = new DesktopSettingsStore(root);
    assert.deepStrictEqual(await reloaded.load(), {
      closeToTray: false,
      launchAtLogin: true,
      notifications: false,
      remoteConnections: [
        {
          id: "workshop",
          name: "Workshop PC",
          url: "http://192.168.1.50:4310",
          rememberSession: true,
        },
      ],
    });

    const mainSource = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");
    const preloadSource = fs.readFileSync(path.resolve(__dirname, "../desktop/preload.js"), "utf8");
    assert.match(mainSource, /function sendRendererCommand\(/);
    assert.match(mainSource, /event\.sender !== mainWindow\.webContents/);
    assert.match(mainSource, /event\.senderFrame\.parent !== null/);
    assert.match(mainSource, /event\.senderFrame\.origin/);
    assert.match(mainSource, /function externalHttpUrl\(/);
    assert.match(mainSource, /embedded credentials are not allowed/);
    assert.match(mainSource, /stats\.isDirectory\(\)/);
    assert.match(mainSource, /label: "Projects"/);
    assert.match(mainSource, /label: "Tools"/);
    assert.match(mainSource, /label: "Navigate"/);
    assert.match(
      mainSource,
      /PROJECT_REPOSITORY_URL = "https:\/\/github\.com\/Bacon-Fixation\/Ultimate-Project-Manager"/,
    );
    assert.match(mainSource, /KOFI_URL = "https:\/\/ko-fi\.com\/baconfixation"/);
    assert.match(mainSource, /async function showAboutDialog\(/);
    assert.match(mainSource, /async function requestElevatedRestart\(/);
    assert.match(mainSource, /releaseSingleInstanceLock/);
    assert.match(mainSource, /elevatedRelaunchSupport/);
    assert.match(mainSource, /upm:restart-elevated/);
    assert.match(preloadSource, /restartElevated/);
    assert.match(mainSource, /label: `About \${PRODUCT_NAME}`/);
    assert.match(mainSource, /label: "Support On Ko-fi"/);
    assert.match(mainSource, /accelerator: "F5"/);
    assert.match(mainSource, /accelerator: "F1"/);
    assert.match(mainSource, /autoHideMenuBar: true/);
    assert.match(mainSource, /backgroundColor: "#0b0b0f"/);
    assert.match(preloadSource, /onCommand: \(callback\) =>/);
    assert.match(preloadSource, /upm:renderer-command/);
    assert.match(preloadSource, /restartApp: \(\) => ipcRenderer\.invoke\("upm:restart-app"\)/);
    assert.match(mainSource, /ipcMain\.handle\("upm:restart-app"/);
    assert.match(mainSource, /recoverLastKnownGoodEnv/);
    assert.match(mainSource, /label: "Remote UPM"/);
    assert.match(mainSource, /async function openRemoteConnection\(/);
    assert.match(mainSource, /remoteSessionPartition\(connection\)/);
    assert.match(mainSource, /upm:remote-probe/);

    await fsp.writeFile(path.join(root, "desktop-settings.json"), "{broken", "utf8");
    const recovered = new DesktopSettingsStore(root);
    assert.deepStrictEqual(await recovered.load(), {
      closeToTray: true,
      launchAtLogin: false,
      notifications: true,
      remoteConnections: [],
    });

    console.log("desktop-settings tests passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
