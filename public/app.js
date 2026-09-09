"use strict";

const state = {
  projects: [],
  storage: null,
  selectedBackupProject: null,
  discoveryProjects: [],
  pm2HistoryProject: null,
  pm2HistoryRange: "24h",
  pm2HistoryData: null,
  hostHistoryData: null,
  hostChartDefinitions: [],
  pm2Logs: {
    projectId: null,
    pm2Id: null,
    data: null,
    layout: "combined",
    ansiColors: true,
    sourceColors: true,
    autoRefresh: false,
    timer: null,
    loading: false,
    requestSerial: 0,
  },
  selectedDependencyProject: null,
  dependencyData: null,
  dependencyVersions: {},
  dependencyUpdating: {},
  directoryPicker: {
    targetId: null,
    mode: "replace",
    currentPath: null,
    parentPath: null,
    roots: [],
    platform: null,
  },
  fileTools: {
    projectId: null,
    mode: "pipeline",
    preview: null,
    meta: null,
    sanitizer: {
      scan: null,
      selected: new Set(),
      meta: null,
      preview: null,
      previewChanges: [],
      activeChange: -1,
      syncingScroll: false,
    },
  },
  activity: [],
  eventDetails: null,
  collapsedProjects: new Set(),
  collapsedSections: new Set(),
  overviewCollapsedSections: new Set(),
  storageCollapsedSections: new Set(),
  diff: { projectId: null, summary: null, selectedPath: null },
  featurePack: { projectId: null, preview: null },
  recovery: {
    projectId: null,
    analysis: null,
    selectedPath: null,
    selectedCandidateId: null,
    candidate: null,
  },
  journal: { projectId: null, data: null },
  tasks: { projectId: null, data: null, editingId: null },
  auth: { enabled: false, authenticated: true, username: null },
  desktop: { enabled: false, settings: null },
  settings: null,
  status: null,
  refreshTimer: null,
  openProjectActionMenus: new Set(),
  activeDashboardTab: "projects",
  activeRuntimeSettingsTab: "server",
  uiPreferences: {
    colorVisionPalette: "default",
    chartPatterns: true,
  },
};
const $ = (selector) => document.querySelector(selector);

const UI_PREFERENCES_KEY = "upm:accessibility-preferences";
const PROJECT_ACTION_MENUS_KEY = "upm:project-action-menus";
const COLOR_VISION_PALETTES = Object.freeze({
  default: {
    name: "Default Purple",
    description: "Original Bacons Helper purple with standard green, amber, and red status colors.",
  },
  "red-green": {
    name: "Red-Green Friendly",
    description:
      "Uses blue for healthy states, orange for warnings, and magenta for errors to reduce red/green dependence.",
  },
  "blue-yellow": {
    name: "Blue-Yellow Friendly",
    description:
      "Uses green, orange, and magenta with a magenta accent to reduce blue/yellow dependence.",
  },
  "high-contrast": {
    name: "High Contrast",
    description:
      "Increases text, border, surface, and status contrast for stronger visual separation.",
  },
  monochrome: {
    name: "Monochrome",
    description:
      "Removes most semantic color and relies on text, symbols, border styles, and line patterns.",
  },
});

function normalizeColorVisionPalette(value) {
  const palette = String(value || "default").toLowerCase();
  return COLOR_VISION_PALETTES[palette] ? palette : "default";
}

function saveUiPreferences() {
  try {
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(state.uiPreferences));
  } catch {}
}

function loadUiPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) || "{}");
    state.uiPreferences = {
      colorVisionPalette: normalizeColorVisionPalette(stored.colorVisionPalette),
      chartPatterns: stored.chartPatterns !== false,
    };
  } catch {
    state.uiPreferences = { colorVisionPalette: "default", chartPatterns: true };
  }
}

function populateAccessibilitySettings() {
  const palette = normalizeColorVisionPalette(state.uiPreferences.colorVisionPalette);
  const meta = COLOR_VISION_PALETTES[palette];
  if ($("#settingsColorVisionPalette")) $("#settingsColorVisionPalette").value = palette;
  if ($("#settingsChartPatterns"))
    $("#settingsChartPatterns").checked = state.uiPreferences.chartPatterns !== false;
  if ($("#settingsColorVisionName")) $("#settingsColorVisionName").textContent = meta.name;
  if ($("#settingsColorVisionDescription"))
    $("#settingsColorVisionDescription").textContent = meta.description;
}

function redrawPaletteAwareCharts() {
  if (state.hostHistoryData) renderHostHistoryInteractiveCharts();
  if ($("#pm2HistoryDialog")?.open && state.pm2HistoryData)
    renderPm2HistoryCharts(state.pm2HistoryData);
}

function applyUiPreferences(options = {}) {
  const palette = normalizeColorVisionPalette(state.uiPreferences.colorVisionPalette);
  state.uiPreferences.colorVisionPalette = palette;
  if (palette === "default") delete document.documentElement.dataset.colorVision;
  else document.documentElement.dataset.colorVision = palette;
  document.documentElement.classList.toggle(
    "chart-patterns",
    state.uiPreferences.chartPatterns !== false,
  );
  populateAccessibilitySettings();
  if (options.persist) saveUiPreferences();
  redrawPaletteAwareCharts();
}

function setColorVisionPalette(value) {
  state.uiPreferences.colorVisionPalette = normalizeColorVisionPalette(value);
  applyUiPreferences({ persist: true });
}

function setChartPatterns(enabled) {
  state.uiPreferences.chartPatterns = enabled !== false;
  applyUiPreferences({ persist: true });
}

function resetAccessibilityPreferences() {
  state.uiPreferences = { colorVisionPalette: "default", chartPatterns: true };
  applyUiPreferences({ persist: true });
  toast("Accessibility colors reset to Default Purple.");
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char],
  );
}

const UI_TITLE_CASE_SELECTOR = [
  ".button",
  ".badge:not(.error-block)",
  ".dashboard-tab",
  ".project-settings-tab",
  ".runtime-settings-tab",
  ".project-collapse-button",
].join(", ");

const UI_TITLE_CASE_ACRONYMS = Object.freeze({
  api: "API",
  "aes-256-gcm": "AES-256-GCM",
  cpu: "CPU",
  csp: "CSP",
  db: "DB",
  docker: "Docker",
  fix: "FIX",
  git: "Git",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  json: "JSON",
  lan: "LAN",
  mariadb: "MariaDB",
  note: "NOTE",
  npm: "npm",
  pid: "PID",
  pm2: "PM2",
  postgresql: "PostgreSQL",
  redis: "Redis",
  rss: "RSS",
  "sha-256": "SHA-256",
  todo: "TODO",
  upm: "UPM",
  url: "URL",
  ui: "UI",
  vs: "VS",
});

function titleCaseUiLabel(value) {
  return String(value ?? "").replace(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g, (token) => {
    const known = UI_TITLE_CASE_ACRONYMS[token.toLowerCase()];
    if (known) return known;
    return token
      .split("-")
      .map((part) => {
        const preserved = UI_TITLE_CASE_ACRONYMS[part.toLowerCase()];
        if (preserved) return preserved;
        return part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
      })
      .join("-");
  });
}

function titleCaseUiElement(element) {
  if (!(element instanceof Element)) return;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest("code, pre, kbd, samp, .path, .preserve-case, .error-block")) continue;
    nodes.push(node);
  }
  for (const node of nodes) {
    const next = titleCaseUiLabel(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
}

function applyUiTitleCase(root = document) {
  const controls = [];
  if (root instanceof Element && root.matches(UI_TITLE_CASE_SELECTOR)) controls.push(root);
  if (root?.querySelectorAll) controls.push(...root.querySelectorAll(UI_TITLE_CASE_SELECTOR));
  for (const control of new Set(controls)) titleCaseUiElement(control);
}

function initUiTitleCase() {
  applyUiTitleCase(document);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const control = node.parentElement?.closest(UI_TITLE_CASE_SELECTOR);
          if (control) titleCaseUiElement(control);
          continue;
        }
        if (node.nodeType === Node.ELEMENT_NODE) applyUiTitleCase(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Number(bytes),
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function formatPercent(ratio) {
  if (!Number.isFinite(Number(ratio))) return "-";
  return `${(Number(ratio) * 100).toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const totalSeconds = Math.floor(value / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.className = "toast";
  }, 4200);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  if (response.status === 401 && data?.authenticationRequired) {
    showAuthGate();
  }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

function showAuthGate(message = "") {
  $("#authGate").hidden = false;
  document.querySelector(".shell").hidden = true;
  $("#authMessage").textContent = message;
  $("#authPassword").value = "";
  setTimeout(() => ($("#authUsername").value ? $("#authPassword") : $("#authUsername")).focus(), 0);
}

function hideAuthGate() {
  $("#authGate").hidden = true;
  document.querySelector(".shell").hidden = false;
  $("#authMessage").textContent = "";
}

async function checkAuthentication() {
  const response = await fetch("/api/auth/status", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Unable to check authentication status.");
  state.auth = data.auth || {
    enabled: false,
    authenticated: true,
    username: null,
  };
  state.desktop.enabled = data.desktop === true;
  applyRuntimeMode(state.desktop.enabled);
  $("#logoutBtn").hidden =
    state.desktop.enabled || !state.auth.enabled || !state.auth.authenticated;
  if (state.desktop.enabled) loadDesktopSettings().catch(() => {});
  if (state.auth.enabled && !state.auth.authenticated) {
    $("#authUsername").value = state.auth.configuredUsername || "admin";
    const cookieMessage = state.auth.cookie?.compatible === false ? state.auth.cookie.message : "";
    showAuthGate(cookieMessage);
    return false;
  }
  hideAuthGate();
  return true;
}

function applyRuntimeMode(desktopEnabled = window.upmDesktop?.isDesktop === true) {
  const desktop = desktopEnabled === true;
  document.body.dataset.runtimeMode = desktop ? "desktop" : "browser";
  const runtimeStatus = $("#desktopModeStatus");
  if (runtimeStatus) {
    runtimeStatus.hidden = false;
    runtimeStatus.textContent = desktop ? "Desktop App" : "Browser Mode";
    runtimeStatus.classList.toggle("online", desktop);
  }
  const desktopActions = $("#desktopActionGroup");
  if (desktopActions) desktopActions.hidden = !desktop;
}

function runDesktopRendererCommand(command) {
  const actions = {
    refresh: () => $("#refreshBtn")?.click(),
    "backup-all": () => $("#backupAllBtn")?.click(),
    "add-project": () => $("#addProjectBtn")?.click(),
    discover: () => $("#discoverBtn")?.click(),
    "file-tools": () => $("#fileToolsBtn")?.click(),
    diagnostics: () => $("#diagnosticsBtn")?.click(),
    settings: () => $("#settingsBtn")?.click(),
    help: () => openHelp(),
    projects: () => setDashboardTab("projects", { focusPanel: true }),
    overview: () => setDashboardTab("overview", { focusPanel: true }),
    storage: () => setDashboardTab("storage", { focusPanel: true }),
    activity: () => setDashboardTab("activity", { focusPanel: true }),
  };
  actions[String(command || "")]?.();
}

function initDesktopCommandBridge() {
  if (!window.upmDesktop?.onCommand) return;
  window.upmDesktop.onCommand((command) => runDesktopRendererCommand(command));
}

function initDashboardActionMenu() {
  const menu = $("#dashboardMoreMenu");
  if (!menu) return;
  const summary = menu.querySelector(":scope > summary");

  menu.addEventListener("click", (event) => {
    if (
      !event.target.closest(".dashboard-action-menu-panel button, .dashboard-action-menu-panel a")
    )
      return;
    menu.open = false;
  });

  document.addEventListener("click", (event) => {
    if (!menu.open || menu.contains(event.target)) return;
    menu.open = false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    summary?.focus();
  });
}

async function login(event) {
  event.preventDefault();
  const button = $("#authLoginBtn");
  button.disabled = true;
  $("#authMessage").textContent = "Signing in…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("#authUsername").value.trim(),
        password: $("#authPassword").value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || "Sign in failed.");
    state.auth = data.auth;
    $("#logoutBtn").hidden = !state.auth.enabled;

    if (!(await checkAuthentication())) {
      if (!$("#authMessage").textContent) {
        showAuthGate(
          "Credentials were accepted, but the browser did not return the session cookie. Check the dashboard URL and cookie security settings.",
        );
      }
      return;
    }

    await refresh();
    if (!state.refreshTimer)
      state.refreshTimer = setInterval(() => {
        if (!$("#authGate").hidden) return;
        refresh().catch(() => {});
      }, 10000);
  } catch (error) {
    showAuthGate(error.message);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});
  state.auth.authenticated = false;
  $("#logoutBtn").hidden = true;
  showAuthGate("Signed out.");
}

const RUNTIME_SETTINGS_TABS = [
  "server",
  "access",
  "http",
  "auth",
  "backups",
  "accessibility",
  "integrations",
  "setup",
];
const RUNTIME_SETTINGS_TAB_LABELS = {
  server: "Server settings",
  access: "Remote access settings",
  http: "HTTP hardening and limits",
  auth: "Authentication settings",
  backups: "Backup encryption settings",
  accessibility: "Accessibility and color vision settings",
  integrations: "Editor and LAN agent integrations",
  setup: "Setup import / export",
};

function validRuntimeSettingsTab(value) {
  const tab = String(value || "").toLowerCase();
  return RUNTIME_SETTINGS_TABS.includes(tab) ? tab : null;
}

function setRuntimeSettingsTab(tabId, options = {}) {
  const tab = validRuntimeSettingsTab(tabId) || "server";
  state.activeRuntimeSettingsTab = tab;
  let activeButton = null;
  document.querySelectorAll("[data-runtime-settings-tab]").forEach((button) => {
    const active = button.dataset.runtimeSettingsTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) activeButton = button;
  });
  if (options.keepTabVisible !== false) keepTabVisible(activeButton);
  document.querySelectorAll("[data-runtime-settings-section]").forEach((panel) => {
    const active = panel.dataset.runtimeSettingsSection === tab;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  const status = $("#settingsSectionStatus");
  if (status) status.textContent = RUNTIME_SETTINGS_TAB_LABELS[tab] || "Runtime settings";
  if (options.focusPanel) {
    document
      .querySelector(`[data-runtime-settings-section="${CSS.escape(tab)}"]`)
      ?.focus({ preventScroll: true });
  }
}

function runtimeSettingsTabForElement(element) {
  return (
    element?.closest?.("[data-runtime-settings-section]")?.dataset.runtimeSettingsSection || null
  );
}

function initRuntimeSettingsTabs() {
  const tablist = document.querySelector(".runtime-settings-tabs");
  tablist?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-runtime-settings-tab]");
    if (!button) return;
    setRuntimeSettingsTab(button.dataset.runtimeSettingsTab);
  });
  tablist?.addEventListener("keydown", (event) => {
    const current = event.target.closest("[data-runtime-settings-tab]");
    if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...tablist.querySelectorAll("[data-runtime-settings-tab]")];
    let index = buttons.indexOf(current);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buttons.length - 1;
    else if (event.key === "ArrowRight") index = (index + 1) % buttons.length;
    else index = (index - 1 + buttons.length) % buttons.length;
    const next = buttons[index];
    setRuntimeSettingsTab(next.dataset.runtimeSettingsTab);
    next.focus();
  });

  $("#settingsForm")?.addEventListener(
    "invalid",
    (event) => {
      const tab = runtimeSettingsTabForElement(event.target);
      if (tab) setRuntimeSettingsTab(tab);
    },
    true,
  );
}

function renderRuntimeLanAgents(agents = []) {
  const list = $("#settingsLanAgentList");
  const count = $("#settingsLanAgentCount");
  if (!list || !count) return;
  const values = Array.isArray(agents) ? agents : [];
  count.textContent = String(values.length);
  count.className = `badge${values.length ? " success" : ""}`;
  list.innerHTML = values.length
    ? values
        .map(
          (agent) => `
            <div class="runtime-agent-item">
              <div class="runtime-agent-identity">
                <strong>${escapeHtml(agent.name || agent.id)}</strong>
                <span class="muted">${escapeHtml(agent.id)}</span>
              </div>
              <code>${escapeHtml(agent.url || "-")}</code>
              <span class="badge ${agent.secureTransport ? "success" : "warning"}">${agent.secureTransport ? "HTTPS" : "HTTP"}</span>
              <span class="badge ${agent.tokenConfigured ? "success" : "warning"}">${agent.tokenConfigured ? "Token Configured" : "Token Missing"}</span>
            </div>`,
        )
        .join("")
    : '<div class="empty">No LAN agents configured.</div>';
}

function setSettingsValue(selector, value) {
  const element = $(selector);
  if (!element) return;
  if (element.type === "checkbox") element.checked = value === true;
  else element.value = value ?? "";
}

function renderSettingsSecrets(secrets = {}) {
  const setStatus = (selector, configured) => {
    const element = $(selector);
    element.textContent = configured ? "Configured" : "Not configured";
    element.className = `badge ${configured ? "success" : "warning"}`;
  };
  setStatus("#settingsAuthPasswordStatus", secrets.authPasswordConfigured);
  setStatus("#settingsSessionSecretStatus", secrets.sessionSecretConfigured);
  setStatus("#settingsEncryptionStatus", secrets.backupEncryptionKeyConfigured);
}

function populateSettingsForm(payload) {
  const settings = payload?.settings || {};
  const fields = {
    "#settingsHost": settings.host,
    "#settingsPort": settings.port,
    "#settingsBackupRoot": settings.backupRoot,
    "#settingsRestoreRoot": settings.restoreRoot,
    "#settingsAllowRemoteDashboard": settings.allowRemoteDashboard,
    "#settingsAllowRemoteAdmin": settings.allowRemoteAdmin,
    "#settingsAllowRemoteFilesystem": settings.allowRemoteFilesystem,
    "#settingsTrustProxy": settings.trustProxy,
    "#settingsSecurityHeaders": settings.securityHeaders,
    "#settingsCsp": settings.contentSecurityPolicy,
    "#settingsJsonLimit": settings.jsonLimit,
    "#settingsRateWindow": settings.apiRateLimitWindowMs,
    "#settingsRateMax": settings.apiRateLimitMax,
    "#settingsWriteRateMax": settings.writeRateLimitMax,
    "#settingsRequestTimeout": settings.requestTimeoutMs,
    "#settingsHeadersTimeout": settings.headersTimeoutMs,
    "#settingsKeepAliveTimeout": settings.keepAliveTimeoutMs,
    "#settingsAuthEnabled": settings.authEnabled,
    "#settingsAuthUsername": settings.authUsername,
    "#settingsAuthSessionHours": settings.authSessionHours,
    "#settingsAuthCookieSecure": settings.authCookieSecure,
    "#settingsAuthMaxAttempts": settings.authMaxAttempts,
    "#settingsAuthLockoutMinutes": settings.authLockoutMinutes,
    "#settingsEditor": settings.editor,
    "#settingsEditorCommand": settings.editorCommand,
    "#settingsLanAllowInsecureHttp": settings.lanAllowInsecureHttp,
  };
  for (const [selector, value] of Object.entries(fields)) setSettingsValue(selector, value);

  $("#settingsNewAuthPassword").value = "";
  $("#settingsConfirmAuthPassword").value = "";
  $("#settingsNewEncryptionKey").value = "";
  $("#settingsRotateSessionSecret").checked = false;
  $("#settingsLanAgentsJson").value = "";
  $("#settingsClearLanAgents").checked = false;
  renderRuntimeLanAgents(payload?.lanAgents || []);
  $("#settingsSource").textContent = `Current source: ${payload?.source || "unknown"}`;
  const overrides = Array.isArray(payload?.environmentOverrides)
    ? payload.environmentOverrides
    : [];
  const ignoredInvalidOverrides = Array.isArray(payload?.ignoredInvalidEnvironmentOverrides)
    ? payload.ignoredInvalidEnvironmentOverrides
    : [];
  const warningBox = $("#settingsWarnings");
  warningBox.hidden = overrides.length === 0 && ignoredInvalidOverrides.length === 0;
  warningBox.innerHTML = [
    overrides.length
      ? `<strong>Environment override${overrides.length === 1 ? "" : "s"} active</strong><br>${escapeHtml(overrides.join(", "))}<br>These parent process values take priority over .env until the external variables are removed.`
      : "",
    ignoredInvalidOverrides.length
      ? `<strong>Invalid inherited override ignored</strong><br>${escapeHtml(ignoredInvalidOverrides.join(", "))}<br>A valid .env value was used instead so startup could continue safely.`
      : "",
  ]
    .filter(Boolean)
    .join("<br><br>");
  renderSettingsSecrets(payload?.secrets || {});
  populateAccessibilitySettings();
}

async function openSettings() {
  const payload = await api("/api/settings");
  state.settings = payload;
  populateSettingsForm(payload);
  setRuntimeSettingsTab(state.activeRuntimeSettingsTab || "server");
  $("#settingsDialog").showModal();
}

function collectSettingsForm() {
  const number = (selector) => Number($(selector).value);
  return {
    host: $("#settingsHost").value.trim(),
    port: number("#settingsPort"),
    backupRoot: $("#settingsBackupRoot").value.trim(),
    restoreRoot: $("#settingsRestoreRoot").value.trim(),
    allowRemoteDashboard: $("#settingsAllowRemoteDashboard").checked,
    allowRemoteAdmin: $("#settingsAllowRemoteAdmin").checked,
    allowRemoteFilesystem: $("#settingsAllowRemoteFilesystem").checked,
    trustProxy: $("#settingsTrustProxy").checked,
    securityHeaders: $("#settingsSecurityHeaders").checked,
    contentSecurityPolicy: $("#settingsCsp").checked,
    jsonLimit: $("#settingsJsonLimit").value.trim(),
    apiRateLimitWindowMs: number("#settingsRateWindow"),
    apiRateLimitMax: number("#settingsRateMax"),
    writeRateLimitMax: number("#settingsWriteRateMax"),
    requestTimeoutMs: number("#settingsRequestTimeout"),
    headersTimeoutMs: number("#settingsHeadersTimeout"),
    keepAliveTimeoutMs: number("#settingsKeepAliveTimeout"),
    authEnabled: $("#settingsAuthEnabled").checked,
    authUsername: $("#settingsAuthUsername").value.trim(),
    authSessionHours: number("#settingsAuthSessionHours"),
    authCookieSecure: $("#settingsAuthCookieSecure").checked,
    authMaxAttempts: number("#settingsAuthMaxAttempts"),
    authLockoutMinutes: number("#settingsAuthLockoutMinutes"),
    editor: $("#settingsEditor").value,
    editorCommand: $("#settingsEditorCommand").value.trim(),
    lanAllowInsecureHttp: $("#settingsLanAllowInsecureHttp").checked,
  };
}

function generateBackupEncryptionKey() {
  if (!window.crypto?.getRandomValues) {
    throw new Error("Secure random key generation is unavailable in this browser.");
  }
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const input = $("#settingsNewEncryptionKey");
  input.value = key;
  input.focus();
  toast("Generated a new 256-bit backup encryption key. Save Settings to activate it.");
}

function restartFieldLabel(field) {
  return (
    {
      host: "bind host",
      port: "port",
      backupRoot: "backup root",
      restoreRoot: "restore root",
      jsonLimit: "JSON request limit",
      apiRateLimitWindowMs: "API rate-limit window",
      apiRateLimitMax: "API rate limit",
      writeRateLimitMax: "write rate limit",
      requestTimeoutMs: "request timeout",
      headersTimeoutMs: "headers timeout",
      keepAliveTimeoutMs: "keep-alive timeout",
      liveApplyRecovery: "a setting that could not be live-applied",
    }[field] || String(field || "runtime setting")
  );
}

async function promptForRuntimeRestart(result) {
  const restartFields = Array.isArray(result?.restartFields) ? result.restartFields : [];
  const labels = restartFields.map(restartFieldLabel);
  const detail = labels.length ? ` Required for: ${labels.join(", ")}.` : "";

  if (window.upmDesktop?.restartApp) {
    const restartNow = window.confirm(
      `Settings were saved successfully.${detail} Restart Ultimate Project Manager now?`,
    );
    if (restartNow) {
      toast("Restarting Ultimate Project Manager…");
      await window.upmDesktop.restartApp();
      return true;
    }
    toast(`Settings saved.${detail} Restart UPM when convenient.`);
    return false;
  }

  window.alert(
    `Settings were saved successfully.${detail} Restart the Ultimate Project Manager process to apply these changes.`,
  );
  return false;
}

async function saveRuntimeSettings(event) {
  event.preventDefault();
  const button = $("#saveSettingsBtn");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const data = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        settings: collectSettingsForm(),
        secrets: {
          newAuthPassword: $("#settingsNewAuthPassword").value,
          confirmAuthPassword: $("#settingsConfirmAuthPassword").value,
          rotateSessionSecret: $("#settingsRotateSessionSecret").checked,
          newBackupEncryptionKey: $("#settingsNewEncryptionKey").value,
          lanAgentsJson: $("#settingsLanAgentsJson").value,
          clearLanAgents: $("#settingsClearLanAgents").checked,
        },
      }),
    });
    const result = data.result || {};
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const warningBox = $("#settingsWarnings");
    warningBox.hidden = warnings.length === 0;
    warningBox.innerHTML = warnings.length
      ? `<strong>Saved with warning${warnings.length === 1 ? "" : "s"}</strong><br>${warnings.map(escapeHtml).join("<br>")}`
      : "";
    renderSettingsSecrets(result.secrets || {});
    if (Array.isArray(result.lanAgents)) {
      renderRuntimeLanAgents(result.lanAgents);
      if (state.settings) state.settings.lanAgents = result.lanAgents;
    }
    $("#settingsNewAuthPassword").value = "";
    $("#settingsConfirmAuthPassword").value = "";
    $("#settingsNewEncryptionKey").value = "";
    $("#settingsRotateSessionSecret").checked = false;
    $("#settingsLanAgentsJson").value = "";
    $("#settingsClearLanAgents").checked = false;
    $("#settingsDialog").close();
    const sessionOverrideWarning = warnings.find((warning) =>
      /UPM_SESSION_SECRET/.test(String(warning || "")),
    );
    if (result.restartRequired) {
      await promptForRuntimeRestart(result);
    } else if (sessionOverrideWarning) {
      toast(sessionOverrideWarning, true);
    } else if (result.sessionSecretRotated) {
      toast(
        "Session secret rotated, verified, and applied live. Existing browser sessions must sign in again.",
      );
    } else {
      const applied = Array.isArray(result.appliedLiveFields) ? result.appliedLiveFields.length : 0;
      toast(
        applied
          ? `Settings saved and ${applied} change${applied === 1 ? "" : "s"} applied immediately.`
          : "Settings saved. No restart is required.",
      );
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Save Settings";
  }
}

function downloadJsonFile(value, fileName) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "Ultimate-Project-Manager-setup.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportSetup() {
  const button = $("#exportSetupBtn");
  button.disabled = true;
  button.textContent = "Exporting…";
  try {
    const data = await api("/api/setup/export");
    downloadJsonFile(data.setup, data.fileName);
    toast("UPM setup exported. Secret values were excluded.");
  } finally {
    button.disabled = false;
    button.textContent = "Export Setup";
  }
}

async function importSetupFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error("Setup file is too large (10 MB maximum).");
  let setup;
  try {
    setup = JSON.parse(await file.text());
  } catch {
    throw new Error("The selected setup file is not valid JSON.");
  }

  const mode = $("#setupImportMode").value === "replace" ? "replace" : "merge";
  const runtimeSettings = $("#setupImportRuntimeSettings").checked;
  const projects = $("#setupImportProjects").checked;
  if (!runtimeSettings && !projects)
    throw new Error("Choose at least one setup section to import.");
  if (mode === "replace" && projects) {
    const confirmed = window.confirm(
      "Replace all project setups with the imported project list? Existing projects are left intact if any imported project fails validation.",
    );
    if (!confirmed) return;
  }

  const button = $("#importSetupBtn");
  button.disabled = true;
  button.textContent = "Importing…";
  try {
    const data = await api("/api/setup/import", {
      method: "POST",
      body: JSON.stringify({
        setup,
        options: { mode, runtimeSettings, projects },
      }),
    });
    const result = data.result || {};
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const warningBox = $("#settingsWarnings");
    warningBox.hidden = warnings.length === 0;
    warningBox.innerHTML = warnings.length
      ? `<strong>Imported with warning${warnings.length === 1 ? "" : "s"}</strong><br>${warnings.map(escapeHtml).join("<br>")}`
      : "";
    if (projects && result.projects?.applied) await refresh();
    const projectResult = result.projects;
    const projectSummary = projectResult
      ? ` ${projectResult.added?.length || 0} added, ${projectResult.updated?.length || 0} updated${projectResult.errors?.length ? `, ${projectResult.errors.length} skipped` : ""}.`
      : "";
    if (result.restartRequired) {
      toast(`Setup import complete.${projectSummary}`, warnings.length > 0);
      await promptForRuntimeRestart(result.settings || { restartRequired: true });
    } else {
      toast(`Setup import complete.${projectSummary}`, warnings.length > 0);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Choose Setup File";
    $("#setupImportFile").value = "";
  }
}

function loadCollapsedProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem("backup-manager:collapsed-projects") || "[]");
    state.collapsedProjects = new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    state.collapsedProjects = new Set();
  }
}

function saveCollapsedProjects() {
  try {
    localStorage.setItem(
      "backup-manager:collapsed-projects",
      JSON.stringify([...state.collapsedProjects]),
    );
  } catch {}
}

function keepTabVisible(button) {
  if (!button || typeof button.scrollIntoView !== "function") return;
  try {
    button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  } catch {
    button.scrollIntoView();
  }
}

const DASHBOARD_TABS = ["projects", "overview", "storage", "activity", "help"];

function validDashboardTab(value) {
  const tab = String(value || "")
    .replace(/^#/, "")
    .toLowerCase();
  return DASHBOARD_TABS.includes(tab) ? tab : null;
}

function storedDashboardTab() {
  try {
    return validDashboardTab(localStorage.getItem("upm:dashboard-tab"));
  } catch {
    return null;
  }
}

function setDashboardTab(tabId, options = {}) {
  const tab = validDashboardTab(tabId) || "projects";
  state.activeDashboardTab = tab;

  let activeButton = null;
  document.querySelectorAll("[data-dashboard-tab]").forEach((button) => {
    const active = button.dataset.dashboardTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) activeButton = button;
  });
  if (options.keepTabVisible !== false) keepTabVisible(activeButton);

  document.querySelectorAll(".dashboard-panel[data-dashboard-section]").forEach((panel) => {
    const active = panel.dataset.dashboardSection === tab;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  if (tab === "overview" && state.hostHistoryData) {
    requestAnimationFrame(() => renderHostHistoryInteractiveCharts());
  }

  try {
    localStorage.setItem("upm:dashboard-tab", tab);
  } catch {}

  if (options.updateHash !== false && window.location.hash !== `#${tab}`) {
    history.replaceState(null, "", `#${tab}`);
  }

  if (options.focusPanel) {
    const panel = document.querySelector(
      `.dashboard-panel[data-dashboard-section="${CSS.escape(tab)}"]`,
    );
    panel?.focus({ preventScroll: true });
  }
}

function initDashboardTabs() {
  const initial = validDashboardTab(window.location.hash) || storedDashboardTab() || "projects";
  setDashboardTab(initial, { updateHash: !validDashboardTab(window.location.hash) });

  const tablist = document.querySelector(".dashboard-tabs");
  tablist?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dashboard-tab]");
    if (!button) return;
    setDashboardTab(button.dataset.dashboardTab);
  });
  document.querySelectorAll("[data-dashboard-jump]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setDashboardTab(link.dataset.dashboardJump, { focusPanel: true });
    });
  });
  tablist?.addEventListener("keydown", (event) => {
    const current = event.target.closest("[data-dashboard-tab]");
    if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...tablist.querySelectorAll("[data-dashboard-tab]")];
    let index = buttons.indexOf(current);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buttons.length - 1;
    else if (event.key === "ArrowRight") index = (index + 1) % buttons.length;
    else index = (index - 1 + buttons.length) % buttons.length;
    const next = buttons[index];
    setDashboardTab(next.dataset.dashboardTab);
    next.focus();
  });

  window.addEventListener("hashchange", () => {
    const tab = validDashboardTab(window.location.hash);
    if (tab) setDashboardTab(tab, { updateHash: false });
  });
}

const GETTING_STARTED_TIPS_KEY = "upm:getting-started-tips-hidden";

function gettingStartedTipsHidden() {
  try {
    return localStorage.getItem(GETTING_STARTED_TIPS_KEY) === "1";
  } catch {
    return false;
  }
}

function setGettingStartedTipsVisible(visible, options = {}) {
  const card = $("#gettingStartedTips");
  if (card) card.hidden = !visible;
  if (options.persist === false) return;
  try {
    if (visible) localStorage.removeItem(GETTING_STARTED_TIPS_KEY);
    else localStorage.setItem(GETTING_STARTED_TIPS_KEY, "1");
  } catch {}
}

function filterHelpTopics(value = "") {
  const query = String(value || "")
    .trim()
    .toLowerCase();
  let matches = 0;
  document.querySelectorAll("[data-help-topic-card]").forEach((topic) => {
    const haystack = `${topic.dataset.helpKeywords || ""} ${topic.textContent || ""}`.toLowerCase();
    const visible = !query || haystack.includes(query);
    topic.hidden = !visible;
    if (visible) {
      matches += 1;
      if (query) topic.open = true;
    }
  });
  const noResults = $("#helpNoResults");
  if (noResults) noResults.hidden = matches > 0;
  return matches;
}

function clearHelpSearch() {
  const search = $("#helpSearch");
  if (search) search.value = "";
  filterHelpTopics("");
}

function scrollToHelpTopic(topicId) {
  const id = String(topicId || "").trim();
  if (!id) return;
  clearHelpSearch();
  const topic = document.getElementById(`help-topic-${id}`);
  if (!topic) return;
  topic.hidden = false;
  topic.open = true;
  requestAnimationFrame(() => {
    topic.scrollIntoView({ behavior: "smooth", block: "start" });
    topic.querySelector("summary")?.focus({ preventScroll: true });
  });
}

function openHelp(topicId = null) {
  setDashboardTab("help", { focusPanel: true });
  if (topicId) scrollToHelpTopic(topicId);
  else requestAnimationFrame(() => $("#helpSearch")?.focus({ preventScroll: true }));
}

function runHelpAction(action) {
  const target = String(action || "");
  if (target === "add-project") {
    setDashboardTab("projects");
    $("#addProjectBtn")?.click();
    return;
  }
  if (target === "discover") {
    setDashboardTab("projects");
    $("#discoverBtn")?.click();
    return;
  }
  if (target === "file-tools") {
    $("#fileToolsBtn")?.click();
    return;
  }
  if (target === "settings") {
    $("#settingsBtn")?.click();
    return;
  }
  if (target === "diagnostics") $("#diagnosticsBtn")?.click();
}

function initHelpCenter() {
  setGettingStartedTipsVisible(!gettingStartedTipsHidden(), { persist: false });

  $("#helpBtn")?.addEventListener("click", (event) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    openHelp();
  });
  $("#openHelpFromTipsBtn")?.addEventListener("click", () => openHelp("getting-started"));
  $("#dismissGettingStartedTipsBtn")?.addEventListener("click", () => {
    setGettingStartedTipsVisible(false);
    toast("Getting Started tips hidden. You can restore them from Help & Tips.");
  });
  $("#helpShowStartTipsBtn")?.addEventListener("click", () => {
    setGettingStartedTipsVisible(true);
    setDashboardTab("projects", { focusPanel: true });
    requestAnimationFrame(() =>
      $("#gettingStartedTips")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  });

  $("#helpSearch")?.addEventListener("input", (event) => filterHelpTopics(event.target.value));
  $("#helpSearchClear")?.addEventListener("click", () => {
    clearHelpSearch();
    $("#helpSearch")?.focus();
  });

  document.querySelectorAll("[data-help-topic-target]").forEach((button) => {
    button.addEventListener("click", () => scrollToHelpTopic(button.dataset.helpTopicTarget));
  });
  document.querySelectorAll("[data-help-action]").forEach((button) => {
    button.addEventListener("click", () => runHelpAction(button.dataset.helpAction));
  });
}

const PROJECT_SETTINGS_TABS = ["general", "backups", "recovery", "runtime", "services"];
const PROJECT_SETTINGS_TAB_LABELS = {
  general: "General settings",
  backups: "Backup settings",
  recovery: "Recovery settings",
  runtime: "Runtime / PM2 settings",
  services: "Supporting service health",
};

function validProjectSettingsTab(value) {
  const tab = String(value || "").toLowerCase();
  return PROJECT_SETTINGS_TABS.includes(tab) ? tab : null;
}

