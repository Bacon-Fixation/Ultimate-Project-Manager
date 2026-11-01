"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const responsiveCss = fs.readFileSync(path.join(root, "public", "styles-responsive.css"), "utf8");
const cohesiveCss = fs.readFileSync(path.join(root, "public", "styles-cohesive.css"), "utf8");
const allCss = `${css}\n${responsiveCss}\n${cohesiveCss}`;

function decodeUiEntities(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function visibleText(fragment) {
  return decodeUiEntities(
    String(fragment)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function assertTitleCaseUiLabel(label, context) {
  const tokens = String(label).match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) || [];
  for (const token of tokens) {
    for (const part of token.split("-")) {
      if (!part || part === "npm") continue;
      assert.equal(part[0], part[0].toUpperCase(), `${context} is not Title Case: ${label}`);
    }
  }
}

const staticButtons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
for (const match of staticButtons) {
  const attrs = match[1];
  const className = attrs.match(/\bclass="([^"]*)"/i)?.[1] || "";
  if (className.split(/\s+/).includes("icon-button")) continue;
  let labelSource = match[2];
  if (className.split(/\s+/).includes("file-tools-workflow")) {
    labelSource = labelSource.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1] || "";
  }
  const label = visibleText(labelSource);
  if (label) assertTitleCaseUiLabel(label, `Button ${attrs}`);
}

for (const match of html.matchAll(
  /<(span|div|p)\b([^>]*)class="([^"]*\bbadge\b[^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi,
)) {
  const label = visibleText(match[4]);
  if (label) assertTitleCaseUiLabel(label, `Badge ${match[3]}`);
}

