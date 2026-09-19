"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "upmRemoteManager",
  Object.freeze({
    list: () => ipcRenderer.invoke("upm:remote-list"),
    save: (connection) => ipcRenderer.invoke("upm:remote-save", connection),
    remove: (id) => ipcRenderer.invoke("upm:remote-remove", id),
    probe: (connection) => ipcRenderer.invoke("upm:remote-probe", connection),
    connect: (id) => ipcRenderer.invoke("upm:remote-connect", id),
    close: () => ipcRenderer.invoke("upm:remote-manager-close"),
  }),
);
