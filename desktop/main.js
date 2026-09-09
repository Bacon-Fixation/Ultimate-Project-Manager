"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} = require("electron");
const { createApp } = require("../src/index");
const { loadRuntimeConfig } = require("../src/config/runtime-config");
const { ensureLaunchableSessionSecret } = require("../src/config/settings-service");
const {
  markLastKnownGoodEnv,
  recoverLastKnownGoodEnv,
} = require("../src/config/settings-recovery");
const { DesktopSettingsStore } = require("./desktop-settings");

const PRODUCT_NAME = "Ultimate Project Manager";
const PROJECT_REPOSITORY_URL = "https://github.com/Bacon-Fixation/Ultimate-Project-Manager";
const KOFI_URL = "https://ko-fi.com/baconfixation";
const DESKTOP_HEADER = "X-UPM-Desktop-Token";

let mainWindow = null;
let tray = null;
let serverState = null;
let settingsStore = null;
let trayRefreshTimer = null;
let quitting = false;

function dashboardUrl(host, port) {
  const normalized = String(host || "")
    .trim()
    .toLowerCase();
  const localHost = ["0.0.0.0", "::", "[::]", ""].includes(normalized) ? "127.0.0.1" : host;
  const urlHost =
    String(localHost).includes(":") && !String(localHost).startsWith("[")
      ? `[${localHost}]`
      : localHost;
  return `http://${urlHost}:${port}`;
}

function appIconPath(rootDir) {
  return path.join(rootDir, "public", "icons", "upm-app-icon-256.png");
}

async function ensureDesktopEnv(rootDir, userDataDir) {
  const envPath = path.join(userDataDir, ".env");
  const examplePath = path.join(rootDir, ".env.example");
  try {
    await fsp.access(envPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      const example = await fsp.readFile(examplePath, "utf8");
      await fsp.mkdir(userDataDir, { recursive: true });
      await fsp.writeFile(
        envPath,
        `# Electron desktop runtime configuration.\n# Edit from Settings in Ultimate Project Manager.\n\n${example}`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (copyError) {
      if (copyError.code !== "ENOENT") throw copyError;
    }
  }
  return envPath;
}

async function startBackendOnce() {
  const rootDir = app.getAppPath();
  const userDataDir = app.getPath("userData");
  const runtimeHome = app.isPackaged ? userDataDir : rootDir;
  const dataDir = path.join(runtimeHome, "data");
  const envPath = app.isPackaged
    ? await ensureDesktopEnv(rootDir, userDataDir)
    : path.join(rootDir, ".env");
  await fsp.mkdir(dataDir, { recursive: true });

  const runtimeEnv = { ...process.env };
  let runtimeConfig = await loadRuntimeConfig({
    rootDir,
    dataDir,
    envPath,
    env: runtimeEnv,
  });
  const sessionRepair = await ensureLaunchableSessionSecret({ envPath, runtimeConfig });
  if (sessionRepair.repaired) {
    runtimeConfig = await loadRuntimeConfig({ rootDir, dataDir, envPath, env: runtimeEnv });
    console.warn(`Ultimate Project Manager: ${sessionRepair.reason}`);
  }
  const desktopAccessToken = crypto.randomBytes(32).toString("base64url");
  const services = await createApp({
    rootDir,
    dataDir,
    runtimeConfig,
    desktopAccessToken,
  });

  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = services.app.listen(runtimeConfig.port, runtimeConfig.host, () =>
        resolve(listener),
      );
      listener.once("error", reject);
    });
  } catch (error) {
    await Promise.allSettled([services.hostStats?.shutdown?.(), services.manager?.shutdown?.()]);
    services.dockerRuntime?.stop?.();
    throw error;
  }
  server.requestTimeout = runtimeConfig.requestTimeoutMs;
  server.keepAliveTimeout = runtimeConfig.keepAliveTimeoutMs;
  server.headersTimeout = Math.max(
    runtimeConfig.headersTimeoutMs,
    runtimeConfig.keepAliveTimeoutMs + 1000,
  );

  const url = dashboardUrl(runtimeConfig.host, runtimeConfig.port);
  return {
    ...services,
    server,
    url,
    rootDir,
    dataDir,
    envPath,
    desktopAccessToken,
  };
}

