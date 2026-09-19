"use strict";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  session,
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
const {
  MAX_CONNECTIONS,
  normalizeRemoteConnection,
  remoteSessionPartition,
  sameRemoteOrigin,
} = require("./remote-connections");
const {
  createElevationChecker,
  elevatedRelaunchSupport,
  relaunchElevated,
} = require("../src/security/elevation");

const PRODUCT_NAME = "Ultimate Project Manager";
const PROJECT_REPOSITORY_URL = "https://github.com/Bacon-Fixation/Ultimate-Project-Manager";
const KOFI_URL = "https://ko-fi.com/baconfixation";
const DESKTOP_HEADER = "X-UPM-Desktop-Token";
const LOCAL_DASHBOARD_PARTITION = "upm-local-dashboard";
const REMOTE_MANAGER_PARTITION = "upm-remote-manager";

let mainWindow = null;
let remoteManagerWindow = null;
const remoteWindows = new Map();
let tray = null;
let serverState = null;
let settingsStore = null;
let trayRefreshTimer = null;
let quitting = false;
let desktopElevationStatus = null;
const elevationChecker = createElevationChecker();

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

function remoteConnections() {
  return settingsStore?.get().remoteConnections || [];
}

function remoteConnectionById(id) {
  const value = String(id || "").trim();
  return remoteConnections().find((connection) => connection.id === value) || null;
}

function requireRemoteConnection(id) {
  const connection = remoteConnectionById(id);
  if (!connection) throw new Error("The selected Remote UPM connection no longer exists.");
  return connection;
}

function trustedRemoteManagerSender(event) {
  if (!remoteManagerWindow || remoteManagerWindow.isDestroyed()) return false;
  if (event.sender !== remoteManagerWindow.webContents) return false;
  if (!event.senderFrame || event.senderFrame.parent !== null) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    const expected = pathToFileURL(path.join(__dirname, "remote-connect.html"));
    return senderUrl.href === expected.href;
  } catch {
    return false;
  }
}

function requireRemoteManagerSender(event) {
  if (!trustedRemoteManagerSender(event))
    throw new Error("Remote UPM manager request was rejected.");
}

async function clearRemoteSession(connection) {
  try {
    const partition = remoteSessionPartition(connection);
    await session.fromPartition(partition).clearStorageData();
  } catch (error) {
    console.warn(`Ultimate Project Manager: unable to clear Remote UPM session: ${error.message}`);
  }
}

async function saveRemoteConnection(input = {}) {
  const next = normalizeRemoteConnection(input);
  const connections = remoteConnections();
  const duplicate = connections.find(
    (connection) =>
      connection.id !== next.id && connection.url.toLowerCase() === next.url.toLowerCase(),
  );
  if (duplicate) throw new Error(`A Remote UPM connection for ${duplicate.url} already exists.`);

  const index = connections.findIndex((connection) => connection.id === next.id);
  const previous = index >= 0 ? connections[index] : null;
  if (index >= 0) connections[index] = next;
  else {
    if (connections.length >= MAX_CONNECTIONS)
      throw new Error(`Remote UPM supports up to ${MAX_CONNECTIONS} saved connections.`);
    connections.push(next);
  }

  if (
    previous &&
    (previous.url !== next.url || remoteSessionPartition(previous) !== remoteSessionPartition(next))
  ) {
    await clearRemoteSession(previous);
  }

  const settings = await settingsStore.update({ remoteConnections: connections });
  rebuildTrayMenu();
  createApplicationMenu();
  return { connection: next, connections: settings.remoteConnections };
}

async function removeRemoteConnection(id) {
  const connection = requireRemoteConnection(id);
  const existingWindow = remoteWindows.get(connection.id);
  if (existingWindow && !existingWindow.isDestroyed()) existingWindow.close();
  remoteWindows.delete(connection.id);
  await clearRemoteSession(connection);
  const settings = await settingsStore.update({
    remoteConnections: remoteConnections().filter((item) => item.id !== connection.id),
  });
  rebuildTrayMenu();
  createApplicationMenu();
  return settings.remoteConnections;
}