assert.match(js, /function titleCaseUiLabel\(/);
assert.match(js, /function initUiTitleCase\(/);
assert.match(js, /new MutationObserver\(/);
assert.match(js, /\.badge:not\(\.error-block\)/);
assert.match(js, /npm: "npm"/);
assert.match(js, /pm2: "PM2"/);
assert.match(js, /http: "HTTP"/);
assert.match(js, /lan: "LAN"/);
assert.match(js, /json: "JSON"/);
assert.match(js, /git: "Git"/);
assert.match(js, /Backup Now/);
assert.match(js, /No PM2 Match/);

assert.match(html, /rel="icon"[^>]+href="\/favicon\.svg"/);
assert.match(html, /<title>Ultimate Project Manager<\/title>/);
assert.match(html, /name="theme-color"/);
assert.match(html, /class="skip-link"/);
assert.match(html, /id="dashboardNav"/);
assert.match(html, /<h1>Ultimate Project Manager<\/h1>/);
assert.match(html, /id="footerProductName">Ultimate Project Manager<\/span>/);
assert.match(html, /https:\/\/github\.com\/Bacon-Fixation\//);
assert.match(html, /class="playerIcon"/);
assert.match(html, /id="collapseAllProjectsBtn"/);
assert.match(html, /id="expandAllProjectsBtn"/);
assert.match(html, /id="eventDetailsDialog"/);
assert.match(html, /id="diffDialog"/);
assert.ok(
  html.indexOf('data-dashboard-section="projects"') <
    html.indexOf('data-dashboard-section="overview"'),
);
assert.ok(fs.existsSync(path.join(root, "public", "favicon.svg")));

assert.match(js, /collapsedProjects: new Set\(\)/);
assert.match(js, /function setProjectActionMenuState\(/);
assert.match(js, /function pruneProjectUiState\(/);
assert.match(js, /details\.action-menu > summary/);
assert.match(js, /data-action="toggle-collapse"/);
assert.match(js, /function syncProjectGridCollapseLayout\(/);
assert.match(js, /is-mixed-collapse-state/);
assert.match(js, /project-collapse-chevron[^>]*><\/span>/);
assert.match(js, /data-activity-index/);
assert.match(js, /data-pm2-event-index/);
assert.match(js, /function openEventDetails\(/);
assert.match(js, /copyEventJsonBtn/);
assert.match(js, /function renderCollapsedPm2Summary\(/);
assert.match(js, /function renderCollapsedServiceSummary\(/);
assert.match(js, /data-action="pm2-logs"[\s\S]*?>Log<\/button>/);
assert.match(js, /data-action="pm2-history"[\s\S]*?>Health History<\/button>/);
assert.match(js, /Process Control/);
assert.match(allCss, /\.collapsed-process-actions/);
assert.match(allCss, /\.project-collapsed-services/);
assert.match(js, /function collapsedPm2CardClass\(/);
assert.match(js, /Heap/);
assert.match(js, /Loop p95/);
assert.match(js, /collapsedSections: new Set\(\)/);
assert.match(js, /function openProjectDiff\(/);
assert.match(js, /data-action="diff"/);

assert.match(allCss, /\.site-footer/);
assert.match(allCss, /\.project-collapse-button/);
assert.match(
  allCss,
  /\.project-grid\.is-mixed-collapse-state[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/,
);
assert.match(allCss, /\.project-collapse-chevron[\s\S]*border-right:\s*2px solid currentColor/);
assert.match(
  allCss,
  /\.action-menu > summary::after[\s\S]*border-bottom:\s*2px solid currentColor/,
);
assert.match(allCss, /\.event-details-grid/);
assert.match(allCss, /\.project-collapsed-pm2/);
assert.match(allCss, /\.collapsed-pm2-success/);
assert.match(allCss, /\.collapsed-pm2-error/);
assert.match(allCss, /\.dashboard-section/);
assert.match(allCss, /\.diff-layout/);
assert.match(allCss, /\.diff-code-line/);

assert.match(html, /id="fileToolsRespectGitignore"/);
assert.match(html, /id="fileToolsUseProjectExcludes"/);
assert.match(html, /id="fileToolsPreserveLicense"/);
assert.match(html, /id="fileToolsMaxCommentBytes"/);
assert.match(html, /id="fileToolsAggressiveness"/);
assert.match(html, /id="fileToolsParserStatus"/);
assert.match(html, /Safe - keep docs, notes, and tooling directives/);
assert.match(html, /Aggressive - remove tooling directives too/);
assert.match(html, /id="fileToolsIgnoredDetails"/);
assert.match(html, /id="authGate"/);
assert.match(html, /id="authForm"/);
assert.match(html, /id="logoutBtn"/);
assert.match(html, /id="backupEncryptionEnabled"/);
assert.match(html, /id="extraIncludes"/);
assert.match(html, /Backup include overrides/);
assert.match(html, /data-runtime-settings-tab="setup"/);
assert.match(html, /id="exportSetupBtn"/);
assert.match(html, /id="importSetupBtn"/);
assert.match(js, /async function exportSetup\(/);
assert.match(js, /async function importSetupFile\(/);
assert.match(html, /data-file-tools-mode="inventory"/);
assert.match(html, /data-file-tools-mode="sanitizer"/);
assert.match(html, /id="textSanitizerPanel"/);
assert.match(html, /id="textSanitizerOriginal"/);
assert.match(html, /id="textSanitizerSanitized"/);
assert.match(html, /id="textSanitizerCatalog"/);
assert.match(html, /id="textSanitizerOutputRoot"/);
assert.match(html, /id="tsOverwriteOutput"/);
assert.match(html, /id="tsWriteManifest"/);
assert.match(html, /Copy-Only Output/);
assert.doesNotMatch(html, /id="tsBackupFiles"/);
assert.match(js, /async function scanTextSanitizer\(/);
assert.match(js, /async function applyTextSanitizer\(/);
assert.match(js, /function renderTextSanitizerSegments\(/);
assert.match(allCss, /\.text-sanitizer-panel/);
assert.match(allCss, /\.ts-diff-original/);
assert.match(allCss, /\.ts-diff-sanitized/);
assert.match(html, /id="fileToolsIncludes"/);
assert.match(html, /id="fileToolsMinBytes"/);
assert.match(html, /id="fileToolsMaxBytes"/);
assert.match(html, /id="fileToolsDuplicateDetails"/);
assert.match(js, /respectGitignore/);
assert.match(js, /preserveLicenseComments/);
assert.match(js, /commentAggressiveness/);
assert.match(allCss, /\.file-tools-ignored-details/);
assert.match(allCss, /\.auth-gate/);
assert.match(js, /async function checkAuthentication/);
assert.match(js, /browser did not return the session cookie/);
assert.match(js, /cookie\?\.compatible === false/);
assert.match(js, /AES-256-GCM/);
assert.match(js, /Inventory \+ Duplicate Finder/);
assert.match(js, /function renderFileToolsDuplicates/);

assert.match(html, /id="recoveryDialog"/);
assert.match(html, /id="recoveryPath"/);
assert.match(html, /id="recoverSuggestedBtn"/);
assert.match(js, /data-action="recovery"/);
assert.match(js, /async function openRecovery\(/);
assert.match(js, /function renderRecoveryCandidates\(/);
assert.match(allCss, /\.recovery-layout/);
assert.match(allCss, /\.recovery-warning/);

assert.match(html, /id="journalDialog"/);
assert.match(html, /id="deltaJournalEnabled"/);
assert.match(html, /id="deltaJournalRetentionDays"/);
assert.match(html, /id="deltaJournalMaxEntries"/);
assert.match(html, /id="deltaJournalMaxStorageMB"/);
assert.match(html, /id="deltaJournalMaxFileMB"/);
assert.match(html, /id="executionHost"/);
assert.match(js, /remoteAgentId/);
assert.match(js, /executionTarget/);
assert.match(html, /id="projectEditor"/);
assert.match(html, /id="repositoryUrl"/);
assert.match(html, /id="pm2AutoStart"/);
assert.match(html, /id="pm2WaitForDocker"/);
assert.match(html, /id="pm2RequireElevation"/);
assert.match(html, /id="pm2RequiredContainers"/);
assert.match(html, /id="pm2StartupGateTimeoutSeconds"/);
assert.match(html, /id="restartElevatedBtn"/);
assert.match(js, /Docker runtime/);
assert.match(html, /id="pm2EcosystemFile"/);
assert.match(html, /id="pm2EcosystemAppName"/);
assert.match(html, /id="serviceHealthEnabled"/);
assert.match(html, /id="healthRedisEnabled"/);
assert.match(html, /id="healthMariaDbEnabled"/);
assert.match(html, /id="healthPostgresEnabled"/);
assert.match(html, /id="healthDockerEnabled"/);
assert.match(html, /id="serviceHealthCustomServices"/);
assert.match(html, /id="directoryPickerDialog" class="directory-picker-modal"/);
assert.match(html, /class="directory-browser-layout"/);
assert.match(html, /class="directory-locations-panel"/);
assert.match(html, /id="directoryBrowserSummary"/);
assert.match(html, /id="directoryCreatePanel"/);
assert.match(html, /id="directoryNewFolderName"/);
assert.match(js, /function directoryLocationIcon\(/);
assert.match(js, /async function createDirectoryFromPicker\(/);
assert.doesNotMatch(js, /prompt\("New folder name:/);
assert.match(allCss, /\.directory-browser-layout/);
assert.match(allCss, /\.directory-create-panel/);
assert.match(html, /id="projectDialog" class="project-settings-modal"/);
assert.match(html, /data-project-settings-tab="general"/);
assert.match(html, /data-project-settings-tab="backups"/);
assert.match(html, /data-project-settings-tab="recovery"/);
assert.match(html, /data-project-settings-tab="runtime"/);
assert.match(html, /data-project-settings-tab="services"/);
assert.match(html, /data-project-settings-section="general"/);
assert.match(html, /data-project-settings-section="services"/);
assert.match(js, /function initProjectSettingsTabs\(/);
assert.match(js, /function setProjectSettingsTab\(/);
assert.match(js, /projectSettingsTabForElement/);
assert.match(allCss, /\.project-settings-nav/);
assert.match(allCss, /\.project-settings-actions/);
assert.match(js, /const interactiveChartState = new WeakMap\(\)/);
assert.match(js, /function showChartTooltip\(/);
assert.match(js, /function bindInteractiveChart\(/);
assert.match(js, /function renderHostHistoryInteractiveCharts\(/);
assert.match(html, /id="chartInteractionHelp"/);
assert.match(allCss, /\.chart-tooltip/);
assert.match(allCss, /\.interactive-chart-panel/);
assert.match(js, /function renderServiceHealth\(/);
assert.match(js, /function collectServiceHealthConfig\(/);
assert.match(js, /data-action="service-health-refresh"/);
assert.match(allCss, /\.service-health-section/);
assert.match(allCss, /\.service-health-list/);

assert.match(js, /data-action="journal"/);
assert.match(js, /data-action="open-editor"/);
assert.match(js, /data-action="open-repository"/);
assert.match(js, /data-action="pm2-start-project"/);
assert.match(js, /async function openProjectInEditor\(/);
assert.match(js, /async function openProjectRepository\(/);
assert.match(js, /async function openDeltaJournal\(/);
assert.match(js, /JOURNAL/);
assert.match(allCss, /\.journal-entry-list/);
assert.match(html, /class="action-menu dashboard-action-menu"/);
assert.match(html, /id="dashboardMoreMenu"/);
assert.match(html, /class="dashboard-nav-primary"/);
assert.match(html, /id="settingsBtn"[\s\S]*?class="dashboard-tab dashboard-nav-control"/);
assert.match(html, /id="dashboardMoreMenu"[\s\S]*?id="addProjectBtn"[\s\S]*?id="backupAllBtn"/);
assert.match(html, /id="dashboardMoreMenu"[\s\S]*?id="toolbarRefreshBtn"[\s\S]*?id="fileToolsBtn"/);
assert.match(
  html,
  /id="projectRepositoryLink"[\s\S]*?github\.com\/Bacon-Fixation\/Ultimate-Project-Manager/,
);
assert.match(html, /id="kofiSupportLink"[\s\S]*?ko-fi\.com\/baconfixation/);
assert.match(html, /id="refreshBtn"[\s\S]*?id="projectAddBtn"/);
assert.match(
  html,
  /id="desktopActionGroup"[\s\S]*?id="openDesktopBrowserBtn"[\s\S]*?id="openDesktopDataBtn"/,
);
const navPrimaryStart = html.indexOf('class="dashboard-nav-primary"');
const settingsNavIndex = html.indexOf('id="settingsBtn"');
const moreMenuIndex = html.indexOf('id="dashboardMoreMenu"');
const addProjectMenuIndex = html.indexOf('id="addProjectBtn"');
assert.ok(
  navPrimaryStart >= 0 && settingsNavIndex > navPrimaryStart && settingsNavIndex < moreMenuIndex,
);
assert.ok(addProjectMenuIndex > moreMenuIndex);
assert.match(js, /class="action-menu project-action-menu"/);
assert.match(js, /More Actions/);
assert.match(js, /Process Controls/);
assert.match(allCss, /\.button/);
assert.match(allCss, /min-height: 44px/);
assert.match(allCss, /env\(safe-area-inset-bottom\)/);
assert.match(js, /state\.openProjectActionMenus = captureOpenProjectActionMenus/);
assert.match(js, /captureOpenProjectActionMenus/);
assert.match(html, /id="featurePackDialog"/);
assert.match(html, /id="featurePackExcludeSensitive"/);
assert.match(html, /id="exportFeaturePackBtn"/);
assert.match(js, /data-action="feature-pack"/);
assert.match(js, /function renderFeaturePackPreview\(/);
assert.match(allCss, /\.feature-pack-dialog-card/);
assert.match(html, /id="settingsBtn"/);
assert.match(html, /id="settingsDialog"/);
assert.match(html, /id="settingsForm"/);
assert.match(html, /data-runtime-settings-tab="server"/);
assert.match(html, /data-runtime-settings-tab="access"/);
assert.match(html, /data-runtime-settings-tab="http"/);
assert.match(html, /data-runtime-settings-tab="auth"/);
assert.match(html, /data-runtime-settings-tab="backups"/);
assert.match(html, /data-runtime-settings-tab="accessibility"/);
assert.match(html, /data-runtime-settings-tab="integrations"/);
assert.match(html, /data-runtime-settings-section="server"/);
assert.match(html, /data-runtime-settings-section="accessibility"/);
assert.match(html, /data-runtime-settings-section="integrations"/);
assert.match(html, /id="settingsColorVisionPalette"/);
assert.match(html, /Red-Green Friendly/);
assert.match(html, /Blue-Yellow Friendly/);
assert.match(html, /High Contrast/);
assert.match(html, /Monochrome/);
assert.match(html, /id="settingsChartPatterns"/);
assert.match(html, /id="resetAccessibilityBtn"/);
assert.match(html, /id="settingsLanAgentList"/);
assert.match(html, /id="settingsLanAllowInsecureHttp"/);
assert.match(html, /href="\/styles-responsive\.css"/);
assert.match(html, /id="settingsLanAgentsJson"/);
assert.match(html, /id="settingsClearLanAgents"/);
assert.match(html, /id="settingsAllowRemoteAdmin"/);
assert.match(html, /id="settingsNewAuthPassword"/);
assert.match(js, /async function openSettings\(/);
assert.match(js, /async function saveRuntimeSettings\(/);
assert.match(
  js,
  /async function saveRuntimeSettings\([\s\S]*?\$\("#settingsDialog"\)\.close\(\);[\s\S]*?promptForRuntimeRestart/,
);
assert.match(html, /id="generateEncryptionKeyBtn"/);
assert.match(js, /function generateBackupEncryptionKey\(/);
assert.match(js, /window\.crypto\?\.getRandomValues/);
assert.match(js, /window\.upmDesktop\?\.restartApp/);
assert.match(js, /function initRuntimeSettingsTabs\(/);
assert.match(js, /function setRuntimeSettingsTab\(/);
assert.match(js, /runtimeSettingsTabForElement/);
assert.match(js, /function renderRuntimeLanAgents\(/);
assert.match(js, /settingsLanAllowInsecureHttp/);
assert.match(js, /upm:accessibility-preferences/);
assert.match(js, /function applyUiPreferences\(/);
assert.match(js, /function setColorVisionPalette\(/);
assert.match(js, /function resetAccessibilityPreferences\(/);
assert.match(js, /linePatterns = \[\[\], \[8, 5\], \[2, 4\]\]/);
assert.match(js, /ctx\.setLineDash\(/);
assert.match(allCss, /data-color-vision="red-green"/);
assert.match(allCss, /data-color-vision="blue-yellow"/);
assert.match(allCss, /data-color-vision="high-contrast"/);
assert.match(allCss, /data-color-vision="monochrome"/);
assert.match(allCss, /--bh-accent-rgb/);
assert.match(allCss, /\.accessibility-preview/);
assert.match(allCss, /\.badge\.success::before/);
assert.match(allCss, /\.badge\.warning::before/);
assert.match(allCss, /\.badge\.error::before/);
assert.match(responsiveCss, /Responsive layout hardening/);
assert.match(allCss, /\.settings-dialog-card/);
assert.match(allCss, /\.runtime-settings-nav/);
assert.match(allCss, /\.runtime-settings-panel/);
assert.match(allCss, /\.runtime-agent-list/);
assert.match(html, /id="hostStats"/);
assert.match(html, /id="hostHistoryRange"/);
assert.match(html, /id="hostHistoryCharts"/);
assert.match(html, /id="hostCoreCharts"/);
assert.match(html, /id="hostCoreSummary"/);
assert.match(html, /id="storageBackupSummary"/);
assert.match(html, /id="storageDriveList"/);
assert.match(html, /id="collapseAllOverviewBtn"/);
assert.match(html, /id="expandAllOverviewBtn"/);
assert.match(html, /data-overview-section="operations"/);
assert.match(html, /data-overview-section="host"/);
assert.match(html, /data-overview-section="cores"/);
assert.doesNotMatch(html, /data-overview-section="storage"/);
assert.match(html, /data-storage-section="destinations"/);
assert.match(html, /data-overview-toggle="operations"/);
assert.match(html, /data-overview-toggle="host"/);
assert.match(html, /data-overview-toggle="cores"/);
assert.match(html, /data-storage-toggle="destinations"/);
assert.match(js, /function renderHostStats\(/);
assert.match(js, /function renderHostHistory\(/);
assert.match(js, /function hostCoreHistoryChart\(/);
assert.match(js, /function renderBackupStorage\(/);
assert.match(js, /function storageDestinations\(/);
assert.match(js, /overviewCollapsedSections: new Set\(\)/);
assert.match(js, /storageCollapsedSections: new Set\(\)/);
assert.match(js, /upm:overview-collapsed-sections/);
assert.match(js, /upm:storage-collapsed-sections/);
assert.match(js, /legacyOverview/);
assert.match(js, /function setOverviewSectionCollapsed\(/);
assert.match(js, /function setAllOverviewSectionsCollapsed\(/);
assert.match(js, /function setStorageSectionCollapsed\(/);
assert.match(js, /loadOverviewCollapsedSections\(\)/);
assert.match(js, /applyOverviewCollapsedSections\(\)/);
assert.match(js, /applyStorageCollapsedSections\(\)/);
assert.match(allCss, /\.overview-collapse-toggle/);
assert.match(allCss, /\.overview-collapsible-body\[hidden\]/);
assert.match(js, /\/api\/host-stats\/history/);
assert.match(allCss, /\.host-overview-card/);
assert.match(allCss, /\.host-core-charts/);
assert.match(allCss, /\.overview-summary-card/);
assert.match(allCss, /\.storage-drive-card/);
assert.match(allCss, /\.storage-destinations-card/);
assert.match(html, /id="dashboard-tab-help"/);
assert.match(html, /id="dashboard-help"/);
assert.match(html, /id="helpSearch"/);
assert.match(html, /id="gettingStartedTips"/);
assert.match(html, /id="helpBtn"/);
assert.match(html, /data-help-topic-card/);
assert.match(html, /data-help-topic-target="backups"/);
assert.match(html, /data-help-topic-target="desktop-builds"/);
assert.match(html, /id="help-topic-desktop-builds"/);
assert.match(html, /class="help-tip"/);
assert.match(js, /function initHelpCenter\(/);
assert.match(js, /function filterHelpTopics\(/);
assert.match(js, /function openHelp\(/);
assert.match(js, /upm:getting-started-tips-hidden/);
assert.match(allCss, /\.help-dashboard/);
assert.match(allCss, /\.help-onboarding\s*\{[\s\S]*padding:\s*clamp\(/);
assert.match(allCss, /\.help-onboarding-copy\s*\{[\s\S]*gap:/);
assert.match(allCss, /\.help-topic/);
assert.match(allCss, /\.help-tip/);
assert.match(html, /data-guidance-label="Tour \/ Tips"/);
assert.match(html, /data-guidance-label="Tip"/);
assert.match(allCss, /\.help-guidance-frame/);
assert.match(allCss, /TIP  ·/);
assert.match(html, /id="tasksDialog"/);
assert.match(html, /id="taskForm"/);
assert.match(html, /id="scanTasksBtn"/);
assert.match(html, /id="taskIncludeGitignored"/);
assert.match(js, /data-action="tasks"/);
assert.match(js, /async function openProjectTasks\(/);
assert.match(js, /async function scanProjectTasks\(/);
assert.match(allCss, /\.task-list/);
assert.match(html, /id="desktopActionGroup"/);
assert.match(html, /id="desktopModeStatus"/);
assert.match(html, /id="openDesktopDataBtn"/);
assert.match(html, /id="openDesktopBrowserBtn"/);
assert.match(html, /role="toolbar" aria-label="Global project actions"/);
assert.match(html, /id="toolbarRefreshBtn"/);
assert.match(html, /id="dashboardMoreMenu"/);
assert.match(
  html,
  /class="dashboard-nav-actions" role="toolbar" aria-label="Global project actions"/,
);
assert.match(js, /window\.upmDesktop\?\.selectDirectory/);
assert.match(js, /function applyRuntimeMode\(/);
assert.match(js, /data\.desktop === true/);
assert.match(js, /function initDesktopCommandBridge\(/);
assert.match(js, /#projectAddBtn/);
assert.match(js, /dashboard-action-menu-panel button, \.dashboard-action-menu-panel a/);
assert.match(js, /function runDesktopRendererCommand\(/);
assert.match(js, /async function loadDesktopSettings\(/);
assert.match(js, /async function openDesktopDataFolder\(/);
assert.match(js, /async function openDashboardInBrowser\(/);
assert.match(allCss, /body\[data-runtime-mode="browser"\] #desktopModeStatus/);
assert.match(allCss, /body\[data-runtime-mode="desktop"\] \.shell/);
assert.match(allCss, /\.dashboard-action-menu-panel/);
assert.match(
  allCss,
  /\.help-hero,[\s\S]*\.help-quick-card,[\s\S]*\.help-footer-guide[\s\S]*padding:/,
);
console.log("Dashboard UI checks passed.");

assert.match(js, /function initDashboardTabs\(/);
assert.match(js, /function setDashboardTab\(/);
assert.match(js, /upm:dashboard-tab/);
assert.match(js, /function keepTabVisible\(/);
assert.match(js, /scrollIntoView/);
assert.match(js, /function capturePm2LogScrollState\(/);
assert.match(js, /function restorePm2LogScrollState\(/);
assert.match(html, /id="pm2LogsLayout"/);
assert.match(html, /id="pm2LogsAnsiColors"/);
assert.match(html, /id="pm2LogsSourceColors"/);
assert.match(js, /function renderCombinedPm2Logs\(/);
assert.match(js, /function renderAnsiText\(/);
assert.match(js, /function parsePm2LogTimestamp\(/);
assert.match(js, /function nearestAnsiColorName\(/);
assert.match(allCss, /\.pm2-combined-line/);
assert.match(allCss, /\.ansi-fg-bright-red/);
assert.match(js, /options\.silent && state\.pm2Logs\.loading/);
assert.match(html, /role="tablist"/);
assert.match(html, /data-dashboard-tab="projects"/);
assert.match(html, /role="tabpanel"/);
assert.match(html, /id="dashboard-overview"/);
