#!/usr/bin/env node
"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { DEFAULTS } = require("./runtime-config");
const { validateAndMapSettings, renderCanonicalEnv } = require("./settings-service");
const { generateSessionSecret } = require("../security/session-secret");

async function main() {
  const rootDir = path.resolve(__dirname, "..", "..");
  const target = path.join(rootDir, ".env");

  try {
    await fsp.access(target);
    console.log(`.env already exists: ${target}`);
    return;
  } catch {}

  const { envUpdates } = validateAndMapSettings({}, DEFAULTS);
  envUpdates.UPM_AUTH_PASSWORD_HASH = "";
  envUpdates.UPM_SESSION_SECRET = generateSessionSecret();
  envUpdates.UPM_BACKUP_ENCRYPTION_KEY = "";

  await fsp.writeFile(target, renderCanonicalEnv(envUpdates), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Created ${target} with safe local-only defaults.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