async function probeRemoteConnection(input = {}) {
  const connection = normalizeRemoteConnection(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  timeout.unref?.();
  let response;
  try {
    response = await net.fetch(`${connection.url}/api/auth/status`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Timed out connecting to ${connection.url}.`);
    throw new Error(`Unable to connect to ${connection.url}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    if (response.status === 403)
      throw new Error(
        "The server is reachable, but Remote Dashboard access is disabled on that UPM host.",
      );
    throw new Error(payload?.error || `Remote UPM returned HTTP ${response.status}.`);
  }
  if (!payload || typeof payload.auth !== "object")
    throw new Error(
      "The server responded, but it does not appear to be a compatible UPM dashboard.",
    );

  return {
    ok: true,
    url: connection.url,
    authEnabled: payload.auth.enabled === true,
    authenticated: payload.auth.authenticated === true,
    secure: connection.url.startsWith("https://"),
  };
}

function remoteWindowTitle(connection) {
  return `${connection.name} - Remote UPM`;
}

async function openRemoteConnection(id) {
  const connection = requireRemoteConnection(id);
  const existing = remoteWindows.get(connection.id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { opened: true, reused: true, id: connection.id };
  }

  const remoteWindow = new BrowserWindow({
    title: remoteWindowTitle(connection),
    width: 1480,
    height: 940,
    minWidth: 920,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0f",
    icon: appIconPath(serverState.rootDir),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: remoteSessionPartition(connection),
    },
  });
  remoteWindows.set(connection.id, remoteWindow);
  remoteWindow.removeMenu();

  remoteWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        openExternalHttp(parsed.toString()).catch(console.error);
    } catch {}
    return { action: "deny" };
  });
  const guardRemoteNavigation = (event, url) => {
    if (sameRemoteOrigin(connection, url)) return;
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        openExternalHttp(parsed.toString()).catch(console.error);
    } catch {}
  };
  remoteWindow.webContents.on("will-navigate", guardRemoteNavigation);
  remoteWindow.webContents.on("will-redirect", guardRemoteNavigation);
  remoteWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    remoteWindow.setTitle(remoteWindowTitle(connection));
  });
  remoteWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      dialog
        .showMessageBox(remoteWindow, {
          type: "error",
          title: "Remote UPM Connection Failed",
          message: `Unable to load ${connection.name}.`,
          detail: `${errorDescription} (${errorCode})\n${validatedUrl || connection.url}`,
          buttons: ["Close"],
          noLink: true,
        })
        .catch(() => {});
    },
  );
  remoteWindow.on("closed", () => remoteWindows.delete(connection.id));
  remoteWindow.on("ready-to-show", () => remoteWindow.show());

  try {
    await remoteWindow.loadURL(connection.url);
  } catch (error) {
    remoteWindows.delete(connection.id);
    if (!remoteWindow.isDestroyed()) remoteWindow.destroy();
    throw new Error(`Unable to open ${connection.name}: ${error.message}`);
  }
  return { opened: true, reused: false, id: connection.id };
}

