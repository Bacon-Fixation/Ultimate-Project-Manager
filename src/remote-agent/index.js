"use strict";

const fs = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const { loadEnvFile, parseInteger } = require("../config/runtime-config");
const { createRemoteAgentApp } = require("./server");

function list(value) {
  return String(value || "")
    .split(/[;,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const rootDir = path.resolve(__dirname, "..", "..");
  await loadEnvFile(path.join(rootDir, ".env.agent"), process.env);
  const host = String(process.env.UPM_AGENT_HOST || "0.0.0.0");
  const port = parseInteger(process.env.UPM_AGENT_PORT, 4311, {
    min: 1,
    max: 65535,
  });
  const token = String(process.env.UPM_AGENT_TOKEN || "");
  const dataDir = path.resolve(
    process.env.UPM_AGENT_DATA_DIR || path.join(rootDir, "data", "lan-agent"),
  );
  const app = createRemoteAgentApp({
    token,
    agentId: process.env.UPM_AGENT_ID,
    agentName: process.env.UPM_AGENT_NAME,
    dataDir,
    backupRoot: process.env.UPM_AGENT_BACKUP_ROOT || path.join(dataDir, "backups"),
    restoreRoot: process.env.UPM_AGENT_RESTORE_ROOT || path.join(dataDir, "restores"),
    allowedProjectRoots: list(process.env.UPM_AGENT_ALLOWED_PROJECT_ROOTS),
    allowedBackupRoots: list(process.env.UPM_AGENT_ALLOWED_BACKUP_ROOTS),
    allowedRestoreRoots: list(process.env.UPM_AGENT_ALLOWED_RESTORE_ROOTS),
    allowedControllers: list(process.env.UPM_AGENT_ALLOWED_CONTROLLER_IPS),
    encryptionKey:
      process.env.UPM_AGENT_BACKUP_ENCRYPTION_KEY || process.env.UPM_BACKUP_ENCRYPTION_KEY || "",
  });
  await app.locals.start();

  const tlsKeyPath = String(process.env.UPM_AGENT_TLS_KEY_PATH || "").trim();
  const tlsCertPath = String(process.env.UPM_AGENT_TLS_CERT_PATH || "").trim();
  if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
    throw new Error(
      "UPM_AGENT_TLS_KEY_PATH and UPM_AGENT_TLS_CERT_PATH must both be configured to enable HTTPS.",
    );
  }

  let server;
  let protocol = "http";
  if (tlsKeyPath && tlsCertPath) {
    const [key, cert] = await Promise.all([
      fs.readFile(path.resolve(tlsKeyPath)),
      fs.readFile(path.resolve(tlsCertPath)),
    ]);
    server = https.createServer({ key, cert, minVersion: "TLSv1.2" }, app);
    protocol = "https";
  } else {
    server = http.createServer(app);
  }

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;

  server.listen(port, host, () => {
    console.log(`Ultimate Project Manager LAN Agent: ${protocol}://${host}:${port}`);
    console.log(`Agent ID: ${process.env.UPM_AGENT_ID || require("os").hostname()}`);
    if (protocol === "http" && host !== "127.0.0.1" && host !== "localhost")
      console.warn(
        "WARNING: LAN agent is using plain HTTP. Configure TLS or explicitly enable UPM_LAN_ALLOW_INSECURE_HTTP on the controller for a trusted LAN.",
      );
  });
  const stop = async () => {
    await app.locals.shutdown().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  if (/TOKEN/.test(error.message || ""))
    console.error(
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  process.exitCode = 1;
});
