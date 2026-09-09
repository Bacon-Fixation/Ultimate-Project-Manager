"use strict";

const { currentSettings, publicLanAgents } = require("./settings-service");

const SETUP_FORMAT = "ultimate-project-manager-setup";
const SETUP_SCHEMA_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSetupDocument({ runtimeConfig, projects = [], appVersion = "unknown" } = {}) {
  if (!runtimeConfig) throw new Error("runtimeConfig is required to export a setup.");
  return {
    format: SETUP_FORMAT,
    schemaVersion: SETUP_SCHEMA_VERSION,
    product: "Ultimate Project Manager",
    appVersion: String(appVersion || "unknown"),
    exportedAt: new Date().toISOString(),
    secretsIncluded: false,
    runtimeSettings: currentSettings(runtimeConfig),
    secretRequirements: {
      authPasswordConfigured: Boolean(runtimeConfig.authPasswordHash),
      sessionSecretConfigured: Boolean(runtimeConfig.sessionSecret),
      backupEncryptionKeyConfigured: Boolean(runtimeConfig.backupEncryptionKey),
      lanAgentCount: Array.isArray(runtimeConfig.lanAgents) ? runtimeConfig.lanAgents.length : 0,
    },
    lanAgents: publicLanAgents(runtimeConfig.lanAgents),
    projects: clone(Array.isArray(projects) ? projects : []),
    notes: [
      "Authentication password hashes, session secrets, backup encryption keys, and LAN agent tokens are intentionally excluded.",
      "Existing destination secrets are preserved during import. Missing secrets must be configured separately.",
      "Project and backup paths are exported as configured and may need adjustment on another computer.",
    ],
  };
}

function validateSetupDocument(payload) {
  const setup = payload?.setup && typeof payload.setup === "object" ? payload.setup : payload;
  if (!setup || typeof setup !== "object" || Array.isArray(setup))
    throw new Error("Setup import must contain a JSON object.");
  if (setup.format !== SETUP_FORMAT)
    throw new Error("This file is not an Ultimate Project Manager setup export.");
  const schemaVersion = Number(setup.schemaVersion || 0);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SETUP_SCHEMA_VERSION)
    throw new Error(`Unsupported setup schema version: ${setup.schemaVersion || "missing"}.`);
  if (
    setup.runtimeSettings !== undefined &&
    (typeof setup.runtimeSettings !== "object" || Array.isArray(setup.runtimeSettings))
  )
    throw new Error("Imported runtimeSettings must be an object.");
  if (!Array.isArray(setup.projects)) throw new Error("Imported setup projects must be an array.");
  if (setup.projects.length > 1000) throw new Error("Imported setup contains too many projects.");
  return setup;
}

function prepareRuntimeSettingsImport(setup, runtimeConfig) {
  const settings = { ...(setup.runtimeSettings || {}) };
  const warnings = [];

  if (settings.authEnabled === true && !runtimeConfig.authPasswordHash) {
    settings.authEnabled = false;
    warnings.push(
      "Authentication was enabled in the exported setup, but no destination password hash exists. Authentication remains disabled until a password is configured.",
    );
  }
  if (
    setup.secretRequirements?.backupEncryptionKeyConfigured &&
    !runtimeConfig.backupEncryptionKey
  ) {
    warnings.push(
      "The exported setup used a backup encryption key. The key was not exported; configure UPM_BACKUP_ENCRYPTION_KEY before creating or restoring encrypted backups.",
    );
  }
  if (Number(setup.secretRequirements?.lanAgentCount || 0) > 0) {
    warnings.push(
      "LAN agent tokens are not exported. Existing LAN agent secrets were preserved; configure any missing agents/tokens separately.",
    );
  }
  if (setup.secretRequirements?.authPasswordConfigured && !runtimeConfig.authPasswordHash) {
    warnings.push(
      "The exported dashboard password was not included and must be configured separately.",
    );
  }

  return { settings, warnings };
}

module.exports = {
  SETUP_FORMAT,
  SETUP_SCHEMA_VERSION,
  createSetupDocument,
  validateSetupDocument,
  prepareRuntimeSettingsImport,
};