function setProjectSettingsTab(tabId, options = {}) {
  const tab = validProjectSettingsTab(tabId) || "general";
  let activeButton = null;
  document.querySelectorAll("[data-project-settings-tab]").forEach((button) => {
    const active = button.dataset.projectSettingsTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) activeButton = button;
  });
  if (options.keepTabVisible !== false) keepTabVisible(activeButton);
  document.querySelectorAll("[data-project-settings-section]").forEach((panel) => {
    const active = panel.dataset.projectSettingsSection === tab;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  const status = $("#projectSettingsSectionStatus");
  if (status) status.textContent = PROJECT_SETTINGS_TAB_LABELS[tab] || "Project settings";
  if (options.focusPanel) {
    document
      .querySelector(`[data-project-settings-section="${CSS.escape(tab)}"]`)
      ?.focus({ preventScroll: true });
  }
}

function projectSettingsTabForElement(element) {
  return (
    element?.closest?.("[data-project-settings-section]")?.dataset.projectSettingsSection || null
  );
}

function initProjectSettingsTabs() {
  const tablist = document.querySelector(".project-settings-tabs");
  tablist?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-project-settings-tab]");
    if (!button) return;
    setProjectSettingsTab(button.dataset.projectSettingsTab);
  });
  tablist?.addEventListener("keydown", (event) => {
    const current = event.target.closest("[data-project-settings-tab]");
    if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...tablist.querySelectorAll("[data-project-settings-tab]")];
    let index = buttons.indexOf(current);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buttons.length - 1;
    else if (event.key === "ArrowRight") index = (index + 1) % buttons.length;
    else index = (index - 1 + buttons.length) % buttons.length;
    const next = buttons[index];
    setProjectSettingsTab(next.dataset.projectSettingsTab);
    next.focus();
  });

  $("#projectForm")?.addEventListener(
    "invalid",
    (event) => {
      const tab = projectSettingsTabForElement(event.target);
      if (tab) setProjectSettingsTab(tab);
    },
    true,
  );
}

function loadCollapsedSections() {
  try {
    const raw = JSON.parse(localStorage.getItem("upm:collapsed-sections") || "[]");
    state.collapsedSections = new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    state.collapsedSections = new Set();
  }
}

function saveCollapsedSections() {
  try {
    localStorage.setItem("upm:collapsed-sections", JSON.stringify([...state.collapsedSections]));
  } catch {}
}

const OVERVIEW_SECTION_IDS = ["operations", "host", "cores"];

function loadOverviewCollapsedSections() {
  try {
    const raw = JSON.parse(localStorage.getItem("upm:overview-collapsed-sections") || "[]");
    state.overviewCollapsedSections = new Set(
      Array.isArray(raw) ? raw.map(String).filter((id) => OVERVIEW_SECTION_IDS.includes(id)) : [],
    );
  } catch {
    state.overviewCollapsedSections = new Set();
  }
}

function saveOverviewCollapsedSections() {
  try {
    localStorage.setItem(
      "upm:overview-collapsed-sections",
      JSON.stringify([...state.overviewCollapsedSections]),
    );
  } catch {}
}

function setOverviewSectionCollapsed(sectionId, collapsed, options = {}) {
  const id = String(sectionId || "");
  if (!OVERVIEW_SECTION_IDS.includes(id)) return;

  if (collapsed) state.overviewCollapsedSections.add(id);
  else state.overviewCollapsedSections.delete(id);
  if (options.persist !== false) saveOverviewCollapsedSections();

  const section = document.querySelector(`[data-overview-section="${CSS.escape(id)}"]`);
  const body = document.querySelector(`[data-overview-body="${CSS.escape(id)}"]`);
  const toggle = document.querySelector(`[data-overview-toggle="${CSS.escape(id)}"]`);

  section?.classList.toggle("is-collapsed", collapsed);
  if (body) body.hidden = collapsed;
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute(
      "title",
      collapsed ? "Expand this overview section" : "Collapse this overview section",
    );
    const label = toggle.querySelector(".overview-collapse-label");
    if (label) label.textContent = collapsed ? "Expand" : "Collapse";
  }
  if (!collapsed && (id === "host" || id === "cores") && state.hostHistoryData) {
    requestAnimationFrame(() => renderHostHistoryInteractiveCharts());
  }
}

function applyOverviewCollapsedSections() {
  for (const id of OVERVIEW_SECTION_IDS) {
    setOverviewSectionCollapsed(id, state.overviewCollapsedSections.has(id), {
      persist: false,
    });
  }
}

function setAllOverviewSectionsCollapsed(collapsed) {
  for (const id of OVERVIEW_SECTION_IDS) {
    setOverviewSectionCollapsed(id, collapsed, { persist: false });
  }
  saveOverviewCollapsedSections();
}

const STORAGE_SECTION_IDS = ["destinations"];

function loadStorageCollapsedSections() {
  try {
    const saved = localStorage.getItem("upm:storage-collapsed-sections");
    if (saved === null) {
      const legacyOverview = JSON.parse(
        localStorage.getItem("upm:overview-collapsed-sections") || "[]",
      );
      state.storageCollapsedSections = new Set(
        Array.isArray(legacyOverview) && legacyOverview.map(String).includes("storage")
          ? ["destinations"]
          : [],
      );
      saveStorageCollapsedSections();
      return;
    }

    const raw = JSON.parse(saved || "[]");
    state.storageCollapsedSections = new Set(
      Array.isArray(raw) ? raw.map(String).filter((id) => STORAGE_SECTION_IDS.includes(id)) : [],
    );
  } catch {
    state.storageCollapsedSections = new Set();
  }
}

function saveStorageCollapsedSections() {
  try {
    localStorage.setItem(
      "upm:storage-collapsed-sections",
      JSON.stringify([...state.storageCollapsedSections]),
    );
  } catch {}
}

function setStorageSectionCollapsed(sectionId, collapsed, options = {}) {
  const id = String(sectionId || "");
  if (!STORAGE_SECTION_IDS.includes(id)) return;

  if (collapsed) state.storageCollapsedSections.add(id);
  else state.storageCollapsedSections.delete(id);
  if (options.persist !== false) saveStorageCollapsedSections();

  const section = document.querySelector(`[data-storage-section="${CSS.escape(id)}"]`);
  const body = document.querySelector(`[data-storage-body="${CSS.escape(id)}"]`);
  const toggle = document.querySelector(`[data-storage-toggle="${CSS.escape(id)}"]`);

  section?.classList.toggle("is-collapsed", collapsed);
  if (body) body.hidden = collapsed;
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("title", collapsed ? "Expand backup drives" : "Collapse backup drives");
    const label = toggle.querySelector(".storage-collapse-label");
    if (label) label.textContent = collapsed ? "Expand" : "Collapse";
  }
}

function applyStorageCollapsedSections() {
  for (const id of STORAGE_SECTION_IDS) {
    setStorageSectionCollapsed(id, state.storageCollapsedSections.has(id), {
      persist: false,
    });
  }
}

function setDashboardSectionCollapsed(sectionId, collapsed) {
  const id = String(sectionId);
  if (collapsed) state.collapsedSections.add(id);
  else state.collapsedSections.delete(id);
  saveCollapsedSections();

  const section = document.querySelector(`[data-dashboard-section="${CSS.escape(id)}"]`);
  if (!section) return;
  section.classList.toggle("is-collapsed", collapsed);
  const body = section.querySelector(".dashboard-section-body");
  if (body) body.hidden = collapsed;
  const toggle = section.querySelector(`[data-section-toggle="${CSS.escape(id)}"]`);
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "Expand section" : "Collapse section";
  }
}

function applyCollapsedSections() {
  document.querySelectorAll("[data-dashboard-section]").forEach((section) => {
    const id = String(section.dataset.dashboardSection || "");
    setDashboardSectionCollapsed(id, state.collapsedSections.has(id));
  });
}

function syncProjectGridCollapseLayout(grid = $("#projectGrid")) {
  if (!grid) return;
  const total = state.projects.length;
  let collapsedCount = 0;
  for (const project of state.projects) {
    if (state.collapsedProjects.has(String(project.id))) collapsedCount += 1;
  }
  const mixed = collapsedCount > 0 && collapsedCount < total;
  grid.classList.toggle("is-mixed-collapse-state", mixed);
  grid.classList.toggle("is-all-collapsed", total > 0 && collapsedCount === total);
  grid.classList.toggle("is-all-expanded", total > 0 && collapsedCount === 0);
}

function setProjectCollapsed(projectId, collapsed, card = null) {
  const id = String(projectId);
  if (collapsed) state.collapsedProjects.add(id);
  else state.collapsedProjects.delete(id);
  saveCollapsedProjects();
  syncProjectGridCollapseLayout();

  const target = card || document.querySelector(`.project-card[data-id="${CSS.escape(id)}"]`);
  if (!target) return;
  target.classList.toggle("is-collapsed", collapsed);
  const body = target.querySelector(".project-card-body");
  if (body) body.hidden = collapsed;
  const toggle = target.querySelector('[data-action="toggle-collapse"]');
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("title", collapsed ? "Expand Project Details" : "Collapse Project Details");
    const label = toggle.querySelector(".collapse-label");
    if (label) label.textContent = collapsed ? "Expand" : "Collapse";
  }
}

function setAllProjectsCollapsed(collapsed) {
  for (const project of state.projects) {
    if (collapsed) state.collapsedProjects.add(String(project.id));
    else state.collapsedProjects.delete(String(project.id));
  }
  saveCollapsedProjects();
  syncProjectGridCollapseLayout();
  document.querySelectorAll(".project-card[data-id]").forEach((card) => {
    const id = String(card.dataset.id);
    card.classList.toggle("is-collapsed", collapsed);
    const body = card.querySelector(".project-card-body");
    if (body) body.hidden = collapsed;
    const toggle = card.querySelector('[data-action="toggle-collapse"]');
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute(
        "title",
        collapsed ? "Expand Project Details" : "Collapse Project Details",
      );
      const label = toggle.querySelector(".collapse-label");
      if (label) label.textContent = collapsed ? "Expand" : "Collapse";
    }
  });
}

function eventProjectLabel(item) {
  const ids = [item?.projectId, ...(Array.isArray(item?.projectIds) ? item.projectIds : [])]
    .filter(Boolean)
    .map(String);
  if (!ids.length) return null;
  return [...new Set(ids)]
    .map((id) => state.projects.find((project) => String(project.id) === id)?.name || id)
    .join(", ");
}

function eventValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "-";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function openEventDetails(item, options = {}) {
  if (!item) return;
  state.eventDetails = item;
  const title = options.title || item.message || item.eventType || "Event details";
  $("#eventDetailsTitle").textContent = title;

  const severity = String(item.severity || item.level || "info").toLowerCase();
  const badgeClass =
    severity === "error"
      ? "error"
      : severity === "warning"
        ? "warning"
        : severity === "success"
          ? "success"
          : "";
  const projectLabel = eventProjectLabel(item);
  $("#eventDetailsSummary").innerHTML = `
    <span class="badge ${escapeHtml(badgeClass)}">${escapeHtml(severity)}</span>
    <strong>${escapeHtml(item.message || item.eventType || "Recorded event")}</strong>
    <span class="muted">${escapeHtml(formatDate(item.timestamp))}</span>
    ${projectLabel ? `<span class="muted">Project: ${escapeHtml(projectLabel)}</span>` : ""}
  `;

  const preferredKeys = [
    "id",
    "eventType",
    "operation",
    "source",
    "projectId",
    "projectIds",
    "processKey",
    "pm2Id",
    "name",
    "namespace",
    "previousStatus",
    "status",
    "restarts",
    "restartDelta",
    "unexpected",
    "plannedAction",
    "pm2Action",
    "pm2Event",
    "daemonPid",
    "previousDaemonPid",
    "backupFile",
    "destination",
    "destinations",
    "pendingCount",
    "recoveryRunId",
    "recoverySource",
    "recoveryPath",
    "recoveryWorkspace",
    "recoveryReport",
    "recoveredFiles",
    "failedFiles",
    "liveProjectModified",
    "errorCode",
    "errorPath",
    "error",
    "recommendation",
  ];
  const excluded = new Set(["message", "timestamp", "level", "severity", "errorStack"]);
  const keys = [
    ...preferredKeys.filter((key) => Object.prototype.hasOwnProperty.call(item, key)),
    ...Object.keys(item).filter((key) => !preferredKeys.includes(key) && !excluded.has(key)),
  ];
  $("#eventDetailsGrid").innerHTML = keys.length
    ? keys
        .map(
          (key) => `
    <div class="event-detail-row">
      <span class="meta-label">${escapeHtml(key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()))}</span>
      <pre>${escapeHtml(eventValue(item[key]))}</pre>
    </div>
  `,
        )
        .join("")
    : '<div class="empty">No additional event fields were recorded.</div>';

  const raw = JSON.stringify(item, null, 2);
  $("#eventDetailsJson").textContent = raw;
  const existingStack = $("#eventDetailsGrid").querySelector(".event-stack");
  if (existingStack) existingStack.remove();
  if (item.errorStack) {
    $("#eventDetailsGrid").insertAdjacentHTML(
      "beforeend",
      `<details class="event-stack"><summary>Stack trace</summary><pre>${escapeHtml(item.errorStack)}</pre></details>`,
    );
  }
  $("#eventDetailsDialog").showModal();
}

function directoryPickerFieldLabel(targetId) {
  return (
    {
      projectRoot: "project path",
      backupDir: "primary backup path",
      backupDirSecondary: "secondary backup path",
      discoverRoots: "discovery parent folders",
      restoreDestination: "restore folder",
      fileToolsSourceRoot: "File Tools source folder",
      fileToolsOutputRoot: "File Tools output folder",
    }[targetId] || "directory path"
  );
}

function directoryLocationIcon(kind) {
  return (
    {
      home: "⌂",
      manager: "UPM",
      backup: "B",
      restore: "R",
      drive: "D",
      root: "/",
    }[kind] || "▸"
  );
}

function renderDirectoryQuickLocations(roots = []) {
  const container = $("#directoryQuickLocations");
  const selected = String(state.directoryPicker.currentPath || "");
  const normalize = (value) =>
    state.directoryPicker.platform === "win32"
      ? String(value || "").toLowerCase()
      : String(value || "");
  container.innerHTML = roots.length
    ? roots
        .map((root) => {
          const active = normalize(root.path) === normalize(selected);
          return `<button type="button" class="directory-quick-button${active ? " is-active" : ""}" data-directory-root="${escapeHtml(root.path)}"${active ? ' aria-current="location"' : ""}><span class="directory-location-icon" aria-hidden="true">${escapeHtml(directoryLocationIcon(root.kind))}</span><span class="directory-location-copy"><strong>${escapeHtml(root.name)}</strong><small class="path">${escapeHtml(root.path)}</small></span></button>`;
        })
        .join("")
    : '<span class="muted">No quick locations are currently available.</span>';
}

function renderDirectoryBrowser(result) {
  state.directoryPicker.currentPath = result.currentPath || null;
  state.directoryPicker.parentPath = result.parentPath || null;
  state.directoryPicker.roots = result.roots || [];
  state.directoryPicker.platform = result.platform || state.directoryPicker.platform;
  renderDirectoryQuickLocations(state.directoryPicker.roots);

  $("#directoryPathInput").value = result.currentPath || $("#directoryPathInput").value || "";
  $("#directoryCurrentPath").textContent =
    result.currentPath || "Choose a quick location or enter an absolute path.";
  $("#directoryUpBtn").disabled = !result.parentPath;
  $("#directoryUseBtn").disabled = !result.currentPath;
  $("#directoryNewFolderBtn").disabled = !result.currentPath;
  $("#directoryPlatformLabel").textContent =
    result.platform === "win32"
      ? "Windows"
      : result.platform === "darwin"
        ? "macOS"
        : result.platform === "linux"
          ? "Linux"
          : "Local";

  const directories = result.directories || [];
  $("#directoryBrowserSummary").textContent = result.currentPath
    ? `${directories.length} ${directories.length === 1 ? "folder" : "folders"}`
    : "Choose a location";
  if (!result.currentPath) {
    $("#directoryList").innerHTML =
      '<div class="empty">Choose a quick location or enter an absolute path to begin browsing.</div>';
    return;
  }
  $("#directoryList").innerHTML = directories.length
    ? directories
        .map(
          (entry) =>
            `<button type="button" class="directory-entry" data-directory-path="${escapeHtml(entry.path)}"><span class="directory-folder-icon" aria-hidden="true">▸</span><span class="directory-entry-name">${escapeHtml(entry.name)}</span><span class="directory-entry-path path">${escapeHtml(entry.path)}</span></button>`,
        )
        .join("")
    : '<div class="empty">This folder has no visible subfolders.</div>';
}

async function browseDirectory(directoryPath = null) {
  closeDirectoryCreatePanel();
  $("#directoryList").innerHTML = '<div class="empty">Loading folders…</div>';
  $("#directoryBrowserSummary").textContent = "Loading…";
  const params = new URLSearchParams();
  if (directoryPath) params.set("path", directoryPath);
  if ($("#directoryShowHidden").checked) params.set("showHidden", "true");
  try {
    const data = await api(`/api/filesystem/browse${params.size ? `?${params}` : ""}`);
    renderDirectoryBrowser(data.result);
  } catch (error) {
    $("#directoryBrowserSummary").textContent = "Unable to browse";
    $("#directoryList").innerHTML =
      '<div class="empty">Unable to load this folder. Check the path and filesystem permissions.</div>';
    throw error;
  }
}

