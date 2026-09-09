"use strict";

const express = require("express");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream/promises");
const { Pm2Monitor, aliasMatches, pathMatches, summarizeProject } = require("../pm2/pm2-monitor");
const { RemoteProjectExecutor } = require("./remote-project-executor");
const { probeProjectServices } = require("../services/service-health-monitor");
const { DockerRuntimeMonitor } = require("../system/docker-runtime-monitor");

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requestAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function tokenMatches(expected, supplied) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(supplied || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createRequestLimiter({ windowMs = 60_000, max = 240, maxBuckets = 2000 } = {}) {
  const buckets = new Map();
  const bucketLimit = Math.max(100, Number(maxBuckets) || 2000);
  return (req, res, next) => {
    const now = Date.now();
    const key = requestAddress(req) || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= bucketLimit) {
        for (const [candidate, value] of buckets) {
          if (value.resetAt <= now) buckets.delete(candidate);
        }
        while (buckets.size >= bucketLimit) buckets.delete(buckets.keys().next().value);
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= max) return next();
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many LAN agent requests. Try again shortly." });
  };
}

function createRemoteAgentApp(options = {}) {
  const token = String(options.token || "");
  if (token.length < 32) throw new Error("UPM_AGENT_TOKEN must be at least 32 characters.");
  const agentId = String(options.agentId || os.hostname()).trim();
  const agentName = String(options.agentName || agentId).trim();
  const allowedControllers = new Set(
    (options.allowedControllers || []).map((item) => String(item).trim()).filter(Boolean),
  );
  const executor =
    options.executor ||
    new RemoteProjectExecutor({
      dataDir: options.dataDir,
      backupRoot: options.backupRoot,
      restoreRoot: options.restoreRoot,
      allowedProjectRoots: options.allowedProjectRoots,
      allowedBackupRoots: options.allowedBackupRoots,
      allowedRestoreRoots: options.allowedRestoreRoots,
      encryptionKey: options.encryptionKey,
    });
  const pm2 = options.pm2Monitor || new Pm2Monitor({ refreshMs: options.pm2RefreshMs || 10_000 });
  const dockerRuntime =
    options.dockerRuntimeMonitor ||
    new DockerRuntimeMonitor({ refreshMs: options.pm2RefreshMs || 10_000 });
  const startedAt = new Date().toISOString();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(createRequestLimiter(options.rateLimit || {}));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (allowedControllers.size && !allowedControllers.has(requestAddress(req)))
      return res.status(403).json({ error: "Controller address is not allowed." });
    const auth = String(req.get("authorization") || "");
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!tokenMatches(token, supplied))
      return res.status(401).json({ error: "Invalid LAN agent token." });
    return next();
  });

  const health = () => ({
    id: agentId,
    name: agentName,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    processUptimeSeconds: Math.floor(process.uptime()),
    systemUptimeSeconds: Math.floor(os.uptime()),
    startedAt,
  });

  app.get("/api/agent/health", (req, res) =>
    res.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      health: health(),
      pm2: pm2.getStatus(),
      dockerRuntime: dockerRuntime.getCurrent(),
    }),
  );

  app.post(
    "/api/agent/pm2/projects",
    asyncRoute(async (req, res) => {
      if (req.body?.refresh === true) await pm2.refresh();
      const global = pm2.getStatus();
      const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];
      const enabled = projects.filter((project) => project.pm2Monitoring !== false);
      const assigned = new Map(projects.map((project) => [project.id, []]));
      for (const proc of global.processes || []) {
        const explicit = enabled.filter((project) => aliasMatches(project, proc));
        if (explicit.length) {
          for (const project of explicit) assigned.get(project.id)?.push(proc);
          continue;
        }
        const pathCandidates = enabled
          .filter((project) => pathMatches(project, proc))
          .sort((a, b) => String(b.projectRoot || "").length - String(a.projectRoot || "").length);
        if (pathCandidates[0]) assigned.get(pathCandidates[0].id)?.push(proc);
      }
      const summaries = projects.map((project) => {
        const summary = summarizeProject(
          project,
          project.pm2Monitoring === false ? [] : assigned.get(project.id) || [],
          global.available,
          global.checkedAt,
          global.error,
        );
        if (project.pm2Monitoring === false) summary.status = "disabled";
        summary.controlsEnabled = false;
        summary.gpu = { ...(global.gpu || {}) };
        return summary;
      });
      res.json({
        checkedAt: global.checkedAt || new Date().toISOString(),
        health: health(),
        pm2: global,
        dockerRuntime: dockerRuntime.getCurrent(),
        projects: summaries,
      });
    }),
  );

  app.post(
    "/api/agent/projects/services/health",
    asyncRoute(async (req, res) => {
      const project = req.body?.project || {};
      await executor.validate(project);
      res.json({ health: await probeProjectServices(project) });
    }),
  );

  app.post(
    "/api/agent/projects/validate",
    asyncRoute(async (req, res) => {
      const project = await executor.validate(req.body?.project || {});
      res.json({
        ok: true,
        project: {
          projectRoot: project.projectRoot,
          backupDir: project.backupDir,
          backupDirSecondary: project.backupDirSecondary,
        },
      });
    }),
  );
  app.post(
    "/api/agent/projects/inspect",
    asyncRoute(async (req, res) =>
      res.json({ result: await executor.inspect(req.body?.project || {}) }),
    ),
  );
  app.post(
    "/api/agent/projects/backup",
    asyncRoute(async (req, res) =>
      res.json({
        result: await executor.backup(req.body?.project || {}, {
          force: req.body?.force === true,
        }),
      }),
    ),
  );
  app.post(
    "/api/agent/projects/backups",
    asyncRoute(async (req, res) =>
      res.json({
        backups: await executor.listBackups(req.body?.project || {}),
      }),
    ),
  );
  app.post(
    "/api/agent/projects/backups/verify",
    asyncRoute(async (req, res) =>
      res.json({
        result: await executor.verify(req.body?.project || {}, req.body?.file),
      }),
    ),
  );
  app.post(
    "/api/agent/projects/backups/verify-all",
    asyncRoute(async (req, res) =>
      res.json({ results: await executor.verifyAll(req.body?.project || {}) }),
    ),
  );
  app.post(
    "/api/agent/projects/backups/delete",
    asyncRoute(async (req, res) =>
      res.json({
        results: await executor.delete(req.body?.project || {}, req.body?.file),
      }),
    ),
  );
  app.post(
    "/api/agent/projects/backups/restore",
    asyncRoute(async (req, res) =>
      res.json({
        result: await executor.restore(req.body?.project || {}, req.body?.file, {
          destination: req.body?.destination || null,
          overwrite: req.body?.overwrite === true,
          backupDestination: req.body?.backupDestination || null,
        }),
      }),
    ),
  );
  app.post(
    "/api/agent/projects/storage",
    asyncRoute(async (req, res) =>
      res.json({ storage: await executor.storage(req.body?.project || {}) }),
    ),
  );
  app.post(
    "/api/agent/projects/backups/download",
    asyncRoute(async (req, res) => {
      const resolved = await executor.resolve(
        req.body?.project || {},
        req.query.file,
        req.query.destination || null,
      );
      const stat = await fs.promises.stat(resolved.path);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(resolved.path).replace(/"/g, "")}"`,
      );
      await pipeline(fs.createReadStream(resolved.path), res);
    }),
  );

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const candidate = Number(error.statusCode || 500);
    const status = candidate >= 400 && candidate < 600 ? candidate : 500;
    const exposeDetails = status < 500;
    res.status(status).json({
      error: exposeDetails
        ? error.message || "LAN agent request failed."
        : "LAN agent request failed.",
      ...(exposeDetails && error.code ? { code: error.code } : {}),
    });
  });

  app.locals.pm2 = pm2;
  app.locals.dockerRuntime = dockerRuntime;
  app.locals.executor = executor;
  app.locals.start = async () => {
    await Promise.all([pm2.start(() => []), dockerRuntime.start()]);
    return app;
  };
  app.locals.shutdown = async () => {
    pm2.stop();
    dockerRuntime.stop();
  };
  return app;
}

module.exports = { createRemoteAgentApp };