async function openRemoteConnectionManager() {
  if (remoteManagerWindow && !remoteManagerWindow.isDestroyed()) {
    if (remoteManagerWindow.isMinimized()) remoteManagerWindow.restore();
    remoteManagerWindow.show();
    remoteManagerWindow.focus();
    return;
  }

  remoteManagerWindow = new BrowserWindow({
    title: "Remote UPM Connections",
    width: 900,
    height: 760,
    minWidth: 660,
    minHeight: 560,
    show: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0f",
    icon: appIconPath(serverState.rootDir),
    webPreferences: {
      preload: path.join(__dirname, "remote-connect-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: REMOTE_MANAGER_PARTITION,
    },
  });
  remoteManagerWindow.removeMenu();
  remoteManagerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  remoteManagerWindow.webContents.on("will-navigate", (event, url) => {
    const expected = pathToFileURL(path.join(__dirname, "remote-connect.html")).toString();
    if (url === expected) return;
    event.preventDefault();
  });
  remoteManagerWindow.on("closed", () => {
    remoteManagerWindow = null;
  });
  remoteManagerWindow.on("ready-to-show", () => remoteManagerWindow.show());
  await remoteManagerWindow.loadFile(path.join(__dirname, "remote-connect.html"));
}

function remoteConnectionsMenu() {
  const connections = remoteConnections();
  return [
    {
      label: "Connect / Manage Remote UPMs…",
      accelerator: "CmdOrCtrl+Shift+R",
      click: () => openRemoteConnectionManager().catch(console.error),
    },
    { type: "separator" },
    ...(connections.length
      ? connections.map((connection) => ({
          label: connection.name,
          sublabel: connection.url,
          click: () =>
            openRemoteConnection(connection.id).catch((error) =>
              dialog.showErrorBox("Remote UPM Connection Failed", error.message),
            ),
        }))
      : [{ label: "No saved Remote UPM connections", enabled: false }]),
  ];
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
      {
        label: "Remote UPMs",
        submenu: remoteConnectionsMenu(),
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
      {
        label:
          elevatedRelaunchSupport({ platform: process.platform, packaged: app.isPackaged }).label ||
          "Restart Elevated",
        enabled:
          desktopElevationStatus?.elevated !== true &&
          elevatedRelaunchSupport({ platform: process.platform, packaged: app.isPackaged })
            .supported,
        click: () =>
          requestElevatedRestart().catch((error) =>
            dialog.showErrorBox(`${PRODUCT_NAME} elevation failed`, error.message),
          ),
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
        { type: "separator" },
        {
          label:
            elevatedRelaunchSupport({ platform: process.platform, packaged: app.isPackaged })
              .label || "Restart Elevated",
          enabled:
            desktopElevationStatus?.elevated !== true &&
            elevatedRelaunchSupport({ platform: process.platform, packaged: app.isPackaged })
              .supported,
          click: () =>
            requestElevatedRestart().catch((error) =>
              dialog.showErrorBox(`${PRODUCT_NAME} elevation failed`, error.message),
            ),
        },
      ],
    },
    {
      label: "Remote UPM",
      submenu: remoteConnectionsMenu(),
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

async function requestElevatedRestart() {
  desktopElevationStatus = await elevationChecker(true);
  if (desktopElevationStatus.elevated) return { restarting: false, alreadyElevated: true };

  const support = elevatedRelaunchSupport({
    platform: process.platform,
    packaged: app.isPackaged,
  });
  if (!support.supported) throw new Error(support.reason);

  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: `${PRODUCT_NAME} Elevated Restart`,
    message: `Restart ${PRODUCT_NAME} with elevated privileges?`,
    detail:
      "The operating system will ask you to approve elevation. UPM does not save or receive your administrator/root password. Projects configured to require elevation will remain blocked unless the elevated UPM/PM2 session is active.",
    buttons: [support.label || "Restart Elevated", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response !== 0) return { restarting: false, cancelled: true };

  app.releaseSingleInstanceLock?.();
  try {
    await relaunchElevated({
      platform: process.platform,
      executable: process.execPath,
      packaged: app.isPackaged,
    });
  } catch (error) {
    app.requestSingleInstanceLock();
    throw error;
  }

  setImmediate(() => {
    quitting = true;
    app.quit();
  });
  return { restarting: true };
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
  ipcMain.handle("upm:get-desktop-settings", async (event) => {
    requireTrustedIpcSender(event);
    desktopElevationStatus = await elevationChecker();
    return {
      ...settingsStore.get(),
      packaged: app.isPackaged,
      platform: process.platform,
      dataDir: serverState.dataDir,
      envPath: serverState.envPath,
      dashboardUrl: serverState.url,
      elevation: desktopElevationStatus,
      elevationRelaunch: elevatedRelaunchSupport({
        platform: process.platform,
        packaged: app.isPackaged,
      }),
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
  ipcMain.handle("upm:restart-elevated", async (event) => {
    requireTrustedIpcSender(event);
    return requestElevatedRestart();
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
  ipcMain.handle("upm:open-remote-manager", async (event) => {
    requireTrustedIpcSender(event);
    await openRemoteConnectionManager();
    return { ok: true };
  });
  ipcMain.handle("upm:remote-list", (event) => {
    requireRemoteManagerSender(event);
    return remoteConnections();
  });
  ipcMain.handle("upm:remote-save", async (event, connection) => {
    requireRemoteManagerSender(event);
    return saveRemoteConnection(connection);
  });
  ipcMain.handle("upm:remote-remove", async (event, id) => {
    requireRemoteManagerSender(event);
    return removeRemoteConnection(id);
  });
  ipcMain.handle("upm:remote-probe", async (event, connection) => {
    requireRemoteManagerSender(event);
    return probeRemoteConnection(connection);
  });
  ipcMain.handle("upm:remote-connect", async (event, id) => {
    requireRemoteManagerSender(event);
    return openRemoteConnection(id);
  });
  ipcMain.handle("upm:remote-manager-close", (event) => {
    requireRemoteManagerSender(event);
    remoteManagerWindow?.close();
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
      partition: LOCAL_DASHBOARD_PARTITION,
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
  const guardMainNavigation = (event, url) => {
    try {
      if (new URL(url).origin === new URL(serverState.url).origin) return;
    } catch {}
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        openExternalHttp(parsed.toString()).catch(console.error);
    } catch {}
  };
  mainWindow.webContents.on("will-navigate", guardMainNavigation);
  mainWindow.webContents.on("will-redirect", guardMainNavigation);
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
  desktopElevationStatus = await elevationChecker(true);
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
