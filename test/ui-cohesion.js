"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles-cohesive.css"), "utf8");
const baseCss = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const responsiveCss = fs.readFileSync(path.join(root, "public", "styles-responsive.css"), "utf8");
const allCss = [baseCss, responsiveCss, css].join("\n");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "Static dashboard IDs must be unique.");

const staticButtons = [...html.matchAll(/<button\b[\s\S]*?>/gi)].map((match) => match[0]);
for (const tag of staticButtons) {
  assert.match(tag, /\btype\s*=/, `Static button is missing an explicit type: ${tag}`);
}

const generatedButtons = [...js.matchAll(/<button\b[^>]*>/gi)].map((match) => match[0]);
for (const tag of generatedButtons) {
  assert.match(tag, /\btype=/, `Generated button template is missing an explicit type: ${tag}`);
}

assert.doesNotMatch(html, /\sstyle="/i, "CSP-safe UI must not use inline style attributes.");
assert.match(html, /class="skip-link"/);
assert.match(html, /name="theme-color"/);
assert.match(html, /id="dashboardNav"/);
assert.ok(
  html.indexOf("/styles-cohesive.css") > html.indexOf("/styles-responsive.css"),
  "Cohesive stylesheet must load after responsive overrides.",
);
for (const controlId of [
  "textSanitizerSearch",
  "textSanitizerStatusFilter",
  "textSanitizerGroupFilter",
  "textSanitizerSort",
  "textSanitizerRuleSearch",
  "textSanitizerCatalogGroup",
]) {
  assert.match(
    html,
    new RegExp(`id="${controlId}"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*id="${controlId}"`),
    `${controlId} needs an accessible label.`,
  );
}

for (const token of [
  "--bh-surface-raised",
  "--bh-surface-inset",
  "--bh-border-subtle",
  "--bh-focus-ring",
  "--bh-control-height",
  "--bh-space-1",
  "--bh-space-8",
]) {
  assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(css, /\.skip-link/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /forced-colors: active/);
assert.match(css, /Guidance is intentionally visually distinct/);
assert.match(css, /\.help-guidance-frame/);
assert.match(css, /\.action-menu-panel/);
assert.match(css, /\.dialog-heading/);
assert.match(css, /\.dependency-table/);
assert.match(css, /layout, toolbar, runtime-mode, and Help spacing hardening/);
assert.match(css, /\.help-dashboard[\s\S]*padding:/);
assert.match(allCss, /\.help-onboarding\s*\{[\s\S]*padding:\s*clamp\(/);
assert.match(css, /\.help-hero,[\s\S]*\.help-quick-card,[\s\S]*\.help-footer-guide/);
assert.match(css, /@media \(max-width: 767\.98px\)/);
assert.match(css, /Section-heading h2 elements historically used ::before/);
assert.match(css, /\.section-heading h2\[data-upm-icon\]\s*\{[\s\S]*?padding-left:\s*0/);
assert.match(css, /\.section-heading h2\[data-upm-icon\]::before\s*\{[\s\S]*?position:\s*static/);
assert.match(
  css,
  /\.section-heading h2\[data-upm-icon\]::before\s*\{[\s\S]*?background-color:\s*transparent/,
);
assert.match(
  css,
  /\.dashboard-section-heading\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/,
);
assert.match(css, /v0\.10\.3 desktop application shell and navigation action bar/);
assert.match(css, /\.dashboard-nav-actions/);
assert.match(css, /body\[data-runtime-mode="desktop"\] \.topbar/);
assert.match(allCss, /\.project-grid\.is-mixed-collapse-state/);
assert.match(
  allCss,
  /\.project-collapse-button\[aria-expanded="false"\] \.project-collapse-chevron/,
);

console.log("UI cohesion checks passed.");
