"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const defaultExecFileAsync = promisify(execFile);
const DEFAULT_REFRESH_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 4_000;

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
};
