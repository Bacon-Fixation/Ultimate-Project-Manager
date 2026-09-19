"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const defaultExecFileAsync = promisify(execFile);
const DEFAULT_REFRESH_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_CONTAINER_DEPENDENCIES = 32;

function normalizeContainerNames(values = []) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const name = String(value || "").trim();
    if (!name || seen.has(name)) continue;
    if (name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
      throw new Error(`Invalid Docker container name or id: ${name || "(blank)"}`);
    seen.add(name);
    result.push(name);
    if (result.length > MAX_CONTAINER_DEPENDENCIES)
      throw new Error(`A project may wait for at most ${MAX_CONTAINER_DEPENDENCIES} Docker containers.`);
  }
  return result;
}

function parseContainerInspect(stdout, requested = []) {
  let items;
  try {
    items = JSON.parse(String(stdout || "[]"));
  } catch {
    throw new Error("Docker returned malformed container inspection data.");
  }
  if (!Array.isArray(items)) throw new Error("Docker container inspection response was not an array.");
  const byName = new Map();
  for (const item of items) {
    const names = [String(item?.Name || "").replace(/^\//, ""), String(item?.Id || "")].filter(Boolean);
    for (const name of names) byName.set(name, item);
  }
  return requested.map((requestedName) => {
    const exact = byName.get(requestedName);
    const item = exact || items.find((candidate) => String(candidate?.Id || "").startsWith(requestedName));
    if (!item) return { name: requestedName, found: false, running: false, healthy: false, ready: false, status: "missing" };
    const state = item.State || {};
    const running = state.Running === true || String(state.Status || "").toLowerCase() === "running";
    const healthStatus = state.Health ? String(state.Health.Status || "unknown").toLowerCase() : null;
    const healthy = healthStatus ? healthStatus === "healthy" : running;
    return {
      name: requestedName,
      containerName: String(item.Name || "").replace(/^\//, "") || requestedName,
      id: String(item.Id || "").slice(0, 12) || null,
      found: true,
      running,
      healthcheck: Boolean(state.Health),
      healthStatus,
      healthy,
      ready: running && healthy,
      status: healthStatus || String(state.Status || "unknown").toLowerCase(),
    };
  });
}

function commandErrorText(error) {
  return String(error?.stderr || error?.stdout || error?.message || "").trim();
}

function parseDockerInfo(stdout) {
  let info = {};
  try {
    info = JSON.parse(String(stdout || "").trim() || "{}");
  } catch {
    info = {};
  }
  return {
    serverVersion: info.ServerVersion || null,
    operatingSystem: info.OperatingSystem || null,
    name: info.Name || null,
    containers: Number.isFinite(Number(info.Containers)) ? Number(info.Containers) : null,
    containersRunning: Number.isFinite(Number(info.ContainersRunning))
      ? Number(info.ContainersRunning)
      : null,
    dockerRootDir: info.DockerRootDir || null,
  };
}

function parseWindowsService(stdout) {
  const text = String(stdout || "");
  const state = /STATE\s*:\s*\d+\s+([A-Z_]+)/i.exec(text)?.[1]?.toUpperCase() || null;
  return {
    installed: Boolean(state),
    state,
    running: state === "RUNNING",
  };
}

function taskListHasDockerDesktop(stdout) {
  const text = String(stdout || "");
  return /(^|[",])Docker Desktop\.exe([",]|$)/im.test(text);
}

class DockerRuntimeMonitor {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.execFileAsync = options.execFileAsync || defaultExecFileAsync;
    this.refreshMs = Math.max(3_000, Number(options.refreshMs || DEFAULT_REFRESH_MS));
    this.timeoutMs = Math.max(500, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
    this.timer = null;
    this.refreshing = null;
    this.current = {
      checkedAt: null,
      platform: this.platform,
      runtime: this.platform === "win32" ? "Docker Desktop" : "Docker Engine",
      state: "unknown",
      running: false,
      daemonReady: false,
      cliAvailable: null,
      desktopProcessRunning: null,
      serviceInstalled: null,
      serviceRunning: null,
      serviceState: null,
      serverVersion: null,
      error: null,
      message: "Docker runtime has not been checked yet.",
    };
  }

  async _run(file, args) {
    return this.execFileAsync(file, args, {
      timeout: this.timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  }

  async inspectContainers(values = []) {
    const names = normalizeContainerNames(values);
    if (!names.length) return { ready: true, containers: [], message: "No Docker container dependencies configured." };
    try {
      const { stdout } = await this._run(this.platform === "win32" ? "docker.exe" : "docker", [
        "inspect",
        "--type=container",
        ...names,
      ]);
      const containers = parseContainerInspect(stdout, names);
      const ready = containers.every((item) => item.ready);
      const waiting = containers.filter((item) => !item.ready);
      return {
        ready,
        containers,
        message: ready
          ? `Docker dependencies ready: ${containers.map((item) => item.containerName || item.name).join(", ")}.`
          : `Waiting for Docker containers: ${waiting.map((item) => `${item.name} (${item.status})`).join(", ")}.`,
      };
    } catch (error) {
      const text = commandErrorText(error);
      const missingMatch = /No such object:\s*([^\r\n]+)/i.exec(text);
      if (missingMatch) {
        const missing = missingMatch[1].trim();
        const containers = names.map((name) => ({
          name,
          found: name !== missing,
          running: false,
          healthy: false,
          ready: false,
          status: name === missing ? "missing" : "unknown",
        }));
        return { ready: false, containers, message: `Waiting for Docker container ${missing} (missing).` };
      }
      return {
        ready: false,
        containers: names.map((name) => ({ name, found: false, running: false, healthy: false, ready: false, status: "unavailable" })),
        error: text || "Docker container inspection failed.",
        message: text || "Unable to inspect Docker container dependencies.",
      };
    }
  }

  async _dockerInfo() {
    try {
      const { stdout } = await this._run(this.platform === "win32" ? "docker.exe" : "docker", [
        "info",
        "--format",
        "{{json .}}",
      ]);
      return { cliAvailable: true, daemonReady: true, info: parseDockerInfo(stdout), error: null };
    } catch (error) {
      return {
        cliAvailable: error?.code === "ENOENT" ? false : true,
        daemonReady: false,
        info: {},
        error: commandErrorText(error) || "Docker daemon is unavailable.",
      };
    }
  }

  async _windowsDesktop() {
    let service = { installed: false, state: null, running: false };
    let desktopProcessRunning = false;
    try {
      const { stdout } = await this._run("sc.exe", ["query", "com.docker.service"]);
      service = parseWindowsService(stdout);
    } catch (error) {
      const text = commandErrorText(error);
      if (!/1060|does not exist|not exist/i.test(text)) {
        service = { installed: null, state: null, running: null };
      }
    }
    try {
      const { stdout } = await this._run("tasklist.exe", [
        "/FI",
        "IMAGENAME eq Docker Desktop.exe",
        "/FO",
        "CSV",
        "/NH",
      ]);
      desktopProcessRunning = taskListHasDockerDesktop(stdout);
    } catch {
      desktopProcessRunning = null;
    }
    return { service, desktopProcessRunning };
  }

  async _unixService() {
    try {
      const { stdout } = await this._run("systemctl", ["is-active", "docker"]);
      const state = String(stdout || "")
        .trim()
        .toLowerCase();
      return { serviceInstalled: true, serviceRunning: state === "active", serviceState: state };
    } catch (error) {
      const text = commandErrorText(error).toLowerCase();
      if (/not found|enoent/.test(text) || error?.code === "ENOENT") {
        return { serviceInstalled: null, serviceRunning: null, serviceState: null };
      }
      return {
        serviceInstalled: true,
        serviceRunning: false,
        serviceState: text.split(/\s+/)[0] || "inactive",
      };
    }
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async _refresh() {
    const checkedAt = new Date().toISOString();
    const [docker, runtimeStatus] = await Promise.all([
      this._dockerInfo(),
      this.platform === "win32" ? this._windowsDesktop() : this._unixService(),
    ]);
    let desktopProcessRunning = null;
    let serviceInstalled = null;
    let serviceRunning = null;
    let serviceState = null;

    if (this.platform === "win32") {
      desktopProcessRunning = runtimeStatus.desktopProcessRunning;
      serviceInstalled = runtimeStatus.service.installed;
      serviceRunning = runtimeStatus.service.running;
      serviceState = runtimeStatus.service.state;
    } else {
      serviceInstalled = runtimeStatus.serviceInstalled;
      serviceRunning = runtimeStatus.serviceRunning;
      serviceState = runtimeStatus.serviceState;
    }

    const runtimeProcessRunning =
      this.platform === "win32"
        ? desktopProcessRunning === true || serviceRunning === true
        : serviceRunning === true;
    const state = docker.daemonReady
      ? "ready"
      : runtimeProcessRunning
        ? "starting"
        : docker.cliAvailable === false && serviceInstalled === false
          ? "not-installed"
          : "stopped";
    const info = docker.info || {};
    const message = docker.daemonReady
      ? [
          this.platform === "win32" ? "Docker Desktop daemon ready" : "Docker daemon ready",
          info.serverVersion ? `v${info.serverVersion}` : null,
          Number.isFinite(info.containersRunning) && Number.isFinite(info.containers)
            ? `${info.containersRunning}/${info.containers} containers running`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : runtimeProcessRunning
        ? `${this.platform === "win32" ? "Docker Desktop" : "Docker service"} is running; waiting for the Docker daemon.`
        : docker.error ||
          `${this.platform === "win32" ? "Docker Desktop" : "Docker"} is not running.`;

    this.current = {
      checkedAt,
      platform: this.platform,
      runtime: this.platform === "win32" ? "Docker Desktop" : "Docker Engine",
      state,
      running: docker.daemonReady || runtimeProcessRunning,
      daemonReady: docker.daemonReady,
      cliAvailable: docker.cliAvailable,
      desktopProcessRunning,
      serviceInstalled,
      serviceRunning,
      serviceState,
      serverVersion: info.serverVersion || null,
      operatingSystem: info.operatingSystem || null,
      engineName: info.name || null,
      containers: info.containers ?? null,
      containersRunning: info.containersRunning ?? null,
      dockerRootDir: info.dockerRootDir || null,
      error: docker.daemonReady ? null : docker.error,
      message,
    };
    return this.getCurrent();
  }

  async start() {
    await this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getCurrent() {
    return { ...this.current };
  }
}

module.exports = {
  DockerRuntimeMonitor,
  parseDockerInfo,
  parseWindowsService,
  taskListHasDockerDesktop,
  normalizeContainerNames,
  parseContainerInspect,
};
