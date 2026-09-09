"use strict";

const net = require("net");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { EventEmitter } = require("events");

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_INTERVAL_SECONDS = 30;
const MAX_SERVICES = 32;
const SERVICE_TYPES = new Set(["redis", "mariadb", "postgres", "docker", "tcp", "http"]);

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function safeId(value, fallback) {
  const normalized = String(value || fallback || "service")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || String(fallback || "service");
}

function normalizeServiceDefinition(input = {}, index = 0) {
  const type = String(input.type || "tcp")
    .trim()
    .toLowerCase();
  if (!SERVICE_TYPES.has(type)) throw new Error(`Unsupported service health type: ${type}`);
  const defaults = {
    redis: { name: "Redis", host: "127.0.0.1", port: 6379 },
    mariadb: { name: "MariaDB", host: "127.0.0.1", port: 3306 },
    postgres: { name: "PostgreSQL", host: "127.0.0.1", port: 5432 },
    docker: { name: "Docker" },
    tcp: { name: "TCP service", host: "127.0.0.1", port: 80 },
    http: { name: "HTTP service" },
  }[type];
  const name = String(input.name || defaults.name)
    .trim()
    .slice(0, 100);
  const id = safeId(input.id, `${type}-${index + 1}`);
  const base = {
    id,
    name: name || defaults.name,
    type,
    enabled: input.enabled !== false,
  };
  if (["redis", "mariadb", "postgres", "tcp"].includes(type)) {
    const host = String(input.host || defaults.host || "127.0.0.1").trim();
    const port = clampNumber(input.port, 1, 65535, defaults.port || 80);
    if (!host) throw new Error(`${base.name} requires a host.`);
    return { ...base, host, port };
  }
  if (type === "http") {
    const url = String(input.url || "").trim();
    if (!/^https?:\/\//i.test(url))
      throw new Error(`${base.name} requires an http:// or https:// URL.`);
    return { ...base, url };
  }
  return base;
}

function normalizeServiceHealthConfig(input = {}, existing = null) {
  const base = existing || {};
  const rawServices = Array.isArray(input.services)
    ? input.services
    : Array.isArray(base.services)
      ? base.services
      : [];
  const services = rawServices
    .slice(0, MAX_SERVICES)
    .map((service, index) => normalizeServiceDefinition(service, index));
  const ids = new Set();
  for (const service of services) {
    if (ids.has(service.id)) throw new Error(`Duplicate service health id: ${service.id}`);
    ids.add(service.id);
  }
  return {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    intervalSeconds: clampNumber(
      input.intervalSeconds ?? base.intervalSeconds,
      10,
      3600,
      DEFAULT_INTERVAL_SECONDS,
    ),
    timeoutMs: clampNumber(input.timeoutMs ?? base.timeoutMs, 500, 30000, DEFAULT_TIMEOUT_MS),
    services,
  };
}

function targetFor(service) {
  if (service.type === "docker") return "local Docker daemon";
  if (service.type === "http") return service.url;
  return `${service.host}:${service.port}`;
}

function resultBase(service, startedAt) {
  return {
    id: service.id,
    name: service.name,
    type: service.type,
    target: targetFor(service),
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

function connectSocket(service, timeoutMs, onConnect) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const socket = net.createConnection({
      host: service.host,
      port: service.port,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...resultBase(service, startedAt), ...result });
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () =>
      finish({ status: "unhealthy", healthy: false, message: "Timed out." }),
    );
    socket.once("error", (error) =>
      finish({
        status: "unhealthy",
        healthy: false,
        message: error.message,
        code: error.code || null,
      }),
    );
    socket.once("connect", () => {
      if (!onConnect)
        return finish({
          status: "healthy",
          healthy: true,
          message: "TCP connection accepted.",
        });
      try {
        onConnect(socket, finish);
      } catch (error) {
        finish({ status: "unhealthy", healthy: false, message: error.message });
      }
    });
  });
}

function probeRedis(service, timeoutMs) {
  return connectSocket(service, timeoutMs, (socket, finish) => {
    socket.write("*1\r\n$4\r\nPING\r\n");
    socket.once("data", (chunk) => {
      const response = String(chunk || "").trim();
      if (/^\+PONG/i.test(response))
        return finish({
          status: "healthy",
          healthy: true,
          message: "PING → PONG",
        });
      if (/^-NOAUTH|^-NOPERM/i.test(response))
        return finish({
          status: "healthy",
          healthy: true,
          authRequired: true,
          message: "Redis responded; authentication is required for PING.",
        });
      if (response)
        return finish({
          status: "degraded",
          healthy: true,
          message: `Redis responded: ${response.slice(0, 160)}`,
        });
      return finish({
        status: "unhealthy",
        healthy: false,
        message: "Redis returned an empty response.",
      });
    });
  });
}