async function openDirectoryPicker(targetId, mode = "replace") {
  const target = document.getElementById(targetId);
  if (!target) return;

  let startPath = "";
  if (mode === "append-lines") {
    const values = String(target.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    startPath = values.at(-1) || "";
  } else {
    startPath = String(target.value || "").trim();
  }

  if (window.upmDesktop?.selectDirectory) {
    const selectedPath = await window.upmDesktop.selectDirectory({
      title: `Choose ${directoryPickerFieldLabel(targetId)}`,
      defaultPath: startPath || undefined,
    });
    if (!selectedPath) return;
    if (mode === "append-lines") {
      const values = String(target.value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const normalize = (value) =>
        window.upmDesktop.platform === "win32" ? String(value).toLowerCase() : String(value);
      if (!values.some((value) => normalize(value) === normalize(selectedPath)))
        values.push(selectedPath);
      target.value = values.join("\n");
    } else {
      target.value = selectedPath;
    }
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  state.directoryPicker.targetId = targetId;
  state.directoryPicker.mode = mode;
  state.directoryPicker.currentPath = null;
  state.directoryPicker.parentPath = null;
  $("#directoryPickerTitle").textContent = `Choose ${directoryPickerFieldLabel(targetId)}`;
  $("#directoryPickerTargetHint").textContent =
    mode === "append-lines"
      ? "The selected folder will be added as a new line."
      : "The selected folder will replace the current field value.";
  $("#directoryShowHidden").checked = false;
  closeDirectoryCreatePanel();
  $("#directoryPathInput").value = startPath;
  $("#directoryPickerDialog").showModal();

  try {
    await browseDirectory(startPath || null);
  } catch (error) {
    toast(error.message, true);
    $("#directoryPathInput").value = startPath;
    await browseDirectory(null);
  }
}

function closeDirectoryCreatePanel() {
  const panel = $("#directoryCreatePanel");
  if (!panel) return;
  panel.hidden = true;
  $("#directoryNewFolderName").value = "";
}

function openDirectoryCreatePanel() {
  if (!state.directoryPicker.currentPath) return;
  const panel = $("#directoryCreatePanel");
  panel.hidden = false;
  const input = $("#directoryNewFolderName");
  input.value = "";
  input.focus();
}

async function createDirectoryFromPicker() {
  const parentPath = state.directoryPicker.currentPath;
  const name = $("#directoryNewFolderName").value.trim();
  if (!parentPath || !name) return;
  const button = $("#directoryCreateFolderBtn");
  button.disabled = true;
  try {
    const data = await api("/api/filesystem/mkdir", {
      method: "POST",
      body: JSON.stringify({ parentPath, name }),
    });
    toast("Folder created.");
    closeDirectoryCreatePanel();
    await browseDirectory(data.result.path);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function applyDirectorySelection() {
  const { targetId, mode, currentPath } = state.directoryPicker;
  const target = document.getElementById(targetId);
  if (!target || !currentPath) return;
  if (mode === "append-lines") {
    const current = String(target.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const normalize = (value) =>
      state.directoryPicker.platform === "win32" ? value.toLowerCase() : value;
    const key = normalize(currentPath);
    if (!current.some((item) => normalize(item) === key)) current.push(currentPath);
    target.value = current.join("\n");
  } else {
    target.value = currentPath;
  }
  target.dispatchEvent(new Event("change", { bubbles: true }));
  $("#directoryPickerDialog").close();
}

function overviewMetric(label, value, tone = "") {
  return `<div class="overview-metric${tone ? ` tone-${escapeHtml(tone)}` : ""}"><span class="meta-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderStats(status, storage) {
  const projects = state.projects || [];
  const monitoredProjects = projects.filter((project) => project.serviceHealth?.enabled);
  const serviceWarnings = monitoredProjects.filter((project) =>
    ["degraded", "unhealthy"].includes(project.serviceHealthStatus?.status),
  ).length;
  const mirrorWarnings = Number(storage.mirrorWarnings || 0);
  const diagnosticsErrors = Number(status.diagnostics24h?.errors || 0);

  const groups = [
    {
      eyebrow: "PROJECTS",
      title: "Project operations",
      metrics: [
        ["Registered", status.projectCount],
        ["Running jobs", status.running ?? 0],
        ["Change watchers", status.watching],
        ["Scheduled", status.scheduled],
      ],
    },
    {
      eyebrow: "BACKUPS",
      title: "Backup health",
      metrics: [
        ["Logical backups", storage.totalBackups],
        ["Stored copies", storage.totalCopies ?? storage.totalBackups],
        ["Fully verified", `${storage.verifiedCount}/${storage.totalBackups}`],
        [
          "Mirror health",
          `${storage.mirroredProjects ?? 0} configured · ${mirrorWarnings} warning(s)`,
          mirrorWarnings ? "warning" : "success",
        ],
      ],
    },
    {
      eyebrow: "RUNTIME",
      title: "PM2 & services",
      metrics: [
        [
          "PM2 online",
          status.pm2?.available ? `${status.pm2.online}/${status.pm2.processCount}` : "Unavailable",
          status.pm2?.available ? "success" : "warning",
        ],
        ["PM2 crashes · 24h", status.pm2Health24h?.crashes ?? 0],
        ["Unexpected restarts · 24h", status.pm2Health24h?.unexpectedRestarts ?? 0],
        [
          "Docker daemon",
          status.dockerRuntime?.daemonReady
            ? `Ready${status.dockerRuntime.serverVersion ? ` · v${status.dockerRuntime.serverVersion}` : ""}`
            : status.dockerRuntime?.running
              ? "Starting"
              : status.dockerRuntime?.checkedAt
                ? "Stopped"
                : "Unknown",
          status.dockerRuntime?.daemonReady
            ? "success"
            : status.dockerRuntime?.running
              ? "warning"
              : "error",
        ],
        [
          "Service monitors",
          monitoredProjects.length
            ? `${monitoredProjects.length} project(s) · ${serviceWarnings} warning(s)`
            : "Not enabled",
          serviceWarnings ? "warning" : monitoredProjects.length ? "success" : "",
        ],
      ],
    },
    {
      eyebrow: "DIAGNOSTICS",
      title: "Recent health",
      metrics: [
        [
          "Warnings · 24h",
          status.diagnostics24h?.warnings ?? 0,
          Number(status.diagnostics24h?.warnings || 0) ? "warning" : "success",
        ],
        ["Errors · 24h", diagnosticsErrors, diagnosticsErrors ? "error" : "success"],
        ["PM2 daemon restarts · 24h", status.pm2Health24h?.daemonRestarts ?? 0],
        ["Managed archive data", formatBytes(storage.totalBytes)],
      ],
    },
  ];

  $("#stats").innerHTML = groups
    .map(
      (group) => `<article class="overview-summary-card">
        <div class="overview-summary-card-heading"><span class="eyebrow">${escapeHtml(group.eyebrow)}</span><h4>${escapeHtml(group.title)}</h4></div>
        <div class="overview-summary-metrics">${group.metrics
          .map(([label, value, tone]) => overviewMetric(label, value, tone))
          .join("")}</div>
      </article>`,
    )
    .join("");
}

function hostPercent(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "-";
}

function renderHostStats(host = {}, dockerRuntime = {}) {
  const cpu =
    host.cpuPercent === null || host.cpuPercent === undefined ? null : Number(host.cpuPercent);
  const memory =
    host.memoryPercent === null || host.memoryPercent === undefined
      ? null
      : Number(host.memoryPercent);
  const loadAverage = Array.isArray(host.loadAverage)
    ? host.loadAverage
        .slice(0, 3)
        .map((value) => Number(value).toFixed(2))
        .join(" · ")
    : "-";
  const cards = [
    ["Overall CPU", hostPercent(host.cpuPercent), Number.isFinite(cpu) ? cpu : null],
    [
      "Memory usage",
      `${hostPercent(host.memoryPercent)} · ${formatBytes(host.usedMemoryBytes)} / ${formatBytes(host.totalMemoryBytes)}`,
      Number.isFinite(memory) ? memory : null,
    ],
    ["System uptime", formatDuration(host.systemUptimeMs)],
    ["UPM uptime", formatDuration(host.processUptimeMs)],
    [
      "UPM memory",
      `${formatBytes(host.processRssBytes)} RSS · ${formatBytes(host.processHeapUsedBytes)} heap`,
    ],
    ["Load average", loadAverage],
    ["Processor", `${host.cpuModel || "Unknown"} · ${host.logicalCpus || 0} logical`],
    [
      "Host",
      `${host.hostname || "-"} · ${host.platform || "-"} ${host.release || ""} · ${host.arch || "-"}`,
    ],
    [
      "Docker runtime",
      dockerRuntime.daemonReady
        ? `${dockerRuntime.runtime || "Docker"} Ready${dockerRuntime.serverVersion ? ` · v${dockerRuntime.serverVersion}` : ""}`
        : dockerRuntime.running
          ? `${dockerRuntime.runtime || "Docker"} Starting`
          : dockerRuntime.checkedAt
            ? `${dockerRuntime.runtime || "Docker"} Stopped`
            : "Unknown",
    ],
    [
      "Docker service",
      dockerRuntime.platform === "win32"
        ? dockerRuntime.serviceRunning === true
          ? "com.docker.service Running"
          : dockerRuntime.desktopProcessRunning === true
            ? "Docker Desktop Process Running"
            : dockerRuntime.serviceInstalled === false
              ? "Service Not Installed"
              : "Not Running"
        : dockerRuntime.serviceRunning === true
          ? "docker.service Running"
          : dockerRuntime.serviceState || "Not Running",
    ],
    ["Node", host.nodeVersion || "-"],
  ];
  $("#hostStats").innerHTML = cards
    .map(([label, value, meter]) => {
      const meterValue = Number.isFinite(meter)
        ? Math.max(0, Math.min(100, meter)).toFixed(1)
        : null;
      const meterHtml =
        meterValue !== null
          ? `<progress class="host-meter" value="${meterValue}" max="100" aria-label="${escapeHtml(label)}">${meterValue}%</progress>`
          : "";
      return `<div class="host-stat"><span class="meta-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${meterHtml}</div>`;
    })
    .join("");
}

function historyValues(points, getter) {
  return (points || [])
    .map((point) => {
      const raw = getter(point);
      if (raw === null || raw === undefined || raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? { timestamp: point.timestamp, value } : null;
    })
    .filter(Boolean);
}

function hostHistoryChartFromValues(values, label, meta = "", options = {}) {
  if (values.length < 2) {
    return `<div class="host-chart-panel${options.className ? ` ${escapeHtml(options.className)}` : ""}"><div class="host-chart-heading"><strong>${escapeHtml(label)}</strong><span class="muted">Collecting samples…</span></div><div class="host-chart-empty">History appears after the next samples are recorded.</div></div>`;
  }
  const chartId = `host-history-chart-${state.hostChartDefinitions.length + 1}`;
  state.hostChartDefinitions.push({
    id: chartId,
    label,
    values,
    formatter: options.formatter || hostPercent,
    yMax: Number.isFinite(options.yMax) ? options.yMax : 100,
    minHeight: Number.isFinite(options.minHeight) ? options.minHeight : 150,
  });
  const summary = meta || hostPercent(values.at(-1)?.value);
  return `<div class="host-chart-panel interactive-chart-panel${options.className ? ` ${escapeHtml(options.className)}` : ""}"><div class="host-chart-heading"><strong>${escapeHtml(label)}</strong><span class="muted">${escapeHtml(summary)}</span></div><canvas id="${chartId}" class="host-chart interactive-chart" aria-label="${escapeHtml(label)} history"></canvas></div>`;
}

function hostHistoryChart(points, key, label) {
  return hostHistoryChartFromValues(
    historyValues(points, (point) => point[key]),
    label,
  );
}

function hostCoreHistoryChart(points, coreSummary = {}) {
  const index = Number(coreSummary.index || 0);
  const values = historyValues(points, (point) => point.coreCpuPercent?.[index]);
  const summaryText = Number.isFinite(coreSummary.average)
    ? `Avg ${hostPercent(coreSummary.average)} · Peak ${hostPercent(coreSummary.max)}`
    : "Collecting samples…";
  return hostHistoryChartFromValues(values, `Core ${index + 1}`, summaryText, {
    className: "host-core-chart-panel",
    minHeight: 126,
  });
}

function renderHostHistoryInteractiveCharts() {
  for (const definition of state.hostChartDefinitions || []) {
    const canvas = $(`#${definition.id}`);
    if (!canvas) continue;
    const points = definition.values.map((item) => ({
      timestamp: item.timestamp,
      value: item.value,
    }));
    drawLineChart(canvas, points, [{ key: "value", label: "Usage" }], definition.formatter, {
      minValue: 0,
      maxValue: definition.yMax,
      minMax: definition.yMax,
      minHeight: definition.minHeight,
      showLegend: false,
    });
  }
}

function renderHostHistory(history = {}) {
  state.hostHistoryData = history;
  state.hostChartDefinitions = [];
  const summary = history.summary || {};
  const rangeLabel = `${history.hours || 24}h`;
  const formatSummary = (item) =>
    item && Number.isFinite(item.average)
      ? `Avg ${hostPercent(item.average)} · Min ${hostPercent(item.min)} · Max ${hostPercent(item.max)}`
      : "Collecting samples…";
  $("#hostHistorySummary").innerHTML = `
    <div><span class="meta-label">Overall CPU · ${escapeHtml(rangeLabel)}</span><strong>${escapeHtml(formatSummary(summary.cpuPercent))}</strong></div>
    <div><span class="meta-label">Memory · ${escapeHtml(rangeLabel)}</span><strong>${escapeHtml(formatSummary(summary.memoryPercent))}</strong></div>`;
  $("#hostHistoryCharts").innerHTML = [
    hostHistoryChart(history.points, "cpuPercent", "Overall CPU history"),
    hostHistoryChart(history.points, "memoryPercent", "Memory history"),
  ].join("");

  const coreSummary = Array.isArray(summary.coreCpuPercent) ? summary.coreCpuPercent : [];
  const coreContainer = $("#hostCoreCharts");
  const coreLabel = $("#hostCoreSummary");
  if (coreLabel)
    coreLabel.textContent = coreSummary.length
      ? `${coreSummary.length} logical processors · ${rangeLabel}`
      : `Per-core samples begin after upgrade · ${rangeLabel}`;
  if (coreContainer)
    coreContainer.innerHTML = coreSummary.length
      ? coreSummary.map((item) => hostCoreHistoryChart(history.points, item)).join("")
      : '<div class="host-core-empty muted">Per-core history will appear as new host samples are collected.</div>';

  renderHostHistoryInteractiveCharts();
}

async function loadHostHistory(hours = null) {
  const selected = hours || $("#hostHistoryRange")?.value || 24;
  const data = await api(`/api/host-stats/history?hours=${encodeURIComponent(selected)}`);
  renderHostHistory(data.history || {});
}

function filesystemPercent(fs = {}) {
  const total = Number(fs.totalBytes);
  const available = Number(fs.availableBytes);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return null;
  return Math.max(0, Math.min(100, ((total - available) / total) * 100));
}

function storageDestinationCard(item, kind) {
  const fs = item.filesystem || {};
  const knownDisk =
    Number.isFinite(Number(fs.totalBytes)) && Number.isFinite(Number(fs.availableBytes));
  const usedPercent = filesystemPercent(fs);
  const available = knownDisk
    ? `${formatBytes(fs.availableBytes)} free of ${formatBytes(fs.totalBytes)}`
    : "Capacity unavailable";
  const status = knownDisk ? "Available" : "Unavailable";
  const statusClass = knownDisk ? "success" : "warning";
  const host = item.host || "This PC";
  const error = fs.error || item.error || null;
  return `<article class="storage-drive-card drive-${escapeHtml(kind)}">
    <div class="storage-drive-card-heading">
      <div><span class="badge ${kind === "secondary" ? "warning" : ""}">${escapeHtml(kind === "secondary" ? "Secondary Mirror" : "Primary")}</span><h5>${escapeHtml(item.projectName || "Project")}</h5></div>
      <span class="badge ${statusClass}">${escapeHtml(status)}</span>
    </div>
    <div class="storage-drive-path"><span class="meta-label">${escapeHtml(host)}${fs.root ? ` · ${escapeHtml(fs.root)}` : ""}</span><strong class="path">${escapeHtml(item.backupDir || fs.path || "-")}</strong></div>
    <div class="storage-drive-metrics">
      <div><span class="meta-label">Disk capacity</span><strong>${escapeHtml(available)}</strong></div>
      <div><span class="meta-label">Disk used</span><strong>${Number.isFinite(usedPercent) ? `${usedPercent.toFixed(1)}%` : "-"}</strong></div>
      <div><span class="meta-label">Backup copies</span><strong>${escapeHtml(item.backupCount ?? 0)}</strong></div>
      <div><span class="meta-label">Archive data</span><strong>${escapeHtml(formatBytes(item.totalBytes || 0))}</strong></div>
    </div>
    ${Number.isFinite(usedPercent) ? `<progress class="drive-meter" value="${usedPercent.toFixed(1)}" max="100" aria-label="Disk used">${usedPercent.toFixed(1)}%</progress>` : ""}
    ${error ? `<p class="storage-drive-warning">${escapeHtml(error)}</p>` : ""}
  </article>`;
}

function storageDestinations(storage = {}) {
  const rows = [];
  for (const projectStorage of storage.projects || []) {
    const project = (state.projects || []).find(
      (candidate) => candidate.id === projectStorage.projectId,
    );
    const host =
      project?.executionTarget === "lan"
        ? project.remoteAgent?.name || project.remoteAgentId || "LAN agent"
        : "This PC";
    const destinations = Array.isArray(projectStorage.destinations)
      ? [...projectStorage.destinations]
      : [];
    if (
      projectStorage.backupDirSecondary &&
      !destinations.some((item) => item.key === "secondary")
    ) {
      destinations.push({
        key: "secondary",
        label: "Secondary",
        backupDir: projectStorage.backupDirSecondary,
        backupCount: 0,
        totalBytes: 0,
        error: projectStorage.error || "Secondary destination details unavailable.",
      });
    }
    for (const destination of destinations) {
      rows.push({
        ...destination,
        projectId: projectStorage.projectId,
        projectName: projectStorage.projectName || project?.name || "Project",
        host,
      });
    }
  }
  return rows;
}

function renderBackupStorage(storage = {}) {
  const destinations = storageDestinations(storage);
  const primary = destinations.filter((item) => item.key !== "secondary");
  const secondary = destinations.filter((item) => item.key === "secondary");
  const availableSecondary = secondary.filter(
    (item) =>
      Number.isFinite(Number(item.filesystem?.totalBytes)) &&
      Number.isFinite(Number(item.filesystem?.availableBytes)),
  ).length;
  const rootFs = storage.filesystem || {};
  const rootAvailable = Number.isFinite(Number(rootFs.availableBytes))
    ? formatBytes(rootFs.availableBytes)
    : "Unavailable";

  const summary = $("#storageBackupSummary");
  if (summary)
    summary.innerHTML = [
      ["Managed archive data", formatBytes(storage.totalBytes)],
      ["Stored copies", storage.totalCopies ?? storage.totalBackups ?? 0],
      ["Backup root free", rootAvailable],
      [
        "Secondary mirrors",
        secondary.length
          ? `${availableSecondary}/${secondary.length} reporting capacity`
          : "Not configured",
      ],
      ["Mirror warnings", storage.mirrorWarnings ?? 0],
    ]
      .map(
        ([label, value]) =>
          `<div><span class="meta-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
      )
      .join("");

  const list = $("#storageDriveList");
  if (!list) return;
  const secondaryHtml = secondary.length
    ? secondary.map((item) => storageDestinationCard(item, "secondary")).join("")
    : '<div class="storage-drive-empty">No secondary backup destinations are configured. Add one per project to mirror verified backups to another drive, NAS, or approved LAN-agent path.</div>';
  const primaryHtml = primary.length
    ? primary.map((item) => storageDestinationCard(item, "primary")).join("")
    : '<div class="storage-drive-empty">No primary backup destination details are available yet.</div>';
  list.innerHTML = `
    <section class="storage-drive-group">
      <div class="storage-drive-group-heading"><div><span class="meta-label">PRIMARY</span><h4>Primary backup destinations</h4></div><span class="muted">Committed first</span></div>
      <div class="storage-drive-grid">${primaryHtml}</div>
    </section>
    <section class="storage-drive-group">
      <div class="storage-drive-group-heading"><div><span class="meta-label">SECONDARY</span><h4>Mirror destinations</h4></div><span class="muted">Optional / best-effort</span></div>
      <div class="storage-drive-grid">${secondaryHtml}</div>
    </section>`;
}

function renderStorage(storage) {
  const fs = storage.filesystem || {};
  const knownDisk =
    Number.isFinite(Number(fs.totalBytes)) && Number.isFinite(Number(fs.availableBytes));
  const usedPercent = filesystemPercent(fs);
  $("#storageDetails").innerHTML = `<div class="storage-grid">
    <div><span class="meta-label">Managed archive copies</span><strong>${escapeHtml(formatBytes(storage.totalBytes))}</strong></div>
    <div><span class="meta-label">Logical backups</span><strong>${escapeHtml(storage.totalBackups)}</strong></div>
    <div><span class="meta-label">Stored copies</span><strong>${escapeHtml(storage.totalCopies ?? storage.totalBackups)}</strong></div>
    <div><span class="meta-label">Mirrors</span><strong>${escapeHtml(storage.mirroredProjects ?? 0)} configured · ${escapeHtml(storage.mirrorWarnings ?? 0)} warning(s)</strong></div>
    <div><span class="meta-label">Verification</span><strong>${escapeHtml(storage.verifiedCount)} verified · ${escapeHtml(storage.failedVerificationCount)} failed · ${escapeHtml(storage.unverifiedCount)} unverified</strong></div>
    <div><span class="meta-label">Backup root</span><strong class="path">${escapeHtml(fs.path || "-")}</strong></div>
    <div><span class="meta-label">Disk available</span><strong>${knownDisk ? `${formatBytes(fs.availableBytes)} of ${formatBytes(fs.totalBytes)}` : "Unavailable"}</strong></div>
    <div><span class="meta-label">Disk used</span><strong>${Number.isFinite(usedPercent) ? `${usedPercent.toFixed(1)}%` : "-"}</strong></div>
  </div>`;
}

function storageForProject(projectId) {
  return state.storage?.projects?.find((item) => item.projectId === projectId) || null;
}

function changeCounts(project) {
  const changes = project.runtime?.lastResult?.changes || {};
  return {
    added: changes.added?.length || 0,
    modified: changes.modified?.length || 0,
    deleted: changes.deleted?.length || 0,
  };
}

function projectStatus(project) {
  if (project.runtime?.running) return ["Running", "warning"];
  if (project.runtime?.lastError?.partial) return ["Mirror Warning", "warning"];
  if (project.runtime?.lastError) return ["Error", "error"];
  if (project.watch && project.schedule?.enabled) return ["Watching + Scheduled", "success"];
  if (project.watch) return ["Watching", "success"];
  if (project.schedule?.enabled) return ["Scheduled", "success"];
  return ["Manual", ""];
}

function pm2StatusBadge(pm2) {
  if (!pm2?.monitored) return '<span class="badge">PM2 Disabled</span>';
  if (!pm2?.available) return '<span class="badge">PM2 Unavailable</span>';
  if (pm2.status === "online") return '<span class="badge success">PM2 Online</span>';
  if (pm2.status === "degraded") return '<span class="badge warning">PM2 Degraded</span>';
  if (pm2.status === "none") return '<span class="badge">No PM2 Match</span>';
  return `<span class="badge">PM2 ${escapeHtml(pm2.status || "unknown")}</span>`;
}

function pm2ProcessKey(proc) {
  return `${proc.namespace || "default"}:${proc.name || "unknown"}:${Number.isFinite(Number(proc.id)) ? Number(proc.id) : "na"}`;
}

function pm2ProcessStatusClass(status) {
  const value = String(status || "unknown").toLowerCase();
  if (value === "online") return "success";
  if (["errored", "error"].includes(value)) return "error";
  if (["stopped", "offline"].includes(value)) return "stopped";
  if (["launching", "stopping", "waiting restart", "one-launch-status"].includes(value))
    return "warning";
  return "neutral";
}

function collapsedPm2CardClass(pm2) {
  if (!pm2?.monitored || !pm2?.available || !pm2?.processes?.length) return "collapsed-pm2-neutral";
  const classes = pm2.processes.map((proc) => pm2ProcessStatusClass(proc.status));
  if (classes.includes("error")) return "collapsed-pm2-error";
  if (classes.includes("warning")) return "collapsed-pm2-warning";
  if (classes.includes("stopped")) return "collapsed-pm2-stopped";
  if (classes.every((value) => value === "success")) return "collapsed-pm2-success";
  return "collapsed-pm2-neutral";
}

function formatProcessCpu(proc) {
  const value = Number(proc?.cpuPercent ?? proc?.cpu);
  return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 1 : 2)}%` : "-";
}

function processCpuTitle(proc) {
  const raw = Number(proc?.cpuRawPercent);
  const normalized = Number(proc?.cpuPercent ?? proc?.cpu);
  const cores = Number(proc?.cpuLogicalCpus);
  if (!Number.isFinite(raw) || !Number.isFinite(normalized) || !Number.isFinite(cores)) return "";
  return `Normalized total-host CPU: ${normalized.toFixed(2)}%. PM2 raw CPU: ${raw.toFixed(2)}% across ${cores} logical CPUs.`;
}

function formatGpuMetric(proc) {
  const value = Number(proc?.gpuPercent);
  return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 1 : 2)}%` : "-";
}

function gpuTelemetryTitle(pm2) {
  if (pm2?.gpu?.available)
    return `Per-process GPU telemetry source: ${pm2.gpu.source || "system provider"}.`;
  return pm2?.gpu?.error || "Per-process GPU telemetry is unavailable on this host.";
}

function formatHttpRate(proc) {
  const perSecond = Number(proc?.httpRequestsPerSecond);
  const perMinute = Number(proc?.httpRequestsPerMinute);
  if (Number.isFinite(perSecond) && perSecond >= 1) return `${perSecond.toFixed(1)} req/s`;
  if (Number.isFinite(perMinute)) return `${perMinute.toFixed(perMinute >= 10 ? 0 : 1)} req/min`;
  if (Number.isFinite(perSecond)) return `${perSecond.toFixed(2)} req/s`;
  return "-";
}

function formatLatency(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number >= 10 ? 0 : 1)} ms` : "-";
}

function hasHttpProcessMetrics(proc) {
  return [
    proc?.httpRequestsPerSecond,
    proc?.httpRequestsPerMinute,
    proc?.httpMeanLatencyMs,
    proc?.httpP95LatencyMs,
    proc?.activeRequests,
  ].some((value) => Number.isFinite(Number(value)));
}

function formatHeapMetric(proc) {
  const used = Number(proc?.heapUsedBytes);
  const total = Number(proc?.heapTotalBytes);
  const percent = Number(proc?.heapUsagePercent);
  if (!Number.isFinite(used) && !Number.isFinite(total) && !Number.isFinite(percent)) return "-";

  const parts = [];
  if (Number.isFinite(used)) parts.push(formatBytes(used));
  if (Number.isFinite(total)) parts.push(`/ ${formatBytes(total)}`);
  let value = parts.join(" ");
  if (Number.isFinite(percent)) value += `${value ? " " : ""}(${percent.toFixed(1)}%)`;
  return value || "-";
}

function compactMetric(label, value, className = "", title = "") {
  return `<span class="collapsed-process-metric${className ? ` ${className}` : ""}"${title ? ` title="${escapeHtml(title)}"` : ""}><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
}

function renderCollapsedPm2Summary(pm2, project = null, openMenus = new Set()) {
  if (!pm2?.monitored) {
    return '<div class="project-collapsed-pm2 empty-state"><span class="badge">PM2 Disabled</span><span class="muted">Enable PM2 monitoring to show live process usage.</span></div>';
  }
  if (!pm2?.available) {
    return `<div class="project-collapsed-pm2 empty-state"><span class="badge warning">PM2 Unavailable</span><span class="muted">${escapeHtml(pm2?.error || "PM2 CLI is not available.")}</span></div>`;
  }
  if (!pm2?.processes?.length) {
    if (project?.pm2AutoStart) {
      const attempt = project.runtime?.pm2AutoStart;
      const failed = attempt?.state === "failed";
      const waitingForDocker = attempt?.state === "waiting-for-docker";
      const label = failed
        ? "Auto-Start Failed"
        : waitingForDocker
          ? "Waiting For Docker"
          : "Auto-Start Armed";
      const message =
        failed || waitingForDocker
          ? attempt?.message
          : `Waiting for PM2 match · ${project.pm2EcosystemFile || "ecosystem.config.js"}`;
      return `<div class="project-collapsed-pm2 empty-state"><span class="badge ${failed ? "error" : "warning"}">${label}</span><span class="muted">${escapeHtml(message || "Waiting for Docker daemon readiness.")}</span></div>`;
    }
    return '<div class="project-collapsed-pm2 empty-state"><span class="badge">No PM2 Match</span><span class="muted">No PM2 process is currently matched to this project.</span></div>';
  }

  return `<div class="project-collapsed-pm2" title="PM2 checked ${escapeHtml(formatDate(pm2.checkedAt))}">${pm2.processes
    .map((proc) => {
      const statusClass = pm2ProcessStatusClass(proc.status);
      const optional = [];
      if (Number.isFinite(Number(proc.eventLoopLatencyP95Ms)))
        optional.push(
          compactMetric("Loop p95", `${Number(proc.eventLoopLatencyP95Ms).toFixed(1)} ms`),
        );
      if (Number.isFinite(Number(proc.activeHandles)))
        optional.push(compactMetric("Handles", String(Math.round(Number(proc.activeHandles)))));
      if (Number.isFinite(Number(proc.gpuPercent)))
        optional.push(compactMetric("GPU", formatGpuMetric(proc)));
      if (hasHttpProcessMetrics(proc)) {
        if (Number.isFinite(Number(proc.httpRequestsPerSecond)))
          optional.push(compactMetric("HTTP", formatHttpRate(proc)));
        if (Number.isFinite(Number(proc.httpP95LatencyMs)))
          optional.push(compactMetric("HTTP p95", formatLatency(proc.httpP95LatencyMs)));
      }

      const remote = project?.executionTarget === "lan";
      const pm2MenuKey = pm2ActionMenuKey(
        project?.id || "unknown",
        pm2ProcessKey(proc),
        "collapsed",
      );
      const controls =
        !remote && project?.pm2ControlsEnabled
          ? `<details class="action-menu pm2-control-menu collapsed-pm2-control-menu"${menuOpenAttribute(openMenus, pm2MenuKey)}>
            <summary class="button small">Process Control</summary>
            <div class="action-menu-panel pm2-control-menu-panel">
              <div class="action-menu-group">
                ${proc.status === "online" ? `<button type="button" class="button small" data-pm2-action="restart" data-pm2-id="${escapeHtml(proc.id)}">Restart</button><button type="button" class="button small" data-pm2-action="reload" data-pm2-id="${escapeHtml(proc.id)}">Reload</button><button type="button" class="button danger small" data-pm2-action="stop" data-pm2-id="${escapeHtml(proc.id)}">Stop</button>` : `<button type="button" class="button primary small" data-pm2-action="start" data-pm2-id="${escapeHtml(proc.id)}">Start</button>`}
                <button type="button" class="button small" data-pm2-action="reset" data-pm2-id="${escapeHtml(proc.id)}">Reset Restarts</button>
              </div>
            </div>
          </details>`
          : !remote
            ? '<span class="collapsed-process-control-note muted">Process Control Disabled</span>'
            : "";
      const actions = remote
        ? '<div class="collapsed-process-actions"><span class="badge">Remote Read-Only</span></div>'
        : `<div class="collapsed-process-actions">
            <button type="button" class="button small" data-action="pm2-logs" data-upm-icon="pm2" data-pm2-id="${escapeHtml(proc.id)}">Log</button>
            <button type="button" class="button small" data-action="pm2-history" data-upm-icon="pm2" data-process-key="${escapeHtml(pm2ProcessKey(proc))}">Health History</button>
            ${controls}
          </div>`;

      return `<div class="collapsed-process status-${statusClass}" data-pm2-process-key="${escapeHtml(pm2ProcessKey(proc))}">
      <div class="collapsed-process-main">
        <div class="collapsed-process-name"><strong>${escapeHtml(proc.namespace && proc.namespace !== "default" ? `${proc.namespace}/${proc.name}` : proc.name)}</strong><span class="badge ${statusClass === "stopped" || statusClass === "neutral" ? "" : statusClass}">${escapeHtml(proc.status || "unknown")}</span></div>
        <div class="collapsed-process-metrics">
          ${compactMetric("CPU", formatProcessCpu(proc), "", processCpuTitle(proc))}
          ${compactMetric("RSS", formatBytes(proc.memoryBytes))}
          ${compactMetric("Heap", formatHeapMetric(proc), "heap")}
          ${compactMetric("Uptime", formatDuration(proc.uptimeMs))}
          ${compactMetric("Restarts", String(proc.restarts ?? 0))}
          ${compactMetric("PID", proc.pid ? String(proc.pid) : "-")}
          ${optional.join("")}
        </div>
        ${actions}
      </div>
    </div>`;
    })
    .join("")}</div>`;
}

function renderCollapsedServiceSummary(project) {
  const config = project?.serviceHealth || {};
  if (!config.enabled) return "";

  const health = project.serviceHealthStatus;
  const configured = (config.services || []).filter((service) => service.enabled !== false);
  const results = (health?.services || []).filter((service) => service.status !== "disabled");
  const summary = health?.summary;
  const summaryText = summary
    ? `${summary.healthy || 0} Healthy · ${summary.degraded || 0} Degraded · ${summary.unhealthy || 0} Down`
    : `${configured.length} Configured · Pending First Check`;
  const services = results.length
    ? `<div class="collapsed-service-list">${results
        .map((service) => {
          const latency = Number.isFinite(Number(service.latencyMs))
            ? `<span class="collapsed-service-latency">${escapeHtml(Number(service.latencyMs))} ms</span>`
            : "";
          return `<div class="collapsed-service-item"><strong>${escapeHtml(service.name)}</strong>${serviceHealthBadge(service.status)}${latency}</div>`;
        })
        .join("")}</div>`
    : '<span class="muted collapsed-service-pending">Waiting For Service Health Check</span>';

  return `<div class="project-collapsed-services" title="Services checked ${escapeHtml(formatDate(health?.checkedAt))}">
    <div class="collapsed-service-heading">
      <span class="meta-label">Service Status</span>
      <div class="collapsed-service-overall">${serviceHealthBadge(health?.status)}<span class="muted">${escapeHtml(summaryText)}</span></div>
    </div>
    ${services}
  </div>`;
}

function pm2ActionMenuKey(projectId, processKey, context = "expanded") {
  return `pm2:${context}:${projectId}:${processKey}`;
}

function projectActionMenuKey(details) {
  const card = details?.closest?.(".project-card[data-id]");
  const projectId = card?.dataset?.id;
  if (!projectId) return null;

  if (details.classList.contains("project-action-menu")) return `project:${projectId}`;

  if (details.classList.contains("pm2-control-menu")) {
    const processCard = details.closest("[data-pm2-process-key]");
    const processKey = processCard?.dataset?.pm2ProcessKey;
    if (!processKey) return null;
    const context = details.classList.contains("collapsed-pm2-control-menu")
      ? "collapsed"
      : "expanded";
    return pm2ActionMenuKey(projectId, processKey, context);
  }

  return null;
}

function loadOpenProjectActionMenus() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_ACTION_MENUS_KEY) || "[]");
    state.openProjectActionMenus = new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    state.openProjectActionMenus = new Set();
  }
}

function saveOpenProjectActionMenus() {
  try {
    localStorage.setItem(
      PROJECT_ACTION_MENUS_KEY,
      JSON.stringify([...state.openProjectActionMenus]),
    );
  } catch {}
}

function setProjectActionMenuState(details, open) {
  const key = projectActionMenuKey(details);
  if (!key) return;
  if (open) state.openProjectActionMenus.add(key);
  else state.openProjectActionMenus.delete(key);
  saveOpenProjectActionMenus();
}

function updateProjectActionMenuState(details) {
  setProjectActionMenuState(details, details.open);
}

function pruneProjectUiState() {
  const projectIds = new Set(state.projects.map((project) => String(project.id)));
  let changedCollapsed = false;
  for (const id of [...state.collapsedProjects]) {
    if (projectIds.has(id)) continue;
    state.collapsedProjects.delete(id);
    changedCollapsed = true;
  }
  if (changedCollapsed) saveCollapsedProjects();

  const validMenus = new Set();
  for (const project of state.projects) {
    const projectId = String(project.id);
    validMenus.add(`project:${projectId}`);
    for (const proc of project.pm2?.processes || []) {
      const processKey = pm2ProcessKey(proc);
      validMenus.add(pm2ActionMenuKey(projectId, processKey, "expanded"));
      validMenus.add(pm2ActionMenuKey(projectId, processKey, "collapsed"));
    }
  }

  let changedMenus = false;
  for (const key of [...state.openProjectActionMenus]) {
    if (validMenus.has(key)) continue;
    state.openProjectActionMenus.delete(key);
    changedMenus = true;
  }
  if (changedMenus) saveOpenProjectActionMenus();
}

function captureOpenProjectActionMenus(grid) {
  const openMenus = new Set();
  if (!grid) return openMenus;

  grid.querySelectorAll("details.action-menu[open]").forEach((details) => {
    const key = projectActionMenuKey(details);
    if (key) openMenus.add(key);
  });

  return openMenus;
}

function menuOpenAttribute(openMenus, key) {
  return openMenus?.has(key) ? " open" : "";
}

function renderPm2Processes(pm2, project, openMenus = new Set()) {
  if (!pm2?.monitored)
    return '<div class="pm2-empty muted">PM2 monitoring disabled for this project.</div>';
  if (!pm2?.available)
    return `<div class="pm2-empty muted">${escapeHtml(pm2?.error || "PM2 CLI is not available.")}</div>`;
  if (!pm2.processes?.length)
    return '<div class="pm2-empty muted">No PM2 process matched this project.</div>';

  return `<div class="pm2-list">${pm2.processes
    .map((proc) => {
      const rawStatusClass = pm2ProcessStatusClass(proc.status);
      const statusClass =
        rawStatusClass === "stopped" || rawStatusClass === "neutral" ? "warning" : rawStatusClass;
      const pm2MenuKey = pm2ActionMenuKey(project.id, pm2ProcessKey(proc), "expanded");
      const remote = project.executionTarget === "lan";
      const controls =
        !remote && project.pm2ControlsEnabled
          ? `<details class="action-menu pm2-control-menu"${menuOpenAttribute(openMenus, pm2MenuKey)}>
      <summary class="button small">Process Controls</summary>
      <div class="action-menu-panel pm2-control-menu-panel">
        <div class="action-menu-group">
          ${proc.status === "online" ? `<button type="button" class="button small" data-pm2-action="restart" data-pm2-id="${escapeHtml(proc.id)}">Restart</button><button type="button" class="button small" data-pm2-action="reload" data-pm2-id="${escapeHtml(proc.id)}">Reload</button><button type="button" class="button danger small" data-pm2-action="stop" data-pm2-id="${escapeHtml(proc.id)}">Stop</button>` : `<button type="button" class="button primary small" data-pm2-action="start" data-pm2-id="${escapeHtml(proc.id)}">Start</button>`}
          <button type="button" class="button small" data-pm2-action="reset" data-pm2-id="${escapeHtml(proc.id)}">Reset Restarts</button>
        </div>
      </div>
    </details>`
          : '<div class="pm2-controls-note muted">Controls disabled in project settings.</div>';
      return `<div class="pm2-process status-${statusClass}" data-pm2-process-key="${escapeHtml(pm2ProcessKey(proc))}">
      <div class="pm2-process-title">
        <strong>${escapeHtml(proc.namespace && proc.namespace !== "default" ? `${proc.namespace}/${proc.name}` : proc.name)}</strong>
        <span class="badge ${statusClass}">${escapeHtml(proc.status)}</span>
      </div>
      <div class="pm2-metrics">
        <span>ID ${escapeHtml(Number.isFinite(proc.id) ? proc.id : "-")}</span>
        <span>PID ${escapeHtml(proc.pid || "-")}</span>
        <span${processCpuTitle(proc) ? ` title="${escapeHtml(processCpuTitle(proc))}"` : ""}>CPU ${escapeHtml(formatProcessCpu(proc))}</span>
        ${Number(proc.cpuRawPercent) > 100 ? `<span title="PM2 reports per-process CPU on a 0-100 × logical-core scale.">PM2 Raw CPU ${escapeHtml(Number(proc.cpuRawPercent).toFixed(1))}%</span>` : ""}
        <span title="${escapeHtml(gpuTelemetryTitle(pm2))}">GPU ${escapeHtml(formatGpuMetric(proc))}</span>
        <span>RAM ${escapeHtml(formatBytes(proc.memoryBytes))}</span>
        <span>Heap ${escapeHtml(formatHeapMetric(proc))}</span>
        ${hasHttpProcessMetrics(proc) ? `<span>HTTP ${escapeHtml(formatHttpRate(proc))}</span>` : ""}
        ${Number.isFinite(Number(proc.httpMeanLatencyMs)) ? `<span>HTTP Mean ${escapeHtml(formatLatency(proc.httpMeanLatencyMs))}</span>` : ""}
        ${Number.isFinite(Number(proc.httpP95LatencyMs)) ? `<span>HTTP p95 ${escapeHtml(formatLatency(proc.httpP95LatencyMs))}</span>` : ""}
        ${Number.isFinite(Number(proc.eventLoopLatencyP95Ms)) ? `<span>Loop p95 ${escapeHtml(Number(proc.eventLoopLatencyP95Ms).toFixed(1))} ms</span>` : ""}
        ${Number.isFinite(Number(proc.activeHandles)) ? `<span>Handles ${escapeHtml(Math.round(Number(proc.activeHandles)))}</span>` : ""}
        ${Number.isFinite(Number(proc.activeRequests)) ? `<span>Requests ${escapeHtml(Math.round(Number(proc.activeRequests)))}</span>` : ""}
        <span>Uptime ${escapeHtml(formatDuration(proc.uptimeMs))}</span>
        <span>Restarts ${escapeHtml(proc.restarts ?? 0)}</span>
        <span>${escapeHtml(proc.execMode || "mode -")}</span>
      </div>
      <div class="pm2-path path">${escapeHtml(proc.script || proc.cwd || "-")}</div>
      <div class="pm2-process-actions">${remote ? '<div class="pm2-controls-note muted">LAN agent · read-only PM2 status</div>' : `<div class="pm2-observe-actions"><button type="button" class="button small" data-action="pm2-logs" data-upm-icon="pm2" data-pm2-id="${escapeHtml(proc.id)}">Logs</button><button type="button" class="button small" data-action="pm2-history" data-upm-icon="pm2" data-process-key="${escapeHtml(pm2ProcessKey(proc))}">Health History</button></div>${controls}`}</div>
    </div>`;
    })
    .join("")}</div>`;
}

function serviceHealthBadge(status) {
  const value = String(status || "unknown").toLowerCase();
  if (value === "healthy") return '<span class="badge success">Healthy</span>';
  if (value === "degraded") return '<span class="badge warning">Degraded</span>';
  if (value === "unhealthy") return '<span class="badge error">Down</span>';
  if (value === "disabled") return '<span class="badge">Disabled</span>';
  return '<span class="badge">Pending</span>';
}

function renderServiceHealth(project) {
  const config = project.serviceHealth || {};
  if (!config.enabled)
    return `<div class="service-health-section is-disabled"><div class="service-health-heading"><span class="meta-label">Services</span><span class="badge">Monitoring Disabled</span></div></div>`;

  const health = project.serviceHealthStatus;
  const configured = (config.services || []).filter((service) => service.enabled !== false);
  const results = health?.services || [];
  const summary = health?.summary;
  const summaryText = summary
    ? `${summary.healthy || 0} healthy · ${summary.degraded || 0} degraded · ${summary.unhealthy || 0} down`
    : `${configured.length} configured · waiting for first check`;

  const cards = results.length
    ? results
        .filter((service) => service.status !== "disabled")
        .map((service) => {
          const latency = Number.isFinite(Number(service.latencyMs))
            ? `${Number(service.latencyMs)} ms`
            : "-";
          return `<div class="service-health-item status-${escapeHtml(service.status || "unknown")}">
            <div class="service-health-item-title"><strong>${escapeHtml(service.name)}</strong>${serviceHealthBadge(service.status)}</div>
            <div class="service-health-item-meta"><span>${escapeHtml(String(service.type || "service").toUpperCase())}</span><span>${escapeHtml(latency)}</span></div>
            <div class="service-health-target">${escapeHtml(service.target || "-")}</div>
            <div class="service-health-message">${escapeHtml(service.message || "No details available.")}</div>
          </div>`;
        })
        .join("")
    : '<div class="pm2-empty muted">Waiting for the first service health check.</div>';

  return `<div class="service-health-section status-${escapeHtml(health?.status || "pending")}">
    <div class="service-health-heading">
      <div><span class="meta-label">Services · checked ${escapeHtml(formatDate(health?.checkedAt))}</span><div class="service-health-summary-text">${escapeHtml(summaryText)}</div></div>
      <div class="service-health-heading-actions">${serviceHealthBadge(health?.status)}<button type="button" class="button small" data-action="service-health-refresh" data-upm-icon="health">Refresh Services</button></div>
    </div>
    ${health?.error ? `<div class="badge error error-block">${escapeHtml(health.error)}</div>` : ""}
    <div class="service-health-list">${cards}</div>
  </div>`;
}

function renderProjects() {
  const grid = $("#projectGrid");
  if (grid?.querySelector(".project-card[data-id]")) {
    state.openProjectActionMenus = captureOpenProjectActionMenus(grid);
    saveOpenProjectActionMenus();
  }
  const openMenus = state.openProjectActionMenus;

  if (!state.projects.length) {
    grid.classList.remove("is-mixed-collapse-state", "is-all-collapsed", "is-all-expanded");
    grid.innerHTML =
      '<div class="empty">No projects are registered yet. Add one manually or scan parent folders for package.json files.</div>';
    return;
  }

  syncProjectGridCollapseLayout(grid);
  grid.innerHTML = state.projects
    .map((project) => {
      const [statusText, statusClass] = projectStatus(project);
      const counts = changeCounts(project);
      const lastResult = project.runtime?.lastResult;
      const storage = storageForProject(project.id);
      const cardStateClass = statusClass ? `state-${statusClass}` : "state-manual";
      const pm2StateClass = `pm2-${project.pm2?.status || "none"}`;
      const collapsedPm2Class = collapsedPm2CardClass(project.pm2);
      const runningClass = project.runtime?.running ? "is-running" : "";
      const collapsed = state.collapsedProjects.has(String(project.id));
      return `<article class="card project-card ${cardStateClass} ${pm2StateClass} ${collapsedPm2Class} ${runningClass}${collapsed ? " is-collapsed" : ""}" data-id="${escapeHtml(project.id)}">
      <div class="project-title-row">
        <div class="project-title-main">
          <button class="project-collapse-button" type="button" data-action="toggle-collapse" aria-expanded="${collapsed ? "false" : "true"}" title="${collapsed ? "Expand Project Details" : "Collapse Project Details"}">
            <span class="project-collapse-chevron" aria-hidden="true"></span><span class="collapse-label">${collapsed ? "Expand" : "Collapse"}</span>
          </button>
          <div><h3>${escapeHtml(project.name)}</h3><span class="badge ${statusClass}">${escapeHtml(statusText)}</span>${project.serviceHealth?.enabled ? serviceHealthBadge(project.serviceHealthStatus?.status) : ""}</div>
        </div>
      </div>
      ${renderCollapsedPm2Summary(project.pm2, project, openMenus)}
      ${renderCollapsedServiceSummary(project)}
      <div class="project-card-body"${collapsed ? " hidden" : ""}>
        <div class="project-meta">
          <div class="meta-row"><span class="meta-label">Host</span><span>${project.executionTarget === "lan" ? `<span class="badge ${project.pm2?.available ? "success" : "warning"}">LAN</span> ${escapeHtml(project.remoteAgent?.name || project.remoteAgentId || "Remote agent")}` : '<span class="badge">Local</span> This PC'}</span></div>
          <div class="meta-row"><span class="meta-label">Project</span><span class="path">${escapeHtml(project.projectRoot)}</span></div>
          <div class="meta-row"><span class="meta-label">Editor</span><span>${project.executionTarget === "lan" ? "Remote host · dashboard launch disabled" : escapeHtml(project.editorInfo?.label || project.editor || "Server default")}</span></div>
          <div class="meta-row"><span class="meta-label">Repository</span><span>${project.executionTarget === "lan" && !project.repositoryUrl ? "Remote auto-detect unavailable" : project.repositoryUrl ? escapeHtml(project.repositoryUrl) : "Auto-detect Git origin"}</span></div>
          <div class="meta-row"><span class="meta-label">Primary</span><span class="path">${escapeHtml(project.backupDirResolved)}</span></div>
          <div class="meta-row"><span class="meta-label">Secondary</span><span class="path">${escapeHtml(project.backupDirSecondaryResolved || "Not configured")}</span></div>
          <div class="meta-row"><span class="meta-label">Encryption</span><span>${project.backupEncryptionEnabled ? (project.executionTarget === "lan" ? '<span class="badge success">Agent-Managed AES-256-GCM</span>' : `<span class="badge ${project.backupEncryptionConfigured ? "success" : "error"}">${project.backupEncryptionConfigured ? "AES-256-GCM Enabled" : "Enabled · Key Missing"}</span>`) : '<span class="badge">Off</span>'}</span></div>
          <div class="meta-row"><span class="meta-label">Delta journal</span><span>${project.deltaJournalEnabled ? `<span class="badge success">On</span> ${escapeHtml(project.deltaJournalRetentionDays)}d · ${escapeHtml(project.deltaJournalMaxEntries)} entries · ${escapeHtml(project.deltaJournalMaxStorageMB)} MB` : '<span class="badge">Off</span>'}</span></div>
          <div class="meta-row"><span class="meta-label">PM2 auto-start</span><span>${project.pm2AutoStart ? `<span class="badge success">Enabled</span> ${escapeHtml(project.pm2EcosystemFile || "ecosystem.config.js")}${project.pm2EcosystemAppName ? ` · ${escapeHtml(project.pm2EcosystemAppName)}` : ""}${project.pm2WaitForDocker ? ' · <span class="badge">Wait For Docker</span>' : ""}${project.runtime?.pm2AutoStart?.state === "suppressed" ? ' · <span class="badge warning">Manual Stop · Suppressed</span>' : project.runtime?.pm2AutoStart?.state === "waiting-for-docker" ? ' · <span class="badge warning">Waiting For Docker</span>' : project.runtime?.pm2AutoStart?.state === "failed" ? ` · <span class="badge error">Last Start Failed</span>` : ""}` : '<span class="badge">Off</span>'}</span></div>
          <div class="meta-row"><span class="meta-label">Docker runtime</span><span>${project.dockerRuntime?.daemonReady ? `<span class="badge success">Ready</span> ${escapeHtml(project.dockerRuntime.runtime || "Docker")}${project.dockerRuntime.serverVersion ? ` · v${escapeHtml(project.dockerRuntime.serverVersion)}` : ""}` : project.dockerRuntime?.running ? `<span class="badge warning">Starting</span> ${escapeHtml(project.dockerRuntime.message || "Waiting for daemon")}` : project.dockerRuntime?.checkedAt ? `<span class="badge error">Stopped</span> ${escapeHtml(project.dockerRuntime.runtime || "Docker")}` : '<span class="badge">Unavailable</span>'}</span></div>
          <div class="meta-row"><span class="meta-label">Watcher</span><span>${project.watch ? `Every ${project.intervalSeconds}s` : "Disabled"}</span></div>
          <div class="meta-row"><span class="meta-label">Schedule</span><span>${escapeHtml(project.scheduleDescription || "Disabled")}</span></div>
          <div class="meta-row"><span class="meta-label">Next schedule</span><span>${escapeHtml(formatDate(project.runtime?.nextScheduledAt))}</span></div>
          <div class="meta-row"><span class="meta-label">Last backup</span><span>${escapeHtml(formatDate(project.runtime?.lastBackupAt))}</span></div>
          <div class="meta-row"><span class="meta-label">Tracked</span><span>${lastResult?.fileCount ?? "-"} files · ${formatBytes(lastResult?.sourceBytes)}</span></div>
          <div class="meta-row"><span class="meta-label">Storage</span><span>${storage ? (storage.error ? `Storage unavailable: ${escapeHtml(storage.error)}` : `${storage.backupCount} backups · ${storage.copyCount ?? storage.backupCount} copies · ${formatBytes(storage.totalBytes)} · ${storage.verifiedCount} fully verified${storage.configuredDestinations > 1 ? ` · mirror ${storage.mirrorHealthy ? "healthy" : "warning"}` : ""}`) : "-"}</span></div>
          <div class="meta-row"><span class="meta-label">Dependencies</span><span>${project.dependencySummary ? `${project.dependencySummary.total} total · ${project.dependencySummary.outdated} outdated · checked ${escapeHtml(formatDate(project.dependencySummary.checkedAt))}` : "Not checked yet"}</span></div>
          <div class="meta-row"><span class="meta-label">Tasks</span><span>${project.taskSummary ? `${project.taskSummary.open} open · ${project.taskSummary.completed} done${project.taskSummary.missingSource ? ` · ${project.taskSummary.missingSource} source removed` : ""}` : "0 open"}</span></div>
        </div>
        <div class="pm2-section">
          <div class="pm2-heading"><span class="meta-label">PM2 · checked ${escapeHtml(formatDate(project.pm2?.checkedAt))}</span><div class="pm2-heading-actions">${pm2StatusBadge(project.pm2)}${project.executionTarget === "lan" ? '<span class="badge">Remote Read-Only</span>' : '<button type="button" class="button small" data-action="pm2-history" data-upm-icon="pm2">History</button>'}</div></div>
          ${renderPm2Processes(project.pm2, project, openMenus)}
        </div>
        ${renderServiceHealth(project)}
        <div class="change-grid">
          <div class="change-item"><strong>${counts.added}</strong><span>Added</span></div>
          <div class="change-item"><strong>${counts.modified}</strong><span>Modified</span></div>
          <div class="change-item"><strong>${counts.deleted}</strong><span>Deleted</span></div>
        </div>
        ${project.runtime?.lastError ? `<p class="badge ${project.runtime.lastError.partial ? "warning" : "error"} error-block">${escapeHtml(project.runtime.lastError.message)}</p>` : ""}
        <div class="card-actions project-quick-actions">
          <button type="button" class="button primary small" data-action="backup" data-upm-icon="backups">Backup Now</button>
          ${project.executionTarget === "lan" ? "" : `<button type="button" class="button small" data-action="open-editor" data-upm-icon="editor">Open ${escapeHtml(project.editorInfo?.label || "editor")}</button><button type="button" class="button small" data-action="open-repository" data-upm-icon="repository">Repository</button>`}
          <button type="button" class="button small" data-action="tasks" data-upm-icon="activity">Tasks${project.taskSummary?.open ? ` (${project.taskSummary.open})` : ""}</button>
          <details class="action-menu project-action-menu"${menuOpenAttribute(openMenus, `project:${project.id}`)}>
            <summary class="button small" data-upm-icon="tools">More Actions</summary>
            <div class="action-menu-panel project-action-menu-panel">
              <div class="action-menu-group">
                <span class="action-menu-label">Inspect & history</span>
                <button type="button" class="button small" data-action="inspect" data-upm-icon="file-tools">Check Changes</button>
                ${project.executionTarget === "lan" ? "" : '<button type="button" class="button small" data-action="diff" data-upm-icon="file-tools">Diff</button><button type="button" class="button small" data-action="feature-pack" data-upm-icon="feature-packs">Export Changes</button>'}
                <button type="button" class="button small" data-action="history" data-upm-icon="backups">Backups</button>
                ${project.executionTarget === "lan" ? "" : '<button type="button" class="button small" data-action="dependencies" data-upm-icon="updates">Dependencies</button>'}
              </div>
              ${project.executionTarget === "lan" ? '<div class="action-menu-group"><span class="action-menu-label">LAN agent</span><span class="muted">Backups and PM2 status execute on the remote PC. Source tools remain local-only.</span></div>' : '<div class="action-menu-group"><span class="action-menu-label">Recovery & tools</span><button type="button" class="button small" data-action="recovery" data-upm-icon="recovery">Recovery</button><button type="button" class="button small" data-action="journal" data-upm-icon="journal">Journal</button><button type="button" class="button small" data-action="file-tools" data-upm-icon="file-tools">File Tools</button></div>'}
              <div class="action-menu-group">
                <span class="action-menu-label">Automation</span>
                ${project.pm2?.available && !project.pm2?.processes?.length && project.pm2ControlsEnabled ? '<button type="button" class="button small" data-action="pm2-start-project" data-upm-icon="pm2">Start In PM2</button>' : ""}
                <button type="button" class="button small" data-action="toggle-watch">${project.watch ? "Pause Watcher" : "Resume Watcher"}</button>
                <button type="button" class="button small" data-action="toggle-schedule">${project.schedule?.enabled ? "Disable Schedule" : "Enable Schedule"}</button>
              </div>
              <div class="action-menu-group action-menu-danger-zone">
                <span class="action-menu-label">Project</span>
                <button type="button" class="button small" data-action="edit" data-upm-icon="settings">Edit Settings</button>
                <button type="button" class="button danger small" data-action="remove">Remove Project</button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </article>`;
    })
    .join("");
}

function taskKindLabel(kind) {
  return kind === "fix" ? "FIX" : kind === "note" ? "NOTE" : "TODO";
}

function resetTaskEditor() {
  state.tasks.editingId = null;
  $("#taskKind").value = "todo";
  $("#taskTitle").value = "";
  $("#taskDetails").value = "";
  $("#saveTaskBtn").textContent = "Add Item";
  $("#cancelTaskEditBtn").hidden = true;
}

function renderProjectTasks() {
  const data = state.tasks.data;
  if (!data) return;
  const summary = data.summary || {};
  $("#taskSummary").innerHTML = [
    ["Open", summary.open || 0, ""],
    ["TODO", summary.todo || 0, ""],
    ["FIX", summary.fix || 0, "warning"],
    ["NOTE", summary.note || 0, ""],
    ["Done", summary.completed || 0, "success"],
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="task-summary-item ${cls}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");

  const search = $("#taskSearch").value.trim().toLowerCase();
  const status = $("#taskStatusFilter").value;
  const kind = $("#taskKindFilter").value;
  const items = (data.tasks || []).filter((task) => {
    if (status === "open" && task.completed) return false;
    if (status === "completed" && !task.completed) return false;
    if (kind !== "all" && task.kind !== kind) return false;
    if (
      search &&
      !`${task.title} ${task.details || ""} ${task.source?.path || ""}`
        .toLowerCase()
        .includes(search)
    )
      return false;
    return true;
  });

  $("#taskList").innerHTML = items.length
    ? items
        .map((task) => {
          const source = task.source;
          const sourceText = source ? `${source.path}:${source.line || "?"}` : "Manual item";
          const missing = source && source.present === false;
          return `<article class="task-row${task.completed ? " is-completed" : ""}" data-task-id="${escapeHtml(task.id)}">
      <label class="task-check"><input type="checkbox" data-task-action="complete" ${task.completed ? "checked" : ""} aria-label="Mark ${escapeHtml(task.title)} complete" /></label>
      <div class="task-main">
        <div class="task-title-line"><span class="task-kind task-kind-${escapeHtml(task.kind)}">${taskKindLabel(task.kind)}</span><strong>${escapeHtml(task.title)}</strong>${missing ? '<span class="badge warning">Source Removed</span>' : ""}</div>
        ${task.details ? `<p>${escapeHtml(task.details)}</p>` : ""}
        <div class="task-source muted">${escapeHtml(sourceText)}${source?.type ? ` · ${escapeHtml(source.type === "task-file" ? "task list" : "comment")}` : ""}${source?.depth ? ` · level ${escapeHtml(source.depth + 1)}` : ""}</div>
      </div>
      <div class="task-actions"><button type="button" class="button tiny" data-task-action="edit">Edit</button><button type="button" class="button tiny danger" data-task-action="remove">Delete</button></div>
    </article>`;
        })
        .join("")
    : '<div class="empty">No task items match the current filters.</div>';

  $("#taskListCount").textContent = `${items.length} shown`;
}

async function loadProjectTasks(projectId = state.tasks.projectId) {
  if (!projectId) return;
  const data = await api(
    `/api/projects/${encodeURIComponent(projectId)}/tasks?includeCompleted=true`,
  );
  state.tasks.data = data.taskList;
  renderProjectTasks();
}

async function openProjectTasks(project) {
  state.tasks.projectId = project.id;
  state.tasks.data = null;
  resetTaskEditor();
  $("#tasksTitle").textContent = `${project.name} · TODO / FIX / NOTE`;
  const remote = project.executionTarget === "lan";
  $("#scanTasksBtn").disabled = remote;
  $("#taskIncludeGitignored").disabled = remote;
  $("#taskScanStatus").textContent = remote
    ? "Manual task tracking works for LAN projects; source comment/task-file scanning remains local-only."
    : "Scan source comments and common TODO/task files to import existing work items.";
  $("#taskList").innerHTML = '<div class="empty">Loading task list…</div>';
  $("#tasksDialog").showModal();
  try {
    await loadProjectTasks(project.id);
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveTaskFromForm(event) {
  event.preventDefault();
  const projectId = state.tasks.projectId;
  if (!projectId) return;
  const title = $("#taskTitle").value.trim();
  if (!title) return toast("Task text is required.", true);
  const payload = {
    kind: $("#taskKind").value,
    title,
    details: $("#taskDetails").value.trim(),
  };
  const editingId = state.tasks.editingId;
  try {
    await api(
      editingId
        ? `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(editingId)}`
        : `/api/projects/${encodeURIComponent(projectId)}/tasks`,
      {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      },
    );
    resetTaskEditor();
    await loadProjectTasks(projectId);
    toast(editingId ? "Task updated." : "Task added.");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

async function scanProjectTasks() {
  const projectId = state.tasks.projectId;
  if (!projectId) return;
  const button = $("#scanTasksBtn");
  button.disabled = true;
  $("#taskScanStatus").textContent = "Scanning project comments and TODO/task files…";
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks/scan`, {
      method: "POST",
      body: JSON.stringify({
        includeGitignored: $("#taskIncludeGitignored").checked,
      }),
    });
    const result = data.result;
    state.tasks.data = {
      projectId,
      projectName: state.tasks.data?.projectName,
      summary: result.summary,
      tasks: result.tasks,
    };
    $("#taskScanStatus").textContent =
      `Scanned ${result.filesScanned} files · found ${result.discovered} markers/items · ${result.added} new · ${result.missingSource} open item(s) whose source marker was removed${result.truncated ? " · scan limit reached" : ""}.`;
    renderProjectTasks();
    toast(
      result.added
        ? `Imported ${result.added} new task item${result.added === 1 ? "" : "s"}.`
        : "Task scan complete; no new items.",
    );
    await refresh();
  } catch (error) {
    $("#taskScanStatus").textContent = "Task scan failed.";
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function diffStatusBadge(status) {
  const cls = status === "added" ? "success" : status === "deleted" ? "error" : "warning";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function renderDiffSummary() {
  const diff = state.diff.summary;
  if (!diff) return;
  const counts = diff.counts || {};
  $("#diffSummary").innerHTML = [
    ["Added", counts.added || 0, "success"],
    ["Modified", counts.modified || 0, "warning"],
    ["Deleted", counts.deleted || 0, "error"],
    ["Total", counts.total || 0, ""],
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="diff-summary-card ${cls}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");
  $("#diffBaseline").innerHTML = diff.baseline
    ? `Baseline <strong>${escapeHtml(diff.baseline.backupFile || "last successful backup")}</strong> · ${escapeHtml(formatDate(diff.baseline.createdAt))} · current scan ${escapeHtml(formatDate(diff.checkedAt))}`
    : `No successful backup baseline exists yet. Current tracked files are shown as added.`;
}

function filteredDiffFiles() {
  const diff = state.diff.summary;
  if (!diff) return [];
  const query = $("#diffFilter").value.trim().toLowerCase();
  const status = $("#diffStatusFilter").value;
  return (diff.files || []).filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (query && !item.path.toLowerCase().includes(query)) return false;
    return true;
  });
}

function renderDiffFiles() {
  const files = filteredDiffFiles();
  $("#diffFileCount").textContent = `${files.length} shown`;
  $("#diffFileList").innerHTML = files.length
    ? files
        .map((item) => {
          const beforeSize = item.before?.size;
          const afterSize = item.after?.size;
          const sizeText =
            item.status === "added"
              ? formatBytes(afterSize)
              : item.status === "deleted"
                ? formatBytes(beforeSize)
                : `${formatBytes(beforeSize)} → ${formatBytes(afterSize)}`;
          return `<button type="button" class="diff-file-row${state.diff.selectedPath === item.path ? " active" : ""}" data-diff-path="${escapeHtml(item.path)}">
      <span class="diff-file-main">${diffStatusBadge(item.status)}<strong>${escapeHtml(item.path)}</strong></span>
      <span class="muted">${escapeHtml(sizeText)}</span>
    </button>`;
        })
        .join("")
    : '<div class="empty">No files match this filter.</div>';
}

function renderLineDiff(detail) {
  const textDiff = detail.textDiff || {};
  if (!textDiff.detailed) {
    const reason =
      {
        "binary-file":
          "Binary content changed. A line-by-line text diff is intentionally not rendered.",
        "file-too-large": "This file exceeds the configured detailed-diff size limit.",
        "diff-too-large": "The text is too large for the bounded in-memory line diff.",
        "non-file-entry": "This entry is not a regular text file.",
      }[textDiff.reason] || "A detailed text diff is not available for this entry.";
    return `<div class="diff-unavailable"><strong>Metadata diff only</strong><p class="muted">${escapeHtml(reason)}</p></div>`;
  }

  const lines = textDiff.lines || [];
  const rows = lines
    .map((line) => {
      const marker = line.type === "added" ? "+" : line.type === "deleted" ? "−" : " ";
      return `<div class="diff-code-line ${escapeHtml(line.type)}"><span class="diff-line-number">${line.beforeLine ?? ""}</span><span class="diff-line-number">${line.afterLine ?? ""}</span><span class="diff-marker">${marker}</span><code>${escapeHtml(line.text)}</code></div>`;
    })
    .join("");
  const truncation = textDiff.truncated
    ? '<div class="diff-truncated">Diff output was truncated at the configured safety limit.</div>'
    : "";
  return `${truncation}<div class="diff-code">${rows || '<div class="empty">No line changes.</div>'}</div>`;
}

async function loadProjectFileDiff(relativePath) {
  const projectId = state.diff.projectId;
  if (!projectId || !relativePath) return;
  state.diff.selectedPath = relativePath;
  renderDiffFiles();
  $("#diffDetailHeader").innerHTML =
    `<strong>${escapeHtml(relativePath)}</strong><span class="muted">Loading archived/current content…</span>`;
  $("#diffDetail").innerHTML = '<div class="empty">Loading detailed diff…</div>';
  try {
    const params = new URLSearchParams({
      path: relativePath,
      maxBytes: String(512 * 1024),
      maxInputLines: "2000",
      maxOutputLines: "4000",
    });
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/diff/file?${params}`);
    const detail = data.diff;
    $("#diffDetailHeader").innerHTML =
      `<div><strong>${escapeHtml(relativePath)}</strong><div class="muted">${diffStatusBadge(detail.status)} · before ${escapeHtml(formatBytes(detail.before?.size))} · after ${escapeHtml(formatBytes(detail.after?.size))}</div></div>`;
    $("#diffDetail").innerHTML = renderLineDiff(detail);
  } catch (error) {
    $("#diffDetail").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadProjectDiff({ refresh = false } = {}) {
  const projectId = state.diff.projectId;
  if (!projectId) return;
  $("#diffBaseline").textContent =
    "Scanning project and comparing it with the last backup baseline…";
  $("#diffSummary").innerHTML = "";
  $("#diffFileList").innerHTML = '<div class="empty">Scanning…</div>';
  $("#diffDetail").innerHTML =
    '<div class="empty">Choose a changed file after the scan completes.</div>';
  const data = await api(
    `/api/projects/${encodeURIComponent(projectId)}/diff${refresh ? "?refresh=true" : ""}`,
  );
  state.diff.summary = data.diff;
  state.diff.selectedPath = null;
  renderDiffSummary();
  renderDiffFiles();
}

async function openProjectDiff(project) {
  state.diff.projectId = project.id;
  state.diff.summary = null;
  state.diff.selectedPath = null;
  $("#diffTitle").textContent = `${project.name} diff`;
  $("#diffFilter").value = "";
  $("#diffStatusFilter").value = "all";
  $("#diffDialog").showModal();
  await loadProjectDiff();
}

function featurePackPayload() {
  return {
    packName: $("#featurePackName").value.trim(),
    includeAdded: $("#featurePackIncludeAdded").checked,
    includeModified: $("#featurePackIncludeModified").checked,
    includeDeleted: $("#featurePackIncludeDeleted").checked,
    includeTextDiffs: $("#featurePackIncludeDiffs").checked,
    excludeSensitive: $("#featurePackExcludeSensitive").checked,
  };
}

function featurePackActionLabel(row) {
  if (row.omitted) return '<span class="badge error">Omitted · Sensitive</span>';
  if (row.packAction === "include-current-file")
    return '<span class="badge success">Current File</span>';
  if (row.packAction === "deleted-manifest")
    return '<span class="badge warning">Deletion Manifest</span>';
  return '<span class="badge">Metadata Only</span>';
}

function renderFeaturePackPreview() {
  const preview = state.featurePack.preview;
  if (!preview) return;
  const counts = preview.counts || {};
  $("#featurePackBaseline").innerHTML = preview.baseline
    ? `Baseline <strong>${escapeHtml(preview.baseline.backupFile || "last successful backup")}</strong> · ${escapeHtml(formatDate(preview.baseline.createdAt))} · current scan ${escapeHtml(formatDate(preview.checkedAt))}`
    : `No previous backup baseline · current tree scanned ${escapeHtml(formatDate(preview.checkedAt))}`;
  $("#featurePackSummary").innerHTML = [
    ["Current files", counts.includedRegularFiles || 0, "success"],
    [
      "Deleted entries",
      counts.deletedManifestEntries || 0,
      counts.deletedManifestEntries ? "warning" : "",
    ],
    ["Omitted secrets", counts.omittedSensitive || 0, counts.omittedSensitive ? "error" : ""],
    ["Est. source bytes", formatBytes(preview.estimatedBytes || 0), ""],
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="diff-summary-card ${cls}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");
  $("#featurePackWarnings").innerHTML = (preview.warnings || []).length
    ? (preview.warnings || [])
        .map((warning) => `<div class="feature-pack-warning">${escapeHtml(warning)}</div>`)
        .join("")
    : '<div class="feature-pack-ok">No export warnings detected.</div>';
  const files = preview.files || [];
  $("#featurePackFileCount").textContent =
    `${files.length} selected change${files.length === 1 ? "" : "s"}`;
  $("#featurePackFileList").innerHTML = files.length
    ? files
        .map((row) => {
          const statusClass =
            row.status === "added" ? "success" : row.status === "deleted" ? "error" : "warning";
          const size = row.after?.size ?? row.before?.size;
          return `<div class="feature-pack-file-row${row.omitted ? " is-omitted" : ""}">
      <div class="feature-pack-file-main"><span class="badge ${statusClass}">${escapeHtml(row.status)}</span><strong>${escapeHtml(row.path)}</strong></div>
      <div class="feature-pack-file-meta">${featurePackActionLabel(row)}<span class="muted">${escapeHtml(formatBytes(size))}</span></div>
    </div>`;
        })
        .join("")
    : '<div class="empty">No changes match the selected Feature Pack options.</div>';
  $("#exportFeaturePackBtn").disabled = !preview.hasExportableChanges;
}

async function loadFeaturePackPreview({ refresh = true } = {}) {
  const projectId = state.featurePack.projectId;
  if (!projectId) return;
  $("#featurePackBaseline").textContent = "Scanning project changes for Feature Pack export…";
  $("#featurePackSummary").innerHTML = "";
  $("#featurePackWarnings").innerHTML = "";
  $("#featurePackFileList").innerHTML = '<div class="empty">Scanning…</div>';
  $("#exportFeaturePackBtn").disabled = true;
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}/feature-pack/preview`, {
    method: "POST",
    body: JSON.stringify({ ...featurePackPayload(), refresh }),
  });
  state.featurePack.preview = data.preview;
  renderFeaturePackPreview();
}

async function openFeaturePack(project) {
  state.featurePack = { projectId: project.id, preview: null };
  $("#featurePackTitle").textContent = `${project.name} Feature Pack`;
  $("#featurePackName").value = `${project.name}-changes`;
  $("#featurePackIncludeAdded").checked = true;
  $("#featurePackIncludeModified").checked = true;
  $("#featurePackIncludeDeleted").checked = true;
  $("#featurePackIncludeDiffs").checked = true;
  $("#featurePackExcludeSensitive").checked = true;
  $("#featurePackDialog").showModal();
  await loadFeaturePackPreview();
}

function contentDispositionFilename(value, fallback) {
  const match = /filename\*?=(?:UTF-8''|\")?([^\";]+)/i.exec(String(value || ""));
  if (!match) return fallback;
  try {
    return decodeURIComponent(match[1].replace(/^"|"$/g, "").trim());
  } catch {
    return match[1].replace(/^"|"$/g, "").trim();
  }
}

async function exportFeaturePack() {
  const projectId = state.featurePack.projectId;
  if (!projectId) return;
  const button = $("#exportFeaturePackBtn");
  button.disabled = true;
  button.textContent = "Building Pack…";
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/feature-pack/export`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(featurePackPayload()),
      },
    );
    if (!response.ok) {
      const data = response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : null;
      if (response.status === 401 && data?.authenticationRequired) showAuthGate();
      throw new Error(data?.error || `Feature Pack export failed (${response.status}).`);
    }
    const blob = await response.blob();
    const fallback = "upm-changes.upmfeature.tgz";
    const fileName = contentDispositionFilename(
      response.headers.get("content-disposition"),
      fallback,
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(`Feature Pack exported: ${fileName}`);
  } finally {
    button.textContent = "Export Feature Pack";
    button.disabled = !state.featurePack.preview?.hasExportableChanges;
  }
}

function renderDeltaJournal() {
  const data = state.journal.data;
  if (!data) return;
  const stats = data.stats || {};
  $("#journalStats").innerHTML = [
    ["Entries", stats.entryCount || 0, stats.enabled ? "success" : ""],
    ["Stored", formatBytes(stats.totalBytes), ""],
    ["Recoverable patches", stats.reconstructableFiles || 0, "success"],
    ["Metadata-only", stats.skippedFiles || 0, stats.skippedFiles ? "warning" : ""],
    [
      "Protection",
      stats.encryptionEnabled ? "AES-256-GCM" : "Plain",
      stats.encryptionEnabled ? "success" : "",
    ],
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="diff-summary-card ${cls}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");
  const entries = data.entries || [];
  $("#journalEntries").innerHTML = entries.length
    ? entries
        .map(
          (entry) => `<div class="journal-entry-row">
    <div class="journal-entry-heading"><strong>${escapeHtml(formatDate(entry.createdAt))}</strong><span class="badge success">${escapeHtml(entry.reconstructableFiles || 0)} Recoverable</span>${entry.skippedFiles ? `<span class="badge warning">${escapeHtml(entry.skippedFiles)} Metadata-Only</span>` : ""}</div>
    <div class="muted">${escapeHtml(entry.changedFiles || 0)} changed file(s) · ${escapeHtml(formatBytes(entry.size))} compressed · payload ${escapeHtml(formatBytes(entry.uncompressedPatchBytes || 0))}</div>
    <div class="path">${escapeHtml((entry.fromProjectHash || "").slice(0, 16))}… → ${escapeHtml((entry.toProjectHash || "").slice(0, 16))}…</div>
    <div class="muted">${escapeHtml(entry.fromBackupFile || "previous snapshot")} → ${escapeHtml(entry.toBackupFile || "current snapshot")}</div>
  </div>`,
        )
        .join("")
    : `<div class="empty">${stats.enabled ? "No snapshot transitions have been journaled yet. The first delta is created after the next successful changed backup." : "Persistent delta journaling is disabled for this project."}</div>`;
  $("#pruneJournalBtn").disabled = !stats.enabled || !entries.length;
}

async function openDeltaJournal(project) {
  state.journal = { projectId: project.id, data: null };
  $("#journalTitle").textContent = `${project.name} delta journal`;
  $("#journalStats").innerHTML = "";
  $("#journalEntries").innerHTML = '<div class="empty">Loading journal…</div>';
  $("#journalDialog").showModal();
  const data = await api(`/api/projects/${encodeURIComponent(project.id)}/journal?limit=200`);
  state.journal.data = data.journal;
  renderDeltaJournal();
}

async function pruneDeltaJournal() {
  if (!state.journal.projectId) return;
  if (
    !confirm(
      "Apply this project’s delta-journal retention limits now? Entries outside retention will be permanently removed.",
    )
  )
    return;
  const button = $("#pruneJournalBtn");
  button.disabled = true;
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(state.journal.projectId)}/journal/prune`,
      { method: "POST", body: "{}" },
    );
    toast(`Delta journal retention applied · ${data.result.removed.length} entry(s) removed.`);
    const refreshed = await api(
      `/api/projects/${encodeURIComponent(state.journal.projectId)}/journal?limit=200`,
    );
    state.journal.data = refreshed.journal;
    renderDeltaJournal();
  } finally {
    button.disabled = false;
  }
}

function recoverySourceBadge(candidate) {
  if (candidate?.source === "backup") {
    const cls = candidate.verificationStatus === "verified" ? "success" : "warning";
    return `<span class="badge ${cls}">BACKUP${candidate.encrypted ? " · ENCRYPTED" : ""}</span>`;
  }
  if (candidate?.source === "journal") return '<span class="badge success">JOURNAL</span>';
  return '<span class="badge">GIT</span>';
}

function renderRecoverySuggestions() {
  const suggestions = state.recovery.analysis?.suggestions || [];
  $("#recoverySuggestionCount").textContent =
    `${suggestions.length} file${suggestions.length === 1 ? "" : "s"}`;
  $("#recoverySuggestions").innerHTML = suggestions.length
    ? suggestions
        .map(
          (item) => `
    <button type="button" class="recovery-row${state.recovery.selectedPath === item.path ? " active" : ""}" data-recovery-path="${escapeHtml(item.path)}">
      <span>${diffStatusBadge(item.status)}</span>
      <strong>${escapeHtml(item.path)}</strong>
    </button>`,
        )
        .join("")
    : '<div class="empty">No modified or deleted files are currently detected. You can still enter a path manually.</div>';
}

function recoveryCandidates() {
  const analysis = state.recovery.analysis;
  if (!analysis) return [];
  return [
    ...(analysis.backupCandidates || []),
    ...(analysis.journal?.candidates || []),
    ...(analysis.git?.candidates || []),
  ];
}

function renderRecoveryCandidates() {
  const analysis = state.recovery.analysis;
  const candidates = recoveryCandidates();
  $("#recoveryCandidateCount").textContent =
    `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`;
  $("#recoveryCandidates").innerHTML = candidates.length
    ? candidates
        .map((candidate) => {
          const selected = state.recovery.selectedCandidateId === candidate.id;
          const detail =
            candidate.source === "backup"
              ? `${formatDate(candidate.createdAt)} · ${candidate.backupDestination || "primary"}${candidate.changeKind ? ` · ${candidate.changeKind}` : ""}`
              : candidate.source === "journal"
                ? `${formatDate(candidate.createdAt)} · anchor ${candidate.anchorBackupFile || candidate.anchorSource || "verified state"} · ${candidate.journalEntryId || ""}`
                : `${formatDate(candidate.authoredAt)} · ${candidate.author || "unknown author"} · ${candidate.shortCommit || ""}`;
          const recommended =
            analysis.recommended?.id === candidate.id
              ? '<span class="badge success">RECOMMENDED</span>'
              : "";
          return `<button type="button" class="recovery-candidate-row${selected ? " active" : ""}" data-recovery-candidate-id="${escapeHtml(candidate.id)}">
      <div class="recovery-candidate-title">${recoverySourceBadge(candidate)}${recommended}<strong>${escapeHtml(candidate.label || candidate.id)}</strong></div>
      <div class="muted">${escapeHtml(detail)}</div>
      ${candidate.source === "git" && candidate.subject ? `<div class="muted">${escapeHtml(candidate.subject)}</div>` : ""}
    </button>`;
        })
        .join("")
    : '<div class="empty">No retained backup, reconstructable journal chain, or Git object containing this path was found.</div>';
}

function renderRecoverySummary() {
  const analysis = state.recovery.analysis;
  if (!analysis) return;
  const current = analysis.current;
  const git = analysis.git || {};
  const parts = [
    analysis.path ? `Path: ${analysis.path}` : "No file selected",
    current
      ? current.exists
        ? `current ${current.type || "entry"} · ${formatBytes(current.size)}`
        : "current file missing"
      : null,
    `${analysis.backupCandidates?.length || 0} backup candidate(s)`,
    `${analysis.journal?.candidates?.length || 0} journal candidate(s)`,
    `${git.candidates?.length || 0} Git candidate(s)`,
    git.available ? `Git ${git.branch || "(detached)"}` : "Git history unavailable",
  ].filter(Boolean);
  $("#recoverySummary").textContent = parts.join(" · ");
}

function renderRecoveryCandidateDetail(candidateData) {
  state.recovery.candidate = candidateData;
  if (!candidateData) {
    $("#recoveryCandidateDetail").innerHTML = '<div class="empty">Select a candidate.</div>';
    $("#exportRecoveryBtn").disabled = true;
    return;
  }
  const candidate = candidateData.candidate || {};
  $("#recoveryCandidateHeader").innerHTML =
    `<div><strong>${escapeHtml(candidateData.path)}</strong><div class="muted">${recoverySourceBadge(candidate)} · ${escapeHtml(formatBytes(candidateData.size))}${candidateData.sha256 ? ` · SHA-256 ${escapeHtml(candidateData.sha256.slice(0, 16))}…` : ""}</div></div>`;
  let body = "";
  if (candidateData.tooLarge) {
    body =
      '<div class="diff-unavailable"><strong>Preview skipped</strong><p>This candidate exceeds the bounded preview size. It can still be exported if it is below the recovery safety ceiling.</p></div>';
  } else if (candidateData.binary) {
    body =
      '<div class="diff-unavailable"><strong>Binary candidate</strong><p>The bytes are recoverable, but a text preview is intentionally not rendered.</p></div>';
  } else {
    body = `<pre class="recovery-preview"><code>${escapeHtml(candidateData.preview || "")}</code></pre>`;
  }
  if (candidate.source === "journal") {
    body += `<div class="recovery-provenance"><strong>Delta journal provenance</strong><div class="muted">Entry ${escapeHtml(candidate.journalEntryId || "-")} · anchor ${escapeHtml(candidate.anchorBackupFile || candidate.anchorSource || "verified state")}</div><div class="recovery-provenance-list"><span>From ${escapeHtml((candidate.fromProjectHash || "").slice(0, 16) || "-")}…</span><span>To ${escapeHtml((candidate.toProjectHash || "").slice(0, 16) || "-")}…</span><span>SHA-256 ${escapeHtml((candidate.sha256 || candidateData.sha256 || "").slice(0, 16) || "-")}…</span></div></div>`;
  }
  if (candidateData.blame) {
    const commits = (candidateData.blame.commits || [])
      .map(
        (item) =>
          `<span>${escapeHtml(item.shortCommit)} · ${escapeHtml(item.lines)} line${item.lines === 1 ? "" : "s"}</span>`,
      )
      .join("");
    const authors = (candidateData.blame.authors || [])
      .map((item) => `<span>${escapeHtml(item.author)} · ${escapeHtml(item.lines)}</span>`)
      .join("");
    body += `<div class="recovery-provenance"><strong>Git blame provenance</strong><div class="muted">${escapeHtml(candidateData.blame.analyzedLines)} line(s) analyzed</div>${commits ? `<div class="recovery-provenance-list">${commits}</div>` : ""}${authors ? `<div class="recovery-provenance-list">${authors}</div>` : ""}</div>`;
  }
  $("#recoveryCandidateDetail").innerHTML = body;
  $("#exportRecoveryBtn").disabled = false;
}

async function loadRecoveryAnalysis({ path: requestedPath = null, refresh = false } = {}) {
  const projectId = state.recovery.projectId;
  if (!projectId) return;
  const pathValue = requestedPath ?? $("#recoveryPath").value.trim();
  $("#recoverySummary").textContent =
    "Searching verified backups, persistent delta journal, and Git history…";
  $("#recoveryCandidates").innerHTML = '<div class="empty">Searching history…</div>';
  $("#recoveryCandidateDetail").innerHTML =
    '<div class="empty">Select a candidate after analysis completes.</div>';
  $("#exportRecoveryBtn").disabled = true;
  const params = new URLSearchParams();
  if (pathValue) params.set("path", pathValue);
  if (refresh) params.set("refresh", "true");
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}/recovery?${params}`);
  state.recovery.analysis = data.recovery;
  state.recovery.selectedPath = data.recovery.path || pathValue || null;
  state.recovery.selectedCandidateId = data.recovery.recommended?.id || null;
  state.recovery.candidate = null;
  if (data.recovery.path) $("#recoveryPath").value = data.recovery.path;
  renderRecoverySummary();
  renderRecoverySuggestions();
  renderRecoveryCandidates();
  if (state.recovery.selectedCandidateId)
    await loadRecoveryCandidate(state.recovery.selectedCandidateId);
}

async function loadRecoveryCandidate(candidateId) {
  const analysis = state.recovery.analysis;
  const pathValue = analysis?.path || $("#recoveryPath").value.trim();
  if (!state.recovery.projectId || !pathValue || !candidateId) return;
  state.recovery.selectedCandidateId = candidateId;
  renderRecoveryCandidates();
  $("#recoveryCandidateDetail").innerHTML =
    '<div class="empty">Loading exact historical bytes…</div>';
  $("#exportRecoveryBtn").disabled = true;
  const params = new URLSearchParams({
    path: pathValue,
    candidateId,
    maxBytes: String(1024 * 1024),
    includeBlame: "true",
    blameLines: "500",
  });
  const data = await api(
    `/api/projects/${encodeURIComponent(state.recovery.projectId)}/recovery/candidate?${params}`,
  );
  renderRecoveryCandidateDetail(data.candidate);
}

async function openRecovery(project) {
  state.recovery = {
    projectId: project.id,
    analysis: null,
    selectedPath: null,
    selectedCandidateId: null,
    candidate: null,
  };
  $("#recoveryTitle").textContent = `${project.name} recovery`;
  $("#recoveryPath").value = "";
  $("#recoveryDialog").showModal();
  await loadRecoveryAnalysis();
}

async function exportSelectedRecoveryCandidate() {
  const analysis = state.recovery.analysis;
  const candidate = recoveryCandidates().find(
    (item) => item.id === state.recovery.selectedCandidateId,
  );
  if (!analysis?.path || !candidate) throw new Error("Select a historical candidate first.");
  if (
    !confirm(
      `Export ${analysis.path} from the selected ${candidate.source} candidate into a separate recovery workspace? The live project will not be changed.`,
    )
  )
    return;
  const button = $("#exportRecoveryBtn");
  button.disabled = true;
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(state.recovery.projectId)}/recovery/export`,
      {
        method: "POST",
        body: JSON.stringify({
          path: analysis.path,
          candidateId: candidate.id,
        }),
      },
    );
    toast(`Recovery candidate exported to ${data.recovery.workspace}`);
  } finally {
    button.disabled = false;
  }
}

