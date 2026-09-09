"use strict";

const express = require("express");
const path = require("path");
const os = require("os");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { Readable } = require("stream");
const { BackupManager } = require("./manager/backup-manager");
const { LocalDirectoryBrowser } = require("./filesystem/local-directory-browser");
const { FileToolsService } = require("./file-tools/file-tools-service");
const { TextSanitizerService } = require("./file-tools/text-sanitizer-service");
const packageJson = require("../package.json");
const { loadRuntimeConfig, parseBoolean } = require("./config/runtime-config");
const {
  publicSettings,
  saveSettings,
  ensureLaunchableSessionSecret,
} = require("./config/settings-service");
const { markLastKnownGoodEnv, recoverLastKnownGoodEnv } = require("./config/settings-recovery");
const {
  createSetupDocument,
  validateSetupDocument,
  prepareRuntimeSettingsImport,
} = require("./config/setup-transfer");
const { AuthService } = require("./security/auth-service");
const { trustedDesktopRequest } = require("./security/desktop-trust");
const { HostStatsMonitor } = require("./system/host-stats-monitor");
const { DockerRuntimeMonitor } = require("./system/docker-runtime-monitor");

const PRODUCT_NAME = "Ultimate Project Manager";

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function normalizeNetworkAddress(address) {
  let value = String(address || "")
    .trim()
    .toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value.startsWith("::ffff:")) value = value.slice(7);
  return value;
}

function isLoopbackAddress(address) {
  const value = normalizeNetworkAddress(address);
  return value === "::1" || value.startsWith("127.");
}

function localMachineAddresses() {
  const addresses = new Set(["127.0.0.1", "::1"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const address = normalizeNetworkAddress(entry?.address);
      if (address) addresses.add(address);
    }
  }
  return addresses;
}

function isLocalMachineAddress(address) {
  const value = normalizeNetworkAddress(address);
  if (!value || isLoopbackAddress(value)) return Boolean(value);
  return localMachineAddresses().has(value);
}

function isPotentiallyTrustworthyRequest(req) {
  if (req.secure) return true;
  const hostname = normalizeNetworkAddress(req.hostname || "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || isLoopbackAddress(hostname);
}

function requestAddress(req) {
  return req.ip || req.socket?.remoteAddress || "";
}

function firstForwardedHeaderValue(value) {
  return String(value || "")
    .split(",", 1)[0]
    .trim();
}

function requestAuthorities(req, trustProxy = false) {
  const authorities = new Set();
  const directHost = String(req.get("host") || "")
    .trim()
    .toLowerCase();
  if (directHost) authorities.add(directHost);
  const trustedProxyConnection = trustProxy && isLoopbackAddress(req.socket?.remoteAddress || "");
  if (trustedProxyConnection) {
    const forwardedHost = firstForwardedHeaderValue(req.get("x-forwarded-host")).toLowerCase();
    if (forwardedHost) authorities.add(forwardedHost);
  }
  return authorities;
}

function requestOriginAllowed(req, config) {
  const origin = req.get("origin");
  if (!origin) return true;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const authorities = requestAuthorities(req, config.trustProxy === true);
  if (!authorities.has(originUrl.host.toLowerCase())) return false;
  const requestProtocol = String(req.protocol || (req.secure ? "https" : "http")).toLowerCase();
  return originUrl.protocol.toLowerCase() === `${requestProtocol}:`;
}

function isRemoteRequest(req) {
  return !isLocalMachineAddress(requestAddress(req));
}

function redactFilesystemText(value) {
  return String(value ?? "")
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n\t"'<>|]+\\)*[^\r\n\t"'<>|]*/g, "[redacted path]")
    .replace(/(^|[\s"'(])\/(?:[^\s"'<>]+\/?)+/g, "$1[redacted path]");
}

function isFilesystemKey(key) {
  const name = String(key || "");
  if (
    [
      "projectRoot",
      "backupRoot",
      "restoreRoot",
      "backupDir",
      "backupDirResolved",
      "backupDirSecondary",
      "backupDirSecondaryResolved",
      "deltaJournalDir",
      "cwd",
      "script",
      "outLogPath",
      "errLogPath",
      "errorPath",
      "archivePath",
      "workspacePath",
      "sourcePath",
      "destinationPath",
      "filePath",
      "envPath",
      "configFile",
    ].includes(name)
  )
    return true;
  return /(?:path|dir|root)$/i.test(name) && !["repositoryUrl"].includes(name);
}

function sanitizeRemotePayload(value, key = "") {
  if (value === null || value === undefined) return value;
  if (isFilesystemKey(key)) return "[redacted]";
  if (typeof value === "string") return redactFilesystemText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRemotePayload(item));
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeRemotePayload(childValue, childKey),
    ]),
  );
}

function validateRemoteSecurityConfig(config) {
  if ((config.allowRemoteAdmin || config.allowRemoteFilesystem) && !config.authEnabled) {
    throw new Error(
      "Authentication must be enabled when remote admin or remote filesystem access is enabled.",
    );
  }
}