function probeMariaDb(service, timeoutMs) {
  return connectSocket(service, timeoutMs, (socket, finish) => {
    socket.once("data", (chunk) => {
      const data = Buffer.from(chunk || []);
      if (data.length < 6)
        return finish({
          status: "degraded",
          healthy: true,
          message: "MariaDB/MySQL accepted the connection.",
        });
      if (data[4] === 0xff)
        return finish({
          status: "degraded",
          healthy: true,
          message: "MariaDB/MySQL responded with a server error packet.",
        });
      const nul = data.indexOf(0, 5);
      const version = nul > 5 ? data.subarray(5, nul).toString("utf8") : null;
      return finish({
        status: "healthy",
        healthy: true,
        version,
        message: version
          ? `Server handshake · ${version}`
          : "MariaDB/MySQL server handshake received.",
      });
    });
  });
}

function probePostgres(service, timeoutMs) {
  return connectSocket(service, timeoutMs, (socket, finish) => {
    const request = Buffer.alloc(8);
    request.writeInt32BE(8, 0);
    request.writeInt32BE(80877103, 4);
    socket.write(request);
    socket.once("data", (chunk) => {
      const response = Buffer.from(chunk || []);
      const marker = response.length ? String.fromCharCode(response[0]) : "";
      if (marker === "S" || marker === "N")
        return finish({
          status: "healthy",
          healthy: true,
          sslSupported: marker === "S",
          message:
            marker === "S"
              ? "PostgreSQL responded · SSL supported."
              : "PostgreSQL responded · SSL not enabled.",
        });
      return finish({
        status: response.length ? "degraded" : "unhealthy",
        healthy: response.length > 0,
        message: response.length
          ? "PostgreSQL returned a protocol response."
          : "PostgreSQL returned no protocol response.",
      });
    });
  });
}

