"use strict";

const path = require("path");
const { atomicWriteJson, readJsonRecoverable } = require("../src/filesystem/atomic-file");

const DEFAULTS = Object.freeze({
  closeToTray: true,
  launchAtLogin: false,
  notifications: true,
});

function sanitizeSettings(value = {}) {
  return {
    closeToTray: value.closeToTray !== false,
    launchAtLogin: value.launchAtLogin === true,
    notifications: value.notifications !== false,
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
    return { ...this.settings };
  }

  async update(patch = {}) {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    await atomicWriteJson(this.filePath, this.settings, {
      backup: true,
      mode: 0o600,
      validator: validSettings,
    });
    return this.get();
  }
}

module.exports = { DesktopSettingsStore, sanitizeSettings, DEFAULTS };
