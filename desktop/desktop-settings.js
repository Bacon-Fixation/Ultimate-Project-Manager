"use strict";

const path = require("path");
const { atomicWriteJson, readJsonRecoverable } = require("../src/filesystem/atomic-file");
const { sanitizeRemoteConnections } = require("./remote-connections");

const DEFAULTS = Object.freeze({
  closeToTray: true,
  launchAtLogin: false,
  notifications: true,
  remoteConnections: [],
});

function sanitizeSettings(value = {}) {
  return {
    closeToTray: value.closeToTray !== false,
    launchAtLogin: value.launchAtLogin === true,
    notifications: value.notifications !== false,
    remoteConnections: sanitizeRemoteConnections(value.remoteConnections),
  };
}

function validSettings(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

class DesktopSettingsStore {
  constructor(userDataDir) {
    this.filePath = path.join(userDataDir, "desktop-settings.json");
    this.settings = { ...DEFAULTS };
  }

  async load() {
    const parsed = await readJsonRecoverable(this.filePath, null, {
      recover: true,
      validator: validSettings,
    });
    this.settings = parsed ? sanitizeSettings(parsed) : { ...DEFAULTS };
    return this.get();
  }

  get() {
    return {
      ...this.settings,
      remoteConnections: this.settings.remoteConnections.map((connection) => ({ ...connection })),
    };
  }

  async update(patch = {}) {
    const nextSettings = sanitizeSettings({ ...this.settings, ...patch });
    await atomicWriteJson(this.filePath, nextSettings, {
      backup: true,
      mode: 0o600,
      validator: validSettings,
    });
    this.settings = nextSettings;
    return this.get();
  }
}

module.exports = { DesktopSettingsStore, sanitizeSettings, DEFAULTS };