async function probeHttp(service, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(service.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Ultimate-Project-Manager-Health/1.0" },
    });
    const healthy = response.status >= 200 && response.status < 400;
    const degraded = response.status >= 400 && response.status < 500;
    const result = {
      ...resultBase(service, startedAt),
      status: healthy ? "healthy" : degraded ? "degraded" : "unhealthy",
      healthy: healthy || degraded,
      httpStatus: response.status,
      message: `HTTP ${response.status} ${response.statusText || ""}`.trim(),
    };
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel().catch(() => {});
    }
    return result;
  } catch (error) {
    return {
      ...resultBase(service, startedAt),
      status: "unhealthy",
      healthy: false,
      message: error?.name === "AbortError" ? "Timed out." : error.message,
      code: error.code || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeDocker(service, timeoutMs) {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "docker.exe" : "docker",
      ["info", "--format", "{{json .}}"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    let info = {};
    try {
      info = JSON.parse(String(stdout || "").trim() || "{}");
    } catch {
      info = {};
    }
    const version = info.ServerVersion || null;
    const running = Number(info.ContainersRunning);
    const total = Number(info.Containers);
    return {
      ...resultBase(service, startedAt),
      status: "healthy",
      healthy: true,
      version,
      containersRunning: Number.isFinite(running) ? running : null,
      containersTotal: Number.isFinite(total) ? total : null,
      message: [
        version ? `Docker ${version}` : "Docker daemon reachable",
        Number.isFinite(running) && Number.isFinite(total)
          ? `${running}/${total} containers running`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    return {
      ...resultBase(service, startedAt),
      status: "unhealthy",
      healthy: false,
      message: detail || "Docker daemon is unavailable.",
      code: error.code || null,
    };
  }
}

async function probeService(service, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (service.enabled === false)
    return {
      id: service.id,
      name: service.name,
      type: service.type,
      target: targetFor(service),
      status: "disabled",
      healthy: null,
      checkedAt: null,
      latencyMs: null,
      message: "Disabled.",
    };
  if (service.type === "redis") return probeRedis(service, timeoutMs);
  if (service.type === "mariadb") return probeMariaDb(service, timeoutMs);
  if (service.type === "postgres") return probePostgres(service, timeoutMs);
  if (service.type === "docker") return probeDocker(service, timeoutMs);
  if (service.type === "http") return probeHttp(service, timeoutMs);
  return connectSocket(service, timeoutMs);
}

function summarize(results = []) {
  const enabled = results.filter((item) => item.status !== "disabled");
  const unhealthy = enabled.filter((item) => item.status === "unhealthy").length;
  const degraded = enabled.filter((item) => item.status === "degraded").length;
  const healthy = enabled.filter((item) => item.status === "healthy").length;
  return {
    total: results.length,
    enabled: enabled.length,
    healthy,
    degraded,
    unhealthy,
    status: !enabled.length
      ? "disabled"
      : unhealthy
        ? "unhealthy"
        : degraded
          ? "degraded"
          : "healthy",
  };
}

async function probeProjectServices(project = {}) {
  const config = normalizeServiceHealthConfig(project.serviceHealth || {});
  if (!config.enabled)
    return {
      enabled: false,
      checkedAt: null,
      status: "disabled",
      summary: {
        total: config.services.length,
        enabled: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        status: "disabled",
      },
      services: config.services.map((service) => ({
        id: service.id,
        name: service.name,
        type: service.type,
        target: targetFor(service),
        status: "disabled",
        healthy: null,
        checkedAt: null,
        latencyMs: null,
        message: "Project service monitoring disabled.",
      })),
    };
  const results = await Promise.all(
    config.services.map((service) => probeService(service, config.timeoutMs)),
  );
  const summary = summarize(results);
  return {
    enabled: true,
    checkedAt: new Date().toISOString(),
    status: summary.status,
    summary,
    services: results,
  };
}

class ServiceHealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollMs = clampNumber(options.pollMs, 1000, 60000, 5000);
    this.remoteProbe = options.remoteProbe || null;
    this.status = new Map();
    this.inFlight = new Set();
    this.timer = null;
    this.projectProvider = null;
  }

  async start(projectProvider) {
    this.projectProvider = projectProvider;
    this.tick(true).catch(() => {});
    this.timer = setInterval(() => this.tick(false).catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  forgetProject(id) {
    this.status.delete(String(id));
    this.inFlight.delete(String(id));
  }

  getProjectStatus(id) {
    return this.status.get(String(id)) || null;
  }

  async refreshProject(project) {
    if (!project?.id) throw new Error("Project id is required for service health.");
    const id = String(project.id);
    if (this.inFlight.has(id)) return this.getProjectStatus(id);
    this.inFlight.add(id);
    try {
      const value =
        project.executionTarget === "lan" && this.remoteProbe
          ? await this.remoteProbe(project)
          : await probeProjectServices(project);
      const status = {
        ...value,
        projectId: id,
        projectName: project.name,
      };
      this.status.set(id, status);
      this.emit("sample", status);
      return status;
    } catch (error) {
      const fallback = {
        enabled: project.serviceHealth?.enabled === true,
        projectId: id,
        projectName: project.name,
        checkedAt: new Date().toISOString(),
        status: "unhealthy",
        summary: {
          total: 0,
          enabled: 0,
          healthy: 0,
          degraded: 0,
          unhealthy: 1,
          status: "unhealthy",
        },
        services: [],
        error: error.message,
      };
      this.status.set(id, fallback);
      this.emit("sample", fallback);
      return fallback;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async tick(force = false) {
    const projects = this.projectProvider ? this.projectProvider() : [];
    const now = Date.now();
    await Promise.all(
      (projects || []).map(async (project) => {
        const config = normalizeServiceHealthConfig(project.serviceHealth || {});
        if (!config.enabled) {
          this.status.set(String(project.id), {
            enabled: false,
            projectId: project.id,
            projectName: project.name,
            checkedAt: null,
            status: "disabled",
            summary: {
              total: config.services.length,
              enabled: 0,
              healthy: 0,
              degraded: 0,
              unhealthy: 0,
              status: "disabled",
            },
            services: [],
          });
          return;
        }
        const current = this.status.get(String(project.id));
        const checkedAt = current?.checkedAt ? new Date(current.checkedAt).getTime() : 0;
        const due = !checkedAt || now - checkedAt >= config.intervalSeconds * 1000;
        if (force || due) await this.refreshProject(project);
      }),
    );
  }
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_MS,
  SERVICE_TYPES,
  ServiceHealthMonitor,
  normalizeServiceDefinition,
  normalizeServiceHealthConfig,
  probeProjectServices,
  probeService,
  summarize,
};
