"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manager = fs.readFileSync(path.join(root, "src", "manager", "backup-manager.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
const pm2 = fs.readFileSync(path.join(root, "src", "pm2", "pm2-monitor.js"), "utf8");
const ui = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.match(pkg.dependencies.pm2 || "", /^\^7\./);

assert.match(manager, /pm2AutoStart:/);
assert.match(manager, /pm2WaitForDocker:/);
assert.match(manager, /pm2RequiredContainers:/);
assert.match(manager, /pm2RequireElevation:/);
assert.match(manager, /pm2StartupGateTimeoutSeconds:/);
assert.match(manager, /_dockerStartGate/);
assert.match(manager, /waiting-for-docker/);
assert.match(manager, /waiting-for-containers/);
assert.match(manager, /elevation-required/);
assert.match(manager, /_handlePm2QueuedStarts/);
assert.match(manager, /pm2EcosystemFile:/);
assert.match(manager, /pm2EcosystemAppName:/);
assert.match(manager, /repositoryUrl:/);
assert.match(manager, /editor:/);
assert.match(manager, /PM2_AUTO_START_FAILURE_COOLDOWN_MS/);
assert.match(manager, /pm2AutoStartSuppressed/);
assert.match(manager, /manual dashboard Stop/);
assert.match(manager, /startProjectInPm2/);
assert.match(manager, /openProjectInEditor/);
assert.match(manager, /getProjectRepository/);
assert.match(manager, /previewFeaturePack/);
assert.match(manager, /exportFeaturePack/);
assert.match(manager, /version: 15/);
assert.match(manager, /ProjectTaskService/);
assert.match(manager, /scanProjectTasks/);
assert.match(manager, /BuildSlotManager/);
assert.match(manager, /runBackupBuild/);
assert.match(manager, /activateSourceBuild/);
assert.match(manager, /pm2-build-slot-reconcile/);
assert.match(manager, /runningBeforeSwitch/);
assert.match(pm2, /pm2RuntimeRoots/);
assert.match(server, /backups\/:file\/build-slot\/run/);
assert.match(ui, /Run Build/);
assert.match(ui, /Return To Production/);

assert.match(pm2, /startProjectFromEcosystem/);
assert.match(pm2, /runLocalPm2/);
assert.match(pm2, /require\.resolve\(["']pm2\/bin\/pm2["']\)/);
assert.match(pm2, /PM2 ecosystem file resolves outside the project/);

assert.match(server, /open-editor["'],\s*requireLocalHostAction/);
assert.match(server, /repository["'],\s*requireLocalFilesystemAccess/);
assert.match(server, /pm2\/start-project["'],\s*requireLocalFilesystemAccess/);
assert.match(server, /authenticated remote admin access/);
assert.match(server, /serverConfig\.allowRemoteAdmin && auth\.enabled && req\.auth/);
assert.match(server, /feature-pack\/preview/);
assert.match(server, /feature-pack\/export/);
assert.match(server, /projects\/:id\/tasks/);
assert.match(server, /tasks\/scan/);
assert.match(server, /dockerRuntime: dockerRuntime\.getCurrent\(\)/);

assert.match(ui, /Open \$\{escapeHtml\(project\.editorInfo/);
assert.match(ui, /Repository/);
assert.match(ui, /Export Changes/);
assert.match(ui, /openFeaturePack/);
assert.match(ui, /exportFeaturePack/);
assert.match(ui, /Start In PM2/);
assert.match(ui, /Manual Stop · Suppressed/);
assert.match(ui, /Waiting For Docker/);
assert.match(ui, /Waiting For Containers/);
assert.match(ui, /Admin\/Root Required/);
assert.match(ui, /Docker daemon/);
assert.match(ui, /openProjectActionMenus: new Set\(\)/);
assert.match(ui, /function captureOpenProjectActionMenus\(/);
assert.match(ui, /PROJECT_ACTION_MENUS_KEY = "upm:project-action-menus"/);
assert.match(ui, /function loadOpenProjectActionMenus\(/);
assert.match(ui, /function saveOpenProjectActionMenus\(/);
assert.match(ui, /function updateProjectActionMenuState\(/);
assert.match(ui, /pm2ActionMenuKey\([\s\S]*?"collapsed"/);
assert.match(ui, /pm2ActionMenuKey\(project\.id, pm2ProcessKey\(proc\), "expanded"\)/);
assert.match(ui, /menuOpenAttribute\(openMenus, `project:\$\{project\.id\}`\)/);
assert.match(ui, /loadOpenProjectActionMenus\(\)/);

console.log("Project action / PM2 auto-start surface checks passed.");

assert.match(ui, /on the UPM host/);
assert.match(ui, /<progress class="host-meter"/);
assert.doesNotMatch(ui, /style="--host-meter:/);