async function exportSuggestedRecovery() {
  const suggestions = state.recovery.analysis?.suggestions || [];
  if (!suggestions.length)
    throw new Error("No modified or deleted files are currently suggested for recovery.");
  if (
    !confirm(
      `Create a last-resort recovery workspace for ${suggestions.length} modified/deleted file(s)? The live project will not be changed.`,
    )
  )
    return;
  const button = $("#recoverSuggestedBtn");
  button.disabled = true;
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(state.recovery.projectId)}/recovery/export-suggested`,
      {
        method: "POST",
        body: JSON.stringify({
          paths: suggestions.map((item) => item.path),
          maxFiles: 100,
        }),
      },
    );
    const result = data.recovery;
    toast(
      `Recovery workspace created: ${result.recoveredFiles}/${result.requestedFiles} file(s) recovered${result.failedFiles ? ` · ${result.failedFiles} unavailable` : ""}.`,
      result.failedFiles > 0,
    );
  } finally {
    button.disabled = false;
  }
}

function renderActivity(items) {
  state.activity = Array.isArray(items) ? items : [];
  $("#activityList").innerHTML = state.activity.length
    ? state.activity
        .map(
          (
            item,
            index,
          ) => `<button type="button" class="activity-row activity-row-button" data-activity-index="${index}" title="View Event Details">
    <span class="activity-dot ${escapeHtml(item.level)}"></span>
    <div class="activity-body"><p class="activity-message">${escapeHtml(item.message)}</p><div class="activity-time">${escapeHtml(formatDate(item.timestamp))} · Click For Details</div></div>
    <span class="activity-open-indicator" aria-hidden="true">›</span>
  </button>`,
        )
        .join("")
    : '<div class="empty">No activity yet.</div>';
}

async function loadDiagnostics() {
  const level = $("#diagnosticsLevel")?.value || "";
  const params = new URLSearchParams({ limit: "500" });
  if (level) params.set("level", level);
  const data = await api(`/api/diagnostics?${params}`);
  const summary = data.summary24h || {};
  $("#diagnosticsSummary").innerHTML = [
    ["Warnings · 24h", summary.warnings || 0],
    ["Errors · 24h", summary.errors || 0],
    ["Shown", data.diagnostics.length],
  ]
    .map(
      ([label, value]) =>
        `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");
  $("#diagnosticsList").innerHTML = data.diagnostics.length
    ? data.diagnostics
        .map((item) => {
          const details = [
            item.projectId ? `Project: ${item.projectId}` : null,
            item.operation ? `Operation: ${item.operation}` : null,
            item.destination ? `Destination: ${item.destination}` : null,
            item.errorCode ? `Code: ${item.errorCode}` : null,
            item.errorPath ? `Path: ${item.errorPath}` : null,
            item.pendingCount != null ? `Pending mirrors: ${item.pendingCount}` : null,
            item.error ? `Error: ${item.error}` : null,
          ].filter(Boolean);
          return `<article class="diagnostic-row ${escapeHtml(item.level)}">
      <div class="diagnostic-heading"><span class="badge ${escapeHtml(item.level)}">${escapeHtml(item.level)}</span><strong>${escapeHtml(item.message)}</strong><span class="muted">${escapeHtml(formatDate(item.timestamp))}</span></div>
      ${details.length ? `<div class="diagnostic-details">${details.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>` : ""}
      ${item.recommendation ? `<div class="diagnostic-recommendation"><strong>Suggested action</strong><span>${escapeHtml(item.recommendation)}</span></div>` : ""}
      ${item.errorStack ? `<details><summary>Stack trace</summary><pre>${escapeHtml(item.errorStack)}</pre></details>` : ""}
    </article>`;
        })
        .join("")
    : '<div class="empty">No errors or warnings match this filter.</div>';
}

async function openDiagnostics() {
  $("#diagnosticsDialog").showModal();
  $("#diagnosticsList").innerHTML = '<div class="empty">Loading diagnostics…</div>';
  await loadDiagnostics();
}

function fileToolsModeLabel(mode) {
  return (
    {
      latest: "Latest File Parser",
      comments: "Comment Remover",
      pipeline: "Latest + Comment Cleanup",
      inventory: "Inventory + Duplicate Finder",
      sanitizer: "Text Sanitizer",
    }[mode] || "File Tools"
  );
}

function fileToolsRunLabel(mode) {
  return (
    {
      latest: "Run Latest Parser",
      comments: "Run Comment Remover",
      pipeline: "Run Pipeline",
      inventory: "Build Inventory",
      sanitizer: "Write Sanitized Copies",
    }[mode] || "Run File Tools"
  );
}

function fileToolsNeedsLatestOptions() {
  return ["latest", "pipeline"].includes(state.fileTools.mode);
}

function fileToolsNeedsCommentOptions() {
  return ["comments", "pipeline"].includes(state.fileTools.mode);
}