function createRateLimiter({ windowMs, max, keyPrefix = "api", maxBuckets = 5000 }) {
  const buckets = new Map();
  const bucketLimit = Math.max(100, Number(maxBuckets) || 5000);

  function prune(now) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
    while (buckets.size >= bucketLimit) buckets.delete(buckets.keys().next().value);
  }

  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${requestAddress(req)}`;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && buckets.size >= bucketLimit) prune(now);
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count <= max) return next();
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests. Try again shortly." });
  };
}

function applySecurityHeaders(req, res, next, config) {
  if (!config.securityHeaders) return next();
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  if (isPotentiallyTrustworthyRequest(req))
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (config.contentSecurityPolicy) {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: https://avatars.githubusercontent.com",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }
  return next();
}

async function createApp(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, "data"));
  const serverConfig =
    options.runtimeConfig ||
    (await loadRuntimeConfig({
      rootDir,
      dataDir,
      env: options.env || process.env,
    }));
  validateRemoteSecurityConfig(serverConfig);
  const desktopAccessToken = String(options.desktopAccessToken || "");
  const dockerRuntime =
    options.dockerRuntimeMonitor ||
    new DockerRuntimeMonitor({ refreshMs: options.dockerRefreshMs });
  await dockerRuntime.start();
  const envManagedKeys = new Set([
    ...(serverConfig.envFileKeys || []),
    ...(serverConfig.processEnvironmentKeys || []),
  ]);
  const configuredBackupRoot =
    options.backupRoot ||
    (envManagedKeys.has("UPM_BACKUP_ROOT")
      ? serverConfig.backupRoot || path.join(dataDir, "backups")
      : null);
  const configuredRestoreRoot =
    options.restoreRoot ||
    (envManagedKeys.has("UPM_RESTORE_ROOT")
      ? serverConfig.restoreRoot || path.join(dataDir, "restores")
      : null);
  const manager = new BackupManager({
    dataDir,
    backupRoot: configuredBackupRoot || undefined,
    restoreRoot: configuredRestoreRoot || undefined,
    backupEncryptionKey: serverConfig.backupEncryptionKey,
    defaultEditor: serverConfig.editor,
    customEditorCommand: serverConfig.editorCommand,
    remoteAgents: serverConfig.lanAgents,
    remoteAgentAllowInsecureHttp: serverConfig.lanAllowInsecureHttp,
    dockerRuntimeMonitor: dockerRuntime,
  });
  await manager.init();
  const fileTools = await new FileToolsService({ manager, dataDir }).init();
  const textSanitizer = new TextSanitizerService({
    manager,
    dataDir,
    outputRoot: fileTools.outputRoot,
  });
  const hostStats = await new HostStatsMonitor({ dataDir }).init();
  const directoryBrowser = new LocalDirectoryBrowser({
    rootDir,
    backupRoot: manager.backupRoot,
    restoreRoot: manager.restoreRoot,
  });

  let auth = new AuthService({
    enabled: serverConfig.authEnabled,
    username: serverConfig.authUsername,
    passwordHash: serverConfig.authPasswordHash,
    sessionSecret: serverConfig.sessionSecret,
    sessionHours: serverConfig.authSessionHours,
    cookieSecure: serverConfig.authCookieSecure,
    maxAttempts: serverConfig.authMaxAttempts,
    lockoutMinutes: serverConfig.authLockoutMinutes,
  });

  const app = express();

  async function applyLiveRuntimeSettings(result) {
    const requested = new Set(Array.isArray(result?.liveApplyFields) ? result.liveApplyFields : []);
    if (!requested.size) return [];

    const effective = await loadRuntimeConfig({
      rootDir,
      dataDir,
      envPath: serverConfig.envPath || path.join(rootDir, ".env"),
      env: { ...process.env },
    });
    const applied = [];
    const applyConfigField = (field) => {
      serverConfig[field] = effective[field];
      applied.push(field);
    };

    for (const field of [
      "allowRemoteDashboard",
      "allowRemoteAdmin",
      "allowRemoteFilesystem",
      "securityHeaders",
      "contentSecurityPolicy",
    ]) {
      if (requested.has(field)) applyConfigField(field);
    }

    if (requested.has("trustProxy")) {
      applyConfigField("trustProxy");
      app.set("trust proxy", effective.trustProxy ? "loopback" : false);
    }

    const authFields = [
      "authEnabled",
      "authUsername",
      "authSessionHours",
      "authCookieSecure",
      "authMaxAttempts",
      "authLockoutMinutes",
      "authPassword",
      "sessionSecret",
    ];
    if (authFields.some((field) => requested.has(field))) {
      const replacement = new AuthService({
        enabled: effective.authEnabled,
        username: effective.authUsername,
        passwordHash: effective.authPasswordHash,
        sessionSecret: effective.sessionSecret,
        sessionHours: effective.authSessionHours,
        cookieSecure: effective.authCookieSecure,
        maxAttempts: effective.authMaxAttempts,
        lockoutMinutes: effective.authLockoutMinutes,
      });
      auth = replacement;
      app.locals.auth = auth;
      for (const field of authFields) {
        if (!requested.has(field)) continue;
        if (field === "authPassword") serverConfig.authPasswordHash = effective.authPasswordHash;
        else serverConfig[field] = effective[field];
        applied.push(field);
      }
    }

    if (requested.has("backupEncryptionKey")) {
      serverConfig.backupEncryptionKey = effective.backupEncryptionKey;
      manager.backupEncryptionKey = String(effective.backupEncryptionKey || "");
      applied.push("backupEncryptionKey");
    }

    if (requested.has("editor") || requested.has("editorCommand")) {
      serverConfig.editor = effective.editor;
      serverConfig.editorCommand = effective.editorCommand;
      manager.projectLauncher.defaultEditor = effective.editor;
      manager.projectLauncher.customEditorCommand = String(effective.editorCommand || "").trim();
      if (requested.has("editor")) applied.push("editor");
      if (requested.has("editorCommand")) applied.push("editorCommand");
    }

    if (requested.has("lanAgents") || requested.has("lanAllowInsecureHttp")) {
      manager.remoteAgentClient.configure({
        agents: effective.lanAgents,
        allowInsecureHttp: effective.lanAllowInsecureHttp === true,
      });
      serverConfig.lanAgents = effective.lanAgents;
      serverConfig.lanAllowInsecureHttp = effective.lanAllowInsecureHttp === true;
      await manager.remoteAgentMonitor.refresh().catch(() => {});
      if (requested.has("lanAgents")) applied.push("lanAgents");
      if (requested.has("lanAllowInsecureHttp")) applied.push("lanAllowInsecureHttp");
    }

    return [...new Set(applied)];
  }
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("trust proxy", serverConfig.trustProxy ? "loopback" : false);
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    req.isDesktopTrusted =
      isLocalMachineAddress(requestAddress(req)) && trustedDesktopRequest(req, desktopAccessToken);
    res.setHeader("X-Request-ID", req.requestId);
    if (req.isDesktopTrusted) res.setHeader("X-UPM-Desktop", "trusted");
    return applySecurityHeaders(req, res, next, serverConfig);
  });
  app.use((req, res, next) => {
    if (isLocalMachineAddress(requestAddress(req)) || serverConfig.allowRemoteDashboard)
      return next();
    if (req.path.startsWith("/api/"))
      return res.status(403).json({
        error:
          "Remote dashboard access is disabled. Set UPM_ALLOW_REMOTE_DASHBOARD=true to opt in.",
      });
    return res
      .status(403)
      .type("text/plain")
      .send("Ultimate Project Manager remote dashboard access is disabled.");
  });
  app.use(express.json({ limit: serverConfig.jsonLimit }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
    if (fetchSite === "cross-site")
      return res.status(403).json({ error: "Cross-site API requests are not allowed." });
    const origin = req.get("origin");
    if (origin && !requestOriginAllowed(req, serverConfig))
      return res.status(403).json({ error: "Cross-origin API requests are not allowed." });
    return next();
  });
  const apiRateLimiter = createRateLimiter({
    windowMs: serverConfig.apiRateLimitWindowMs,
    max: serverConfig.apiRateLimitMax,
    keyPrefix: "api",
  });
  const writeRateLimiter = createRateLimiter({
    windowMs: serverConfig.apiRateLimitWindowMs,
    max: serverConfig.writeRateLimitMax,
    keyPrefix: "write",
  });
  app.use("/api", apiRateLimiter);

  app.get("/api/auth/status", (req, res) => {
    const session = req.isDesktopTrusted
      ? { username: "Desktop App", desktop: true }
      : auth.sessionFromRequest(req);
    res.json({
      auth: auth.getStatus(session, { requestSecure: req.secure }),
      desktop: req.isDesktopTrusted,
    });
  });

  app.post(
    "/api/auth/login",
    asyncRoute(async (req, res) => {
      if (auth.enabled) {
        const cookiePolicy = auth.getCookiePolicy({
          requestSecure: req.secure,
        });
        if (!cookiePolicy.compatible) {
          const error = new Error(cookiePolicy.message);
          error.statusCode = 409;
          error.code = "AUTH_COOKIE_REQUIRES_HTTPS";
          throw error;
        }
      }

      const account = await auth.authenticate(
        req.body?.username,
        req.body?.password,
        requestAddress(req),
      );
      if (auth.enabled) {
        const token = auth.createSession(account.username);
        res.setHeader("Set-Cookie", auth.cookieHeader(token, { secure: req.secure }));
      }
      await manager.log("info", "Dashboard login succeeded.", {
        authentication: true,
        username: account.username,
        address: requestAddress(req),
        secureRequest: req.secure,
      });
      res.json({
        auth: auth.getStatus({ username: account.username }, { requestSecure: req.secure }),
      });
    }),
  );

  app.post("/api/auth/logout", (req, res) => {
    if (auth.enabled)
      res.setHeader("Set-Cookie", auth.cookieHeader("", { clear: true, secure: req.secure }));
    res.json({
      ok: true,
      auth: auth.getStatus(null, { requestSecure: req.secure }),
    });
  });

  app.use("/api", (req, res, next) => {
    if (req.isDesktopTrusted) {
      req.auth = { username: "Desktop App", desktop: true };
      return next();
    }
    if (!auth.enabled) return next();
    const session = auth.sessionFromRequest(req);
    if (!session)
      return res.status(401).json({
        error: "Authentication required.",
        authenticationRequired: true,
      });
    req.auth = session;
    return next();
  });

  app.use("/api", (req, res, next) => {
    if (!isRemoteRequest(req) || serverConfig.allowRemoteFilesystem) return next();
    const originalJson = res.json.bind(res);
    res.json = (body) => originalJson(sanitizeRemotePayload(body));
    res.setHeader("X-UPM-Filesystem-Redacted", "true");
    return next();
  });

  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (isLocalMachineAddress(requestAddress(req)) || serverConfig.allowRemoteAdmin) return next();
    return res.status(403).json({
      error:
        "Remote administrative actions are disabled. Set UPM_ALLOW_REMOTE_ADMIN=true to opt in.",
    });
  });
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    return writeRateLimiter(req, res, next);
  });
  app.use(
    express.static(path.join(rootDir, "public"), {
      dotfiles: "deny",
      fallthrough: true,
      index: "index.html",
    }),
  );

  const requireLocalFilesystemAccess = (req, res, next) => {
    if (serverConfig.allowRemoteFilesystem || isLocalMachineAddress(requestAddress(req)))
      return next();
    return res.status(403).json({
      error:
        "Remote filesystem/archive access is disabled. Set UPM_ALLOW_REMOTE_FILESYSTEM=true to opt in.",
    });
  };

  const requireSettingsAccess = (req, res, next) => {
    if (isLocalMachineAddress(requestAddress(req))) return next();
    if (
      serverConfig.allowRemoteAdmin &&
      serverConfig.allowRemoteFilesystem &&
      auth.enabled &&
      req.auth
    )
      return next();
    return res.status(403).json({
      error:
        "Runtime settings are restricted to the local host unless authenticated remote admin and filesystem access are both enabled.",
    });
  };

  const requireLocalHostAction = (req, res, next) => {
    if (isLocalMachineAddress(requestAddress(req))) return next();
    if (serverConfig.allowRemoteAdmin && auth.enabled && req.auth) return next();
    return res.status(403).json({
      error:
        "This action launches software on the Ultimate Project Manager host and requires either a client on that host or authenticated remote admin access (UPM_ALLOW_REMOTE_ADMIN=true).",
    });
  };

  app.get("/api/settings", requireSettingsAccess, (req, res) => {
    res.json(publicSettings(serverConfig));
  });

  app.put(
    "/api/settings",
    requireSettingsAccess,
    asyncRoute(async (req, res) => {
      const envPath = serverConfig.envPath || path.join(rootDir, ".env");
      const result = await saveSettings({
        envPath,
        runtimeConfig: serverConfig,
        input: req.body?.settings || req.body || {},
        secrets: req.body?.secrets || {},
      });

      try {
        result.appliedLiveFields = await applyLiveRuntimeSettings(result);
      } catch (error) {
        result.appliedLiveFields = [];
        result.restartRequired = true;
        result.restartFields = [...new Set([...(result.restartFields || []), "liveApplyRecovery"])];
        result.warnings.push(
          `Settings were saved, but live application failed (${error.message}). Restart UPM to apply the saved configuration.`,
        );
      }

      if (!result.restartRequired) {
        await markLastKnownGoodEnv(envPath);
      }

      await manager.log(
        result.restartRequired ? "warning" : "info",
        result.restartRequired
          ? "Runtime settings saved; some changes require a UPM restart."
          : "Runtime settings saved and applied without a restart.",
        {
          operation: "runtime-settings-save",
          changed: result.changed,
          appliedLiveFields: result.appliedLiveFields,
          restartFields: result.restartFields,
          restartRequired: result.restartRequired,
          username: req.auth?.username || null,
          address: requestAddress(req),
        },
      );
      res.json({ result });
    }),
  );

  app.get("/api/setup/export", requireSettingsAccess, (req, res) => {
    const setup = createSetupDocument({
      runtimeConfig: serverConfig,
      projects: manager.getProjectSetup(),
      appVersion: packageJson.version,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.json({
      setup,
      fileName: `Ultimate-Project-Manager-setup-${stamp}.json`,
    });
  });

  app.post(
    "/api/setup/import",
    requireSettingsAccess,
    asyncRoute(async (req, res) => {
      const setup = validateSetupDocument(req.body?.setup || req.body);
      const options = req.body?.options || {};
      const importRuntimeSettings = options.runtimeSettings !== false;
      const importProjects = options.projects !== false;
      const mode =
        String(options.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
      const warnings = [];
      let settingsResult = null;
      let projectsResult = null;

      if (importRuntimeSettings) {
        const prepared = prepareRuntimeSettingsImport(setup, serverConfig);
        warnings.push(...prepared.warnings);
        const envPath = serverConfig.envPath || path.join(rootDir, ".env");
        settingsResult = await saveSettings({
          envPath,
          runtimeConfig: serverConfig,
          input: prepared.settings,
          secrets: {},
        });
        try {
          settingsResult.appliedLiveFields = await applyLiveRuntimeSettings(settingsResult);
        } catch (error) {
          settingsResult.appliedLiveFields = [];
          settingsResult.restartRequired = true;
          settingsResult.restartFields = [
            ...new Set([...(settingsResult.restartFields || []), "liveApplyRecovery"]),
          ];
          settingsResult.warnings.push(
            `Imported settings were saved, but live application failed (${error.message}). Restart UPM to apply them.`,
          );
        }
        if (!settingsResult.restartRequired) await markLastKnownGoodEnv(envPath);
        warnings.push(...(settingsResult.warnings || []));
      }

      if (importProjects) {
        projectsResult = await manager.importProjectSetup(setup.projects, { mode });
        if (projectsResult.skippedReplace) {
          warnings.push(
            "Replace mode was not applied because one or more imported projects could not be validated. Existing project setup was left intact.",
          );
        }
        for (const item of projectsResult.errors || [])
          warnings.push(`${item.name}: ${item.error}`);
      }

      await manager.log(warnings.length ? "warning" : "info", "UPM setup imported.", {
        operation: "setup-import",
        importRuntimeSettings,
        importProjects,
        mode,
        restartRequired: Boolean(settingsResult?.restartRequired),
        warningCount: warnings.length,
        username: req.auth?.username || null,
        address: requestAddress(req),
      });

      res.json({
        result: {
          imported: true,
          mode,
          runtimeSettingsImported: importRuntimeSettings,
          projectsImported: importProjects,
          restartRequired: Boolean(settingsResult?.restartRequired),
          settings: settingsResult,
          projects: projectsResult,
          warnings: [...new Set(warnings)],
        },
      });
    }),
  );

  app.get("/api/status", (req, res) => {
    const projects = manager.getProjects();
    res.json({
      ok: true,
      productName: PRODUCT_NAME,
      version: packageJson.version,
      startedAt: app.locals.startedAt,
      projectCount: projects.length,
      watching: projects.filter((project) => project.watch).length,
      scheduled: projects.filter((project) => project.schedule?.enabled).length,
      running: projects.filter((project) => project.runtime.running).length,
      backupRoot: manager.backupRoot,
      restoreRoot: manager.restoreRoot,
      filesystemDetailsRedacted: isRemoteRequest(req) && !serverConfig.allowRemoteFilesystem,
      pm2: manager.getPm2Status(),
      lanAgents: manager.getRemoteAgentsStatus(),
      pm2Health24h: manager.getPm2HistorySummary("24h"),
      diagnostics24h: manager.getDiagnosticSummary(),
      host: hostStats.getCurrent(),
      dockerRuntime: dockerRuntime.getCurrent(),
      security: {
        allowRemoteDashboard: serverConfig.allowRemoteDashboard,
        allowRemoteAdmin: serverConfig.allowRemoteAdmin,
        allowRemoteFilesystem: serverConfig.allowRemoteFilesystem,
        securityHeaders: serverConfig.securityHeaders,
        contentSecurityPolicy: serverConfig.contentSecurityPolicy,
        authentication: auth.getStatus(req.auth || auth.sessionFromRequest(req), {
          requestSecure: req.secure,
        }),
        backupEncryptionConfigured: Boolean(serverConfig.backupEncryptionKey),
        editor: serverConfig.editor,
        customEditorConfigured: Boolean(serverConfig.editorCommand),
        rateLimit: {
          windowMs: serverConfig.apiRateLimitWindowMs,
          max: serverConfig.apiRateLimitMax,
          writeMax: serverConfig.writeRateLimitMax,
        },
        configSource:
          serverConfig.configSource || (serverConfig.envLoaded ? ".env" : "built-in defaults"),
      },
    });
  });

  app.get("/api/host-stats/history", (req, res) => {
    res.json({ history: hostStats.getHistory(req.query.hours) });
  });

  app.get(
    "/api/filesystem/roots",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ roots: await directoryBrowser.getRoots() });
    }),
  );

  app.get(
    "/api/filesystem/browse",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const result = await directoryBrowser.browse(req.query.path || null, {
        showHidden: parseBoolean(req.query.showHidden, false),
      });
      res.json({ result });
    }),
  );

  app.post(
    "/api/filesystem/mkdir",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const result = await directoryBrowser.createDirectory(req.body?.parentPath, req.body?.name);
      res.status(201).json({ result });
    }),
  );

  app.get("/api/file-tools/meta", requireLocalFilesystemAccess, (req, res) => {
    res.json({ meta: fileTools.getMeta() });
  });

  app.get("/api/file-tools/defaults", requireLocalFilesystemAccess, (req, res) => {
    res.json({
      defaults: fileTools.getDefaults(req.query.projectId || null, req.query.mode || "pipeline"),
    });
  });

  app.get("/api/file-tools/history", requireLocalFilesystemAccess, (req, res) => {
    res.json({ history: fileTools.getHistory(req.query.limit) });
  });

  app.delete(
    "/api/file-tools/history",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      await fileTools.clearHistory();
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/file-tools/preview",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ result: await fileTools.preview(req.body || {}) });
    }),
  );

  app.post(
    "/api/file-tools/run",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ result: await fileTools.run(req.body || {}) });
    }),
  );

  app.get("/api/file-tools/sanitizer/meta", requireLocalFilesystemAccess, (req, res) => {
    res.json({ meta: textSanitizer.getMeta() });
  });

  app.get("/api/file-tools/sanitizer/defaults", requireLocalFilesystemAccess, (req, res) => {
    res.json({ defaults: textSanitizer.getDefaults(req.query.projectId || null) });
  });

  app.post(
    "/api/file-tools/sanitizer/scan",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ scan: await textSanitizer.scan(req.body || {}) });
    }),
  );

  app.get(
    "/api/file-tools/sanitizer/scans/:id/preview",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        preview: await textSanitizer.preview(req.params.id, req.query.file || ""),
      });
    }),
  );

  app.post(
    "/api/file-tools/sanitizer/scans/:id/apply",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ result: await textSanitizer.apply(req.params.id, req.body || {}) });
    }),
  );

  app.get("/api/pm2", (req, res) => {
    res.json({ pm2: manager.getPm2Status() });
  });

  app.post(
    "/api/pm2/refresh",
    asyncRoute(async (req, res) => {
      res.json({ pm2: await manager.refreshPm2() });
    }),
  );

  app.get("/api/pm2/history", (req, res) => {
    res.json({
      summary: manager.getPm2HistorySummary(req.query.range || "24h"),
    });
  });

  app.post(
    "/api/projects/backup-all",
    asyncRoute(async (req, res) => {
      res.json({
        results: await manager.runAllBackups({
          force: parseBoolean(req.body?.force, false),
        }),
      });
    }),
  );

  app.post(
    "/api/backups/verify-all",
    asyncRoute(async (req, res) => {
      res.json({ results: await manager.verifyAllProjects() });
    }),
  );

  app.get(
    "/api/storage",
    asyncRoute(async (req, res) => {
      res.json({ storage: await manager.getStorageStats() });
    }),
  );

  app.get("/api/projects", (req, res) => res.json({ projects: manager.getProjects() }));

  app.post(
    "/api/projects/:id/services/refresh",
    asyncRoute(async (req, res) => {
      res.json({ health: await manager.refreshServiceHealth(req.params.id) });
    }),
  );

  app.get("/api/projects/:id/tasks", (req, res) => {
    res.json({
      taskList: manager.getProjectTasks(req.params.id, {
        includeCompleted: parseBoolean(req.query.includeCompleted, true),
        kind: req.query.kind || null,
      }),
    });
  });

  app.post(
    "/api/projects/:id/tasks",
    asyncRoute(async (req, res) => {
      const task = await manager.addProjectTask(req.params.id, req.body || {});
      res.status(201).json({
        task,
        summary: manager.projectTasks.getSummary(req.params.id),
      });
    }),
  );

  app.put(
    "/api/projects/:id/tasks/:taskId",
    asyncRoute(async (req, res) => {
      const task = await manager.updateProjectTask(
        req.params.id,
        req.params.taskId,
        req.body || {},
      );
      res.json({
        task,
        summary: manager.projectTasks.getSummary(req.params.id),
      });
    }),
  );

  app.delete(
    "/api/projects/:id/tasks/:taskId",
    asyncRoute(async (req, res) => {
      await manager.removeProjectTask(req.params.id, req.params.taskId);
      res.json({
        ok: true,
        summary: manager.projectTasks.getSummary(req.params.id),
      });
    }),
  );

  app.post(
    "/api/projects/:id/tasks/scan",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        result: await manager.scanProjectTasks(req.params.id, req.body || {}),
      });
    }),
  );

  app.get(
    "/api/projects/:id/launch-info",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ launch: await manager.getProjectLaunchInfo(req.params.id) });
    }),
  );

  app.post(
    "/api/projects/:id/open-editor",
    requireLocalHostAction,
    asyncRoute(async (req, res) => {
      res.json({ result: await manager.openProjectInEditor(req.params.id) });
    }),
  );

  app.get(
    "/api/projects/:id/repository",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        repository: await manager.getProjectRepository(req.params.id),
      });
    }),
  );

  app.post(
    "/api/projects/:id/pm2/start-project",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        result: await manager.startProjectInPm2(req.params.id, {
          refresh: parseBoolean(req.body?.refresh, true),
        }),
      });
    }),
  );

  app.get(
    "/api/projects/:id/journal",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        journal: await manager.getDeltaJournal(req.params.id, {
          limit: req.query.limit,
        }),
      });
    }),
  );

  app.post(
    "/api/projects/:id/journal/prune",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({ result: await manager.pruneDeltaJournal(req.params.id) });
    }),
  );

  app.get(
    "/api/projects/:id/diff",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        diff: await manager.getProjectDiff(req.params.id, {
          refresh: parseBoolean(req.query.refresh, false),
        }),
      });
    }),
  );

  app.get(
    "/api/projects/:id/diff/file",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        diff: await manager.getProjectFileDiff(req.params.id, req.query.path, {
          maxBytes: req.query.maxBytes,
          maxInputLines: req.query.maxInputLines,
          maxOutputLines: req.query.maxOutputLines,
        }),
      });
    }),
  );

  app.post(
    "/api/projects/:id/feature-pack/preview",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        preview: await manager.previewFeaturePack(req.params.id, req.body || {}),
      });
    }),
  );

  app.post(
    "/api/projects/:id/feature-pack/export",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const pack = await manager.exportFeaturePack(req.params.id, req.body || {});
      try {
        await new Promise((resolve, reject) => {
          res.download(pack.archivePath, pack.fileName, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      } finally {
        await fsp.rm(pack.archivePath, { force: true }).catch(() => {});
      }
    }),
  );

  app.get(
    "/api/projects/:id/recovery",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        recovery: await manager.inspectRecovery(req.params.id, {
          path: req.query.path || null,
          refresh: parseBoolean(req.query.refresh, false),
          maxBackups: req.query.maxBackups,
          maxGit: req.query.maxGit,
          maxJournal: req.query.maxJournal,
        }),
      });
    }),
  );

  app.get(
    "/api/projects/:id/recovery/candidate",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        candidate: await manager.getRecoveryCandidate(
          req.params.id,
          req.query.path,
          {
            id: req.query.candidateId || null,
            source: req.query.source || null,
            backupFile: req.query.backupFile || null,
            backupDestination: req.query.backupDestination || null,
            journalEntryId: req.query.journalEntryId || null,
            commit: req.query.commit || null,
          },
          {
            maxBytes: req.query.maxBytes,
            includeBlame: parseBoolean(req.query.includeBlame, true),
            blameLines: req.query.blameLines,
            maxJournal: req.query.maxJournal,
          },
        ),
      });
    }),
  );

  app.post(
    "/api/projects/:id/recovery/export",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        recovery: await manager.recoverFileCandidate(
          req.params.id,
          req.body?.path,
          {
            id: req.body?.candidateId || null,
            source: req.body?.source || null,
            backupFile: req.body?.backupFile || null,
            backupDestination: req.body?.backupDestination || null,
            journalEntryId: req.body?.journalEntryId || null,
            commit: req.body?.commit || null,
          },
          {
            maxBytes: req.body?.maxBytes,
          },
        ),
      });
    }),
  );

  app.post(
    "/api/projects/:id/recovery/export-suggested",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        recovery: await manager.recoverSuggestedFiles(req.params.id, {
          paths: Array.isArray(req.body?.paths) ? req.body.paths : null,
          maxFiles: req.body?.maxFiles,
          maxBytes: req.body?.maxBytes,
          refresh: parseBoolean(req.body?.refresh, false),
        }),
      });
    }),
  );

  app.get(
    "/api/projects/:id/dependencies",
    asyncRoute(async (req, res) => {
      res.json({
        dependencies: await manager.inspectDependencies(req.params.id, {
          refresh: parseBoolean(req.query.refresh, false),
        }),
      });
    }),
  );

  app.get(
    "/api/projects/:id/dependency-versions",
    asyncRoute(async (req, res) => {
      res.json({
        versions: await manager.getDependencyVersions(req.params.id, req.query.name, {
          refresh: parseBoolean(req.query.refresh, false),
          includePrerelease: parseBoolean(req.query.includePrerelease, false),
        }),
      });
    }),
  );

  app.post(
    "/api/projects/:id/dependency-update",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const result = await manager.updateDependency(
        req.params.id,
        req.body?.name,
        req.body?.version,
        {
          saveMode: req.body?.saveMode,
          runScripts: parseBoolean(req.body?.runScripts, true),
          refreshVersions: parseBoolean(req.body?.refreshVersions, false),
        },
      );
      res.json({ result });
    }),
  );

  app.post(
    "/api/projects",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const project = await manager.addProject(req.body || {});
      res.status(201).json({ project });
    }),
  );

  app.put(
    "/api/projects/:id",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const project = await manager.updateProject(req.params.id, req.body || {});
      res.json({ project });
    }),
  );

  app.delete(
    "/api/projects/:id",
    asyncRoute(async (req, res) => {
      await manager.removeProject(req.params.id);
      res.json({ ok: true });
    }),
  );

  app.get("/api/projects/:id/pm2", (req, res) => {
    res.json({ pm2: manager.getProjectPm2Status(req.params.id) });
  });

  app.get(
    "/api/projects/:id/pm2/:pm2Id/logs",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      res.json({
        logs: await manager.getProjectPm2Logs(req.params.id, req.params.pm2Id, {
          stream: req.query.stream || "both",
          lines: req.query.lines,
          maxBytes: req.query.maxBytes,
          refresh: parseBoolean(req.query.refresh, false),
        }),
      });
    }),
  );

  app.get("/api/projects/:id/pm2/history", (req, res) => {
    res.json({
      history: manager.getProjectPm2History(req.params.id, {
        range: req.query.range || "24h",
        processKey: req.query.process || null,
        maxPoints: req.query.maxPoints,
      }),
    });
  });

  app.delete(
    "/api/projects/:id/pm2/history",
    asyncRoute(async (req, res) => {
      await manager.clearProjectPm2History(req.params.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/projects/:id/pm2/:pm2Id/action",
    asyncRoute(async (req, res) => {
      res.json({
        result: await manager.runPm2Action(req.params.id, req.params.pm2Id, req.body?.action),
      });
    }),
  );

  app.post(
    "/api/projects/:id/inspect",
    asyncRoute(async (req, res) => {
      res.json({ result: await manager.inspectProject(req.params.id) });
    }),
  );

  app.post(
    "/api/projects/:id/backup",
    asyncRoute(async (req, res) => {
      const result = await manager.runBackup(req.params.id, {
        force: parseBoolean(req.body?.force, false),
        source: "manual",
      });
      res.json({ result });
    }),
  );

  app.get(
    "/api/projects/:id/storage",
    asyncRoute(async (req, res) => {
      res.json({
        storage: await manager.getProjectStorageStats(req.params.id),
      });
    }),
  );

  app.get(
    "/api/projects/:id/backups",
    asyncRoute(async (req, res) => {
      res.json({ backups: await manager.listBackups(req.params.id) });
    }),
  );

  app.post(
    "/api/projects/:id/backups/verify-all",
    asyncRoute(async (req, res) => {
      res.json({ results: await manager.verifyAllBackups(req.params.id) });
    }),
  );

  app.get(
    "/api/projects/:id/backups/:file/download",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      if (manager.isRemoteProject(req.params.id)) {
        const upstream = await manager.getRemoteBackupDownload(
          req.params.id,
          req.params.file,
          req.query.destination || null,
        );
        for (const header of ["content-type", "content-length", "content-disposition"]) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        if (!upstream.body) return res.end();
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      const fullPath = await manager.resolveBackup(
        req.params.id,
        req.params.file,
        req.query.destination || null,
      );
      res.download(fullPath, path.basename(fullPath));
    }),
  );

  app.post(
    "/api/projects/:id/backups/:file/verify",
    asyncRoute(async (req, res) => {
      res.json({
        result: await manager.verifyBackup(req.params.id, req.params.file),
      });
    }),
  );

  app.post(
    "/api/projects/:id/backups/:file/restore",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const result = await manager.restoreBackup(req.params.id, req.params.file, {
        destination: req.body?.destination || null,
        overwrite: parseBoolean(req.body?.overwrite, false),
        backupDestination: req.body?.backupDestination || null,
      });
      res.json({ result });
    }),
  );

  app.delete(
    "/api/projects/:id/backups/:file",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      await manager.deleteBackup(req.params.id, req.params.file);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/discovery/scan",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const roots = Array.isArray(req.body?.roots)
        ? req.body.roots
        : String(req.body?.roots || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
      const result = await manager.discoverProjects(roots, {
        maxDepth: req.body?.maxDepth,
        skipDirectories: req.body?.skipDirectories,
      });
      res.json({ result });
    }),
  );

  app.post(
    "/api/discovery/register",
    requireLocalFilesystemAccess,
    asyncRoute(async (req, res) => {
      const result = await manager.registerDiscoveredProjects(
        req.body?.projects || [],
        req.body?.defaults || {},
      );
      res.json({ result });
    }),
  );

  app.get("/api/activity", (req, res) =>
    res.json({ activity: manager.getActivity(req.query.limit) }),
  );

  app.get("/api/diagnostics", (req, res) =>
    res.json({
      diagnostics: manager.getDiagnostics({
        limit: req.query.limit,
        projectId: req.query.projectId || null,
        level: req.query.level || null,
      }),
      summary24h: manager.getDiagnosticSummary(),
    }),
  );

  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(rootDir, "public", "index.html"));
  });

  app.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(error);
    const candidateStatus = Number(error.statusCode);
    const status =
      Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
        ? candidateStatus
        : 500;
    const exposeDetails = status < 500 || !isRemoteRequest(req);
    if (error.retryAfterSeconds) res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(status).json({
      error: exposeDetails ? error.message || "Request failed." : "Internal server error.",
      ...(exposeDetails && error.code ? { code: error.code } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
    });
  });

  app.locals.manager = manager;
  app.locals.fileTools = fileTools;
  app.locals.auth = auth;
  app.locals.hostStats = hostStats;
  app.locals.dockerRuntime = dockerRuntime;
  app.locals.startedAt = new Date().toISOString();
  return { app, manager, fileTools, auth, hostStats, dockerRuntime, serverConfig };
}

async function startStandaloneRuntime({ rootDir, dataDir }) {
  let runtimeConfig = await loadRuntimeConfig({ rootDir, dataDir });
  const envPath = runtimeConfig.envPath || path.join(rootDir, ".env");
  const sessionRepair = await ensureLaunchableSessionSecret({ envPath, runtimeConfig });
  if (sessionRepair.repaired) {
    runtimeConfig = await loadRuntimeConfig({ rootDir, dataDir });
    console.warn(`${PRODUCT_NAME}: ${sessionRepair.reason}`);
  }

  const services = await createApp({ rootDir, dataDir, runtimeConfig });
  const host = services.serverConfig.host;
  const port = services.serverConfig.port;
  let server = null;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = services.app.listen(port, host, () => resolve(listener));
      listener.once("error", reject);
    });
  } catch (error) {
    await Promise.allSettled([services.hostStats?.shutdown?.(), services.manager?.shutdown?.()]);
    services.dockerRuntime?.stop?.();
    throw error;
  }

  server.requestTimeout = services.serverConfig.requestTimeoutMs;
  server.keepAliveTimeout = services.serverConfig.keepAliveTimeoutMs;
  server.headersTimeout = Math.max(
    services.serverConfig.headersTimeoutMs,
    services.serverConfig.keepAliveTimeoutMs + 1000,
  );
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;

  return { ...services, server, envPath, host, port };
}

async function main(options = {}) {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = path.join(rootDir, "data");
  let runtime;
  try {
    runtime = await startStandaloneRuntime({ rootDir, dataDir });
  } catch (error) {
    if (options.recoveryAttempted !== true) {
      const envPath = path.join(rootDir, ".env");
      const recovery = await recoverLastKnownGoodEnv(envPath, { reason: error.message }).catch(
        () => ({ recovered: false }),
      );
      if (recovery.recovered) {
        console.error(
          `${PRODUCT_NAME}: saved settings failed during startup; restored last-known-good configuration from ${recovery.lastKnownGoodPath}.`,
        );
        if (recovery.failedSettingsPath)
          console.error(
            `${PRODUCT_NAME}: failed settings preserved at ${recovery.failedSettingsPath}.`,
          );
        return main({ recoveryAttempted: true, recovery });
      }
    }
    throw error;
  }

  const { server, manager, hostStats, dockerRuntime, serverConfig, envPath, host, port } = runtime;
  await markLastKnownGoodEnv(envPath).catch((error) =>
    console.warn(`${PRODUCT_NAME}: unable to update last-known-good settings: ${error.message}`),
  );

  console.log(PRODUCT_NAME);
  console.log(`Dashboard: http://${host}:${port}`);
  console.log(`Backup root: ${manager.backupRoot}`);
  console.log(`Restore root: ${manager.restoreRoot}`);
  console.log(`Authentication: ${serverConfig.authEnabled ? "enabled" : "disabled"}`);
  console.log(
    `Backup encryption key: ${serverConfig.backupEncryptionKey ? "configured" : "not configured"}`,
  );
  if (options.recovery?.recovered)
    console.warn(
      "WARNING: UPM recovered the last-known-good settings after the saved settings failed to start.",
    );
  if (serverConfig.envRecoveredFromBackup)
    console.warn(
      `WARNING: .env was missing and has been automatically recovered from ${serverConfig.envBackupPath || ".env.bak"}.`,
    );
  if (serverConfig.lanAllowInsecureHttp)
    console.warn(
      "WARNING: UPM_LAN_ALLOW_INSECURE_HTTP=true permits bearer-token LAN agent traffic over plain HTTP.",
    );
  if (serverConfig.allowRemoteDashboard && !serverConfig.authEnabled)
    console.warn("WARNING: Remote dashboard access is enabled without authentication.");
  if (
    serverConfig.allowRemoteDashboard &&
    serverConfig.authEnabled &&
    !serverConfig.authCookieSecure
  )
    console.warn(
      "WARNING: Remote authenticated dashboard access should use HTTPS. Set UPM_AUTH_COOKIE_SECURE=true when HTTPS is enforced.",
    );

  const shutdown = async () => {
    await hostStats.shutdown();
    dockerRuntime.stop();
    await manager.shutdown();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${PRODUCT_NAME} failed:`, error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, BackupManager };
module.exports.ProjectBackup = require("./backup/project-backup").ProjectBackup;
