"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const desktop = fs.readFileSync(path.join(root, "desktop", "main.js"), "utf8");

const repositoryUrl = "https://github.com/Bacon-Fixation/Ultimate-Project-Manager";
const kofiUrl = "https://ko-fi.com/baconfixation";

assert.equal(pkg.repository?.url, `git+${repositoryUrl}.git`);
assert.equal(pkg.bugs?.url, `${repositoryUrl}/issues`);
assert.equal(pkg.homepage, `${repositoryUrl}#readme`);
assert.equal(pkg.funding, kofiUrl);

assert.match(html, /id="projectAddBtn"/);
assert.ok(
  html.indexOf('id="projectAddBtn"') > html.indexOf('id="refreshBtn"'),
  "Projects Add Project action should follow Refresh.",
);
assert.match(html, new RegExp(repositoryUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(html, new RegExp(kofiUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(desktop, /async function showAboutDialog\(/);
assert.match(desktop, /label: `About \$\{PRODUCT_NAME\}`/);
assert.match(desktop, /label: "Support On Ko-fi"/);

for (const relative of [
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/ISSUE_TEMPLATE/documentation.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "CONTRIBUTING.md",
  "SUPPORT.md",
  "SECURITY.md",
  "docs/wiki/Home.md",
  "docs/wiki/Getting-Started.md",
  "docs/wiki/Installation-and-Updates.md",
  "docs/wiki/Desktop-App-and-Browser-Dashboard.md",
  "docs/wiki/Projects-and-Backups.md",
  "docs/wiki/Backup-Recovery.md",
  "docs/wiki/PM2-Docker-and-Service-Health.md",
  "docs/wiki/File-Tools-and-Text-Sanitizer.md",
  "docs/wiki/Configuration-and-Security.md",
  "docs/wiki/LAN-Remote-Agent.md",
  "docs/wiki/Troubleshooting.md",
  "docs/wiki/FAQ.md",
  "docs/wiki/_Sidebar.md",
]) {
  assert.ok(
    fs.existsSync(path.join(root, relative)),
    `Missing community documentation: ${relative}`,
  );
}

console.log("Repository/community surface tests passed.");