function populateFileToolsProjects(selectedId = null) {
  const select = $("#fileToolsProject");
  if (!select) return;
  const current = selectedId ?? select.value ?? "";
  select.innerHTML =
    '<option value="">Custom / no registered project</option>' +
    state.projects
      .map(
        (project) =>
          `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`,
      )
      .join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function updateFileToolsModeUi(mode = state.fileTools.mode) {
  state.fileTools.mode = ["latest", "comments", "pipeline", "inventory", "sanitizer"].includes(mode)
    ? mode
    : "pipeline";
  document.querySelectorAll("[data-file-tools-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.fileToolsMode === state.fileTools.mode);
  });
  const sanitizerMode = state.fileTools.mode === "sanitizer";
  const headingCopy = $("#fileToolsDialog .file-tools-heading-copy");
  if (headingCopy) {
    headingCopy.textContent = sanitizerMode
      ? "Scan and review problematic Unicode, AI/rich-text symbols, invisible controls, and ASCII-equivalent replacements before writing selected sanitized copies to a separate output tree."
      : "Build clean latest-version trees, remove comments, generate SHA-256 inventories/duplicate reports, and filter source files without modifying the source.";
  }
  $("#fileToolsLegacyPanel").hidden = sanitizerMode;
  $("#textSanitizerPanel").hidden = !sanitizerMode;
  $("#fileToolsParserStatus").hidden = sanitizerMode;
  $("#fileToolsRefreshHistoryBtn").hidden = sanitizerMode;
  $("#fileToolsCopyUnversionedWrap").hidden = !fileToolsNeedsLatestOptions();
  $("#fileToolsCopyUnsupportedWrap").hidden = !fileToolsNeedsCommentOptions();
  $("#fileToolsPreserveLinesWrap").hidden = !fileToolsNeedsCommentOptions();
  $("#fileToolsPreserveLicenseWrap").hidden = !fileToolsNeedsCommentOptions();
  $("#fileToolsAggressivenessWrap").hidden = !fileToolsNeedsCommentOptions();
  $("#fileToolsMaxCommentBytesWrap").hidden = !fileToolsNeedsCommentOptions();
  const inventoryMode = state.fileTools.mode === "inventory";
  $("#fileToolsManifest").checked = inventoryMode ? true : $("#fileToolsManifest").checked;
  $("#fileToolsManifest").disabled = inventoryMode;
  $("#fileToolsOverwrite").disabled = inventoryMode;
  $("#fileToolsRunBtn").textContent = fileToolsRunLabel(state.fileTools.mode);
  $("#fileToolsTitle").textContent = fileToolsModeLabel(state.fileTools.mode);
}

function fileToolsPayload() {
  return {
    mode: state.fileTools.mode,
    projectId: $("#fileToolsProject").value || null,
    sourceRoot: $("#fileToolsSourceRoot").value.trim(),
    outputRoot: $("#fileToolsOutputRoot").value.trim(),
    excludes: $("#fileToolsExcludes").value,
    includes: $("#fileToolsIncludes").value,
    minFileBytes: Number($("#fileToolsMinBytes").value) || 0,
    maxFileBytes: Number($("#fileToolsMaxBytes").value) || 0,
    respectGitignore: $("#fileToolsRespectGitignore").checked,
    useProjectExcludes: $("#fileToolsUseProjectExcludes").checked,
    copyUnversioned: $("#fileToolsCopyUnversioned").checked,
    copyUnsupported: $("#fileToolsCopyUnsupported").checked,
    preserveLinePositions: $("#fileToolsPreserveLines").checked,
    preserveLicenseComments: $("#fileToolsPreserveLicense").checked,
    commentAggressiveness: $("#fileToolsAggressiveness").value || "standard",
    maxCommentFileBytes: Number($("#fileToolsMaxCommentBytes").value) || 4194304,
    overwrite: $("#fileToolsOverwrite").checked,
    writeManifest: $("#fileToolsManifest").checked,
    backupBeforeRun: $("#fileToolsBackupFirst").checked,
    dryRun: $("#fileToolsDryRun").checked,
    previewLimit: 250,
  };
}

function resetFileToolsPreview(message = "Choose a workflow and preview the plan.") {
  state.fileTools.preview = null;
  $("#fileToolsPreviewStatus").textContent = "Not Scanned";
  $("#fileToolsPreviewStatus").className = "badge";
  $("#fileToolsSummary").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  $("#fileToolsWarnings").innerHTML = "";
  $("#fileToolsIgnoredDetails").hidden = true;
  $("#fileToolsIgnoredList").innerHTML = "";
  $("#fileToolsIgnoredCount").textContent = "0";
  $("#fileToolsDuplicateDetails").hidden = true;
  $("#fileToolsDuplicateCount").textContent = "0";
  $("#fileToolsDuplicateList").innerHTML = "";
  $("#fileToolsOperations").innerHTML = '<div class="empty">No preview loaded.</div>';
}

async function loadFileToolsDefaults({ preserveSource = false, preserveOutput = false } = {}) {
  const projectId = $("#fileToolsProject").value || "";
  const params = new URLSearchParams({ mode: state.fileTools.mode });
  if (projectId) params.set("projectId", projectId);
  const data = await api(`/api/file-tools/defaults?${params}`);
  const defaults = data.defaults || {};
  state.fileTools.projectId = defaults.projectId || null;
  if (!preserveSource || !$("#fileToolsSourceRoot").value.trim())
    $("#fileToolsSourceRoot").value = defaults.sourceRoot || "";
  if (!preserveOutput || !$("#fileToolsOutputRoot").value.trim())
    $("#fileToolsOutputRoot").value = defaults.outputRoot || "";
  $("#fileToolsBackupFirst").disabled = !defaults.projectId;
  $("#fileToolsUseProjectExcludes").disabled = !defaults.projectId;
  if (!defaults.projectId) {
    $("#fileToolsBackupFirst").checked = false;
    $("#fileToolsUseProjectExcludes").checked = false;
  } else if (!$("#fileToolsUseProjectExcludes").dataset.userChanged) {
    $("#fileToolsUseProjectExcludes").checked = true;
  }
  resetFileToolsPreview("Paths/options changed. Preview the plan again.");
}

function renderFileToolsSummary(summary = {}) {
  const keys = [
    ["versionGroups", "Version groups"],
    ["timestampedFiles", "Timestamped files"],
    ["filesFound", "Files found"],
    ["plannedCopies", "Planned copies"],
    ["sourceBytes", "Selected size"],
    ["supportedCommentFiles", "Comment-cleanable"],
    ["unsupportedCommentFiles", "Pass-through"],
    ["unversionedFiles", "Unversioned"],
    ["ignoredFiles", "Ignored files"],
    ["ignoredDirectories", "Ignored folders"],
    ["filteredFiles", "Filtered files"],
    ["includePatterns", "Include patterns"],
    ["inventoryBytes", "Inventory size"],
    ["duplicateGroups", "Duplicate groups"],
    ["duplicateFiles", "Duplicate files"],
    ["inventoried", "Inventoried"],
    ["gitignoreRules", ".gitignore rules"],
    ["additionalExcludes", "Extra excludes"],
    ["projectExcludes", "Project excludes"],
    ["collisions", "Collisions"],
    ["commentsRemoved", "Comments removed"],
    ["legalCommentsPreserved", "Legal comments kept"],
    ["policyCommentsPreserved", "Policy comments kept"],
    ["commentsWouldRemove", "Preview removals"],
    ["legalCommentsWouldPreserve", "Preview legal kept"],
    ["policyCommentsWouldPreserve", "Preview policy kept"],
    ["commentPreviewFilesAnalyzed", "Preview files analyzed"],
    ["commentPreviewBytesAnalyzed", "Preview bytes analyzed"],
    ["babelPreviewFiles", "Babel preview files"],
    ["lexicalPreviewFiles", "Lexical preview files"],
    ["lexicalFallbackPreviewFiles", "Babel fallbacks"],
    ["babelParsedFiles", "Babel parsed files"],
    ["lexicalFallbackFiles", "Lexical fallback files"],
    ["copiedUnchangedForSafety", "Safety pass-through"],
    ["copied", "Copied"],
    ["skipped", "Skipped"],
    ["errors", "Errors"],
    ["dryRun", "Dry-run items"],
  ].filter(([key]) => summary[key] !== undefined);

  $("#fileToolsSummary").innerHTML = keys.length
    ? keys
        .map(
          ([key, label]) =>
            `<div class="health-stat"><strong>${escapeHtml(["sourceBytes", "inventoryBytes", "commentPreviewBytesAnalyzed"].includes(key) ? formatBytes(summary[key]) : summary[key])}</strong><span>${escapeHtml(label)}</span></div>`,
        )
        .join("")
    : '<div class="empty">No summary is available.</div>';
}

function renderFileToolsWarnings(warnings = []) {
  $("#fileToolsWarnings").innerHTML = warnings.length
    ? warnings
        .map(
          (warning) =>
            `<div class="file-tools-warning"><span class="badge warning">Notice</span><span>${escapeHtml(warning)}</span></div>`,
        )
        .join("")
    : "";
}

function renderFileToolsOperations(items = [], { resultMode = false, truncated = false } = {}) {
  const container = $("#fileToolsOperations");
  if (!items.length) {
    container.innerHTML = '<div class="empty">No operations matched the current settings.</div>';
    return;
  }
  container.innerHTML = `<div class="file-tools-table-wrap"><table class="file-tools-table">
    <thead><tr><th>Status</th><th>Source</th><th>Destination</th><th>Details</th></tr></thead>
    <tbody>${items
      .map((item) => {
        const status = resultMode ? item.status || "planned" : "planned";
        const statusClass =
          status === "error"
            ? "error"
            : status === "dry-run"
              ? "warning"
              : status === "skipped"
                ? "warning"
                : ["copied", "inventoried"].includes(status)
                  ? "success"
                  : "";
        const details = [
          item.versionsFound > 1 ? `${item.versionsFound} versions` : null,
          item.timestamp || null,
          item.commentStyle || null,
          item.size != null ? formatBytes(item.size) : null,
          item.sha256 ? `SHA-256 ${item.sha256.slice(0, 16)}…` : null,
          item.commentsWouldRemove != null && !resultMode
            ? `${item.commentsWouldRemove} comments would be removed`
            : null,
          item.policyCommentsWouldPreserve != null &&
          !resultMode &&
          item.policyCommentsWouldPreserve
            ? `${item.policyCommentsWouldPreserve} policy comments kept`
            : null,
          item.commentsRemoved != null && resultMode
            ? `${item.commentsRemoved} comments removed`
            : null,
          item.policyCommentsPreserved != null && resultMode && item.policyCommentsPreserved
            ? `${item.policyCommentsPreserved} policy comments kept`
            : null,
          item.legalCommentsPreserved != null && resultMode && item.legalCommentsPreserved
            ? `${item.legalCommentsPreserved} legal comments kept`
            : null,
          item.parserEngine ? `parser ${item.parserEngine}` : null,
          item.parserFallbackReason ? `fallback: ${item.parserFallbackReason}` : null,
          item.reason || null,
          item.error || null,
        ]
          .filter(Boolean)
          .join(" · ");
        return `<tr><td><span class="badge ${statusClass}">${escapeHtml(status)}</span></td><td class="path">${escapeHtml(item.sourceRelativePath || "")}</td><td class="path">${escapeHtml(item.destinationRelativePath || (item.type === "inventory" ? "report only" : ""))}</td><td>${escapeHtml(details || "-")}</td></tr>`;
      })
      .join("")}</tbody>
  </table></div>${truncated ? '<p class="muted file-tools-truncated">Only the first 250 operations are displayed. The manifest contains the complete run.</p>' : ""}`;
}

function renderFileToolsIgnored(ignored = {}) {
  const files = Array.isArray(ignored.files) ? ignored.files : [];
  const directories = Array.isArray(ignored.directories) ? ignored.directories : [];
  const filtered = Array.isArray(ignored.filtered) ? ignored.filtered : [];
  const total = files.length + directories.length + filtered.length;
  const details = $("#fileToolsIgnoredDetails");
  details.hidden = total === 0;
  $("#fileToolsIgnoredCount").textContent = String(total);
  if (!total) {
    $("#fileToolsIgnoredList").innerHTML = "";
    return;
  }
  const rows = [
    ...directories.map((value) => ({ type: "folder", value })),
    ...files.map((value) => ({ type: "file", value })),
    ...filtered.map((value) => ({ type: "filtered", value })),
  ];
  $("#fileToolsIgnoredList").innerHTML =
    rows
      .map(
        (item) =>
          `<div class="file-tools-ignored-row"><span class="badge">${escapeHtml(item.type)}</span><span class="path">${escapeHtml(item.value)}</span></div>`,
      )
      .join("") +
    (ignored.truncated
      ? '<p class="muted">Ignored-item preview truncated; summary counts remain complete.</p>'
      : "");
}

function renderFileToolsDuplicates(groups = []) {
  const details = $("#fileToolsDuplicateDetails");
  const list = $("#fileToolsDuplicateList");
  const normalized = Array.isArray(groups)
    ? groups.filter((group) => Array.isArray(group) && group.length > 1)
    : [];
  details.hidden = normalized.length === 0;
  $("#fileToolsDuplicateCount").textContent = String(normalized.length);
  list.innerHTML = normalized
    .map(
      (group, index) => `
    <div class="file-tools-duplicate-group">
      <div class="file-tools-history-title"><span class="badge warning">Group ${index + 1}</span><strong>${group.length} identical files</strong></div>
      ${group.map((value) => `<div class="path">${escapeHtml(value)}</div>`).join("")}
    </div>`,
    )
    .join("");
}

function renderFileToolsPreview(result) {
  state.fileTools.preview = result;
  const matchCount =
    state.fileTools.mode === "inventory"
      ? Number(result.summary?.filesFound || 0)
      : Number(result.summary?.plannedCopies || 0);
  $("#fileToolsPreviewStatus").textContent = matchCount ? `${matchCount} selected` : "No matches";
  $("#fileToolsPreviewStatus").className = `badge ${matchCount ? "success" : "warning"}`;
  renderFileToolsSummary(result.summary || {});
  renderFileToolsWarnings(result.warnings || []);
  renderFileToolsIgnored(result.ignored || {});
  renderFileToolsDuplicates(result.duplicateGroups || []);
  renderFileToolsOperations(result.operations || [], {
    truncated: result.truncated,
  });
  $("#fileToolsRunHint").textContent = matchCount
    ? state.fileTools.mode === "inventory"
      ? `${matchCount} file(s) will be inventoried; only the report manifest is written.`
      : `${matchCount} operation(s) selected. Source files remain untouched.`
    : "Nothing will be written with the current settings.";
}

async function previewFileTools() {
  const button = $("#fileToolsPreviewBtn");
  button.disabled = true;
  $("#fileToolsPreviewStatus").textContent = "Scanning…";
  $("#fileToolsPreviewStatus").className = "badge warning";
  try {
    const data = await api("/api/file-tools/preview", {
      method: "POST",
      body: JSON.stringify(fileToolsPayload()),
    });
    renderFileToolsPreview(data.result);
  } catch (error) {
    resetFileToolsPreview(error.message);
    $("#fileToolsPreviewStatus").textContent = "Error";
    $("#fileToolsPreviewStatus").className = "badge error";
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderFileToolsRun(result) {
  $("#fileToolsPreviewStatus").textContent = result.summary?.errors
    ? "Completed with errors"
    : result.summary?.dryRun
      ? "Dry run complete"
      : "Complete";
  $("#fileToolsPreviewStatus").className =
    `badge ${result.summary?.errors ? "error" : result.summary?.dryRun ? "warning" : "success"}`;
  renderFileToolsSummary(result.summary || {});
  renderFileToolsWarnings(result.warnings || []);
  renderFileToolsDuplicates(result.duplicateGroups || []);
  renderFileToolsOperations(result.results || [], {
    resultMode: true,
    truncated: result.truncated,
  });
  const backupText = result.backupBeforeRun
    ? result.backupBeforeRun.created
      ? " · pre-run backup created"
      : " · pre-run backup checked"
    : "";
  $("#fileToolsRunHint").textContent =
    `${result.outputRoot || ""}${result.manifestPath ? ` · manifest ${result.manifestPath}` : ""}${backupText}`;
}

async function runFileTools() {
  const payload = fileToolsPayload();
  const project = state.projects.find((item) => item.id === payload.projectId);
  const action = payload.dryRun
    ? "Run this File Tools dry-run?"
    : `Write File Tools output${project ? ` for ${project.name}` : ""}?`;
  if (
    !confirm(
      `${action}\n\nSource files are not modified.\nOutput: ${payload.outputRoot || "(project default)"}`,
    )
  )
    return;
  const button = $("#fileToolsRunBtn");
  button.disabled = true;
  $("#fileToolsPreviewBtn").disabled = true;
  $("#fileToolsPreviewStatus").textContent =
    payload.backupBeforeRun && payload.projectId ? "Backing up + processing…" : "Processing…";
  $("#fileToolsPreviewStatus").className = "badge warning";
  try {
    const data = await api("/api/file-tools/run", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderFileToolsRun(data.result);
    toast(
      data.result.summary?.errors
        ? `File Tools finished with ${data.result.summary.errors} error(s).`
        : "File Tools run completed.",
      Boolean(data.result.summary?.errors),
    );
    await loadFileToolsHistory();
    await refresh();
  } catch (error) {
    $("#fileToolsPreviewStatus").textContent = "Failed";
    $("#fileToolsPreviewStatus").className = "badge error";
    toast(error.message, true);
  } finally {
    button.disabled = false;
    $("#fileToolsPreviewBtn").disabled = false;
  }
}

function renderFileToolsHistory(history = []) {
  $("#fileToolsHistory").innerHTML = history.length
    ? history
        .map((entry) => {
          const level =
            entry.status === "error" ? "error" : entry.status === "warning" ? "warning" : "success";
          const summary = entry.summary || {};
          const detail = entry.error?.message
            ? entry.error.message
            : `${summary.copied || 0} copied · ${summary.commentsRemoved || 0} comments removed · ${summary.errors || 0} errors${entry.dryRun ? " · dry run" : ""}`;
          return `<article class="file-tools-history-row"><span class="activity-dot ${level}"></span><div><div class="file-tools-history-title"><strong>${escapeHtml(fileToolsModeLabel(entry.mode))}</strong><span class="badge ${level}">${escapeHtml(entry.status)}</span></div><div class="muted">${escapeHtml(entry.projectName || entry.sourceRoot || "Custom run")} · ${escapeHtml(formatDate(entry.finishedAt || entry.startedAt))}</div><div class="file-tools-history-detail">${escapeHtml(detail)}</div><div class="path file-tools-history-path">${escapeHtml(entry.outputRoot || "")}</div></div></article>`;
        })
        .join("")
    : '<div class="empty">No File Tools runs have been recorded yet.</div>';
}

async function loadFileToolsHistory() {
  const data = await api("/api/file-tools/history?limit=50");
  renderFileToolsHistory(data.history || []);
}

const TEXT_SANITIZER_PREFS_KEY = "upm:text-sanitizer-preferences";

function textSanitizerCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function textSanitizerOptions() {
  const extensions = textSanitizerCsv($("#tsExtensions").value);
  return {
    replacePunctuation: $("#tsReplacePunctuation").checked,
    replaceBullets: $("#tsReplaceBullets").checked,
    replaceSpaces: $("#tsReplaceSpaces").checked,
    replaceLineBreaks: $("#tsReplaceLineBreaks").checked,
    replaceCompatibility: $("#tsReplaceCompatibility").checked,
    replaceArrowsMath: $("#tsReplaceArrowsMath").checked,
    replaceStatus: $("#tsReplaceStatus").checked,
    replaceMisc: $("#tsReplaceMisc").checked,
    replaceAmbiguous: $("#tsReplaceAmbiguous").checked,
    removeInvisible: $("#tsRemoveInvisible").checked,
    reportNonAscii: $("#tsReportNonAscii").checked,
    useExtensionFilter: $("#tsUseExtensionFilter").checked,
    ignoreDirectories: textSanitizerCsv($("#tsIgnoreDirectories").value),
    extensions: extensions.length ? extensions : null,
  };
}

function saveTextSanitizerPreferences() {
  try {
    localStorage.setItem(
      TEXT_SANITIZER_PREFS_KEY,
      JSON.stringify({
        overwrite: $("#tsOverwriteOutput").checked,
        writeManifest: $("#tsWriteManifest").checked,
        backupBeforeRun: $("#tsBackupProjectFirst").checked,
        options: textSanitizerOptions(),
      }),
    );
  } catch {}
}

function loadTextSanitizerPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(TEXT_SANITIZER_PREFS_KEY) || "null");
    if (!saved) return;
    if (typeof saved.overwrite === "boolean") $("#tsOverwriteOutput").checked = saved.overwrite;
    if (typeof saved.writeManifest === "boolean")
      $("#tsWriteManifest").checked = saved.writeManifest;
    if (typeof saved.backupBeforeRun === "boolean")
      $("#tsBackupProjectFirst").checked = saved.backupBeforeRun;
    // Migrate the previous sanitizer preference name if it exists.
    else if (typeof saved.backupProjectFirst === "boolean")
      $("#tsBackupProjectFirst").checked = saved.backupProjectFirst;
    const options = saved.options || {};
    const map = {
      replacePunctuation: "tsReplacePunctuation",
      replaceBullets: "tsReplaceBullets",
      replaceSpaces: "tsReplaceSpaces",
      replaceLineBreaks: "tsReplaceLineBreaks",
      replaceCompatibility: "tsReplaceCompatibility",
      replaceArrowsMath: "tsReplaceArrowsMath",
      replaceStatus: "tsReplaceStatus",
      replaceMisc: "tsReplaceMisc",
      replaceAmbiguous: "tsReplaceAmbiguous",
      removeInvisible: "tsRemoveInvisible",
      reportNonAscii: "tsReportNonAscii",
      useExtensionFilter: "tsUseExtensionFilter",
    };
    for (const [key, id] of Object.entries(map)) {
      if (typeof options[key] === "boolean") $(`#${id}`).checked = options[key];
    }
    if (Array.isArray(options.ignoreDirectories))
      $("#tsIgnoreDirectories").value = options.ignoreDirectories.join(", ");
    if (Array.isArray(options.extensions)) $("#tsExtensions").value = options.extensions.join(", ");
  } catch {}
}

function applyTextSanitizerPreset(name) {
  const presets = {
    standard: [true, true, true, true, false, true, true, true, false, true, true],
    expanded: [true, true, true, true, true, true, true, true, false, true, true],
    invisible: [false, false, false, false, false, false, false, false, false, true, true],
    report: [false, false, false, false, false, false, false, false, false, false, true],
  };
  const values = presets[name];
  if (!values) return;
  [
    "tsReplacePunctuation",
    "tsReplaceBullets",
    "tsReplaceSpaces",
    "tsReplaceLineBreaks",
    "tsReplaceCompatibility",
    "tsReplaceArrowsMath",
    "tsReplaceStatus",
    "tsReplaceMisc",
    "tsReplaceAmbiguous",
    "tsRemoveInvisible",
    "tsReportNonAscii",
  ].forEach((id, index) => {
    $(`#${id}`).checked = values[index];
  });
  saveTextSanitizerPreferences();
  resetTextSanitizerScan("Preset changed. Scan again to refresh findings.");
}

function populateTextSanitizerProjects(selectedId = "") {
  const select = $("#textSanitizerProject");
  const localProjects = state.projects.filter((project) => project.executionTarget !== "lan");
  select.innerHTML =
    '<option value="">Custom / no registered project</option>' +
    localProjects
      .map(
        (project) =>
          `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`,
      )
      .join("");
  if ([...select.options].some((option) => option.value === selectedId)) select.value = selectedId;
}

async function loadTextSanitizerDefaults(projectId = $("#textSanitizerProject").value || "") {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  const data = await api(`/api/file-tools/sanitizer/defaults?${params}`);
  const defaults = data.defaults || {};
  if (defaults.sourceRoot) $("#textSanitizerSourceRoot").value = defaults.sourceRoot;
  if (defaults.outputRoot) $("#textSanitizerOutputRoot").value = defaults.outputRoot;
  $("#tsBackupProjectFirst").disabled = !defaults.projectId;
  if (!defaults.projectId) $("#tsBackupProjectFirst").checked = false;
  resetTextSanitizerScan("Project/path changed. Scan again to refresh findings.");
}

function textSanitizerVisibleCharacter(value) {
  if (value === " ") return "[space]";
  if (value === "\n") return "[LF]";
  if (value === "\t") return "[tab]";
  if (value === "") return "[remove]";
  return value;
}

