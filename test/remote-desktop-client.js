"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

(() => {
  const root = path.resolve(__dirname, "..");
  const mainSource = fs.readFileSync(path.join(root, "desktop", "main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(root, "desktop", "preload.js"), "utf8");
  const remotePreloadSource = fs.readFileSync(
    path.join(root, "desktop", "remote-connect-preload.js"),
    "utf8",
  );
  const indexSource = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

  const remoteStart = mainSource.indexOf("async function openRemoteConnection(id)");
  const remoteEnd = mainSource.indexOf("async function openRemoteConnectionManager()", remoteStart);
  assert(
    remoteStart >= 0 && remoteEnd > remoteStart,
    "Remote window implementation was not found.",
  );
  const remoteWindowSource = mainSource.slice(remoteStart, remoteEnd);

  assert.match(remoteWindowSource, /contextIsolation: true/);
  assert.match(remoteWindowSource, /nodeIntegration: false/);
  assert.match(remoteWindowSource, /sandbox: true/);
  assert.match(remoteWindowSource, /webSecurity: true/);
  assert.match(remoteWindowSource, /partition: remoteSessionPartition\(connection\)/);
  assert.doesNotMatch(remoteWindowSource, /preload:/);
  assert.match(remoteWindowSource, /sameRemoteOrigin\(connection, url\)/);
  assert.match(remoteWindowSource, /will-redirect/);
  assert.match(mainSource, /preload: path\.join\(__dirname, "remote-connect-preload\.js"\)/);
  assert.match(mainSource, /partition: LOCAL_DASHBOARD_PARTITION/);
  assert.match(mainSource, /partition: REMOTE_MANAGER_PARTITION/);
  assert.match(mainSource, /mainWindow\.webContents\.on\("will-redirect", guardMainNavigation\)/);
  assert.match(mainSource, /clearRemoteSession\(connection\)/);
  assert.match(mainSource, /label: "Remote UPM"/);
  assert.match(preloadSource, /openRemoteConnections/);
  assert.match(indexSource, /id="openRemoteUpmBtn"/);

  assert.match(remotePreloadSource, /upm:remote-list/);
  assert.match(remotePreloadSource, /upm:remote-save/);
  assert.match(remotePreloadSource, /upm:remote-probe/);
  assert.match(remotePreloadSource, /upm:remote-connect/);
  assert.doesNotMatch(remotePreloadSource, /upm:select-directory/);
  assert.doesNotMatch(remotePreloadSource, /upm:restart-elevated/);
  assert.doesNotMatch(remotePreloadSource, /upm:open-path/);

  console.log("remote-desktop-client tests passed");
})();
