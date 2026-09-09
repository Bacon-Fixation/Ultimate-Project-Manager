"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const builderCli = path.join(root, "node_modules", "electron-builder", "cli.js");
const platformAliases = new Map([
  ["win", "win"],
  ["windows", "win"],
  ["linux", "linux"],
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
]);
const archAliases = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
  ["universal", "universal"],
  ["all", "all"],
]);

function valueFor(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function normalizePlatform(value) {
  if (!value) return null;
  const normalized = platformAliases.get(String(value).toLowerCase());
  if (!normalized) throw new Error(`Unsupported platform: ${value}. Use win, linux, or mac.`);
  return normalized;
}

function normalizeArch(value) {
  if (!value) return null;
  const normalized = archAliases.get(String(value).toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported architecture: ${value}. Use x64, arm64, universal, or all.`);
  }
  return normalized;
}

function validateBuildMetadata() {
  const packageJson = require(path.join(root, "package.json"));
  const linux = packageJson.build?.linux || {};

  if (Object.prototype.hasOwnProperty.call(linux, "desktopName")) {
    throw new Error(
      "package.json build.linux.desktopName is invalid for electron-builder 26; move desktopName to the package root.",
    );
  }
  if (linux.syncDesktopName === true && !String(packageJson.desktopName || "").trim()) {
    throw new Error(
      "package.json desktopName is required when build.linux.syncDesktopName is enabled.",
    );
  }
}

function matrix() {
  const rows = [
    ["Windows", "x64", "npm run desktop:build -- --platform win --arch x64"],
    ["Windows", "arm64", "npm run desktop:build -- --platform win --arch arm64"],
    ["Linux", "x64", "npm run desktop:build -- --platform linux --arch x64"],
    ["Linux", "arm64", "npm run desktop:build -- --platform linux --arch arm64"],
    ["macOS", "x64", "npm run desktop:build -- --platform mac --arch x64"],
    ["macOS", "arm64", "npm run desktop:build -- --platform mac --arch arm64"],
    ["macOS", "universal", "npm run desktop:build -- --platform mac --arch universal"],
  ];
  console.log(`UPM Electron build matrix (host: ${os.platform()} ${os.arch()})\n`);
  for (const [platform, arch, command] of rows) {
    console.log(`${platform.padEnd(8)} ${arch.padEnd(9)} ${command}`);
  }
  console.log(
    "\nUse --web for the Windows NSIS web installer and --dir for an unpacked directory build.",
  );
  console.log(
    "Cross-platform release artifacts should be produced on the native CI runners in " +
      ".github/workflows/desktop-multiarch.yml.",
  );
}

function help() {
  console.log(
    [
      "Usage: npm run desktop:build -- [options]",
      "",
      "Options:",
      "  --platform win|linux|mac",
      "  --arch x64|arm64|universal|all",
      "  --web       Build the Windows NSIS web installer (requires UPM_WEB_PACKAGE_URL)",
      "  --dir       Build an unpacked directory instead of installers/packages",
      "  --matrix    Print the supported release matrix",
      "  --help      Show this help",
      "",
      "With no options, electron-builder targets the current host and architecture using the slim profile.",
    ].join("\n"),
  );
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return help();
  if (process.argv.includes("--matrix")) return matrix();

  validateBuildMetadata();

  const platform = normalizePlatform(valueFor("platform"));
  const arch = normalizeArch(valueFor("arch"));
  const web = process.argv.includes("--web");
  const directory = process.argv.includes("--dir");

  if (web && platform && platform !== "win") {
    throw new Error("The NSIS web installer is Windows-only.");
  }
  if (web && directory) throw new Error("--web and --dir cannot be combined.");
  if (arch === "universal" && platform && platform !== "mac") {
    throw new Error("Universal builds are only supported for macOS.");
  }
  if (!fs.existsSync(builderCli)) {
    throw new Error("electron-builder is not installed. Run npm ci before building.");
  }

  const config = web ? "build/electron-builder-web.cjs" : "build/electron-builder-slim.cjs";
  const args = [builderCli, "--config", config];
  const effectivePlatform = web ? "win" : platform;
  if (effectivePlatform === "win") args.push("--win", web ? "nsis-web" : "nsis");
  else if (effectivePlatform === "linux") args.push("--linux", "AppImage", "tar.xz");
  else if (effectivePlatform === "mac") args.push("--mac", "dmg", "zip");

  if (arch === "all") args.push("--x64", "--arm64");
  else if (arch) args.push(`--${arch}`);
  if (directory) args.push("--dir");

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}

try {
  main();
} catch (error) {
  console.error(`Electron build configuration error: ${error.message}`);
  process.exitCode = 1;
}
