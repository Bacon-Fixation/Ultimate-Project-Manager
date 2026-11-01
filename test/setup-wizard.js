"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const wizard = fs.readFileSync(path.join(root, "src", "config", "setup-wizard.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const agentExample = fs.readFileSync(path.join(root, ".env.agent.example"), "utf8");

assert.equal(pkg.scripts.setup, "node src/config/setup-wizard.js");
assert.equal(pkg.scripts["config:setup"], undefined);
assert.match(wizard, /Interactive Setup/);
assert.match(wizard, /promptHidden/);
assert.match(wizard, /Local network \/ all interfaces/);
assert.match(wizard, /Require dashboard authentication/);
assert.match(wizard, /Generate a strong encryption key automatically/);
assert.match(wizard, /Configure advanced HTTP\/security limits/);
assert.match(agentExample, /UPM_AGENT_TOKEN=/);
assert.match(agentExample, /UPM_AGENT_ALLOWED_PROJECT_ROOTS=/);
assert.match(agentExample, /UPM_AGENT_TLS_KEY_PATH=/);
assert.match(agentExample, /Never commit tokens or TLS private keys/);

console.log("Interactive setup surface checks passed.");
