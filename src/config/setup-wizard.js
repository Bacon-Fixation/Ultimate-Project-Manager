#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { loadRuntimeConfig } = require("./runtime-config");
const { saveSettings, EDITORS } = require("./settings-service");

function ynText(value) {
  return value ? "Y/n" : "y/N";
}

function parseYesNo(value, fallback) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) return fallback;
  if (["y", "yes", "1", "true", "on"].includes(text)) return true;
  if (["n", "no", "0", "false", "off"].includes(text)) return false;
  return null;
}

async function askYesNo(rl, prompt, fallback = false) {
  while (true) {
    const result = parseYesNo(await rl.question(`${prompt} [${ynText(fallback)}] `), fallback);
    if (result !== null) return result;
    console.log("Please answer yes or no.");
  }
}

async function askText(rl, prompt, fallback = "", validator = null) {
  while (true) {
    const suffix =
      fallback !== "" && fallback !== null && fallback !== undefined ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    const value = answer || String(fallback ?? "");
    try {
      if (validator) validator(value);
      return value;
    } catch (error) {
      console.log(`Invalid value: ${error.message}`);
    }
  }
}

async function askNumber(rl, prompt, fallback, min, max) {
  return Number(
    await askText(rl, prompt, fallback, (value) => {
      const number = Number.parseInt(value, 10);
      if (!Number.isInteger(number) || number < min || number > max)
        throw new Error(`enter a number from ${min} to ${max}`);
    }),
  );
}

async function askChoice(rl, prompt, choices, fallbackIndex = 0) {
  console.log(`\n${prompt}`);
  choices.forEach((choice, index) => console.log(`  ${index + 1}) ${choice.label}`));
  while (true) {
    const answer = (await rl.question(`Choose [${fallbackIndex + 1}]: `)).trim();
    const selected = answer ? Number.parseInt(answer, 10) - 1 : fallbackIndex;
    if (Number.isInteger(selected) && choices[selected]) return choices[selected].value;
    console.log("Choose one of the listed numbers.");
  }
}