function renderTextSanitizerCatalog() {
  const catalog = state.fileTools.sanitizer.meta?.catalog;
  if (!catalog) return;
  const query = $("#textSanitizerRuleSearch").value.trim().toLowerCase();
  const group = $("#textSanitizerCatalogGroup").value;
  const rows = catalog.replacements.filter((rule) => {
    if (group !== "all" && rule.group !== group) return false;
    if (!query) return true;
    return [rule.group, rule.groupLabel, rule.codePoint, rule.name, rule.from, rule.to, rule.risk]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  $("#textSanitizerCatalog").innerHTML = rows.length
    ? rows
        .map(
          (rule) =>
            `<tr><td>${escapeHtml(rule.groupLabel)}</td><td><code>${escapeHtml(textSanitizerVisibleCharacter(rule.from))}</code></td><td><code>${escapeHtml(rule.codePoint)}</code></td><td>${escapeHtml(rule.name)}</td><td><code>${escapeHtml(textSanitizerVisibleCharacter(rule.to))}</code></td><td><span class="badge ${rule.risk === "high" ? "error" : rule.risk === "medium" ? "warning" : "success"}">${escapeHtml(rule.risk)}</span>${rule.defaultEnabled ? "" : '<div class="muted">Default Off</div>'}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="6" class="muted">No rules match the current filter.</td></tr>';
  $("#textSanitizerInvisibleCatalog").innerHTML = catalog.invisible
    .map(
      (rule) =>
        `<div class="text-sanitizer-invisible-rule"><strong>${escapeHtml(rule.name)}</strong><code>${escapeHtml(rule.range)}</code></div>`,
    )
    .join("");
}

async function loadTextSanitizerMeta() {
  if (state.fileTools.sanitizer.meta) return;
  const data = await api("/api/file-tools/sanitizer/meta");
  state.fileTools.sanitizer.meta = data.meta;
  const catalog = data.meta?.catalog;
  if (!catalog) return;
  $("#textSanitizerRuleCount").textContent =
    `${catalog.counts.replacementCharacters} Replacements · ${catalog.counts.invisibleClasses} Invisible Classes`;
  $("#textSanitizerCatalogCount").textContent = String(catalog.counts.replacementCharacters);
  const groupSelects = [$("#textSanitizerGroupFilter"), $("#textSanitizerCatalogGroup")];
  for (const select of groupSelects) {
    const first = select.options[0];
    select.innerHTML = "";
    select.appendChild(first);
    for (const group of catalog.groups) {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = group.label;
      select.appendChild(option);
    }
    if (select === groupSelects[0]) {
      const invisible = document.createElement("option");
      invisible.value = "invisible";
      invisible.textContent = "Invisible characters";
      select.appendChild(invisible);
    }
  }
  renderTextSanitizerCatalog();
}

function resetTextSanitizerScan(message = "No scan loaded.") {
  const sanitizer = state.fileTools.sanitizer;
  sanitizer.scan = null;
  sanitizer.selected = new Set();
  sanitizer.preview = null;
  sanitizer.previewChanges = [];
  sanitizer.activeChange = -1;
  $("#textSanitizerSummary").innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  $("#textSanitizerResults").innerHTML =
    '<tr><td colspan="7" class="muted">No scan loaded.</td></tr>';
  $("#textSanitizerPreview").hidden = true;
  $("#textSanitizerStatus").textContent = message;
  updateTextSanitizerSelection();
}

function textSanitizerNonAsciiCount(file) {
  return (file.nonAscii || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function textSanitizerPrimaryFinding(file) {
  if (file.changes?.length) {
    const first = [...file.changes].sort((a, b) => b.count - a.count)[0];
    return `${first.name} ×${first.count}`;
  }
  if (file.nonAscii?.length) {
    const first = file.nonAscii[0];
    const hint = first.knownReplacement
      ? ` -> ${first.knownReplacement.to} (${first.knownReplacement.name})`
      : "";
    return `${first.codePoint} ${first.char} ×${first.count}${hint}`;
  }
  return "-";
}

function filteredTextSanitizerFiles() {
  const scan = state.fileTools.sanitizer.scan;
  if (!scan) return [];
  const query = $("#textSanitizerSearch").value.trim().toLowerCase();
  const status = $("#textSanitizerStatusFilter").value;
  const group = $("#textSanitizerGroupFilter").value;
  const sort = $("#textSanitizerSort").value;
  const files = scan.files.filter((file) => {
    if (status === "changed" && !file.changed) return false;
    if (status === "report" && file.changed) return false;
    if (group !== "all" && !(file.changes || []).some((change) => change.group === group))
      return false;
    if (query) {
      const haystack = [
        file.relativePath,
        ...(file.changes || []).flatMap((change) => [
          change.name,
          change.codePoint,
          change.group,
          change.from,
          change.to,
        ]),
        ...(file.nonAscii || []).flatMap((item) => [
          item.codePoint,
          item.char,
          item.knownReplacement?.name,
          item.knownReplacement?.group,
          item.knownReplacement?.to,
        ]),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  files.sort((a, b) => {
    if (sort === "changes")
      return b.changeCount - a.changeCount || a.relativePath.localeCompare(b.relativePath);
    if (sort === "unicode")
      return (
        textSanitizerNonAsciiCount(b) - textSanitizerNonAsciiCount(a) ||
        a.relativePath.localeCompare(b.relativePath)
      );
    return a.relativePath.localeCompare(b.relativePath);
  });
  return files;
}

function updateTextSanitizerSelection() {
  const count = state.fileTools.sanitizer.selected.size;
  $("#textSanitizerSelectionMeta").textContent =
    `${count} file${count === 1 ? "" : "s"} selected for apply.`;
  $("#textSanitizerApplyBtn").disabled = count === 0;
}

function renderTextSanitizerFiles() {
  const scan = state.fileTools.sanitizer.scan;
  if (!scan) return;
  const selected = state.fileTools.sanitizer.selected;
  const files = filteredTextSanitizerFiles();
  $("#textSanitizerResults").innerHTML = files.length
    ? files
        .map(
          (file) =>
            `<tr><td><input type="checkbox" class="text-sanitizer-file-check" data-file="${escapeHtml(file.relativePath)}" ${file.changed ? "" : "disabled"} ${selected.has(file.relativePath) ? "checked" : ""} /></td><td class="path">${escapeHtml(file.relativePath)}</td><td><span class="badge ${file.changed ? "warning" : ""}">${file.changed ? "Will Change" : "Report Only"}</span></td><td>${escapeHtml(file.changeCount)}</td><td>${escapeHtml(textSanitizerNonAsciiCount(file))}</td><td>${escapeHtml(textSanitizerPrimaryFinding(file))}</td><td><button type="button" class="button tiny text-sanitizer-preview-button" data-file="${escapeHtml(file.relativePath)}">Preview</button></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="7" class="muted">No findings match the current filter.</td></tr>';
  document.querySelectorAll(".text-sanitizer-file-check").forEach((checkbox) =>
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(checkbox.dataset.file);
      else selected.delete(checkbox.dataset.file);
      updateTextSanitizerSelection();
    }),
  );
  document
    .querySelectorAll(".text-sanitizer-preview-button")
    .forEach((button) =>
      button.addEventListener("click", () =>
        previewTextSanitizerFile(button.dataset.file).catch((error) => toast(error.message, true)),
      ),
    );
  updateTextSanitizerSelection();
}

function renderTextSanitizerSummary(scan) {
  const summary = scan.summary || {};
  const stats = [
    ["Files Scanned", summary.filesScanned || 0],
    ["Files With Findings", summary.filesWithFindings || 0],
    ["Files To Change", summary.filesChanged || 0],
    ["Characters Fixed", summary.totalChanges || 0],
    ["Remaining Non-ASCII", summary.remainingNonAscii || 0],
    ["Errors", summary.errors || 0],
  ];
  $("#textSanitizerSummary").innerHTML = stats
    .map(
      ([label, value]) =>
        `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");
}

async function scanTextSanitizer() {
  const button = $("#textSanitizerScanBtn");
  const sourceRoot = $("#textSanitizerSourceRoot").value.trim();
  if (!sourceRoot && !$("#textSanitizerProject").value)
    throw new Error("Choose a project or source folder.");
  button.disabled = true;
  $("#textSanitizerStatus").textContent = "Scanning project...";
  saveTextSanitizerPreferences();
  try {
    const data = await api("/api/file-tools/sanitizer/scan", {
      method: "POST",
      body: JSON.stringify({
        projectId: $("#textSanitizerProject").value || null,
        sourceRoot,
        outputRoot: $("#textSanitizerOutputRoot").value.trim(),
        options: textSanitizerOptions(),
      }),
    });
    const scan = data.scan;
    const sanitizer = state.fileTools.sanitizer;
    sanitizer.scan = scan;
    sanitizer.selected = new Set(
      scan.files.filter((file) => file.changed).map((file) => file.relativePath),
    );
    sanitizer.preview = null;
    sanitizer.previewChanges = [];
    $("#textSanitizerPreview").hidden = true;
    renderTextSanitizerSummary(scan);
    renderTextSanitizerFiles();
    $("#textSanitizerStatus").textContent =
      `${scan.summary.filesChanged} file(s) would change · ${scan.summary.totalChanges} character fix(es) · source untouched.`;
    toast(`Text Sanitizer scan complete: ${scan.summary.filesChanged} file(s) would change.`);
  } finally {
    button.disabled = false;
  }
}

function textSanitizerDiffTitle(segment, side) {
  if (segment.type === "remove")
    return `${segment.codePoint} ${segment.name} - removed by sanitizer`;
  const from = segment.original === " " ? "[space]" : segment.original;
  const to = segment.sanitized === " " ? "[space]" : segment.sanitized;
  return `${segment.codePoint} ${segment.name} - ${side === "original" ? `replace ${from} with ${to}` : `replacement for ${from}`}`;
}

function renderTextSanitizerSegments(segments, side) {
  return segments
    .map((segment) => {
      if (segment.type === "unchanged")
        return escapeHtml(side === "original" ? segment.original : segment.sanitized);
      const title = escapeHtml(textSanitizerDiffTitle(segment, side));
      const index = escapeHtml(segment.changeIndex);
      if (segment.type === "remove") {
        if (side === "original")
          return `<mark class="ts-diff-mark ts-diff-original ts-diff-invisible" data-ts-change-index="${index}" title="${title}">[${escapeHtml(segment.codePoint)}]</mark>`;
        return `<span class="ts-diff-removal" data-ts-change-index="${index}" title="${title}">[removed]</span>`;
      }
      const value = side === "original" ? segment.original : segment.sanitized;
      return `<mark class="ts-diff-mark ${side === "original" ? "ts-diff-original" : "ts-diff-sanitized"}" data-ts-change-index="${index}" title="${title}">${escapeHtml(value)}</mark>`;
    })
    .join("");
}

function updateTextSanitizerActiveChange(index, scroll = true) {
  const sanitizer = state.fileTools.sanitizer;
  if (!sanitizer.previewChanges.length) {
    sanitizer.activeChange = -1;
    $("#textSanitizerChangePosition").textContent = "No Automatic Changes";
    $("#textSanitizerChangeLocation").textContent = "";
    $("#textSanitizerPrevChange").disabled = true;
    $("#textSanitizerNextChange").disabled = true;
    return;
  }
  const length = sanitizer.previewChanges.length;
  sanitizer.activeChange = ((index % length) + length) % length;
  const segment = sanitizer.previewChanges[sanitizer.activeChange];
  $("#textSanitizerChangePosition").textContent =
    `Change ${sanitizer.activeChange + 1} Of ${length}`;
  $("#textSanitizerChangeLocation").textContent =
    `Line ${segment.line}, column ${segment.column} · ${segment.codePoint} ${segment.name}`;
  $("#textSanitizerPrevChange").disabled = false;
  $("#textSanitizerNextChange").disabled = false;
  document
    .querySelectorAll(".ts-diff-active")
    .forEach((element) => element.classList.remove("ts-diff-active"));
  const targets = document.querySelectorAll(`[data-ts-change-index="${segment.changeIndex}"]`);
  targets.forEach((element) => element.classList.add("ts-diff-active"));
  if (scroll && targets[0]) targets[0].scrollIntoView({ block: "center", inline: "nearest" });
}

async function previewTextSanitizerFile(relativePath) {
  const scan = state.fileTools.sanitizer.scan;
  if (!scan) throw new Error("Run a sanitizer scan first.");
  const data = await api(
    `/api/file-tools/sanitizer/scans/${encodeURIComponent(scan.id)}/preview?file=${encodeURIComponent(relativePath)}`,
  );
  const preview = data.preview;
  const sanitizer = state.fileTools.sanitizer;
  sanitizer.preview = preview;
  sanitizer.previewChanges = (preview.segments || []).filter(
    (segment) => segment.type !== "unchanged",
  );
  sanitizer.activeChange = -1;
  $("#textSanitizerPreview").hidden = false;
  $("#textSanitizerPreviewTitle").textContent = preview.relativePath;
  $("#textSanitizerPreviewMeta").textContent =
    `${preview.changeCount} sanitizer change(s) · ${preview.nonAscii.reduce((sum, item) => sum + item.count, 0)} non-ASCII character(s) remain after sanitizing.`;
  $("#textSanitizerOriginal").innerHTML = renderTextSanitizerSegments(
    preview.segments || [],
    "original",
  );
  $("#textSanitizerSanitized").innerHTML = renderTextSanitizerSegments(
    preview.segments || [],
    "sanitized",
  );
  const chips = [
    ...(preview.changes || []).map((change) => `${change.count}× ${change.name}`),
    ...(preview.nonAscii || [])
      .slice(0, 12)
      .map(
        (item) =>
          `${item.codePoint} ${item.char} ×${item.count}${item.knownReplacement ? ` -> ${item.knownReplacement.to} (${item.knownReplacement.name})` : ""}`,
      ),
  ];
  $("#textSanitizerChangeChips").innerHTML = chips.length
    ? chips.map((text) => `<span class="badge">${escapeHtml(text)}</span>`).join("")
    : '<span class="badge success">No Findings</span>';
  updateTextSanitizerActiveChange(0, false);
  $("#textSanitizerPreview").scrollIntoView({ block: "start" });
}

async function applyTextSanitizer() {
  const sanitizer = state.fileTools.sanitizer;
  if (!sanitizer.scan) throw new Error("Run a sanitizer scan first.");
  const files = [...sanitizer.selected];
  if (!files.length) throw new Error("Select at least one changed file.");
  const outputRoot = $("#textSanitizerOutputRoot").value.trim();
  if (!outputRoot) throw new Error("Choose an output folder.");
  const overwrite = $("#tsOverwriteOutput").checked;
  const writeManifest = $("#tsWriteManifest").checked;
  const backupBeforeRun =
    $("#tsBackupProjectFirst").checked && !$("#tsBackupProjectFirst").disabled;
  const message = [
    `Write sanitized copies for ${files.length} selected file(s)?`,
    "",
    "Source files will not be modified.",
    `Output: ${outputRoot}`,
    overwrite
      ? "Existing output files: overwrite enabled."
      : "Existing output files: skip enabled.",
    writeManifest ? "JSON manifest: enabled." : "JSON manifest: disabled.",
    backupBeforeRun ? "Verified UPM project backup before processing: enabled." : null,
    "Files changed since the scan will be refused by stale-file protection.",
  ]
    .filter(Boolean)
    .join("\n");
  if (!confirm(message)) return;
  const button = $("#textSanitizerApplyBtn");
  button.disabled = true;
  $("#textSanitizerStatus").textContent = backupBeforeRun
    ? "Backing up project and writing sanitizer output..."
    : "Writing sanitizer output...";
  saveTextSanitizerPreferences();
  try {
    const data = await api(
      `/api/file-tools/sanitizer/scans/${encodeURIComponent(sanitizer.scan.id)}/apply`,
      {
        method: "POST",
        body: JSON.stringify({ files, outputRoot, overwrite, writeManifest, backupBeforeRun }),
      },
    );
    const result = data.result;
    $("#textSanitizerStatus").textContent =
      `${result.summary.written} written · ${result.summary.skipped} skipped · ${result.summary.failed} failed · ${result.summary.stale} stale protected${result.manifestPath ? ` · manifest ${result.manifestPath}` : ""}`;
    toast(
      `Text Sanitizer wrote ${result.summary.written} sanitized file(s) to the output tree.${result.summary.stale ? ` ${result.summary.stale} stale file(s) protected.` : ""}`,
      result.summary.failed > 0,
    );
    await refresh();
  } finally {
    button.disabled = false;
    updateTextSanitizerSelection();
  }
}

function downloadTextSanitizerReport(filename, type, contents) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function exportTextSanitizerJson() {
  const scan = state.fileTools.sanitizer.scan;
  if (!scan) return toast("Run a sanitizer scan first.", true);
  const report = {
    root: scan.root,
    createdAt: scan.createdAt,
    settings: scan.settings,
    summary: scan.summary,
    files: scan.files.map(({ hash, mtimeMs, ...file }) => file),
    errors: scan.errors,
  };
  downloadTextSanitizerReport(
    "upm-text-sanitizer-report.json",
    "application/json",
    JSON.stringify(report, null, 2),
  );
}

function textSanitizerCsvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportTextSanitizerCsv() {
  const scan = state.fileTools.sanitizer.scan;
  if (!scan) return toast("Run a sanitizer scan first.", true);
  const rows = [["file", "status", "changes", "remaining_non_ascii", "primary_finding"]];
  for (const file of scan.files) {
    rows.push([
      file.relativePath,
      file.changed ? "will-change" : "report-only",
      file.changeCount,
      textSanitizerNonAsciiCount(file),
      textSanitizerPrimaryFinding(file),
    ]);
  }
  downloadTextSanitizerReport(
    "upm-text-sanitizer-report.csv",
    "text/csv;charset=utf-8",
    rows.map((row) => row.map(textSanitizerCsvCell).join(",")).join("\r\n"),
  );
}

function syncTextSanitizerPreview(source, target) {
  const sanitizer = state.fileTools.sanitizer;
  if (sanitizer.syncingScroll) return;
  sanitizer.syncingScroll = true;
  const sourceMax = source.scrollHeight - source.clientHeight;
  const targetMax = target.scrollHeight - target.clientHeight;
  const ratio = sourceMax > 0 ? source.scrollTop / sourceMax : 0;
  target.scrollTop = ratio * Math.max(0, targetMax);
  target.scrollLeft = source.scrollLeft;
  requestAnimationFrame(() => {
    sanitizer.syncingScroll = false;
  });
}

async function openTextSanitizer(project = null) {
  populateTextSanitizerProjects(project?.executionTarget === "lan" ? "" : project?.id || "");
  if (project?.executionTarget !== "lan" && project?.id)
    $("#textSanitizerProject").value = project.id;
  loadTextSanitizerPreferences();
  await loadTextSanitizerMeta();
  await loadTextSanitizerDefaults($("#textSanitizerProject").value || "");
}

async function openFileTools(project = null) {
  $("#fileToolsUseProjectExcludes").dataset.userChanged = "";
  populateFileToolsProjects(project?.id || "");
  $("#fileToolsProject").value = project?.id || "";
  state.fileTools.projectId = project?.id || null;
  updateFileToolsModeUi(state.fileTools.mode || "pipeline");
  $("#fileToolsDialog").showModal();
  $("#fileToolsOperations").innerHTML = '<div class="empty">Loading File Tools defaults…</div>';
  try {
    if (state.fileTools.mode === "sanitizer") {
      await openTextSanitizer(project);
      return;
    }
    const metaData = await api("/api/file-tools/meta");
    state.fileTools.meta = metaData.meta;
    const parserStatus = $("#fileToolsParserStatus");
    if (parserStatus) {
      const babelReady = Boolean(metaData.meta?.babel?.available);
      parserStatus.textContent = babelReady ? "Babel parser ready" : "Babel parser fallback";
      parserStatus.className = `badge ${babelReady ? "success" : "warning"}`;
    }
    await loadFileToolsDefaults();
    await loadFileToolsHistory();
  } catch (error) {
    toast(error.message, true);
  }
}

async function refresh() {
  try {
    const hostHours = $("#hostHistoryRange")?.value || 24;
    const [statusData, projectsData, activityData, storageData, hostHistoryData] =
      await Promise.all([
        api("/api/status"),
        api("/api/projects"),
        api("/api/activity?limit=50"),
        api("/api/storage"),
        api(`/api/host-stats/history?hours=${encodeURIComponent(hostHours)}`),
      ]);
    state.status = statusData;
    state.projects = projectsData.projects;
    pruneProjectUiState();
    state.storage = storageData.storage;
    if ($("#fileToolsDialog")?.open) populateFileToolsProjects($("#fileToolsProject").value);
    $("#serviceStatus").textContent = "Service online";
    if ($("#footerProductName"))
      $("#footerProductName").textContent = statusData.productName || "Ultimate Project Manager";
    if ($("#footerVersion"))
      $("#footerVersion").textContent = statusData.version ? `v${statusData.version}` : "";
    $("#serviceStatus").className = "status-pill online";
    renderStats(statusData, storageData.storage);
    renderHostStats(statusData.host || {}, statusData.dockerRuntime || {});
    renderHostHistory(hostHistoryData.history || {});
    renderBackupStorage(storageData.storage);
    renderStorage(storageData.storage);
    renderProjects();
    renderActivity(activityData.activity);
  } catch (error) {
    $("#serviceStatus").textContent = "Service error";
    $("#serviceStatus").className = "status-pill";
    toast(error.message, true);
  }
}

function updateScheduleFields() {
  const type = $("#scheduleType").value;
  $("#scheduleIntervalWrap").hidden = type !== "interval";
  $("#scheduleTimeWrap").hidden = type === "interval";
  $("#weekdayWrap").hidden = type !== "weekly";
}

function setScheduleDays(days) {
  const selected = new Set((days || []).map(Number));
  document.querySelectorAll('input[name="scheduleDay"]').forEach((input) => {
    input.checked = selected.has(Number(input.value));
  });
}

function populateExecutionHosts(project = null) {
  const select = $("#executionHost");
  const agents = Array.isArray(state.status?.lanAgents) ? state.status.lanAgents : [];
  const current = project?.executionTarget === "lan" ? `lan:${project.remoteAgentId}` : "local";
  const options = ['<option value="local">This PC (local)</option>'];
  for (const agent of agents) {
    const suffix = agent.available ? "online" : "offline";
    options.push(
      `<option value="lan:${escapeHtml(agent.id)}">${escapeHtml(agent.name || agent.id)} · LAN agent · ${suffix}</option>`,
    );
  }
  if (
    project?.executionTarget === "lan" &&
    !agents.some((agent) => agent.id === project.remoteAgentId)
  )
    options.push(
      `<option value="lan:${escapeHtml(project.remoteAgentId)}">${escapeHtml(project.remoteAgentId)} · not configured</option>`,
    );
  select.innerHTML = options.join("");
  select.value = current;
}

function updateExecutionHostFields() {
  const value = $("#executionHost").value;
  const remote = value.startsWith("lan:");
  $("#executionHostHint").textContent = remote
    ? "Paths below belong to the selected LAN PC. Backups and PM2 status are executed by its authenticated remote agent."
    : "Local projects use this PC's filesystem, PM2 daemon, and backup destinations.";
  document
    .querySelectorAll(
      '[data-browse-target="projectRoot"], [data-browse-target="backupDir"], [data-browse-target="backupDirSecondary"]',
    )
    .forEach((button) => {
      button.disabled = remote;
      button.title = remote ? "Remote paths cannot be browsed from the controller PC." : "";
    });
  $("#pm2ControlsEnabled").disabled = remote;
  $("#pm2AutoStart").disabled = remote;
  $("#pm2WaitForDocker").disabled = remote;
  if (remote) {
    $("#pm2ControlsEnabled").checked = false;
    $("#pm2AutoStart").checked = false;
    $("#pm2WaitForDocker").checked = false;
    $("#backupEncryptionState").innerHTML =
      '<span class="badge success">Agent-Managed</span> Encrypted remote backups use <code>UPM_AGENT_BACKUP_ENCRYPTION_KEY</code> on the selected LAN PC; the key never crosses the network.';
  } else {
    const configured = Boolean(state.status?.security?.backupEncryptionConfigured);
    $("#backupEncryptionState").innerHTML = configured
      ? '<span class="badge success">AES-256-GCM Ready</span> Uses the secret from <code>UPM_BACKUP_ENCRYPTION_KEY</code>. Existing backups keep their original encryption state.'
      : '<span class="badge error">Key Missing</span> Configure <code>UPM_BACKUP_ENCRYPTION_KEY</code> before creating encrypted backups.';
  }
}

function projectServiceConfig(project, type, id = type) {
  const services = project?.serviceHealth?.services || [];
  return (
    services.find((service) => service.id === id) ||
    services.find((service) => service.type === type) ||
    null
  );
}

function customServiceLines(project) {
  const builtinIds = new Set(["redis", "mariadb", "postgres", "docker"]);
  return (project?.serviceHealth?.services || [])
    .filter((service) => !builtinIds.has(service.id))
    .filter((service) => ["http", "tcp"].includes(service.type))
    .map((service) => {
      const target = service.type === "http" ? service.url : `${service.host}:${service.port}`;
      return `${service.name} | ${service.type} | ${target}`;
    })
    .join("\n");
}

function parseHostPort(value, lineNumber) {
  const target = String(value || "").trim();
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(target);
  if (ipv6) {
    const port = Number(ipv6[2]);
    if (port >= 1 && port <= 65535) return { host: ipv6[1], port };
  }
  const separator = target.lastIndexOf(":");
  const host = separator > 0 ? target.slice(0, separator).trim() : "";
  const port = separator > 0 ? Number(target.slice(separator + 1)) : NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `Other service line ${lineNumber}: TCP target must be host:port (IPv6 may use [address]:port).`,
    );
  return { host, port };
}

function parseCustomHealthServices(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 28) throw new Error("A project can have at most 28 custom health services.");
  return lines.map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 3 || !parts.every(Boolean))
      throw new Error(
        `Other service line ${index + 1}: use Name | http | URL or Name | tcp | host:port.`,
      );
    const [name, rawType, target] = parts;
    const type = rawType.toLowerCase();
    const id = `custom-${index + 1}`;
    if (type === "http") {
      if (!/^https?:\/\//i.test(target))
        throw new Error(
          `Other service line ${index + 1}: HTTP target must start with http:// or https://.`,
        );
      return { id, name, type, enabled: true, url: target };
    }
    if (type === "tcp") {
      const { host, port } = parseHostPort(target, index + 1);
      return { id, name, type, enabled: true, host, port };
    }
    throw new Error(`Other service line ${index + 1}: type must be http or tcp.`);
  });
}

function collectServiceHealthConfig() {
  const custom = parseCustomHealthServices($("#serviceHealthCustomServices").value);
  return {
    enabled: $("#serviceHealthEnabled").checked,
    intervalSeconds: Number($("#serviceHealthIntervalSeconds").value),
    timeoutMs: Number($("#serviceHealthTimeoutMs").value),
    services: [
      {
        id: "redis",
        name: "Redis",
        type: "redis",
        enabled: $("#healthRedisEnabled").checked,
        host: $("#healthRedisHost").value.trim() || "127.0.0.1",
        port: Number($("#healthRedisPort").value),
      },
      {
        id: "mariadb",
        name: "MariaDB / MySQL",
        type: "mariadb",
        enabled: $("#healthMariaDbEnabled").checked,
        host: $("#healthMariaDbHost").value.trim() || "127.0.0.1",
        port: Number($("#healthMariaDbPort").value),
      },
      {
        id: "postgres",
        name: "PostgreSQL",
        type: "postgres",
        enabled: $("#healthPostgresEnabled").checked,
        host: $("#healthPostgresHost").value.trim() || "127.0.0.1",
        port: Number($("#healthPostgresPort").value),
      },
      {
        id: "docker",
        name: "Docker",
        type: "docker",
        enabled: $("#healthDockerEnabled").checked,
      },
      ...custom,
    ],
  };
}

function openProjectDialog(project = null) {
  $("#dialogTitle").textContent = project ? "Edit project" : "Add project";
  $("#projectId").value = project?.id || "";
  $("#name").value = project?.name || "";
  populateExecutionHosts(project);
  $("#projectRoot").value = project?.projectRoot || "";
  $("#backupDir").value = project?.backupDir || "";
  $("#backupDirSecondary").value = project?.backupDirSecondary || "";
  $("#backupEncryptionEnabled").checked = project?.backupEncryptionEnabled ?? false;
  $("#deltaJournalEnabled").checked = project?.deltaJournalEnabled ?? true;
  $("#deltaJournalRetentionDays").value = project?.deltaJournalRetentionDays || 180;
  $("#deltaJournalMaxEntries").value = project?.deltaJournalMaxEntries || 1000;
  $("#deltaJournalMaxStorageMB").value = project?.deltaJournalMaxStorageMB || 1024;
  $("#deltaJournalMaxFileMB").value = project?.deltaJournalMaxFileMB || 16;
  const encryptionConfigured =
    project?.backupEncryptionConfigured ??
    Boolean(state.status?.security?.backupEncryptionConfigured);
  $("#backupEncryptionState").innerHTML = !encryptionConfigured
    ? '<span class="badge error">Key Missing</span> Configure <code>UPM_BACKUP_ENCRYPTION_KEY</code> before creating encrypted backups.'
    : '<span class="badge success">AES-256-GCM Ready</span> Uses the secret from <code>UPM_BACKUP_ENCRYPTION_KEY</code>. Existing backups keep their original encryption state.';
  $("#keep").value = project?.keep || 10;
  $("#intervalSeconds").value = project?.intervalSeconds || 30;
  $("#watch").checked = project?.watch ?? true;
  $("#projectEditor").value = project?.editor || "default";
  $("#repositoryUrl").value = project?.repositoryUrl || "";
  $("#pm2Monitoring").checked = project?.pm2Monitoring ?? true;
  $("#pm2ControlsEnabled").checked = project?.pm2ControlsEnabled ?? false;
  $("#pm2AutoStart").checked = project?.pm2AutoStart ?? false;
  $("#pm2WaitForDocker").checked = project?.pm2WaitForDocker ?? false;
  $("#pm2EcosystemFile").value = project?.pm2EcosystemFile || "ecosystem.config.js";
  $("#pm2EcosystemAppName").value = project?.pm2EcosystemAppName || "";
  $("#pm2ProcessNames").value = (project?.pm2ProcessNames || []).join("\n");
  const serviceHealth = project?.serviceHealth || {};
  const redis = projectServiceConfig(project, "redis", "redis");
  const mariadb = projectServiceConfig(project, "mariadb", "mariadb");
  const postgres = projectServiceConfig(project, "postgres", "postgres");
  const docker = projectServiceConfig(project, "docker", "docker");
  $("#serviceHealthEnabled").checked = serviceHealth.enabled ?? false;
  $("#serviceHealthIntervalSeconds").value = serviceHealth.intervalSeconds || 30;
  $("#serviceHealthTimeoutMs").value = serviceHealth.timeoutMs || 3000;
  $("#healthRedisEnabled").checked = redis?.enabled ?? false;
  $("#healthRedisHost").value = redis?.host || "127.0.0.1";
  $("#healthRedisPort").value = redis?.port || 6379;
  $("#healthMariaDbEnabled").checked = mariadb?.enabled ?? false;
  $("#healthMariaDbHost").value = mariadb?.host || "127.0.0.1";
  $("#healthMariaDbPort").value = mariadb?.port || 3306;
  $("#healthPostgresEnabled").checked = postgres?.enabled ?? false;
  $("#healthPostgresHost").value = postgres?.host || "127.0.0.1";
  $("#healthPostgresPort").value = postgres?.port || 5432;
  $("#healthDockerEnabled").checked = docker?.enabled ?? false;
  $("#serviceHealthCustomServices").value = customServiceLines(project);
  $("#extraExcludes").value = (project?.extraExcludes || []).join("\n");
  $("#extraIncludes").value = (project?.extraIncludes || []).join("\n");
  $("#scheduleEnabled").checked = project?.schedule?.enabled ?? false;
  $("#scheduleType").value = project?.schedule?.type || "daily";
  $("#scheduleEveryMinutes").value = project?.schedule?.everyMinutes || 60;
  $("#scheduleTime").value = project?.schedule?.time || "02:00";
  setScheduleDays(project?.schedule?.daysOfWeek || [1, 2, 3, 4, 5]);
  updateScheduleFields();
  updateExecutionHostFields();
  setProjectSettingsTab("general");
  $("#projectDialog").showModal();
}

