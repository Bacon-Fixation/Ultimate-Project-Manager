"use strict";

const packageJson = require("../package.json");

const packageUrl = String(process.env.UPM_WEB_PACKAGE_URL || "").trim();
if (!packageUrl) {
  throw new Error(
    "UPM_WEB_PACKAGE_URL is required for the web installer, for example: https://downloads.example.com/upm/latest",
  );
}

const config = JSON.parse(JSON.stringify(packageJson.build || {}));
config.electronLanguages = ["en-US"];
config.directories = { ...(config.directories || {}), output: "release-web" };
config.win = { ...(config.win || {}), target: ["nsis-web"] };
config.nsisWeb = {
  ...(config.nsis || {}),
  appPackageUrl: packageUrl,
  artifactName: "Ultimate-Project-Manager-Web-Setup-${version}.${ext}",
};

module.exports = config;