async function startBackend() {
  try {
    const state = await startBackendOnce();
    await markLastKnownGoodEnv(state.envPath).catch((error) =>
      console.warn(
        `Ultimate Project Manager: unable to update last-known-good settings: ${error.message}`,
      ),
    );
    return state;
  } catch (error) {
    const rootDir = app.getAppPath();
    const envPath = app.isPackaged
      ? path.join(app.getPath("userData"), ".env")
      : path.join(rootDir, ".env");
    const recovery = await recoverLastKnownGoodEnv(envPath, { reason: error.message }).catch(
      () => ({
        recovered: false,
      }),
    );
    if (!recovery.recovered) throw error;

    console.error(
      `Ultimate Project Manager: saved settings failed during startup; restored last-known-good configuration from ${recovery.lastKnownGoodPath}.`,
    );
    if (recovery.failedSettingsPath)
      console.error(
        `Ultimate Project Manager: failed settings preserved at ${recovery.failedSettingsPath}.`,
      );

    const state = await startBackendOnce();
    state.settingsRecovery = recovery;
    await markLastKnownGoodEnv(state.envPath).catch(() => {});
    return state;
  }
}

function installDesktopRequestHeader(targetSession) {
  const filter = { urls: [`${serverState.url}/*`] };
  targetSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders[DESKTOP_HEADER] = serverState.desktopAccessToken;
    callback({ requestHeaders: details.requestHeaders });
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function trustedIpcSender(event) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (event.sender !== mainWindow.webContents) return false;
    if (!event.senderFrame || event.senderFrame.parent !== null) return false;
    return event.senderFrame.origin === new URL(serverState.url).origin;
  } catch {
    return false;
  }
}

function requireTrustedIpcSender(event) {
  if (!trustedIpcSender(event)) throw new Error("Desktop IPC request was rejected.");
}

function externalHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 4096) throw new Error("External URL is invalid or too long.");
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Only HTTP(S) links may be opened.");
  if (parsed.username || parsed.password)
    throw new Error("External links containing embedded credentials are not allowed.");
  return parsed.toString();
}

function openExternalHttp(value) {
  return shell.openExternal(externalHttpUrl(value));
}

function launchAtLoginSupported() {
  return app.isPackaged && ["win32", "darwin"].includes(process.platform);
}

function applyLaunchAtLogin(enabled) {
  if (!launchAtLoginSupported()) return;
  const options = { openAtLogin: enabled };
  if (process.platform === "win32") {
    options.path = process.execPath;
    options.args = [];
  }
  app.setLoginItemSettings(options);
}

async function updateDesktopSetting(patch) {
  const settings = await settingsStore.update(patch);
  if (Object.prototype.hasOwnProperty.call(patch, "launchAtLogin"))
    applyLaunchAtLogin(settings.launchAtLogin);
  rebuildTrayMenu();
  if (serverState) createApplicationMenu();
  return { ...settings, packaged: app.isPackaged, platform: process.platform };
}

function trayIcon() {
  const image = nativeImage.createFromPath(appIconPath(serverState.rootDir));
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 20, height: 20 });
}

function traySummary() {
  if (!serverState?.manager) return { projects: 0, pm2: "Unavailable", docker: "Unknown" };
  const projects = serverState.manager.getProjects().length;
  const pm2 = serverState.manager.getPm2Status();
  const pm2Label = pm2.available
    ? `${pm2.online || 0}/${pm2.processCount || 0} Online`
    : "Unavailable";
  const docker = serverState.dockerRuntime?.getCurrent?.() || {};
  const dockerLabel = docker.daemonReady
    ? "Ready"
    : docker.state === "starting"
      ? "Starting"
      : docker.state === "not-installed"
        ? "Not Installed"
        : "Stopped";
  return { projects, pm2: pm2Label, docker: dockerLabel };
}