async function saveProject(event) {
  event.preventDefault();
  const id = $("#projectId").value;
  const executionHost = $("#executionHost").value;
  const remote = executionHost.startsWith("lan:");
  let serviceHealth;
  try {
    serviceHealth = collectServiceHealthConfig();
  } catch (error) {
    setProjectSettingsTab("services");
    toast(error.message, true);
    return;
  }
  const payload = {
    name: $("#name").value.trim(),
    executionTarget: remote ? "lan" : "local",
    remoteAgentId: remote ? executionHost.slice(4) : null,
    projectRoot: $("#projectRoot").value.trim(),
    backupDir: $("#backupDir").value.trim() || null,
    backupDirSecondary: $("#backupDirSecondary").value.trim() || null,
    backupEncryptionEnabled: $("#backupEncryptionEnabled").checked,
    deltaJournalEnabled: $("#deltaJournalEnabled").checked,
    deltaJournalRetentionDays: Number($("#deltaJournalRetentionDays").value),
    deltaJournalMaxEntries: Number($("#deltaJournalMaxEntries").value),
    deltaJournalMaxStorageMB: Number($("#deltaJournalMaxStorageMB").value),
    deltaJournalMaxFileMB: Number($("#deltaJournalMaxFileMB").value),
    keep: Number($("#keep").value),
    intervalSeconds: Number($("#intervalSeconds").value),
    watch: $("#watch").checked,
    editor: $("#projectEditor").value,
    repositoryUrl: $("#repositoryUrl").value.trim() || null,
    pm2Monitoring: $("#pm2Monitoring").checked,
    pm2ControlsEnabled: $("#pm2ControlsEnabled").checked,
    pm2AutoStart: $("#pm2AutoStart").checked,
    pm2WaitForDocker: $("#pm2WaitForDocker").checked,
    pm2EcosystemFile: $("#pm2EcosystemFile").value.trim() || "ecosystem.config.js",
    pm2EcosystemAppName: $("#pm2EcosystemAppName").value.trim() || null,
    pm2ProcessNames: $("#pm2ProcessNames")
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    serviceHealth,
    extraExcludes: $("#extraExcludes")
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    extraIncludes: $("#extraIncludes")
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    schedule: {
      enabled: $("#scheduleEnabled").checked,
      type: $("#scheduleType").value,
      everyMinutes: Number($("#scheduleEveryMinutes").value),
      time: $("#scheduleTime").value || "02:00",
      daysOfWeek: [...document.querySelectorAll('input[name="scheduleDay"]:checked')].map((input) =>
        Number(input.value),
      ),
    },
  };

  try {
    await api(id ? `/api/projects/${id}` : "/api/projects", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    $("#projectDialog").close();
    toast(id ? "Project updated." : "Project added.");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

function verificationBadge(backup) {
  if (backup.configuredCopies > 1) {
    if (backup.mirrorHealthy) return '<span class="badge success">2 Copies Verified</span>';
    return '<span class="badge warning">Mirror Warning</span>';
  }
  if (backup.verificationStatus === "verified")
    return '<span class="badge success">Verified</span>';
  if (backup.verificationStatus === "failed") return '<span class="badge error">Failed</span>';
  return '<span class="badge">Unverified</span>';
}

function renderBackupCopies(backup) {
  return (backup.destinations || [])
    .map((copy) => {
      const cls =
        copy.verificationStatus === "verified"
          ? "success"
          : copy.verificationStatus === "failed"
            ? "error"
            : "warning";
      const status = copy.path ? copy.verificationStatus : "missing";
      const download = copy.path
        ? `<a class="button tiny" href="/api/projects/${state.selectedBackupProject}/backups/${encodeURIComponent(backup.file)}/download?destination=${encodeURIComponent(copy.key)}">Download ${escapeHtml(copy.label)}</a>`
        : "";
      return `<div class="backup-copy-row"><span class="badge ${cls}">${escapeHtml(copy.label)} · ${escapeHtml(status)}</span><span class="path">${escapeHtml(copy.dir || "")}</span><span>${copy.path ? formatBytes(copy.size) : "Missing"}</span>${download}</div>`;
    })
    .join("");
}

async function showBackups(project) {
  state.selectedBackupProject = project.id;
  $("#backupsTitle").textContent = `${project.name} backups`;
  $("#backupsList").innerHTML = '<p class="muted">Loading…</p>';
  if (!$("#backupsDialog").open) $("#backupsDialog").showModal();
  try {
    const data = await api(`/api/projects/${project.id}/backups`);
    $("#backupsList").innerHTML = data.backups.length
      ? data.backups
          .map((backup) => {
            const c = backup.changes || {};
            return `<div class="backup-row" data-file="${escapeHtml(backup.file)}">
        <div class="backup-info">
          <div class="backup-title-line"><div class="backup-name">${escapeHtml(backup.file)}</div>${backup.encrypted ? '<span class="badge success">AES-256-GCM</span>' : '<span class="badge">Plain</span>'}${verificationBadge(backup)}</div>
          <div class="backup-meta">${escapeHtml(formatDate(backup.createdAt))} · ${backup.fileCount ?? "-"} files · ${backup.copyCount ?? 1}/${backup.configuredCopies ?? 1} copies · ${formatBytes(backup.totalStoredBytes ?? backup.size)} stored · +${c.added?.length || 0} ~${c.modified?.length || 0} -${c.deleted?.length || 0}${backup.encrypted ? " · encrypted" : " · unencrypted"}${backup.forced ? " · forced" : ""}</div>
          <div class="backup-copy-list">${renderBackupCopies(backup)}</div>
        </div>
        <div class="backup-actions">
          <button type="button" class="button small" data-verify-backup>Verify</button>
          <button type="button" class="button small" data-restore-backup>Restore</button>
          <button type="button" class="button danger small" data-delete-backup>Delete</button>
        </div>
      </div>`;
          })
          .join("")
      : '<div class="empty">No backups yet.</div>';
  } catch (error) {
    $("#backupsList").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function openRestoreDialog(project, file) {
  $("#restoreProjectId").value = project.id;
  $("#restoreFile").value = file;
  $("#restoreBackupName").textContent = file;
  $("#restoreDestination").value = "";
  $("#restoreOverwrite").checked = false;
  $("#restoreDialog").showModal();
}

async function submitRestore(event) {
  event.preventDefault();
  const projectId = $("#restoreProjectId").value;
  const file = $("#restoreFile").value;
  const submit = $('#restoreForm button[type="submit"]');
  submit.disabled = true;
  try {
    const data = await api(
      `/api/projects/${projectId}/backups/${encodeURIComponent(file)}/restore`,
      {
        method: "POST",
        body: JSON.stringify({
          destination: $("#restoreDestination").value.trim() || null,
          overwrite: $("#restoreOverwrite").checked,
        }),
      },
    );
    $("#restoreDialog").close();
    toast(`Restored to ${data.result.destination}`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

function dependencyStatusBadge(dep) {
  if (dep.missing) return '<span class="badge error">Missing</span>';
  if (dep.outdated) return '<span class="badge warning">Outdated</span>';
  if (dep.upToDate) return '<span class="badge success">Current</span>';
  return '<span class="badge">Unknown</span>';
}

function filteredDependencies() {
  const deps = state.dependencyData?.dependencies || [];
  const filter = $("#dependencyFilter")?.value || "all";
  const query = ($("#dependencySearch")?.value || "").trim().toLowerCase();
  return deps.filter((dep) => {
    if (query && !dep.name.toLowerCase().includes(query)) return false;
    if (filter === "outdated" && !dep.outdated) return false;
    if (filter === "missing" && !dep.missing) return false;
    if (filter === "production" && !dep.types.includes("production")) return false;
    if (filter === "development" && !dep.types.includes("development")) return false;
    return true;
  });
}

function uniqueVersions(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function dependencyQuickVersions(dep) {
  return uniqueVersions([dep.latest, dep.wanted, dep.current, dep.locked]);
}

function dependencyVersionLabel(dep, version) {
  const tags = [];
  if (version === dep.latest) tags.push("latest");
  if (version === dep.wanted) tags.push("wanted");
  if (version === dep.current) tags.push("installed");
  if (version === dep.locked && version !== dep.current) tags.push("locked");
  return tags.length ? `${version} - ${tags.join(", ")}` : version;
}

function dependencyVersionSelect(dep) {
  const loaded = state.dependencyVersions[dep.name];
  const versions = loaded?.versions?.length ? loaded.versions : dependencyQuickVersions(dep);
  const selected = loaded?.selected || "";
  const options = versions
    .map(
      (version) =>
        `<option value="${escapeHtml(version)}"${selected === version ? " selected" : ""}>${escapeHtml(dependencyVersionLabel(dep, version))}</option>`,
    )
    .join("");
  const prereleaseText = $("#dependencyIncludePrerelease")?.checked
    ? "including prereleases"
    : "stable only";
  return `<select class="dependency-version-select" data-dependency-name="${escapeHtml(dep.name)}" aria-label="Version for ${escapeHtml(dep.name)}">
    <option value=""${selected ? "" : " selected"}>Choose version…</option>
    ${options}
    <option value="__load_all__">Load all published versions… (${escapeHtml(prereleaseText)})</option>
  </select>`;
}

function renderDependencies() {
  const data = state.dependencyData;
  if (!data) return;
  const summary = data.summary || {};
  $("#dependencySummary").innerHTML = [
    ["Total", summary.total ?? 0],
    ["Outdated", summary.outdated ?? 0],
    ["Missing", summary.missing ?? 0],
    ["Current", summary.current ?? 0],
  ]
    .map(
      ([label, value]) =>
        `<div class="health-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");

  $("#dependenciesStatus").innerHTML =
    `${escapeHtml(data.packageName || "package")} ${data.packageVersion ? `v${escapeHtml(data.packageVersion)}` : ""} · checked ${escapeHtml(formatDate(data.checkedAt))} · ${data.registryAvailable ? '<span class="text-success">npm registry check available</span>' : `<span class="text-warning">npm registry unavailable - ${escapeHtml(data.registryError || "update status could not be checked")}</span>`}`;
  const rows = filteredDependencies();
  const anyUpdating = Object.values(state.dependencyUpdating).some(Boolean);
  $("#dependenciesList").innerHTML = rows.length
    ? `<table class="dependency-table"><thead><tr><th>Package</th><th>Type</th><th>Declared</th><th>Installed</th><th>Wanted</th><th>Latest</th><th>Status</th><th>Version</th><th>Action</th></tr></thead><tbody>${rows
        .map((dep) => {
          const updating = state.dependencyUpdating[dep.name] === true;
          const selected = state.dependencyVersions[dep.name]?.selected || "";
          return `<tr class="${dep.outdated ? "dependency-outdated" : dep.missing ? "dependency-missing" : ""}">
      <td><strong>${escapeHtml(dep.name)}</strong></td>
      <td>${escapeHtml(dep.types.join(", "))}</td>
      <td><code>${escapeHtml(dep.declared)}</code></td>
      <td>${escapeHtml(dep.current || "-")}</td>
      <td>${escapeHtml(dep.wanted || "-")}</td>
      <td>${escapeHtml(dep.latest || "-")}</td>
      <td>${dependencyStatusBadge(dep)}</td>
      <td class="dependency-version-cell">${dependencyVersionSelect(dep)}</td>
      <td><button type="button" class="button small primary dependency-update-button" data-dependency-update="${escapeHtml(dep.name)}"${!selected || anyUpdating ? " disabled" : ""}>${updating ? "Applying…" : "Apply"}</button></td>
    </tr>`;
        })
        .join("")}</tbody></table>`
    : '<div class="empty">No dependencies match this filter.</div>';
}

async function loadDependencyVersions(packageName, refresh = false) {
  const project = state.projects.find((item) => item.id === state.selectedDependencyProject);
  if (!project) return;
  const select = [...document.querySelectorAll(".dependency-version-select")].find(
    (el) => el.dataset.dependencyName === packageName,
  );
  if (select) {
    select.disabled = true;
    select.options[select.selectedIndex].textContent = "Loading published versions…";
  }
  try {
    const params = new URLSearchParams();
    if ($("#dependencyIncludePrerelease")?.checked) params.set("includePrerelease", "true");
    if (refresh) params.set("refresh", "true");
    params.set("name", packageName);
    const data = await api(`/api/projects/${project.id}/dependency-versions?${params}`);
    const previous = state.dependencyVersions[packageName]?.selected || "";
    state.dependencyVersions[packageName] = {
      versions: data.versions.versions || [],
      selected: previous && data.versions.versions.includes(previous) ? previous : "",
      checkedAt: data.versions.checkedAt,
    };
    renderDependencies();
    toast(`Loaded ${data.versions.versions.length} published versions for ${packageName}.`);
  } catch (error) {
    renderDependencies();
    toast(error.message, true);
  }
}

async function updateSelectedDependency(packageName) {
  const project = state.projects.find((item) => item.id === state.selectedDependencyProject);
  const selectedVersion = state.dependencyVersions[packageName]?.selected;
  if (!project || !selectedVersion || state.dependencyUpdating[packageName]) return;
  const saveMode = $("#dependencySaveMode")?.value || "preserve";
  const runScripts = $("#dependencyRunScripts")?.checked !== false;
  const proceed = window.confirm(
    `Update ${packageName} to ${selectedVersion}?\n\nSave mode: ${saveMode}\nLifecycle scripts: ${runScripts ? "enabled" : "disabled"}`,
  );
  if (!proceed) return;

  state.dependencyUpdating[packageName] = true;
  renderDependencies();
  try {
    const data = await api(`/api/projects/${project.id}/dependency-update`, {
      method: "POST",
      body: JSON.stringify({
        name: packageName,
        version: selectedVersion,
        saveMode,
        runScripts,
      }),
    });
    toast(`${packageName} updated to ${data.result.version}.`);
    delete state.dependencyVersions[packageName];
    await loadDependencies(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    delete state.dependencyUpdating[packageName];
    renderDependencies();
  }
}

async function loadDependencies(refreshRegistry = false) {
  const project = state.projects.find((item) => item.id === state.selectedDependencyProject);
  if (!project) return;
  $("#dependenciesStatus").textContent = refreshRegistry
    ? "Checking npm registry…"
    : "Loading dependencies…";
  const query = refreshRegistry ? "?refresh=true" : "";
  const data = await api(`/api/projects/${project.id}/dependencies${query}`);
  state.dependencyData = data.dependencies;
  renderDependencies();
  await refresh();
}

async function openDependencies(project) {
  state.selectedDependencyProject = project.id;
  state.dependencyData = null;
  state.dependencyVersions = {};
  state.dependencyUpdating = {};
  $("#dependenciesTitle").textContent = `${project.name} dependencies`;
  $("#dependencySearch").value = "";
  $("#dependencyFilter").value = "all";
  $("#dependencySaveMode").value = "preserve";
  $("#dependencyIncludePrerelease").checked = false;
  $("#dependencyRunScripts").checked = true;
  $("#dependenciesStatus").textContent = "Loading package.json and npm dependency status…";
  $("#dependencySummary").innerHTML = "";
  $("#dependenciesList").innerHTML = '<div class="empty">Loading dependencies…</div>';
  $("#dependenciesDialog").showModal();
  try {
    await loadDependencies(false);
  } catch (error) {
    $("#dependenciesList").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  }
}

const interactiveChartState = new WeakMap();

function chartTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    line: style.getPropertyValue("--accent").trim() || "#60a5fa",
    peak: style.getPropertyValue("--warning").trim() || "#fbbf24",
    danger: style.getPropertyValue("--danger").trim() || "#fb7185",
    grid: style.getPropertyValue("--border").trim() || "#283140",
    text: style.getPropertyValue("--muted").trim() || "#8b98aa",
    foreground: style.getPropertyValue("--text").trim() || "#e7ecf3",
    surface: style.getPropertyValue("--panel").trim() || "#151922",
  };
}

function niceChartMaximum(value, floor = 1) {
  const target = Math.max(Number(value) || 0, Number(floor) || 1, 1e-9);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function chartTimestampLabel(value, includeDate = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value || "");
  return date.toLocaleString(
    [],
    includeDate
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { hour: "numeric", minute: "2-digit" },
  );
}

function ensureChartTooltip(canvas) {
  const panel =
    canvas.closest(".interactive-chart-panel, .metric-panel, .host-chart-panel") ||
    canvas.parentElement;
  if (!panel) return null;
  panel.classList.add("interactive-chart-panel");
  let tooltip = panel.querySelector(`.chart-tooltip[data-chart-for="${canvas.id}"]`);
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.dataset.chartFor = canvas.id;
    tooltip.setAttribute("role", "status");
    tooltip.setAttribute("aria-live", "polite");
    tooltip.hidden = true;
    panel.appendChild(tooltip);
  }
  return tooltip;
}

function nearestChartPointIndex(spec, cssX) {
  if (!spec.points.length) return -1;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  spec.pointXs.forEach((x, index) => {
    const distance = Math.abs(x - cssX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function showChartTooltip(canvas, index, anchor = {}) {
  const spec = interactiveChartState.get(canvas);
  if (!spec || index < 0 || index >= spec.points.length) return;
  const point = spec.points[index];
  const tooltip = ensureChartTooltip(canvas);
  if (!tooltip) return;
  const rows = spec.series
    .map((item, seriesIndex) => {
      const value = Number(point[item.key]);
      if (!Number.isFinite(value)) return "";
      return `<div class="chart-tooltip-row"><span class="chart-tooltip-swatch chart-series-${seriesIndex % 3}"></span><span>${escapeHtml(item.label || item.key)}</span><strong>${escapeHtml(spec.formatter(value))}</strong></div>`;
    })
    .join("");
  tooltip.innerHTML = `<div class="chart-tooltip-time">${escapeHtml(chartTimestampLabel(point.timestamp, true))}</div>${rows || '<div class="muted">No value for this sample.</div>'}`;
  tooltip.hidden = false;

  const panel = tooltip.parentElement;
  const canvasRect = canvas.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const x = Number.isFinite(anchor.x) ? anchor.x : spec.pointXs[index];
  const y = Number.isFinite(anchor.y) ? anchor.y : spec.pad.top + 18;
  const desiredLeft = canvasRect.left - panelRect.left + x + 12;
  const desiredTop = canvasRect.top - panelRect.top + y - 10;
  const maxLeft = Math.max(8, panel.clientWidth - tooltip.offsetWidth - 8);
  const maxTop = Math.max(8, panel.clientHeight - tooltip.offsetHeight - 8);
  tooltip.style.left = `${Math.max(8, Math.min(maxLeft, desiredLeft))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(maxTop, desiredTop))}px`;
}

function hideChartTooltip(canvas) {
  const panel =
    canvas.closest(".interactive-chart-panel, .metric-panel, .host-chart-panel") ||
    canvas.parentElement;
  const tooltip = panel?.querySelector(`.chart-tooltip[data-chart-for="${canvas.id}"]`);
  if (tooltip) tooltip.hidden = true;
}

function bindInteractiveChart(canvas) {
  if (canvas.dataset.interactiveChartBound === "true") return;
  canvas.dataset.interactiveChartBound = "true";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-describedby",
    canvas.getAttribute("aria-describedby") || "chartInteractionHelp",
  );

  canvas.addEventListener("pointermove", (event) => {
    const spec = interactiveChartState.get(canvas);
    if (!spec?.points.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(
      spec.pad.left,
      Math.min(rect.width - spec.pad.right, event.clientX - rect.left),
    );
    const y = Math.max(
      spec.pad.top,
      Math.min(rect.height - spec.pad.bottom, event.clientY - rect.top),
    );
    const index = nearestChartPointIndex(spec, x);
    spec.hoverIndex = index;
    paintLineChart(canvas, spec);
    showChartTooltip(canvas, index, { x, y });
  });
  canvas.addEventListener("pointerleave", () => {
    const spec = interactiveChartState.get(canvas);
    if (!spec) return;
    spec.hoverIndex = -1;
    paintLineChart(canvas, spec);
    hideChartTooltip(canvas);
  });
  canvas.addEventListener("focus", () => {
    const spec = interactiveChartState.get(canvas);
    if (!spec?.points.length) return;
    spec.hoverIndex = Math.max(0, spec.hoverIndex >= 0 ? spec.hoverIndex : spec.points.length - 1);
    paintLineChart(canvas, spec);
    showChartTooltip(canvas, spec.hoverIndex);
  });
  canvas.addEventListener("blur", () => {
    const spec = interactiveChartState.get(canvas);
    if (!spec) return;
    spec.hoverIndex = -1;
    paintLineChart(canvas, spec);
    hideChartTooltip(canvas);
  });
  canvas.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const spec = interactiveChartState.get(canvas);
    if (!spec?.points.length) return;
    event.preventDefault();
    const current = spec.hoverIndex >= 0 ? spec.hoverIndex : spec.points.length - 1;
    if (event.key === "Home") spec.hoverIndex = 0;
    else if (event.key === "End") spec.hoverIndex = spec.points.length - 1;
    else if (event.key === "ArrowLeft") spec.hoverIndex = Math.max(0, current - 1);
    else spec.hoverIndex = Math.min(spec.points.length - 1, current + 1);
    paintLineChart(canvas, spec);
    showChartTooltip(canvas, spec.hoverIndex);
  });
}

function paintLineChart(canvas, spec) {
  const { ctx, width, height, pad, plotW, plotH, points, series, formatter, minValue, maxValue } =
    spec;
  const theme = chartTheme();
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.text;
  ctx.font = "11px system-ui";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const value = maxValue - ((maxValue - minValue) * i) / 4;
    ctx.fillText(formatter(value), 4, y + 4);
  }

  if (!points.length) {
    ctx.fillText("No historical samples yet.", pad.left + 12, pad.top + 25);
    return;
  }

  const timeValues = points.map((point) => new Date(point.timestamp).getTime());
  const validTimeline = timeValues.every(Number.isFinite) && timeValues.at(-1) > timeValues[0];
  const startTime = validTimeline ? timeValues[0] : 0;
  const timeSpan = validTimeline ? Math.max(1, timeValues.at(-1) - startTime) : 1;
  const xForIndex = (index) =>
    pad.left +
    plotW *
      (validTimeline
        ? (timeValues[index] - startTime) / timeSpan
        : points.length === 1
          ? 0
          : index / (points.length - 1));
  spec.pointXs = points.map((_, index) => xForIndex(index));

  const colors = [theme.line, theme.peak, theme.danger];
  const linePatterns = [[], [8, 5], [2, 4]];
  const range = Math.max(1e-9, maxValue - minValue);
  series.forEach((item, seriesIndex) => {
    ctx.strokeStyle = colors[seriesIndex % colors.length];
    ctx.setLineDash(
      state.uiPreferences.chartPatterns !== false
        ? linePatterns[seriesIndex % linePatterns.length]
        : [],
    );
    ctx.lineWidth = seriesIndex === 0 ? 2.2 : 1.6;
    ctx.beginPath();
    let started = false;
    points.forEach((point, pointIndex) => {
      const value = Number(point[item.key]);
      if (!Number.isFinite(value)) {
        started = false;
        return;
      }
      const x = xForIndex(pointIndex);
      const y = pad.top + plotH - ((value - minValue) / range) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.setLineDash([]);

  if (spec.showLegend !== false) {
    let legendX = pad.left;
    const legendY = 14;
    series.forEach((item, seriesIndex) => {
      const label = item.label || item.key;
      ctx.strokeStyle = colors[seriesIndex % colors.length];
      ctx.lineWidth = 2;
      ctx.setLineDash(
        state.uiPreferences.chartPatterns !== false
          ? linePatterns[seriesIndex % linePatterns.length]
          : [],
      );
      ctx.beginPath();
      ctx.moveTo(legendX, legendY);
      ctx.lineTo(legendX + 18, legendY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.text;
      ctx.fillText(label, legendX + 24, legendY + 4);
      legendX += 31 + ctx.measureText(label).width;
    });
  }

  const tickIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  ctx.fillStyle = theme.text;
  tickIndexes.forEach((index, tickIndex) => {
    const label = chartTimestampLabel(points[index].timestamp, tickIndex !== 1);
    const labelWidth = ctx.measureText(label).width;
    let x = xForIndex(index) - labelWidth / 2;
    x = Math.max(pad.left, Math.min(width - pad.right - labelWidth, x));
    ctx.fillText(label, x, height - 8);
  });

  if (spec.hoverIndex >= 0 && spec.hoverIndex < points.length) {
    const index = spec.hoverIndex;
    const x = xForIndex(index);
    ctx.strokeStyle = theme.foreground;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;

    series.forEach((item, seriesIndex) => {
      const value = Number(points[index][item.key]);
      if (!Number.isFinite(value)) return;
      const y = pad.top + plotH - ((value - minValue) / range) * plotH;
      ctx.fillStyle = colors[seriesIndex % colors.length];
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = theme.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function drawLineChart(canvas, points, series, formatter = (value) => String(value), options = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width || 520));
  const height = Math.max(
    options.minHeight || 190,
    Math.floor(rect.height || options.minHeight || 230),
  );
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const showLegend = options.showLegend !== false;
  const pad = { left: 58, right: 16, top: showLegend ? 30 : 14, bottom: 32 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const allValues = points.flatMap((point) =>
    series.map((item) => Number(point[item.key])).filter(Number.isFinite),
  );
  const minValue = Number.isFinite(options.minValue) ? Number(options.minValue) : 0;
  const observedMax = Math.max(Number(options.minMax) || 0, ...allValues, minValue + 1e-9);
  const maxValue = Number.isFinite(options.maxValue)
    ? Math.max(Number(options.maxValue), observedMax)
    : niceChartMaximum(observedMax, options.minMax || 1);
  const prior = interactiveChartState.get(canvas);
  const spec = {
    ctx,
    width,
    height,
    pad,
    plotW,
    plotH,
    points: Array.isArray(points) ? points : [],
    series: Array.isArray(series) ? series : [],
    formatter,
    minValue,
    maxValue,
    showLegend,
    hoverIndex: Math.min(prior?.hoverIndex ?? -1, Math.max(-1, points.length - 1)),
    pointXs: [],
  };
  interactiveChartState.set(canvas, spec);
  bindInteractiveChart(canvas);
  paintLineChart(canvas, spec);
  if (spec.hoverIndex >= 0) showChartTooltip(canvas, spec.hoverIndex);
}

function renderPm2HistoryCharts(history) {
  const points = history?.points || [];
  drawLineChart(
    $("#pm2CpuChart"),
    points,
    [
      { key: "cpuAverage", label: "Average" },
      { key: "cpuPeak", label: "Peak" },
    ],
    (value) => `${value.toFixed(0)}%`,
    { minMax: 10, maxValue: 100 },
  );
  drawLineChart(
    $("#pm2GpuChart"),
    points,
    [
      { key: "gpuAverage", label: "Average" },
      { key: "gpuPeak", label: "Peak" },
    ],
    (value) => `${value.toFixed(0)}%`,
    { minMax: 10, maxValue: 100 },
  );
  drawLineChart(
    $("#pm2HttpRateChart"),
    points,
    [
      { key: "httpRequestsAveragePerSecond", label: "Average" },
      { key: "httpRequestsPeakPerSecond", label: "Peak" },
    ],
    (value) => `${value.toFixed(value >= 10 ? 0 : 1)} req/s`,
    { minMax: 1 },
  );
  drawLineChart(
    $("#pm2HttpLatencyChart"),
    points,
    [
      { key: "httpMeanLatencyMs", label: "Mean" },
      { key: "httpP95LatencyMs", label: "P95" },
    ],
    (value) => `${value.toFixed(value >= 10 ? 0 : 1)} ms`,
    { minMax: 5 },
  );
  drawLineChart(
    $("#pm2MemoryChart"),
    points,
    [
      { key: "memoryAverageBytes", label: "Average" },
      { key: "memoryPeakBytes", label: "Peak" },
    ],
    (value) => formatBytes(value),
    { minMax: 1024 * 1024 },
  );
  drawLineChart(
    $("#pm2UptimeChart"),
    points,
    [{ key: "uptimeMs", label: "Uptime" }],
    (value) => formatDuration(value),
    { minMax: 60 * 1000 },
  );
  drawLineChart(
    $("#pm2RestartsChart"),
    points,
    [{ key: "restarts", label: "Restarts" }],
    (value) => Math.round(value).toString(),
    { minMax: 1 },
  );
  drawLineChart(
    $("#pm2EventsChart"),
    points,
    [
      { key: "processCrashes", label: "Crashes" },
      { key: "unexpectedRestarts", label: "Unexpected Restarts" },
      { key: "daemonRestarts", label: "Daemon Restarts" },
    ],
    (value) => Math.round(value).toString(),
    { minMax: 1 },
  );
}

function renderPm2Events(events) {
  $("#pm2EventList").innerHTML = events?.length
    ? events
        .map((event, index) => {
          const cls =
            event.severity === "error"
              ? "error"
              : event.severity === "warning"
                ? "warning"
                : "success";
          const label = event.unexpected
            ? "Unexpected"
            : event.plannedAction
              ? `Planned ${event.plannedAction}`
              : "Observed";
          return `<button type="button" class="pm2-event-row pm2-event-button" data-pm2-event-index="${index}" title="View Full PM2 Event Details"><span class="activity-dot ${cls}"></span><div><div class="pm2-event-title">${escapeHtml(event.message)}</div><div class="backup-meta">${escapeHtml(formatDate(event.timestamp))} · ${escapeHtml(label)} · ${escapeHtml(event.eventType)} · Click For Details</div></div><span class="activity-open-indicator" aria-hidden="true">›</span></button>`;
        })
        .join("")
    : '<div class="empty">No PM2 crash/restart events in this range.</div>';
}

function renderPm2Snapshots(snapshots) {
  $("#pm2SnapshotList").innerHTML = snapshots?.length
    ? `<table class="process-history-table"><thead><tr><th>Time</th><th>Process</th><th>Status</th><th>PID</th><th>CPU</th><th>GPU</th><th>HTTP</th><th>RAM</th><th>Uptime</th><th>Restarts</th><th>Node / app</th><th>Mode</th><th>Script / cwd</th></tr></thead><tbody>${snapshots
        .map((item) => {
          const statusClass =
            item.status === "online"
              ? "success"
              : ["errored", "error"].includes(item.status)
                ? "error"
                : "warning";
          const processName =
            item.namespace && item.namespace !== "default"
              ? `${item.namespace}/${item.name}`
              : item.name;
          const versions =
            [
              item.nodeVersion ? `Node ${item.nodeVersion}` : null,
              item.version ? `App ${item.version}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "-";
          return `<tr><td>${escapeHtml(formatDate(item.timestamp))}</td><td><strong>${escapeHtml(processName || "-")}</strong><div class="muted">ID ${escapeHtml(item.pm2Id ?? "-")}</div></td><td><span class="badge ${statusClass}">${escapeHtml(item.status || "unknown")}</span></td><td>${escapeHtml(item.pid || "-")}</td><td title="${escapeHtml(processCpuTitle(item))}">${escapeHtml(formatProcessCpu(item))}</td><td>${escapeHtml(formatGpuMetric(item))}</td><td>${hasHttpProcessMetrics(item) ? `${escapeHtml(formatHttpRate(item))}${Number.isFinite(Number(item.httpP95LatencyMs)) ? `<div class="muted">p95 ${escapeHtml(formatLatency(item.httpP95LatencyMs))}</div>` : ""}` : "-"}</td><td>${escapeHtml(formatBytes(item.memoryBytes))}</td><td>${escapeHtml(formatDuration(item.uptimeMs))}</td><td>${escapeHtml(item.restarts ?? 0)}${item.unstableRestarts ? ` <span class="muted">(${escapeHtml(item.unstableRestarts)} unstable)</span>` : ""}</td><td>${escapeHtml(versions)}</td><td>${escapeHtml(item.execMode || "-")}</td><td class="path">${escapeHtml(item.script || item.cwd || "-")}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : '<div class="empty">No PM2 process snapshots in this range yet.</div>';
}

function renderPm2History(history) {
  state.pm2HistoryData = history;
  const summary = history.summary || {};
  $("#pm2HistorySummary").innerHTML = [
    ["Peak CPU", `${Number(summary.peakCpu || 0).toFixed(1)}%`],
    ["Peak PM2 Raw CPU", `${Number(summary.peakRawCpu || 0).toFixed(1)}%`],
    ["Peak GPU", `${Number(summary.peakGpu || 0).toFixed(1)}%`],
    ["Peak HTTP", `${Number(summary.peakHttpRequestsPerSecond || 0).toFixed(1)} req/s`],
    ["Peak HTTP p95", formatLatency(summary.peakHttpP95LatencyMs || 0)],
    ["Peak RAM", formatBytes(summary.peakMemoryBytes || 0)],
    ["Max uptime", formatDuration(summary.maxUptimeMs || 0)],
    ["Restart counter", summary.maxRestartCounter ?? 0],
    ["Unexpected crashes", summary.crashes ?? 0],
    ["Unexpected restarts", summary.unexpectedRestarts ?? 0],
    ["Daemon restarts", summary.daemonRestarts ?? 0],
    ["Samples", summary.sampleCount ?? 0],
  ]
    .map(
      ([label, value]) =>
        `<div class="health-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("");

  const select = $("#pm2HistoryProcess");
  const current = history.processKey || select.value || "";
  select.innerHTML = `<option value="">All matched processes</option>${(history.processes || []).map((proc) => `<option value="${escapeHtml(proc.processKey)}">${escapeHtml(proc.namespace && proc.namespace !== "default" ? `${proc.namespace}/${proc.name}` : proc.name)} · ID ${escapeHtml(proc.pm2Id ?? "-")}</option>`).join("")}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  renderPm2HistoryCharts(history);
  renderPm2Events(history.events || []);
  renderPm2Snapshots(history.snapshots || []);
}

async function loadPm2History(processKey = null) {
  const project = state.projects.find((item) => item.id === state.pm2HistoryProject);
  if (!project) return;
  const selected = processKey ?? $("#pm2HistoryProcess")?.value ?? "";
  const query = new URLSearchParams({
    range: state.pm2HistoryRange,
    maxPoints: "420",
  });
  if (selected) query.set("process", selected);
  const data = await api(`/api/projects/${project.id}/pm2/history?${query}`);
  renderPm2History(data.history);
}

async function openPm2History(project, processKey = null) {
  state.pm2HistoryProject = project.id;
  state.pm2HistoryRange = "24h";
  $("#pm2HistoryTitle").textContent = `${project.name} PM2 health`;
  document
    .querySelectorAll("[data-pm2-range]")
    .forEach((button) => button.classList.toggle("active", button.dataset.pm2Range === "24h"));
  $("#pm2HistorySummary").innerHTML = '<div class="empty">Loading PM2 history…</div>';
  $("#pm2HistoryProcess").innerHTML = '<option value="">All matched processes</option>';
  $("#pm2HistoryDialog").showModal();
  try {
    await loadPm2History(processKey);
  } catch (error) {
    toast(error.message, true);
  }
}

function stopPm2LogAutoRefresh() {
  if (state.pm2Logs.timer) clearInterval(state.pm2Logs.timer);
  state.pm2Logs.timer = null;
  state.pm2Logs.autoRefresh = false;
  const checkbox = $("#pm2LogsAutoRefresh");
  if (checkbox) checkbox.checked = false;
}

function startPm2LogAutoRefresh() {
  if (state.pm2Logs.timer) clearInterval(state.pm2Logs.timer);
  const checkbox = $("#pm2LogsAutoRefresh");
  state.pm2Logs.autoRefresh = true;
  if (checkbox) checkbox.checked = true;
  state.pm2Logs.timer = setInterval(() => {
    if (!$("#pm2LogsDialog")?.open) return stopPm2LogAutoRefresh();
    loadPm2Logs({ silent: true }).catch(() => {});
  }, 5000);
}

function capturePm2LogScrollState() {
  const snapshot = {};
  for (const kind of ["stdout", "stderr", "combined"]) {
    const output = document.querySelector(`[data-log-output="${kind}"]`);
    if (!output) continue;
    const distanceFromBottom = Math.max(
      0,
      output.scrollHeight - output.clientHeight - output.scrollTop,
    );
    snapshot[kind] = {
      distanceFromBottom,
      pinnedToBottom: distanceFromBottom <= 24,
    };
  }
  return snapshot;
}

function restorePm2LogScrollState(snapshot = {}) {
  for (const kind of ["stdout", "stderr", "combined"]) {
    const saved = snapshot[kind];
    const output = document.querySelector(`[data-log-output="${kind}"]`);
    if (!saved || !output) continue;
    if (saved.pinnedToBottom) {
      output.scrollTop = output.scrollHeight;
      continue;
    }
    output.scrollTop = Math.max(
      0,
      output.scrollHeight - output.clientHeight - saved.distanceFromBottom,
    );
  }
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SGR_PATTERN = /\x1b\[([0-9;:]*)m/g;
const ANSI_BASE_COLORS = Object.freeze([
  ["black", [0, 0, 0]],
  ["red", [205, 49, 49]],
  ["green", [13, 188, 121]],
  ["yellow", [229, 229, 16]],
  ["blue", [36, 114, 200]],
  ["magenta", [188, 63, 188]],
  ["cyan", [17, 168, 205]],
  ["white", [229, 229, 229]],
  ["bright-black", [102, 102, 102]],
  ["bright-red", [241, 76, 76]],
  ["bright-green", [35, 209, 139]],
  ["bright-yellow", [245, 245, 67]],
  ["bright-blue", [59, 142, 234]],
  ["bright-magenta", [214, 112, 214]],
  ["bright-cyan", [41, 184, 219]],
  ["bright-white", [255, 255, 255]],
]);

function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE_PATTERN, "");
}

function xtermColorToRgb(index) {
  const value = Math.max(0, Math.min(255, Number(index) || 0));
  if (value < 16) return ANSI_BASE_COLORS[value][1];
  if (value >= 232) {
    const level = 8 + (value - 232) * 10;
    return [level, level, level];
  }
  const cube = value - 16;
  const r = Math.floor(cube / 36);
  const g = Math.floor((cube % 36) / 6);
  const b = cube % 6;
  const level = (component) => (component === 0 ? 0 : 55 + component * 40);
  return [level(r), level(g), level(b)];
}

function nearestAnsiColorName(rgb) {
  let best = ANSI_BASE_COLORS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ANSI_BASE_COLORS) {
    const [, color] = candidate;
    const distance = (rgb[0] - color[0]) ** 2 + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best[0];
}

function applyAnsiColorParameter(stateValue, params, index, target) {
  const mode = params[index + 1];
  if (mode === 5 && params[index + 2] != null) {
    stateValue[target] = nearestAnsiColorName(xtermColorToRgb(params[index + 2]));
    return index + 2;
  }
  if (
    mode === 2 &&
    params[index + 2] != null &&
    params[index + 3] != null &&
    params[index + 4] != null
  ) {
    stateValue[target] = nearestAnsiColorName([
      Math.max(0, Math.min(255, params[index + 2])),
      Math.max(0, Math.min(255, params[index + 3])),
      Math.max(0, Math.min(255, params[index + 4])),
    ]);
    return index + 4;
  }
  return index;
}

function updateAnsiState(stateValue, rawParams) {
  const params = rawParams
    ? rawParams
        .replaceAll(":", ";")
        .split(";")
        .map((value) => Number(value || 0))
    : [0];

  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 0) {
      stateValue.fg = null;
      stateValue.bg = null;
      stateValue.bold = false;
      stateValue.dim = false;
      stateValue.italic = false;
      stateValue.underline = false;
      stateValue.inverse = false;
    } else if (code === 1) stateValue.bold = true;
    else if (code === 2) stateValue.dim = true;
    else if (code === 3) stateValue.italic = true;
    else if (code === 4) stateValue.underline = true;
    else if (code === 7) stateValue.inverse = true;
    else if (code === 22) {
      stateValue.bold = false;
      stateValue.dim = false;
    } else if (code === 23) stateValue.italic = false;
    else if (code === 24) stateValue.underline = false;
    else if (code === 27) stateValue.inverse = false;
    else if (code >= 30 && code <= 37) stateValue.fg = ANSI_BASE_COLORS[code - 30][0];
    else if (code >= 90 && code <= 97) stateValue.fg = ANSI_BASE_COLORS[8 + code - 90][0];
    else if (code === 39) stateValue.fg = null;
    else if (code >= 40 && code <= 47) stateValue.bg = ANSI_BASE_COLORS[code - 40][0];
    else if (code >= 100 && code <= 107) stateValue.bg = ANSI_BASE_COLORS[8 + code - 100][0];
    else if (code === 49) stateValue.bg = null;
    else if (code === 38 || code === 48)
      index = applyAnsiColorParameter(stateValue, params, index, code === 38 ? "fg" : "bg");
  }
}

function ansiStateClasses(stateValue) {
  let fg = stateValue.fg;
  let bg = stateValue.bg;
  if (stateValue.inverse) [fg, bg] = [bg, fg];
  return [
    fg ? `ansi-fg-${fg}` : "",
    bg ? `ansi-bg-${bg}` : "",
    stateValue.bold ? "ansi-bold" : "",
    stateValue.dim ? "ansi-dim" : "",
    stateValue.italic ? "ansi-italic" : "",
    stateValue.underline ? "ansi-underline" : "",
  ].filter(Boolean);
}

function renderAnsiText(value) {
  const text = String(value || "").replace(ANSI_ESCAPE_PATTERN, (sequence) =>
    sequence.endsWith("m") ? sequence : "",
  );
  if (!state.pm2Logs.ansiColors) return escapeHtml(stripAnsi(text));

  const stateValue = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
  let cursor = 0;
  let result = "";
  ANSI_SGR_PATTERN.lastIndex = 0;
  for (let match = ANSI_SGR_PATTERN.exec(text); match; match = ANSI_SGR_PATTERN.exec(text)) {
    const chunk = text.slice(cursor, match.index);
    if (chunk) {
      const classes = ansiStateClasses(stateValue);
      result += classes.length
        ? `<span class="${classes.join(" ")}">${escapeHtml(chunk)}</span>`
        : escapeHtml(chunk);
    }
    updateAnsiState(stateValue, match[1]);
    cursor = match.index + match[0].length;
  }
  const remainder = text.slice(cursor);
  if (remainder) {
    const classes = ansiStateClasses(stateValue);
    result += classes.length
      ? `<span class="${classes.join(" ")}">${escapeHtml(remainder)}</span>`
      : escapeHtml(remainder);
  }
  return result;
}

function filterPm2LogLines(content) {
  const filter = $("#pm2LogsFilter")?.value?.trim().toLowerCase() || "";
  const lines = String(content || "").split(/\r?\n/);
  if (!filter) return lines;
  return lines.filter((line) => stripAnsi(line).toLowerCase().includes(filter));
}

function classifyPm2LogLine(line, kind = "stdout") {
  const clean = stripAnsi(line).toLowerCase();
  if (/\b(fatal|panic|uncaught|unhandled|exception|error|failed|failure)\b/.test(clean))
    return "error";
  if (/\b(warn|warning|deprecated|retry|timeout)\b/.test(clean)) return "warning";
  if (/\b(success|ready|started|listening|online|connected|complete(?:d)?)\b/.test(clean))
    return "success";
  if (/\b(debug|trace|verbose)\b/.test(clean)) return "debug";
  return kind === "stderr" ? "error" : "info";
}

function parsePm2LogTimestamp(line) {
  const clean = stripAnsi(line).trimStart();
  const patterns = [
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)/,
    /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)/,
    /^\[?(\d{4}\/\d{2}\/\d{2}[ T]\d{2}:\d{2}:\d{2})\]?/,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    const candidate = match[1].replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3");
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildPm2LogEntries(kind, streamData) {
  if (!streamData?.available) return [];
  const lines = filterPm2LogLines(streamData.content);
  let lastTimestamp = null;
  return lines.map((line, index) => {
    const parsedTimestamp = parsePm2LogTimestamp(line);
    if (parsedTimestamp != null) lastTimestamp = parsedTimestamp;
    return {
      kind,
      line,
      sourceIndex: index,
      timestamp: parsedTimestamp,
      sortTimestamp: parsedTimestamp ?? lastTimestamp,
      modifiedAt: Date.parse(streamData.modifiedAt || "") || 0,
    };
  });
}

function mergePm2LogEntries(data, stream) {
  const entries = [];
  if (stream !== "stderr") entries.push(...buildPm2LogEntries("stdout", data?.stdout));
  if (stream !== "stdout") entries.push(...buildPm2LogEntries("stderr", data?.stderr));
  return entries.sort((left, right) => {
    if (left.sortTimestamp != null && right.sortTimestamp != null) {
      const delta = left.sortTimestamp - right.sortTimestamp;
      if (delta) return delta;
    } else if (left.sortTimestamp != null) return -1;
    else if (right.sortTimestamp != null) return 1;
    const modifiedDelta = left.modifiedAt - right.modifiedAt;
    if (modifiedDelta) return modifiedDelta;
    if (left.kind !== right.kind) return left.kind === "stdout" ? -1 : 1;
    return left.sourceIndex - right.sourceIndex;
  });
}

function renderPm2LogLines(content, kind) {
  return filterPm2LogLines(content)
    .map((line) => {
      const severity = classifyPm2LogLine(line, kind);
      return `<span class="pm2-log-line stream-${kind} severity-${severity}">${renderAnsiText(line)}</span>`;
    })
    .join("\n");
}

function renderPm2LogPane(kind, streamData) {
  const label = kind === "stdout" ? "Standard Output" : "Error Output";
  const accentClass = kind === "stderr" ? "error" : "success";

  if (!streamData) {
    return `<section class="pm2-log-pane hidden" data-log-pane="${kind}"></section>`;
  }

  const status = !streamData.configured
    ? "Not configured by PM2"
    : !streamData.available
      ? streamData.error || "Log unavailable"
      : `${formatBytes(streamData.sizeBytes)} · modified ${formatDate(streamData.modifiedAt)} · ${streamData.linesReturned} line${streamData.linesReturned === 1 ? "" : "s"}${streamData.truncated ? " · tail view" : ""}`;

  const visibleLines = streamData.available ? filterPm2LogLines(streamData.content) : [];
  const hasFilter = Boolean($("#pm2LogsFilter")?.value?.trim());
  const content = streamData.available
    ? visibleLines.length
      ? renderPm2LogLines(streamData.content, kind)
      : escapeHtml(hasFilter ? "No lines match the current filter." : "Log file is empty.")
    : escapeHtml(status);
  const sourceClass = state.pm2Logs.sourceColors ? ` source-colors stream-${kind}` : "";

  return `<section class="pm2-log-pane${sourceClass}" data-log-pane="${kind}">
    <div class="pm2-log-pane-heading">
      <div><strong>${label}</strong><span class="badge ${accentClass}">${kind}</span></div>
      <button type="button" class="button tiny" data-copy-pm2-log="${kind}" ${streamData.available ? "" : "disabled"}>Copy Visible</button>
    </div>
    <div class="pm2-log-meta">
      <span>${escapeHtml(status)}</span>
      <span class="path">${escapeHtml(streamData.path || "No path")}</span>
    </div>
    <pre class="pm2-log-output" data-log-output="${kind}">${content}</pre>
  </section>`;
}

function renderCombinedPm2Logs(data, stream) {
  const entries = mergePm2LogEntries(data, stream);
  const hasFilter = Boolean($("#pm2LogsFilter")?.value?.trim());
  const availableStreams = [
    stream !== "stderr" ? data?.stdout : null,
    stream !== "stdout" ? data?.stderr : null,
  ].filter(Boolean);
  const configured = availableStreams.some((item) => item?.configured);
  const available = availableStreams.some((item) => item?.available);
  const timestamped = entries.filter((item) => item.timestamp != null).length;
  const ordering = timestamped
    ? `${timestamped}/${entries.length} visible line${entries.length === 1 ? "" : "s"} include timestamps · timestamp-aware order`
    : "No parseable per-line timestamps · stable stream/file order";
  const sourceClass = state.pm2Logs.sourceColors ? " source-colors" : "";

  let content;
  if (entries.length) {
    content = entries
      .map((entry) => {
        const severity = classifyPm2LogLine(entry.line, entry.kind);
        const marker = entry.kind === "stderr" ? "ERR" : "OUT";
        return `<div class="pm2-combined-line stream-${entry.kind} severity-${severity}"><span class="pm2-log-source-marker">[${marker}]</span><span class="pm2-log-line-content">${renderAnsiText(entry.line)}</span></div>`;
      })
      .join("");
  } else if (available) {
    content = `<div class="pm2-log-empty">${escapeHtml(hasFilter ? "No lines match the current filter." : "Log files are empty.")}</div>`;
  } else {
    const errors = availableStreams
      .map((item) => item?.error)
      .filter(Boolean)
      .join(" · ");
    content = `<div class="pm2-log-empty">${escapeHtml(errors || (configured ? "PM2 logs are unavailable." : "PM2 log paths are not configured."))}</div>`;
  }

  return `<section class="pm2-log-pane pm2-log-pane-combined${sourceClass}" data-log-pane="combined">
    <div class="pm2-log-pane-heading">
      <div><strong>Combined Log</strong><span class="badge">Output + Error</span><span class="muted pm2-combined-ordering">${escapeHtml(ordering)}</span></div>
      <button type="button" class="button tiny" data-copy-pm2-log="combined" ${entries.length ? "" : "disabled"}>Copy Visible</button>
    </div>
    <div class="pm2-log-meta pm2-combined-meta">
      <span><strong class="pm2-source-key stdout">OUT</strong> Standard Output</span>
      <span><strong class="pm2-source-key stderr">ERR</strong> Error Output</span>
      <span>ANSI ${state.pm2Logs.ansiColors ? "Colors Parsed" : "Colors Stripped"}</span>
    </div>
    <div class="pm2-log-output pm2-log-output-combined" data-log-output="combined">${content}</div>
  </section>`;
}

function renderPm2Logs(data, options = {}) {
  const scrollState = options.preserveScroll === false ? {} : capturePm2LogScrollState();
  state.pm2Logs.data = data;
  const proc = data?.process || {};
  const processName =
    proc.namespace && proc.namespace !== "default"
      ? `${proc.namespace}/${proc.name}`
      : proc.name || "PM2 process";

  $("#pm2LogsTitle").textContent = `${processName} Logs`;
  $("#pm2LogsCheckedAt").textContent =
    `Read ${formatDate(data?.checkedAt)} · PID ${proc.pid || "-"} · status ${proc.status || "unknown"}`;

  const stream = $("#pm2LogsStream").value;
  const layout = $("#pm2LogsLayout")?.value || state.pm2Logs.layout || "combined";
  state.pm2Logs.layout = layout;
  state.pm2Logs.ansiColors = $("#pm2LogsAnsiColors")?.checked !== false;
  state.pm2Logs.sourceColors = $("#pm2LogsSourceColors")?.checked !== false;
  const grid = $("#pm2LogsGrid");
  const useCombined = layout === "combined" && stream === "both";
  grid.classList.toggle("single", useCombined || stream !== "both");
  grid.classList.toggle("combined", useCombined);
  grid.innerHTML = useCombined
    ? renderCombinedPm2Logs(data, stream)
    : `${stream === "stderr" ? "" : renderPm2LogPane("stdout", data?.stdout)}${stream === "stdout" ? "" : renderPm2LogPane("stderr", data?.stderr)}`;
  restorePm2LogScrollState(scrollState);
}

async function loadPm2Logs(options = {}) {
  const project = state.projects.find((item) => item.id === state.pm2Logs.projectId);
  if (!project || state.pm2Logs.pm2Id == null) return;
  if (options.silent && state.pm2Logs.loading) return;

  const pm2Id = state.pm2Logs.pm2Id;
  const lines = $("#pm2LogsLines").value || "200";
  const stream = $("#pm2LogsStream").value || "both";
  const query = new URLSearchParams({ lines, stream });
  if (options.refreshPm2) query.set("refresh", "true");
  const requestSerial = ++state.pm2Logs.requestSerial;
  state.pm2Logs.loading = true;

  const button = $("#refreshPm2LogsBtn");
  if (!options.silent) button.disabled = true;
  try {
    const data = await api(
      `/api/projects/${project.id}/pm2/${encodeURIComponent(pm2Id)}/logs?${query}`,
    );
    if (requestSerial !== state.pm2Logs.requestSerial) return;
    if (project.id !== state.pm2Logs.projectId || Number(pm2Id) !== Number(state.pm2Logs.pm2Id))
      return;
    renderPm2Logs(data.logs);
  } catch (error) {
    if (requestSerial !== state.pm2Logs.requestSerial) return;
    if (!options.silent) toast(error.message, true);
    throw error;
  } finally {
    if (requestSerial === state.pm2Logs.requestSerial) state.pm2Logs.loading = false;
    if (!options.silent) button.disabled = false;
  }
}

async function openPm2Logs(project, pm2Id) {
  stopPm2LogAutoRefresh();
  state.pm2Logs.projectId = project.id;
  state.pm2Logs.pm2Id = Number(pm2Id);
  state.pm2Logs.data = null;
  state.pm2Logs.loading = false;
  state.pm2Logs.requestSerial += 1;

  const processes = project.pm2?.processes || [];
  $("#pm2LogsProjectName").textContent = project.name;
  $("#pm2LogsProcess").innerHTML = processes
    .map((proc) => {
      const label =
        proc.namespace && proc.namespace !== "default"
          ? `${proc.namespace}/${proc.name}`
          : proc.name;
      return `<option value="${escapeHtml(proc.id)}">${escapeHtml(label)} · ID ${escapeHtml(proc.id)}</option>`;
    })
    .join("");
  $("#pm2LogsProcess").value = String(pm2Id);
  $("#pm2LogsStream").value = "both";
  $("#pm2LogsLayout").value = state.pm2Logs.layout || "combined";
  $("#pm2LogsAnsiColors").checked = state.pm2Logs.ansiColors !== false;
  $("#pm2LogsSourceColors").checked = state.pm2Logs.sourceColors !== false;
  $("#pm2LogsLines").value = "200";
  $("#pm2LogsFilter").value = "";
  $("#pm2LogsCheckedAt").textContent = "Loading recent log lines…";
  $("#pm2LogsGrid").innerHTML = '<div class="empty">Loading PM2 logs…</div>';
  $("#pm2LogsDialog").showModal();

  try {
    await loadPm2Logs();
  } catch {
    $("#pm2LogsGrid").innerHTML =
      '<div class="empty">Unable to read PM2 logs for this process.</div>';
  }
}

async function copyVisiblePm2Log(kind) {
  const output = document.querySelector(`[data-log-output="${kind}"]`);
  if (!output) return;
  const text =
    kind === "combined"
      ? [...output.querySelectorAll(".pm2-combined-line")]
          .map((row) => {
            const source = row.classList.contains("stream-stderr") ? "ERR" : "OUT";
            const line = row.querySelector(".pm2-log-line-content")?.textContent || "";
            return `[${source}] ${line}`;
          })
          .join("\n")
      : output.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    const label = kind === "combined" ? "Combined" : kind === "stderr" ? "Error" : "Output";
    toast(`${label} Log Copied.`);
  } catch {
    toast("Clipboard access is unavailable in this browser.", true);
  }
}

async function runGlobalAction(button, url, successText) {
  button.disabled = true;
  try {
    const data = await api(url, { method: "POST", body: "{}" });
    const results = data.results || [];
    const failures = results.filter(
      (item) => item.ok === false || Number(item.failed || 0) > 0,
    ).length;
    toast(
      `${successText}${results.length ? ` (${results.length} project${results.length === 1 ? "" : "s"})` : ""}${failures ? ` · ${failures} with failures` : ""}.`,
      failures > 0,
    );
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderDiscoveryResults(result) {
  state.discoveryProjects = result.projects || [];
  const selectable = state.discoveryProjects.filter((item) => !item.registered);
  $("#discoverySummary").textContent =
    `${state.discoveryProjects.length} project(s) found · ${selectable.length} available to register · ${result.errors?.length || 0} scan error(s)`;
  $("#registerDiscoveredBtn").disabled = selectable.length === 0;
  $("#discoveryResults").innerHTML = state.discoveryProjects.length
    ? state.discoveryProjects
        .map(
          (project, index) => `<label class="discovery-row ${project.registered ? "disabled" : ""}">
    <input type="checkbox" name="discoveredProject" value="${index}" ${project.registered ? "disabled" : "checked"}>
    <div class="discovery-info">
      <div class="discovery-title">${escapeHtml(project.name)} ${project.version ? `<span class="muted">v${escapeHtml(project.version)}</span>` : ""}</div>
      <div class="path">${escapeHtml(project.projectRoot)}</div>
      <div class="backup-meta">${project.registered ? "Already registered" : project.validPackageJson ? "Valid package.json" : `package.json parse error: ${escapeHtml(project.packageJsonError)}`}</div>
    </div>
  </label>`,
        )
        .join("")
    : '<div class="empty">No package.json projects found in the selected folders.</div>';
}

async function scanDiscovery() {
  const button = $("#scanProjectsBtn");
  button.disabled = true;
  $("#discoveryResults").innerHTML = '<div class="empty">Scanning…</div>';
  try {
    const roots = $("#discoverRoots")
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const data = await api("/api/discovery/scan", {
      method: "POST",
      body: JSON.stringify({
        roots,
        maxDepth: Number($("#discoverDepth").value),
      }),
    });
    renderDiscoveryResults(data.result);
  } catch (error) {
    state.discoveryProjects = [];
    $("#registerDiscoveredBtn").disabled = true;
    $("#discoveryResults").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function registerDiscovered() {
  const indexes = [...document.querySelectorAll('input[name="discoveredProject"]:checked')].map(
    (input) => Number(input.value),
  );
  const projects = indexes
    .map((index) => state.discoveryProjects[index])
    .filter(Boolean)
    .map((project) => ({
      name: project.name,
      projectRoot: project.projectRoot,
    }));
  if (!projects.length) return toast("Select at least one project.", true);

  const button = $("#registerDiscoveredBtn");
  button.disabled = true;
  try {
    const data = await api("/api/discovery/register", {
      method: "POST",
      body: JSON.stringify({
        projects,
        defaults: { keep: 10, watch: true, intervalSeconds: 30 },
      }),
    });
    const result = data.result;
    toast(
      `Registered ${result.added.length} project(s)${result.errors.length ? `; ${result.errors.length} failed` : ""}.`,
      result.errors.length > 0,
    );
    await scanDiscovery();
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll("[data-section-toggle]").forEach((button) =>
  button.addEventListener("click", () => {
    const id = button.dataset.sectionToggle;
    setDashboardSectionCollapsed(id, !state.collapsedSections.has(String(id)));
  }),
);
document.querySelectorAll("[data-overview-toggle]").forEach((button) =>
  button.addEventListener("click", () => {
    const id = String(button.dataset.overviewToggle || "");
    setOverviewSectionCollapsed(id, !state.overviewCollapsedSections.has(id));
  }),
);
document.querySelectorAll("[data-storage-toggle]").forEach((button) =>
  button.addEventListener("click", () => {
    const id = String(button.dataset.storageToggle || "");
    setStorageSectionCollapsed(id, !state.storageCollapsedSections.has(id));
  }),
);
$("#collapseAllOverviewBtn")?.addEventListener("click", () =>
  setAllOverviewSectionsCollapsed(true),
);
$("#expandAllOverviewBtn")?.addEventListener("click", () => setAllOverviewSectionsCollapsed(false));
$("#diffFilter").addEventListener("input", renderDiffFiles);
$("#diffStatusFilter").addEventListener("change", renderDiffFiles);
$("#refreshDiffBtn").addEventListener("click", () =>
  loadProjectDiff({ refresh: true }).catch((error) => toast(error.message, true)),
);
$("#diffFileList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-diff-path]");
  if (!row) return;
  loadProjectFileDiff(row.dataset.diffPath).catch((error) => toast(error.message, true));
});

$("#refreshFeaturePackBtn").addEventListener("click", () =>
  loadFeaturePackPreview({ refresh: true }).catch((error) => toast(error.message, true)),
);
$("#exportFeaturePackBtn").addEventListener("click", () =>
  exportFeaturePack().catch((error) => toast(error.message, true)),
);
[
  "#featurePackIncludeAdded",
  "#featurePackIncludeModified",
  "#featurePackIncludeDeleted",
  "#featurePackIncludeDiffs",
  "#featurePackExcludeSensitive",
].forEach((selector) => {
  $(selector).addEventListener("change", () =>
    loadFeaturePackPreview({ refresh: false }).catch((error) => toast(error.message, true)),
  );
});

$("#analyzeRecoveryBtn").addEventListener("click", () =>
  loadRecoveryAnalysis({ refresh: true }).catch((error) => toast(error.message, true)),
);
$("#recoveryPath").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  loadRecoveryAnalysis({ refresh: true }).catch((error) => toast(error.message, true));
});
$("#recoverySuggestions").addEventListener("click", (event) => {
  const row = event.target.closest("[data-recovery-path]");
  if (!row) return;
  $("#recoveryPath").value = row.dataset.recoveryPath;
  loadRecoveryAnalysis({ path: row.dataset.recoveryPath }).catch((error) =>
    toast(error.message, true),
  );
});
$("#recoveryCandidates").addEventListener("click", (event) => {
  const row = event.target.closest("[data-recovery-candidate-id]");
  if (!row) return;
  loadRecoveryCandidate(row.dataset.recoveryCandidateId).catch((error) =>
    toast(error.message, true),
  );
});
$("#exportRecoveryBtn").addEventListener("click", () =>
  exportSelectedRecoveryCandidate().catch((error) => toast(error.message, true)),
);
$("#recoverSuggestedBtn").addEventListener("click", () =>
  exportSuggestedRecovery().catch((error) => toast(error.message, true)),
);

$("#addProjectBtn").addEventListener("click", () => openProjectDialog());
$("#projectAddBtn")?.addEventListener("click", () => openProjectDialog());
$("#discoverBtn").addEventListener("click", () => {
  state.discoveryProjects = [];
  $("#discoverySummary").textContent = "";
  $("#discoveryResults").innerHTML = '<div class="empty">Run a scan to find projects.</div>';
  $("#registerDiscoveredBtn").disabled = true;
  $("#discoverDialog").showModal();
});
$("#refreshBtn").addEventListener("click", refresh);
$("#collapseAllProjectsBtn").addEventListener("click", () => setAllProjectsCollapsed(true));
$("#expandAllProjectsBtn").addEventListener("click", () => setAllProjectsCollapsed(false));
$("#refreshPm2Btn").addEventListener("click", async () => {
  const button = $("#refreshPm2Btn");
  button.disabled = true;
  try {
    await api("/api/pm2/refresh", { method: "POST", body: "{}" });
    toast("PM2 refreshed.");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#backupAllBtn").addEventListener("click", () =>
  runGlobalAction($("#backupAllBtn"), "/api/projects/backup-all", "Backup-all check finished"),
);
$("#verifyEverythingBtn").addEventListener("click", () =>
  runGlobalAction($("#verifyEverythingBtn"), "/api/backups/verify-all", "Verification finished"),
);
$("#refreshPm2HistoryBtn").addEventListener("click", () =>
  loadPm2History().catch((error) => toast(error.message, true)),
);
$("#refreshPm2LogsBtn").addEventListener("click", () =>
  loadPm2Logs({ refreshPm2: true }).catch((error) => toast(error.message, true)),
);
$("#pm2LogsProcess").addEventListener("change", () => {
  state.pm2Logs.pm2Id = Number($("#pm2LogsProcess").value);
  loadPm2Logs().catch((error) => toast(error.message, true));
});
$("#pm2LogsStream").addEventListener("change", () =>
  loadPm2Logs().catch((error) => toast(error.message, true)),
);
$("#pm2LogsLayout").addEventListener("change", () => {
  state.pm2Logs.layout = $("#pm2LogsLayout").value;
  if (state.pm2Logs.data) renderPm2Logs(state.pm2Logs.data);
});
$("#pm2LogsAnsiColors").addEventListener("change", () => {
  state.pm2Logs.ansiColors = $("#pm2LogsAnsiColors").checked;
  if (state.pm2Logs.data) renderPm2Logs(state.pm2Logs.data);
});
$("#pm2LogsSourceColors").addEventListener("change", () => {
  state.pm2Logs.sourceColors = $("#pm2LogsSourceColors").checked;
  if (state.pm2Logs.data) renderPm2Logs(state.pm2Logs.data);
});
$("#pm2LogsLines").addEventListener("change", () =>
  loadPm2Logs().catch((error) => toast(error.message, true)),
);
$("#pm2LogsFilter").addEventListener("input", () => {
  if (state.pm2Logs.data) renderPm2Logs(state.pm2Logs.data);
});
$("#pm2LogsAutoRefresh").addEventListener("change", () => {
  if ($("#pm2LogsAutoRefresh").checked) startPm2LogAutoRefresh();
  else stopPm2LogAutoRefresh();
});
$("#pm2LogsGrid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-pm2-log]");
  if (!button) return;
  copyVisiblePm2Log(button.dataset.copyPm2Log).catch((error) => toast(error.message, true));
});
$("#pm2LogsDialog").addEventListener("close", stopPm2LogAutoRefresh);
$("#refreshDependenciesBtn").addEventListener("click", async () => {
  const button = $("#refreshDependenciesBtn");
  button.disabled = true;
  try {
    await loadDependencies(true);
    toast("Dependency status refreshed.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#dependencyFilter").addEventListener("change", renderDependencies);
$("#dependencySearch").addEventListener("input", renderDependencies);
$("#dependencyIncludePrerelease").addEventListener("change", () => {
  state.dependencyVersions = {};
  renderDependencies();
});
$("#dependenciesList").addEventListener("change", (event) => {
  const select = event.target.closest(".dependency-version-select");
  if (!select) return;
  const packageName = select.dataset.dependencyName;
  if (select.value === "__load_all__") {
    loadDependencyVersions(packageName).catch((error) => toast(error.message, true));
    return;
  }
  if (!state.dependencyVersions[packageName])
    state.dependencyVersions[packageName] = {
      versions: dependencyQuickVersions(
        state.dependencyData.dependencies.find((dep) => dep.name === packageName) || {},
      ),
      selected: "",
    };
  state.dependencyVersions[packageName].selected = select.value;
  renderDependencies();
});
$("#dependenciesList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-dependency-update]");
  if (!button) return;
  updateSelectedDependency(button.dataset.dependencyUpdate).catch((error) =>
    toast(error.message, true),
  );
});
$("#pm2HistoryProcess").addEventListener("change", () =>
  loadPm2History($("#pm2HistoryProcess").value).catch((error) => toast(error.message, true)),
);
document.querySelectorAll("[data-pm2-range]").forEach((button) =>
  button.addEventListener("click", async () => {
    state.pm2HistoryRange = button.dataset.pm2Range;
    document
      .querySelectorAll("[data-pm2-range]")
      .forEach((item) => item.classList.toggle("active", item === button));
    try {
      await loadPm2History();
    } catch (error) {
      toast(error.message, true);
    }
  }),
);
$("#clearPm2HistoryBtn").addEventListener("click", async () => {
  const project = state.projects.find((item) => item.id === state.pm2HistoryProject);
  if (!project || !confirm(`Clear stored PM2 health history for ${project.name}?`)) return;
  const button = $("#clearPm2HistoryBtn");
  button.disabled = true;
  try {
    await api(`/api/projects/${project.id}/pm2/history`, { method: "DELETE" });
    toast("PM2 history cleared.");
    await loadPm2History();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
document.querySelectorAll(".path-browse-button").forEach((button) =>
  button.addEventListener("click", () => {
    openDirectoryPicker(button.dataset.browseTarget, button.dataset.browseMode || "replace").catch(
      (error) => toast(error.message, true),
    );
  }),
);

$("#directoryQuickLocations").addEventListener("click", (event) => {
  const button = event.target.closest("[data-directory-root]");
  if (!button) return;
  browseDirectory(button.dataset.directoryRoot).catch((error) => toast(error.message, true));
});

$("#directoryList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-directory-path]");
  if (!button) return;
  browseDirectory(button.dataset.directoryPath).catch((error) => toast(error.message, true));
});

$("#directoryUpBtn").addEventListener("click", () => {
  if (!state.directoryPicker.parentPath) return;
  browseDirectory(state.directoryPicker.parentPath).catch((error) => toast(error.message, true));
});
$("#directoryRefreshBtn").addEventListener("click", () =>
  browseDirectory(state.directoryPicker.currentPath).catch((error) => toast(error.message, true)),
);
$("#directoryGoBtn").addEventListener("click", () =>
  browseDirectory($("#directoryPathInput").value.trim() || null).catch((error) =>
    toast(error.message, true),
  ),
);
$("#directoryPathInput").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  browseDirectory($("#directoryPathInput").value.trim() || null).catch((error) =>
    toast(error.message, true),
  );
});
$("#directoryShowHidden").addEventListener("change", () =>
  browseDirectory(state.directoryPicker.currentPath).catch((error) => toast(error.message, true)),
);
$("#directoryUseBtn").addEventListener("click", applyDirectorySelection);
$("#directoryNewFolderBtn").addEventListener("click", openDirectoryCreatePanel);
$("#directoryCancelCreateBtn").addEventListener("click", closeDirectoryCreatePanel);
$("#directoryCreateFolderBtn").addEventListener("click", () => createDirectoryFromPicker());
$("#directoryNewFolderName").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDirectoryCreatePanel();
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  createDirectoryFromPicker();
});

$("#diagnosticsBtn").addEventListener("click", () =>
  openDiagnostics().catch((error) => toast(error.message, true)),
);
$("#fileToolsBtn").addEventListener("click", () =>
  openFileTools().catch((error) => toast(error.message, true)),
);
$("#fileToolsPreviewBtn").addEventListener("click", () =>
  previewFileTools().catch((error) => toast(error.message, true)),
);
$("#fileToolsRunBtn").addEventListener("click", () =>
  runFileTools().catch((error) => toast(error.message, true)),
);
$("#fileToolsRefreshHistoryBtn").addEventListener("click", () =>
  loadFileToolsHistory().catch((error) => toast(error.message, true)),
);
$("#fileToolsClearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("Clear File Tools run history? Output files and manifests will not be deleted."))
    return;
  const button = $("#fileToolsClearHistoryBtn");
  button.disabled = true;
  try {
    await api("/api/file-tools/history", { method: "DELETE" });
    renderFileToolsHistory([]);
    toast("File Tools history cleared.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#fileToolsProject").addEventListener("change", () => {
  $("#fileToolsUseProjectExcludes").dataset.userChanged = "";
  loadFileToolsDefaults().catch((error) => toast(error.message, true));
});
$("#textSanitizerProject").addEventListener("change", () =>
  loadTextSanitizerDefaults().catch((error) => toast(error.message, true)),
);
$("#textSanitizerScanBtn").addEventListener("click", () =>
  scanTextSanitizer().catch((error) => toast(error.message, true)),
);
$("#textSanitizerApplyBtn").addEventListener("click", () =>
  applyTextSanitizer().catch((error) => toast(error.message, true)),
);
$("#textSanitizerPrevChange").addEventListener("click", () =>
  updateTextSanitizerActiveChange(state.fileTools.sanitizer.activeChange - 1),
);
$("#textSanitizerNextChange").addEventListener("click", () =>
  updateTextSanitizerActiveChange(state.fileTools.sanitizer.activeChange + 1),
);
$("#textSanitizerSearch").addEventListener("input", renderTextSanitizerFiles);
$("#textSanitizerStatusFilter").addEventListener("change", renderTextSanitizerFiles);
$("#textSanitizerGroupFilter").addEventListener("change", renderTextSanitizerFiles);
$("#textSanitizerSort").addEventListener("change", renderTextSanitizerFiles);
$("#textSanitizerRuleSearch").addEventListener("input", renderTextSanitizerCatalog);
$("#textSanitizerCatalogGroup").addEventListener("change", renderTextSanitizerCatalog);
$("#textSanitizerSelectVisibleBtn").addEventListener("click", () => {
  for (const file of filteredTextSanitizerFiles()) {
    if (file.changed) state.fileTools.sanitizer.selected.add(file.relativePath);
  }
  renderTextSanitizerFiles();
});
$("#textSanitizerClearSelectionBtn").addEventListener("click", () => {
  state.fileTools.sanitizer.selected.clear();
  renderTextSanitizerFiles();
});
$("#textSanitizerExportJsonBtn").addEventListener("click", exportTextSanitizerJson);
$("#textSanitizerExportCsvBtn").addEventListener("click", exportTextSanitizerCsv);
$("#textSanitizerOriginal").addEventListener("scroll", () =>
  syncTextSanitizerPreview($("#textSanitizerOriginal"), $("#textSanitizerSanitized")),
);
$("#textSanitizerSanitized").addEventListener("scroll", () =>
  syncTextSanitizerPreview($("#textSanitizerSanitized"), $("#textSanitizerOriginal")),
);
document
  .querySelectorAll("[data-sanitizer-preset]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      applyTextSanitizerPreset(button.dataset.sanitizerPreset),
    ),
  );
[
  "textSanitizerSourceRoot",
  "textSanitizerOutputRoot",
  "tsReplacePunctuation",
  "tsReplaceBullets",
  "tsReplaceSpaces",
  "tsReplaceLineBreaks",
  "tsReplaceCompatibility",
  "tsReplaceArrowsMath",
  "tsReplaceStatus",
  "tsReplaceMisc",
  "tsReplaceAmbiguous",
  "tsRemoveInvisible",
  "tsReportNonAscii",
  "tsUseExtensionFilter",
  "tsIgnoreDirectories",
  "tsExtensions",
  "tsOverwriteOutput",
  "tsWriteManifest",
  "tsBackupProjectFirst",
].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    saveTextSanitizerPreferences();
    if (
      ![
        "textSanitizerOutputRoot",
        "tsOverwriteOutput",
        "tsWriteManifest",
        "tsBackupProjectFirst",
      ].includes(id)
    )
      resetTextSanitizerScan("Sanitizer settings changed. Scan again to refresh findings.");
  });
});
$("#fileToolsUseProjectExcludes").addEventListener("change", () => {
  $("#fileToolsUseProjectExcludes").dataset.userChanged = "1";
});
document.querySelectorAll("[data-file-tools-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    updateFileToolsModeUi(button.dataset.fileToolsMode);
    if (state.fileTools.mode === "sanitizer") {
      const selectedProject = state.projects.find(
        (project) => project.id === $("#fileToolsProject").value,
      );
      openTextSanitizer(selectedProject || null).catch((error) => toast(error.message, true));
      return;
    }
    loadFileToolsDefaults({ preserveSource: true }).catch((error) => toast(error.message, true));
  }),
);
[
  "fileToolsSourceRoot",
  "fileToolsOutputRoot",
  "fileToolsExcludes",
  "fileToolsIncludes",
  "fileToolsMinBytes",
  "fileToolsMaxBytes",
  "fileToolsRespectGitignore",
  "fileToolsUseProjectExcludes",
  "fileToolsCopyUnversioned",
  "fileToolsCopyUnsupported",
  "fileToolsPreserveLines",
  "fileToolsPreserveLicense",
  "fileToolsMaxCommentBytes",
  "fileToolsOverwrite",
  "fileToolsManifest",
  "fileToolsBackupFirst",
  "fileToolsDryRun",
].forEach((id) => {
  document
    .getElementById(id)
    ?.addEventListener("change", () =>
      resetFileToolsPreview("Paths/options changed. Preview the plan again."),
    );
});
$("#refreshDiagnosticsBtn").addEventListener("click", () =>
  loadDiagnostics().catch((error) => toast(error.message, true)),
);
$("#diagnosticsLevel").addEventListener("change", () =>
  loadDiagnostics().catch((error) => toast(error.message, true)),
);

$("#projectForm").addEventListener("submit", saveProject);
$("#executionHost").addEventListener("change", updateExecutionHostFields);
$("#restoreForm").addEventListener("submit", submitRestore);
$("#scheduleType").addEventListener("change", updateScheduleFields);
$("#scanProjectsBtn").addEventListener("click", scanDiscovery);
$("#registerDiscoveredBtn").addEventListener("click", registerDiscovered);

document.querySelectorAll("[data-close]").forEach((button) =>
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.close);
    dialog?.close();
  }),
);

$("#activityList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-activity-index]");
  if (!row) return;
  const item = state.activity[Number(row.dataset.activityIndex)];
  if (item) openEventDetails(item, { title: item.message || "Activity details" });
});

$("#pm2EventList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-pm2-event-index]");
  if (!row) return;
  const item = state.pm2HistoryData?.events?.[Number(row.dataset.pm2EventIndex)];
  if (item) openEventDetails(item, { title: item.message || "PM2 event details" });
});

