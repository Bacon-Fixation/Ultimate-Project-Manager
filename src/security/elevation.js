"use strict";

const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 5000;
const CACHE_MS = 5000;

function windowsPowerShell(env = process.env) {
  return env.SystemRoot
    ? path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function unixElevated() {
  return typeof process.getuid === "function" ? process.getuid() === 0 : false;
}

async function checkProcessElevation(options = {}) {
  const platform = options.platform || process.platform;
  const runner = options.execFileAsync || execFileAsync;
  if (platform !== "win32") {
    const elevated = options.getuid ? options.getuid() === 0 : unixElevated();
    return {
      platform,
      elevated,
      level: elevated ? "root" : "standard",
      mechanism: "uid",
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const { stdout } = await runner(
      windowsPowerShell(options.env || process.env),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id);if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'elevated'}else{'standard'}",
      ],
      {
        windowsHide: true,
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: options.env || process.env,
      },
    );
    const elevated = String(stdout || "").trim().toLowerCase() === "elevated";
    return {
      platform,
      elevated,
      level: elevated ? "administrator" : "standard",
      mechanism: "windows-token",
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      platform,
      elevated: false,
      level: "unknown",
      mechanism: "windows-token",
      checkedAt: new Date().toISOString(),
      error: String(error?.message || error),
    };
  }
}

function createElevationChecker(options = {}) {
  let cached = null;
  let checkedAtMs = 0;
  return async function elevationChecker(force = false) {
    const now = Date.now();
    if (!force && cached && now - checkedAtMs < (options.cacheMs || CACHE_MS)) return { ...cached };
    cached = await checkProcessElevation(options);
    checkedAtMs = now;
    return { ...cached };
  };
}

function elevatedRelaunchSupport(options = {}) {
  const platform = options.platform || process.platform;
  const packaged = options.packaged === true;
  if (!packaged) {
    return {
      supported: false,
      reason: "Elevation relaunch is available only in a packaged desktop build.",
    };
  }
  if (platform === "win32") return { supported: true, label: "Restart As Administrator" };
  if (platform === "darwin")
    return { supported: true, label: "Restart With Administrator Privileges" };
  if (platform === "linux") {
    return {
      supported: false,
      reason:
        "UPM does not relaunch the Electron desktop as root on Linux because doing so would conflict with Chromium sandboxing. Run UPM server/CLI mode as root only when a project explicitly requires it.",
    };
  }
  return { supported: false, reason: "Elevation relaunch is not supported on this platform." };
}

function waitForLauncher(child, failureMessage) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(failureMessage));
    });
  });
}

async function relaunchElevated(options = {}) {
  const platform = options.platform || process.platform;
  const executable = String(options.executable || process.execPath).trim();
  const packaged = options.packaged === true;
  const support = elevatedRelaunchSupport({ platform, packaged });
  if (!support.supported) throw new Error(support.reason);
  if (!path.isAbsolute(executable)) throw new Error("UPM executable path is invalid for elevation.");

  if (platform === "win32") {
    const env = { ...process.env, ...(options.env || {}), UPM_ELEVATE_EXE: executable };
    const child = (options.spawn || spawn)(
      windowsPowerShell(env),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:UPM_ELEVATE_EXE -ArgumentList '--upm-elevated-relaunch' -Verb RunAs",
      ],
      { stdio: "ignore", windowsHide: true, env },
    );
    await waitForLauncher(child, "Windows elevation request failed or was cancelled.");
    return { launched: true, platform, mechanism: "uac-runas" };
  }

  const script = [
    "on run argv",
    "set executablePath to item 1 of argv",
    'do shell script (quoted form of executablePath & " --upm-elevated-relaunch >/dev/null 2>&1 &") with administrator privileges',
    "end run",
  ].join("\n");
  const child = (options.spawn || spawn)("osascript", ["-e", script, "--", executable], {
    stdio: "ignore",
  });
  await waitForLauncher(child, "macOS administrator authorization failed or was cancelled.");
  return { launched: true, platform, mechanism: "macos-admin-authorization" };
}

module.exports = {
  checkProcessElevation,
  createElevationChecker,
  elevatedRelaunchSupport,
  relaunchElevated,
  windowsPowerShell,
};
