"use strict";

const packageJson = require("../package.json");

const config = JSON.parse(JSON.stringify(packageJson.build || {}));

// Size-focused desktop profile. Electron/Chromium itself remains the dominant
// footprint, so the safe wins are to keep runtime code in ASAR, retain only the
// locale UPM ships, exclude non-runtime dependency material, and emit one
// architecture per download. Native modules that genuinely need unpacking are
// still detected by electron-builder's smart unpacking.
delete config.asarUnpack;
config.asar = { smartUnpack: true };
config.electronLanguages = ["en-US"];
config.compression = "maximum";
config.directories = { ...(config.directories || {}), output: "release-slim" };
config.win = {
  ...(config.win || {}),
  artifactName: "Ultimate-Project-Manager-Windows-Slim-${version}-${arch}.${ext}",
};
config.mac = {
  ...(config.mac || {}),
  artifactName: "Ultimate-Project-Manager-macOS-Slim-${version}-${arch}.${ext}",
};
config.linux = {
  ...(config.linux || {}),
  artifactName: "Ultimate-Project-Manager-Linux-Slim-${version}-${arch}.${ext}",
};

module.exports = config;