async function promptHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    console.log("Warning: password input cannot be hidden in this terminal.");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(`${prompt}: `);
    } finally {
      rl.close();
    }
  }

  stdout.write(`${prompt}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(
            Object.assign(new Error("Setup cancelled."), {
              code: "SETUP_CANCELLED",
            }),
          );
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (char >= " " && char !== "\u007f") {
          value += char;
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function askNewPassword({ existing = false } = {}) {
  if (existing) {
    const replace = await askSimpleYesNo("Replace the existing dashboard password?", false);
    if (!replace) return null;
  }
  while (true) {
    const first = await promptHidden("Dashboard password (minimum 10 characters)");
    if (first.length < 10) {
      console.log("Password must be at least 10 characters.");
      continue;
    }
    const second = await promptHidden("Confirm dashboard password");
    if (first !== second) {
      console.log("Passwords do not match. Try again.");
      continue;
    }
    return first;
  }
}

async function askSimpleYesNo(prompt, fallback) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await askYesNo(rl, prompt, fallback);
  } finally {
    rl.close();
  }
}

async function main() {
  const rootDir = path.resolve(__dirname, "..", "..");
  const dataDir = path.join(rootDir, "data");
  const runtime = await loadRuntimeConfig({ rootDir, dataDir });

  console.log("\nUltimate Project Manager - Interactive Setup");
  console.log("================================================");
  console.log(`Configuration file: ${runtime.envPath}`);
  console.log(
    runtime.envLoaded
      ? "An existing .env was found. Press Enter to keep a current value."
      : "No .env was found. This wizard will create one with safe defaults.",
  );

  if (runtime.envLoaded && !(await askSimpleYesNo("Edit the existing .env?", true))) {
    console.log("No changes made.");
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let input;
  let authNeedsPassword = false;
  try {
    const accessModeDefault = runtime.host === "0.0.0.0" || runtime.host === "::" ? 1 : 0;
    const accessMode = await askChoice(
      rl,
      "How should the dashboard listen?",
      [
        { label: "Local machine only (127.0.0.1)", value: "local" },
        { label: "Local network / all interfaces (0.0.0.0)", value: "lan" },
        { label: "Custom bind address / hostname", value: "custom" },
      ],
      accessModeDefault,
    );

    let host =
      accessMode === "local" ? "127.0.0.1" : accessMode === "lan" ? "0.0.0.0" : runtime.host;
    if (accessMode === "custom")
      host = await askText(rl, "Bind address", runtime.host || "127.0.0.1");
    const port = await askNumber(rl, "Dashboard port", runtime.port || 4310, 1, 65535);

    const remoteByDefault =
      accessMode === "lan" ||
      (accessMode === "custom" && host !== "127.0.0.1" && host !== "localhost");
    const allowRemoteDashboard = remoteByDefault
      ? await askYesNo(
          rl,
          "Allow other computers to open the dashboard?",
          runtime.allowRemoteDashboard || true,
        )
      : false;

    let authEnabled = runtime.authEnabled;
    if (allowRemoteDashboard) {
      authEnabled = await askYesNo(
        rl,
        "Require dashboard authentication? (recommended)",
        runtime.authEnabled || true,
      );
    } else {
      authEnabled = await askYesNo(
        rl,
        "Enable dashboard authentication locally?",
        runtime.authEnabled,
      );
    }

    const authUsername = authEnabled
      ? await askText(rl, "Authentication username", runtime.authUsername || "admin")
      : runtime.authUsername || "admin";
    authNeedsPassword = authEnabled && !runtime.authPasswordHash;

    const allowPrivilegedRemoteAccess = allowRemoteDashboard && authEnabled;
    if (allowRemoteDashboard && !authEnabled) {
      console.log(
        "Remote admin and filesystem access will remain disabled because authentication is off.",
      );
    }
    const allowRemoteAdmin = allowPrivilegedRemoteAccess
      ? await askYesNo(
          rl,
          "Allow authenticated remote backup/PM2/configuration write actions?",
          runtime.allowRemoteAdmin,
        )
      : false;
    const allowRemoteFilesystem = allowPrivilegedRemoteAccess
      ? await askYesNo(
          rl,
          "Allow authenticated remote filesystem/log/diff/File Tools access?",
          runtime.allowRemoteFilesystem,
        )
      : false;

    const backupRoot = await askText(
      rl,
      "Backup root override (blank = data/backups)",
      runtime.backupRoot || "",
    );
    const restoreRoot = await askText(
      rl,
      "Restore root override (blank = data/restores)",
      runtime.restoreRoot || "",
    );

    const editor = await askChoice(
      rl,
      "Default editor",
      EDITORS.map((value) => ({ label: value, value })),
      Math.max(0, EDITORS.indexOf(runtime.editor)),
    );
    const editorCommand =
      editor === "custom"
        ? await askText(rl, "Custom editor executable", runtime.editorCommand || "")
        : runtime.editorCommand || "";

    const authCookieSecure = authEnabled
      ? await askYesNo(
          rl,
          "Will the dashboard be reached over HTTPS? (sets Secure cookie)",
          runtime.authCookieSecure,
        )
      : runtime.authCookieSecure;

    const advanced = await askYesNo(rl, "Configure advanced HTTP/security limits?", false);

    input = {
      host,
      port,
      backupRoot,
      restoreRoot,
      allowRemoteDashboard,
      allowRemoteAdmin,
      allowRemoteFilesystem,
      trustProxy: advanced
        ? await askYesNo(
            rl,
            "Trust reverse-proxy headers from a loopback proxy?",
            runtime.trustProxy,
          )
        : runtime.trustProxy,
      securityHeaders: advanced
        ? await askYesNo(rl, "Enable security headers?", runtime.securityHeaders)
        : runtime.securityHeaders,
      contentSecurityPolicy: advanced
        ? await askYesNo(rl, "Enable Content Security Policy?", runtime.contentSecurityPolicy)
        : runtime.contentSecurityPolicy,
      jsonLimit: advanced
        ? await askText(rl, "JSON request-body limit", runtime.jsonLimit || "2mb")
        : runtime.jsonLimit,
      apiRateLimitWindowMs: advanced
        ? await askNumber(rl, "Rate-limit window (ms)", runtime.apiRateLimitWindowMs, 1000, 3600000)
        : runtime.apiRateLimitWindowMs,
      apiRateLimitMax: advanced
        ? await askNumber(rl, "Read/API requests per window", runtime.apiRateLimitMax, 10, 100000)
        : runtime.apiRateLimitMax,
      writeRateLimitMax: advanced
        ? await askNumber(rl, "Write requests per window", runtime.writeRateLimitMax, 5, 100000)
        : runtime.writeRateLimitMax,
      requestTimeoutMs: advanced
        ? await askNumber(rl, "Request timeout (ms)", runtime.requestTimeoutMs, 5000, 3600000)
        : runtime.requestTimeoutMs,
      headersTimeoutMs: advanced
        ? await askNumber(rl, "Headers timeout (ms)", runtime.headersTimeoutMs, 5000, 3600000)
        : runtime.headersTimeoutMs,
      keepAliveTimeoutMs: advanced
        ? await askNumber(rl, "Keep-alive timeout (ms)", runtime.keepAliveTimeoutMs, 1000, 120000)
        : runtime.keepAliveTimeoutMs,
      authEnabled,
      authUsername,
      authSessionHours: advanced
        ? await askNumber(
            rl,
            "Authentication session length (hours)",
            runtime.authSessionHours,
            1,
            168,
          )
        : runtime.authSessionHours,
      authCookieSecure,
      authMaxAttempts: advanced
        ? await askNumber(rl, "Failed logins before lockout", runtime.authMaxAttempts, 3, 100)
        : runtime.authMaxAttempts,
      authLockoutMinutes: advanced
        ? await askNumber(
            rl,
            "Login lockout duration (minutes)",
            runtime.authLockoutMinutes,
            1,
            1440,
          )
        : runtime.authLockoutMinutes,
      editor,
      editorCommand,
    };
  } finally {
    rl.close();
  }

  const secrets = {};
  if (input.authEnabled) {
    const password = await askNewPassword({
      existing: Boolean(runtime.authPasswordHash),
    });
    if (password) {
      secrets.newAuthPassword = password;
      secrets.confirmAuthPassword = password;
    } else if (authNeedsPassword) {
      throw new Error(
        "Authentication is enabled but no password is configured. Run setup again and provide a password.",
      );
    }
  }

  if (!runtime.sessionSecret) secrets.rotateSessionSecret = true;

  const configureEncryption = await askSimpleYesNo(
    runtime.backupEncryptionKey
      ? "Replace the existing backup encryption key?"
      : "Configure a global backup encryption key now?",
    false,
  );
  if (configureEncryption) {
    const generated = crypto.randomBytes(32).toString("base64url");
    const useGenerated = await askSimpleYesNo(
      "Generate a strong encryption key automatically?",
      true,
    );
    secrets.newBackupEncryptionKey = useGenerated
      ? generated
      : await promptHidden("Backup encryption key (minimum 24 characters)");
    if (useGenerated)
      console.log(
        "A new random backup encryption key will be written to .env. Back up the .env securely.",
      );
  }

  console.log("\nReview");
  console.log("------");
  console.log(`Dashboard: ${input.host}:${input.port}`);
  console.log(`Remote dashboard: ${input.allowRemoteDashboard ? "enabled" : "disabled"}`);
  console.log(`Remote admin: ${input.allowRemoteAdmin ? "enabled" : "disabled"}`);
  console.log(`Remote filesystem: ${input.allowRemoteFilesystem ? "enabled" : "disabled"}`);
  console.log(
    `Authentication: ${input.authEnabled ? `enabled (${input.authUsername})` : "disabled"}`,
  );
  console.log(
    `Secure cookie: ${input.authCookieSecure ? "HTTPS required" : "HTTP/HTTPS compatible"}`,
  );
  console.log(`Editor: ${input.editor}`);
  console.log("Secrets: existing values are preserved unless you explicitly replaced them.");

  if (!(await askSimpleYesNo("Write these settings to .env?", true))) {
    console.log("No changes made.");
    return;
  }

  const result = await saveSettings({
    envPath: runtime.envPath,
    runtimeConfig: runtime,
    input,
    secrets,
  });
  console.log(`\nSaved ${runtime.envPath}`);
  if (result.warnings.length) {
    console.log("\nWarnings:");
    result.warnings.forEach((warning) => console.log(` - ${warning}`));
  }
  console.log("\nRestart Ultimate Project Manager to apply the new runtime settings.");
  console.log("PM2: npm run reload");
  console.log("Direct mode: stop and run npm run serve again");
}

main().catch((error) => {
  if (error.code === "SETUP_CANCELLED") console.error("\nSetup cancelled.");
  else console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