$("#copyEventJsonBtn").addEventListener("click", async () => {
  if (!state.eventDetails) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.eventDetails, null, 2));
    toast("Event JSON copied.");
  } catch (error) {
    toast(`Unable to copy event JSON: ${error.message}`, true);
  }
});

async function loadDesktopSettings() {
  if (!window.upmDesktop?.getDesktopSettings) return null;
  state.desktop.settings = await window.upmDesktop.getDesktopSettings();
  return state.desktop.settings;
}

async function openDesktopDataFolder() {
  const settings = state.desktop.settings || (await loadDesktopSettings());
  if (!settings?.dataDir) throw new Error("The desktop data folder is unavailable.");
  await window.upmDesktop.openPath(settings.dataDir);
}

async function openDashboardInBrowser() {
  const settings = state.desktop.settings || (await loadDesktopSettings());
  if (!settings?.dashboardUrl) throw new Error("The dashboard URL is unavailable.");
  await window.upmDesktop.openExternal(settings.dashboardUrl);
}

async function openProjectInEditor(project) {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/open-editor`, {
      method: "POST",
      body: "{}",
    });
    toast(`Opened ${project.name} in ${data.result.editor?.label || "editor"} on the UPM host.`);
  } catch (error) {
    toast(`Unable to open ${project.name}: ${error.message}`, true);
  }
}

async function openProjectRepository(project) {
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/repository`);
    const repository = data.repository;
    if (!repository?.available || !repository?.url)
      throw new Error(repository?.reason || "No Git repository URL is available for this project.");
    if (popup) popup.location.replace(repository.url);
    else window.open(repository.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    if (popup) popup.close();
    throw error;
  }
}

async function startProjectInPm2(project, button) {
  if (
    !confirm(
      `Start ${project.name} in PM2? Existing stopped/offline matches will be started; otherwise ${project.pm2EcosystemFile || "ecosystem.config.js"} will be used.`,
    )
  )
    return;
  button.disabled = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/pm2/start-project`, {
      method: "POST",
      body: JSON.stringify({ refresh: true }),
    });
    toast(
      data.result.started
        ? `PM2 start completed for ${project.name}.`
        : data.result.reason === "waiting-for-docker"
          ? `PM2 start delayed for ${project.name}: ${data.result.message || "waiting for Docker to become ready"}`
          : `PM2 start skipped: ${data.result.reason || "already running"}.`,
      data.result.reason === "waiting-for-docker",
    );
    await refresh();
  } finally {
    button.disabled = false;
  }
}

$("#taskForm").addEventListener("submit", saveTaskFromForm);
$("#scanTasksBtn").addEventListener("click", scanProjectTasks);
$("#cancelTaskEditBtn").addEventListener("click", resetTaskEditor);
["#taskSearch", "#taskStatusFilter", "#taskKindFilter"].forEach((selector) => {
  const eventName = selector === "#taskSearch" ? "input" : "change";
  $(selector).addEventListener(eventName, renderProjectTasks);
});
$("#taskList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-task-id]");
  const action = event.target.closest("[data-task-action]")?.dataset.taskAction;
  if (!row || !action || action === "complete") return;
  const task = state.tasks.data?.tasks?.find((item) => item.id === row.dataset.taskId);
  if (!task) return;
  if (action === "edit") {
    state.tasks.editingId = task.id;
    $("#taskKind").value = task.kind;
    $("#taskTitle").value = task.title;
    $("#taskDetails").value = task.details || "";
    $("#saveTaskBtn").textContent = "Save Changes";
    $("#cancelTaskEditBtn").hidden = false;
    $("#taskTitle").focus();
    return;
  }
  if (action === "remove") {
    if (!confirm(`Delete this ${taskKindLabel(task.kind)} item?`)) return;
    try {
      await api(
        `/api/projects/${encodeURIComponent(state.tasks.projectId)}/tasks/${encodeURIComponent(task.id)}`,
        { method: "DELETE" },
      );
      await loadProjectTasks();
      await refresh();
      toast("Task deleted.");
    } catch (error) {
      toast(error.message, true);
    }
  }
});
$("#taskList").addEventListener("change", async (event) => {
  const input = event.target.closest('input[data-task-action="complete"]');
  const row = input?.closest("[data-task-id]");
  if (!input || !row) return;
  input.disabled = true;
  try {
    await api(
      `/api/projects/${encodeURIComponent(state.tasks.projectId)}/tasks/${encodeURIComponent(row.dataset.taskId)}`,
      { method: "PUT", body: JSON.stringify({ completed: input.checked }) },
    );
    await loadProjectTasks();
    await refresh();
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message, true);
  } finally {
    input.disabled = false;
  }
});

$("#projectGrid").addEventListener(
  "toggle",
  (event) => {
    const details = event.target.closest?.("details.action-menu");
    if (!details) return;
    updateProjectActionMenuState(details);
  },
  true,
);

$("#projectGrid").addEventListener("click", async (event) => {
  const card = event.target.closest("[data-id]");
  if (!card) return;
  const project = state.projects.find((item) => item.id === card.dataset.id);
  if (!project) return;

  const menuSummary = event.target.closest("details.action-menu > summary");
  if (menuSummary) {
    const details = menuSummary.parentElement;
    setProjectActionMenuState(details, !details.open);
  }

  const pm2Button = event.target.closest("[data-pm2-action]");
  if (pm2Button) {
    const pm2Menu = pm2Button.closest("details.action-menu");
    if (pm2Menu) pm2Menu.open = false;
    const pm2Id = pm2Button.dataset.pm2Id;
    const pm2Action = pm2Button.dataset.pm2Action;
    if (
      ["stop", "restart", "reload"].includes(pm2Action) &&
      !confirm(`${pm2Action} PM2 process ID ${pm2Id}?`)
    )
      return;
    pm2Button.disabled = true;
    try {
      const data = await api(
        `/api/projects/${project.id}/pm2/${encodeURIComponent(pm2Id)}/action`,
        { method: "POST", body: JSON.stringify({ action: pm2Action }) },
      );
      toast(
        data.result.delayed
          ? `PM2 ${data.result.action} delayed for ${data.result.processName}: ${data.result.message || "waiting for Docker to become ready"}`
          : `PM2 ${data.result.action} completed for ${data.result.processName}.`,
        data.result.delayed === true,
      );
      await refresh();
      if ($("#pm2HistoryDialog").open && state.pm2HistoryProject === project.id)
        await loadPm2History();
    } catch (error) {
      toast(error.message, true);
    } finally {
      pm2Button.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const actionMenu = button.closest("details.action-menu");
  if (actionMenu) actionMenu.open = false;

  try {
    if (action === "toggle-collapse") {
      const collapsed = !state.collapsedProjects.has(String(project.id));
      setProjectCollapsed(project.id, collapsed, card);
      return;
    }
    if (action === "edit") return openProjectDialog(project);
    if (action === "open-editor") return openProjectInEditor(project);
    if (action === "open-repository") return openProjectRepository(project);
    if (action === "pm2-start-project") return startProjectInPm2(project, button);
    if (action === "service-health-refresh") {
      button.disabled = true;
      const data = await api(`/api/projects/${encodeURIComponent(project.id)}/services/refresh`, {
        method: "POST",
        body: "{}",
      });
      project.serviceHealthStatus = data.health;
      renderProjects();
      toast(`Service health refreshed for ${project.name}.`);
      return;
    }
    if (action === "history") return showBackups(project);
    if (action === "tasks") return openProjectTasks(project);
    if (action === "dependencies") return openDependencies(project);
    if (action === "file-tools") return openFileTools(project);
    if (action === "diff") return openProjectDiff(project);
    if (action === "feature-pack") return openFeaturePack(project);
    if (action === "recovery") return openRecovery(project);
    if (action === "journal") return openDeltaJournal(project);
    if (action === "pm2-logs") return openPm2Logs(project, button.dataset.pm2Id);
    if (action === "pm2-history") return openPm2History(project, button.dataset.processKey || null);
    if (action === "toggle-watch") {
      await api(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ watch: !project.watch }),
      });
      toast(project.watch ? "Change watcher paused." : "Change watcher resumed.");
    }
    if (action === "toggle-schedule") {
      await api(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({
          schedule: {
            ...project.schedule,
            enabled: !project.schedule?.enabled,
          },
        }),
      });
      toast(project.schedule?.enabled ? "Schedule disabled." : "Schedule enabled.");
    }
    if (action === "remove") {
      if (
        !confirm(
          `Remove ${project.name} from the manager? Existing backup files will NOT be deleted.`,
        )
      )
        return;
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      toast("Project removed. Backup files were preserved.");
    }
    if (action === "inspect") {
      button.disabled = true;
      const data = await api(`/api/projects/${project.id}/inspect`, {
        method: "POST",
        body: "{}",
      });
      toast(data.result.changed ? "Changes detected." : "No changes detected.");
    }
    if (action === "backup") {
      button.disabled = true;
      const data = await api(`/api/projects/${project.id}/backup`, {
        method: "POST",
        body: "{}",
      });
      const repairedMirror =
        !data.result.created &&
        (data.result.destinations || []).some((item) => item.key === "secondary" && item.created);
      const mirrorWarning = (data.result.destinations || []).some((item) => item.warning === true);
      const mirrored = (data.result.destinations || []).find((item) => item.key === "secondary");
      toast(
        data.result.created
          ? mirrorWarning
            ? `Primary backup saved; secondary deferred${mirrored?.pendingCount ? ` (${mirrored.pendingCount} pending)` : ""}.`
            : "Backup created and all destinations verified."
          : repairedMirror
            ? "No source changes; secondary mirror repaired."
            : mirrorWarning
              ? "No source changes; primary is current and secondary sync is pending."
              : "No changes; backup skipped.",
        false,
      );
    }
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#verifyAllBtn").addEventListener("click", async () => {
  const project = state.projects.find((item) => item.id === state.selectedBackupProject);
  if (!project) return;
  const button = $("#verifyAllBtn");
  button.disabled = true;
  try {
    const data = await api(`/api/projects/${project.id}/backups/verify-all`, {
      method: "POST",
      body: "{}",
    });
    const failed = data.results.filter((item) => !item.valid).length;
    toast(
      failed
        ? `${failed} backup(s) failed verification.`
        : `Verified ${data.results.length} backup(s).`,
      failed > 0,
    );
    await showBackups(project);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#backupsList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-file]");
  const project = state.projects.find((item) => item.id === state.selectedBackupProject);
  if (!row || !project) return;
  const file = row.dataset.file;

  const restoreButton = event.target.closest("[data-restore-backup]");
  if (restoreButton) return openRestoreDialog(project, file);

  const verifyButton = event.target.closest("[data-verify-backup]");
  if (verifyButton) {
    verifyButton.disabled = true;
    try {
      const data = await api(
        `/api/projects/${project.id}/backups/${encodeURIComponent(file)}/verify`,
        { method: "POST", body: "{}" },
      );
      toast(
        data.result.valid
          ? "Backup integrity verified."
          : `Verification failed: ${data.result.message}`,
        !data.result.valid,
      );
      await showBackups(project);
      await refresh();
    } catch (error) {
      toast(error.message, true);
    } finally {
      verifyButton.disabled = false;
    }
    return;
  }

  const deleteButton = event.target.closest("[data-delete-backup]");
  if (!deleteButton) return;
  if (!confirm(`Delete backup ${file}? This cannot be undone.`)) return;
  try {
    await api(`/api/projects/${project.id}/backups/${encodeURIComponent(file)}`, {
      method: "DELETE",
    });
    toast("Backup deleted.");
    await showBackups(project);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
});

$("#pruneJournalBtn").addEventListener("click", () =>
  pruneDeltaJournal().catch((error) => toast(error.message, true)),
);

window.addEventListener("resize", () => {
  if (state.hostHistoryData) renderHostHistoryInteractiveCharts();
  if ($("#pm2HistoryDialog")?.open && state.pm2HistoryData)
    renderPm2HistoryCharts(state.pm2HistoryData);
});

$("#toolbarRefreshBtn")?.addEventListener("click", () => $("#refreshBtn")?.click());
$("#authForm").addEventListener("submit", login);
$("#openDesktopDataBtn")?.addEventListener("click", () =>
  openDesktopDataFolder().catch((error) => toast(error.message, true)),
);
$("#openDesktopBrowserBtn")?.addEventListener("click", () =>
  openDashboardInBrowser().catch((error) => toast(error.message, true)),
);
$("#logoutBtn").addEventListener("click", () =>
  logout().catch((error) => toast(error.message, true)),
);
$("#settingsBtn").addEventListener("click", () =>
  openSettings().catch((error) => toast(error.message, true)),
);
$("#closeSettingsBtn").addEventListener("click", () => $("#settingsDialog").close());
$("#cancelSettingsBtn").addEventListener("click", () => $("#settingsDialog").close());
$("#settingsForm").addEventListener("submit", saveRuntimeSettings);
$("#generateEncryptionKeyBtn")?.addEventListener("click", () => {
  try {
    generateBackupEncryptionKey();
  } catch (error) {
    toast(error.message, true);
  }
});
$("#exportSetupBtn")?.addEventListener("click", () =>
  exportSetup().catch((error) => toast(error.message, true)),
);
$("#importSetupBtn")?.addEventListener("click", () => $("#setupImportFile")?.click());
$("#setupImportFile")?.addEventListener("change", (event) =>
  importSetupFile(event.target.files?.[0]).catch((error) => {
    event.target.value = "";
    toast(error.message, true);
  }),
);
$("#settingsColorVisionPalette")?.addEventListener("change", (event) =>
  setColorVisionPalette(event.target.value),
);
$("#settingsChartPatterns")?.addEventListener("change", (event) =>
  setChartPatterns(event.target.checked),
);
$("#resetAccessibilityBtn")?.addEventListener("click", resetAccessibilityPreferences);
$("#hostHistoryRange").addEventListener("change", () =>
  loadHostHistory().catch((error) => toast(error.message, true)),
);

async function bootstrap() {
  applyRuntimeMode(window.upmDesktop?.isDesktop === true);
  initDesktopCommandBridge();
  initDashboardActionMenu();
  loadUiPreferences();
  applyUiPreferences();
  initUiTitleCase();
  loadCollapsedProjects();
  loadOpenProjectActionMenus();
  loadOverviewCollapsedSections();
  applyOverviewCollapsedSections();
  loadStorageCollapsedSections();
  applyStorageCollapsedSections();
  initDashboardTabs();
  initHelpCenter();
  initProjectSettingsTabs();
  initRuntimeSettingsTabs();
  try {
    if (!(await checkAuthentication())) return;
    await refresh();
    if (!state.refreshTimer)
      state.refreshTimer = setInterval(() => {
        if (!$("#authGate").hidden) return;
        refresh().catch(() => {});
      }, 10000);
  } catch (error) {
    showAuthGate(error.message);
  }
}

bootstrap();