function rebuildTrayMenu() {
  if (!tray || !settingsStore) return;
  const settings = settingsStore.get();
  const summary = traySummary();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Projects: ${summary.projects}`, enabled: false },
      { label: `PM2: ${summary.pm2}`, enabled: false },
      { label: `Docker: ${summary.docker}`, enabled: false },
      { type: "separator" },
      { label: "Open Dashboard", click: showMainWindow },
      {
        label: "Open Dashboard In Browser",
        click: () => openExternalHttp(serverState.url).catch(console.error),
      },
      { type: "separator" },
      {
        label: "Launch At Login",
        type: "checkbox",
        checked: settings.launchAtLogin,
        enabled: launchAtLoginSupported(),
        click: (item) => updateDesktopSetting({ launchAtLogin: item.checked }),
      },
      {
        label: "Close To Tray",
        type: "checkbox",
        checked: settings.closeToTray,
        click: (item) => updateDesktopSetting({ closeToTray: item.checked }),
      },
      {
        label: "Desktop Notifications",
        type: "checkbox",
        checked: settings.notifications,
        click: (item) => updateDesktopSetting({ notifications: item.checked }),
      },
      { type: "separator" },
      {
        label: "Quit Ultimate Project Manager",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(PRODUCT_NAME);
  tray.on("double-click", showMainWindow);
  rebuildTrayMenu();
  trayRefreshTimer = setInterval(rebuildTrayMenu, 10_000);
  trayRefreshTimer.unref?.();
}

function sendRendererCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showMainWindow();
  mainWindow.webContents.send("upm:renderer-command", String(command || ""));
}

async function showAboutDialog() {
  const detail = [
    `Version ${app.getVersion()}`,
    "Desktop project operations, backups, monitoring, recovery, and file tools.",
    "",
    "Created by Bacon Fixation",
    PROJECT_REPOSITORY_URL,
    KOFI_URL,
    "",
    `Electron ${process.versions.electron} · Node ${process.versions.node}`,
  ].join("\n");
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: `About ${PRODUCT_NAME}`,
    message: PRODUCT_NAME,
    detail,
    buttons: ["Close", "Open Repository", "Support on Ko-fi"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response === 1) await openExternalHttp(PROJECT_REPOSITORY_URL);
  if (result.response === 2) await openExternalHttp(KOFI_URL);
}

function createApplicationMenu() {
  const settings = settingsStore.get();
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Dashboard In Browser",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => openExternalHttp(serverState.url).catch(console.error),
        },
        {
          label: "Open Data Folder",
          click: () => shell.openPath(serverState.dataDir),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Projects",
      submenu: [
        {
          label: "Refresh Dashboard",
          accelerator: "F5",
          click: () => sendRendererCommand("refresh"),
        },
        {
          label: "Backup All",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => sendRendererCommand("backup-all"),
        },
        { type: "separator" },
        { label: "Add Project", click: () => sendRendererCommand("add-project") },
        { label: "Discover Projects", click: () => sendRendererCommand("discover") },
      ],
    },
    {
      label: "Tools",
      submenu: [
        { label: "File Tools", click: () => sendRendererCommand("file-tools") },
        { label: "Diagnostics", click: () => sendRendererCommand("diagnostics") },
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => sendRendererCommand("settings"),
        },
      ],
    },
    {
      label: "Navigate",
      submenu: [
        { label: "Projects", click: () => sendRendererCommand("projects") },
        { label: "Overview", click: () => sendRendererCommand("overview") },
        { label: "Storage", click: () => sendRendererCommand("storage") },
        { label: "Activity", click: () => sendRendererCommand("activity") },
        { label: "Help", accelerator: "F1", click: () => sendRendererCommand("help") },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Desktop",
      submenu: [
        {
          label: "Launch At Login",
          type: "checkbox",
          checked: settings.launchAtLogin,
          enabled: launchAtLoginSupported(),
          click: (item) => updateDesktopSetting({ launchAtLogin: item.checked }),
        },
        {
          label: "Close To Tray",
          type: "checkbox",
          checked: settings.closeToTray,
          click: (item) => updateDesktopSetting({ closeToTray: item.checked }),
        },
        {
          label: "Desktop Notifications",
          type: "checkbox",
          checked: settings.notifications,
          click: (item) => updateDesktopSetting({ notifications: item.checked }),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Help & Tips", click: () => sendRendererCommand("help") },
        { type: "separator" },
        {
          label: "Ultimate Project Manager On GitHub",
          click: () => openExternalHttp(PROJECT_REPOSITORY_URL).catch(console.error),
        },
        {
          label: "Support On Ko-fi",
          click: () => openExternalHttp(KOFI_URL).catch(console.error),
        },
        { type: "separator" },
        {
          label: `About ${PRODUCT_NAME}`,
          click: () => showAboutDialog().catch(console.error),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers() {
  ipcMain.handle("upm:select-directory", async (event, options = {}) => {
    requireTrustedIpcSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: String(options.title || "Choose Folder"),
      defaultPath: String(options.defaultPath || "") || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("upm:open-path", async (event, targetPath) => {
    requireTrustedIpcSender(event);
    const value = String(targetPath || "").trim();
    if (!value) throw new Error("A path is required.");
    const stats = await fsp.stat(value);
    if (!stats.isDirectory()) throw new Error("Only directories may be opened from the dashboard.");
    const error = await shell.openPath(value);
    if (error) throw new Error(error);
    return { ok: true };
  });
  ipcMain.handle("upm:show-item-in-folder", (event, targetPath) => {
    requireTrustedIpcSender(event);
    const value = String(targetPath || "").trim();
    if (!value) throw new Error("A path is required.");
    shell.showItemInFolder(value);
    return { ok: true };
  });
  ipcMain.handle("upm:open-external", async (event, url) => {
    requireTrustedIpcSender(event);
    await openExternalHttp(url);
    return { ok: true };
  });
  ipcMain.handle("upm:get-desktop-settings", (event) => {
    requireTrustedIpcSender(event);
    return {
      ...settingsStore.get(),
      packaged: app.isPackaged,
      platform: process.platform,
      dataDir: serverState.dataDir,
      envPath: serverState.envPath,
      dashboardUrl: serverState.url,
    };
  });
  ipcMain.handle("upm:set-launch-at-login", (event, enabled) => {
    requireTrustedIpcSender(event);
    return updateDesktopSetting({ launchAtLogin: enabled === true });
  });
  ipcMain.handle("upm:set-close-to-tray", (event, enabled) => {
    requireTrustedIpcSender(event);
    return updateDesktopSetting({ closeToTray: enabled === true });
  });
  ipcMain.handle("upm:set-notifications", (event, enabled) => {
    requireTrustedIpcSender(event);
    return updateDesktopSetting({ notifications: enabled === true });
  });
  ipcMain.handle("upm:show-notification", (event, options = {}) => {
    requireTrustedIpcSender(event);
    if (!settingsStore.get().notifications || !Notification.isSupported()) return { shown: false };
    const notification = new Notification({
      title: String(options.title || PRODUCT_NAME).slice(0, 120),
      body: String(options.body || "").slice(0, 1000),
      silent: options.silent === true,
    });
    notification.on("click", showMainWindow);
    notification.show();
    return { shown: true };
  });
  ipcMain.handle("upm:restart-app", (event) => {
    requireTrustedIpcSender(event);
    setImmediate(() => {
      quitting = true;
      app.relaunch();
      app.quit();
    });
    return { restarting: true };
  });
  ipcMain.handle("upm:show-window", (event) => {
    requireTrustedIpcSender(event);
    showMainWindow();
    return { ok: true };
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1480,
    height: 940,
    minWidth: 920,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0f",
    icon: appIconPath(serverState.rootDir),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  installDesktopRequestHeader(mainWindow.webContents.session);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        openExternalHttp(parsed.toString()).catch(console.error);
    } catch {}
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === new URL(serverState.url).origin) return;
    } catch {}
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        openExternalHttp(parsed.toString()).catch(console.error);
    } catch {}
  });
  mainWindow.on("close", (event) => {
    if (quitting || !settingsStore.get().closeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("ready-to-show", () => mainWindow.show());
  await mainWindow.loadURL(serverState.url);
}

async function shutdownBackend() {
  if (trayRefreshTimer) clearInterval(trayRefreshTimer);
  trayRefreshTimer = null;
  if (!serverState) return;
  await Promise.allSettled([
    serverState.hostStats?.shutdown?.(),
    serverState.manager?.shutdown?.(),
  ]);
  serverState.dockerRuntime?.stop?.();
  await new Promise((resolve) => {
    if (!serverState.server?.listening) return resolve();
    serverState.server.close(() => resolve());
  });
  serverState = null;
}

function enableActivityNotifications() {
  serverState.manager.on("activity", (entry) => {
    if (!settingsStore.get().notifications || !Notification.isSupported()) return;
    const importantSuccess =
      entry.level === "success" &&
      ["backup", "remote-backup", "restore"].includes(String(entry.operation || ""));
    if (!["warning", "error"].includes(entry.level) && !importantSuccess) return;
    if (mainWindow?.isVisible() && mainWindow?.isFocused() && entry.level !== "error") return;

    const bodyParts = [];
    if (entry.backupFile) bodyParts.push(entry.backupFile);
    if (entry.error) bodyParts.push(String(entry.error));
    const notification = new Notification({
      title: entry.level === "error" ? `${PRODUCT_NAME} - Error` : PRODUCT_NAME,
      body: [entry.message, ...bodyParts].filter(Boolean).join("\n").slice(0, 1000),
    });
    notification.on("click", showMainWindow);
    notification.show();
  });
}

async function bootstrap() {
  app.setName(PRODUCT_NAME);
  settingsStore = new DesktopSettingsStore(app.getPath("userData"));
  await settingsStore.load();
  applyLaunchAtLogin(settingsStore.get().launchAtLogin);
  serverState = await startBackend();
  enableActivityNotifications();
  registerIpcHandlers();
  await createMainWindow();
  if (serverState.settingsRecovery?.recovered) {
    dialog
      .showMessageBox(mainWindow, {
        type: "warning",
        title: `${PRODUCT_NAME} Settings Recovered`,
        message:
          "UPM restored the last-known-good settings after the most recently saved settings failed during startup.",
        detail: serverState.settingsRecovery.failedSettingsPath
          ? `The failed settings were preserved at:
${serverState.settingsRecovery.failedSettingsPath}`
          : "The previous known-good settings are active again.",
        buttons: ["OK"],
        noLink: true,
      })
      .catch(() => {});
  }
  createTray();
  createApplicationMenu();
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      console.error(`${PRODUCT_NAME} desktop failed:`, error);
      dialog.showErrorBox(
        `${PRODUCT_NAME} failed to start`,
        error.stack || error.message || String(error),
      );
      app.quit();
    });
}

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !settingsStore?.get().closeToTray) app.quit();
});

app.on("will-quit", (event) => {
  if (!serverState) return;
  event.preventDefault();
  shutdownBackend()
    .catch((error) => console.error("Unable to cleanly stop the UPM backend:", error))
    .finally(() => {
      serverState = null;
      app.quit();
    });
});
