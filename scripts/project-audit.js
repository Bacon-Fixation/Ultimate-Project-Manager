"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const html = read("public/index.html");
const appJs = read("public/app.js");
const cssFiles = [
  "public/styles.css",
  "public/styles-responsive.css",
  "public/styles-cohesive.css",
];
const server = read("src/index.js");
const desktop = read("desktop/main.js");
const issues = [];
const warnings = [];

function requireAudit(condition, message) {
  if (!condition) issues.push(message);
}

requireAudit(
  Boolean(pkg.main) && fs.existsSync(path.join(ROOT, pkg.main)),
  `Package main entry does not exist: ${pkg.main || "(missing)"}`,
);

const buildResources = pkg.build?.directories?.buildResources || "build";
const winIcon = pkg.build?.win?.icon;
if (winIcon) {
  requireAudit(
    fs.existsSync(path.join(ROOT, buildResources, winIcon)),
    `Electron Windows icon does not exist under build resources: ${path.join(buildResources, winIcon)}`,
  );
}

for (const match of html.matchAll(/\b(?:href|src)="(\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
  const publicPath = match[1].slice(1);
  if (!/\.(?:css|js|svg|png|ico|webp|jpg|jpeg)$/i.test(publicPath)) continue;
  requireAudit(
    fs.existsSync(path.join(ROOT, "public", publicPath)),
    `Missing referenced public asset: ${match[1]}`,
  );
}

function balancedBraces(text) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let inComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !inComment;
}

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
requireAudit(duplicateIds.length === 0, `Duplicate HTML ids: ${duplicateIds.join(", ")}`);

const htmlButtons = [...html.matchAll(/<button\b[\s\S]*?>/gi)].map((match) => match[0]);
const missingHtmlButtonTypes = htmlButtons.filter((tag) => !/\btype\s*=/.test(tag));
requireAudit(
  missingHtmlButtonTypes.length === 0,
  `${missingHtmlButtonTypes.length} static button(s) are missing an explicit type.`,
);

const generatedButtons = [...appJs.matchAll(/<button\b[^>]*>/gi)].map((match) => match[0]);
const missingGeneratedButtonTypes = generatedButtons.filter((tag) => !/\btype=/.test(tag));
requireAudit(
  missingGeneratedButtonTypes.length === 0,
  `${missingGeneratedButtonTypes.length} generated button template(s) are missing an explicit type.`,
);

requireAudit(!/\sstyle="/i.test(html), "Inline style attributes were found in public/index.html.");
requireAudit(html.includes('class="skip-link"'), "Dashboard is missing the keyboard skip link.");
requireAudit(html.includes('name="theme-color"'), "Dashboard is missing theme-color metadata.");
requireAudit(
  html.indexOf("/styles-cohesive.css") > html.indexOf("/styles-responsive.css"),
  "Cohesive stylesheet must load after responsive overrides.",
);

for (const file of cssFiles) {
  const css = read(file);
  requireAudit(balancedBraces(css), `${file} has unbalanced CSS braces.`);
}

for (const token of [
  "--bh-space-1",
  "--bh-surface-raised",
  "--bh-focus-ring",
  "--bh-control-height",
  "prefers-reduced-motion",
  ".help-guidance-frame",
]) {
  requireAudit(
    read("public/styles-cohesive.css").includes(token),
    `Cohesive UI token/rule is missing: ${token}`,
  );
}

requireAudit(
  /dependency-update["'],\s*requireLocalFilesystemAccess/.test(server),
  "Dependency update route is not protected by requireLocalFilesystemAccess.",
);
requireAudit(
  /backups\/:file["'],\s*requireLocalFilesystemAccess/.test(server),
  "Backup deletion route is not protected by requireLocalFilesystemAccess.",
);
requireAudit(
  desktop.includes("contextIsolation: true"),
  "Electron context isolation is not enabled.",
);
requireAudit(
  desktop.includes("nodeIntegration: false"),
  "Electron renderer Node integration is not disabled.",
);
requireAudit(desktop.includes("sandbox: true"), "Electron renderer sandbox is not enabled.");
requireAudit(
  !pkg.build?.asarUnpack?.includes?.("node_modules/**/*"),
  "Electron build still forces all node_modules outside ASAR.",
);
requireAudit(
  pkg.build?.asar?.smartUnpack === true,
  "Electron build smart ASAR unpacking is not enabled.",
);
requireAudit(
  typeof pkg.desktopName === "string" && pkg.desktopName.endsWith(".desktop"),
  "Electron package metadata desktopName is missing or invalid.",
);
requireAudit(
  !Object.prototype.hasOwnProperty.call(pkg.build?.linux || {}, "desktopName"),
  "Electron build.linux contains desktopName; electron-builder v26 requires desktopName at package root.",
);
requireAudit(
  pkg.build?.linux?.syncDesktopName === true,
  "Electron Linux syncDesktopName is not enabled.",
);

requireAudit(
  !Object.prototype.hasOwnProperty.call(pkg.bin || {}, "node-backup-manager"),
  "Legacy node-backup-manager CLI alias is still present.",
);
requireAudit(
  !fs.readdirSync(ROOT).some((name) => name.toLowerCase().endsWith(".bat")),
  "Legacy root .bat launchers are still present.",
);
requireAudit(
  fs.existsSync(path.join(ROOT, ".env.agent.example")),
  "LAN Agent configuration template is missing.",
);
requireAudit(
  fs.existsSync(path.join(ROOT, "scripts", "electron-build.js")),
  "Cross-platform Electron build helper is missing.",
);
requireAudit(
  fs.existsSync(path.join(ROOT, "scripts", "run-tests.js")),
  "Automatic test runner is missing.",
);
const electronBuildHelper = read("scripts/electron-build.js");
requireAudit(
  electronBuildHelper.includes("Linux AppImage cannot be built directly") &&
    electronBuildHelper.includes("electronuserland/builder:24") &&
    electronBuildHelper.includes("UPM_ELECTRON_DOCKER_IMAGE"),
  "Electron build helper is missing Linux host/Docker cross-build safeguards.",
);
requireAudit(
  server.includes("maxBuckets = 5000") && server.includes("server.maxRequestsPerSocket = 1000"),
  "Main HTTP rate-limit/server resource bounds are missing.",
);
const agentServer = read("src/remote-agent/server.js");
const agentEntry = read("src/remote-agent/index.js");
requireAudit(
  agentServer.includes("createRequestLimiter") && agentServer.includes("Content-Security-Policy"),
  "LAN Agent request-rate/security-header hardening is missing.",
);
requireAudit(
  agentEntry.includes('minVersion: "TLSv1.2"') &&
    agentEntry.includes("server.headersTimeout = 10_000"),
  "LAN Agent TLS/server timeout hardening is missing.",
);

const readme = read("README.md");
requireAudit(
  readme.includes(`# Ultimate Project Manager v${pkg.version}`),
  "README version does not match package.json.",
);

if (!fs.existsSync(path.join(ROOT, "package-lock.json"))) {
  warnings.push(
    "package-lock.json is absent; run npm install once in a networked environment to regenerate it.",
  );
}

if (issues.length) {
  console.error("Project audit failed:");
  for (const issue of issues) console.error(` - ${issue}`);
  process.exitCode = 1;
} else {
  console.log(
    `Project audit passed (${ids.length} HTML ids, ${htmlButtons.length} static buttons, ${generatedButtons.length} generated button templates).`,
  );
}
for (const warning of warnings) console.warn(`Audit warning: ${warning}`);
