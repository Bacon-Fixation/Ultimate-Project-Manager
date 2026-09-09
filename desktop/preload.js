"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const desktopApi = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  selectDirectory: (options = {}) => ipcRenderer.invoke("upm:select-directory", options),
  openPath: (targetPath) => ipcRenderer.invoke("upm:open-path", targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke("upm:show-item-in-folder", targetPath),
  openExternal: (url) => ipcRenderer.invoke("upm:open-external", url),
  getDesktopSettings: () => ipcRenderer.invoke("upm:get-desktop-settings"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("upm:set-launch-at-login", Boolean(enabled)),
  setCloseToTray: (enabled) => ipcRenderer.invoke("upm:set-close-to-tray", Boolean(enabled)),
  setNotifications: (enabled) => ipcRenderer.invoke("upm:set-notifications", Boolean(enabled)),
  showNotification: (options = {}) => ipcRenderer.invoke("upm:show-notification", options),
  restartApp: () => ipcRenderer.invoke("upm:restart-app"),
  showWindow: () => ipcRenderer.invoke("upm:show-window"),
  onCommand: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("upm:renderer-command", listener);
    return () => ipcRenderer.removeListener("upm:renderer-command", listener);
  },
});

contextBridge.exposeInMainWorld("upmDesktop", desktopApi);
