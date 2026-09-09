"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const DEFAULT_REFRESH_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 4 * 1024 * 1024;

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function addProcessSample(target, pid, sample = {}) {
  const processId = Number(pid);
  if (!Number.isInteger(processId) || processId <= 0) return;
  const current = target.get(processId) || {
    gpuPercent: null,
    gpuRawPercent: 0,
    gpuMemoryPercent: null,
    gpuDevices: [],
  };

  const raw = Number(sample.gpuPercent);
  if (Number.isFinite(raw)) {
    current.gpuRawPercent += Math.max(0, raw);
    current.gpuPercent = clampPercent(current.gpuRawPercent);
  }
  const memory = clampPercent(sample.gpuMemoryPercent);
  if (memory != null)
    current.gpuMemoryPercent = Math.max(
      current.gpuMemoryPercent == null ? 0 : current.gpuMemoryPercent,
      memory,
    );

  if (sample.device != null) {
    const device = String(sample.device);
    const existing = current.gpuDevices.find((item) => item.device === device);
    const detail = {
      device,
      gpuPercent: clampPercent(sample.gpuPercent),
      gpuMemoryPercent: memory,
    };
    if (existing) Object.assign(existing, detail);
    else current.gpuDevices.push(detail);
  }
  target.set(processId, current);
}

function parseNvidiaPmon(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerLine = [...lines]
    .reverse()
    .find((line) => line.startsWith("#") && /\bpid\b/i.test(line) && /\bsm\b/i.test(line));
  if (!headerLine) return new Map();

  const header = headerLine
    .replace(/^#+\s*/, "")
    .split(/\s+/)
    .map((item) => item.toLowerCase());
  const pidIndex = header.indexOf("pid");
  const gpuIndex = header.indexOf("gpu");
  const smIndex = header.indexOf("sm");
  const memIndex = header.indexOf("mem");
  if (pidIndex === -1 || smIndex === -1) return new Map();

  const processes = new Map();
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const columns = line.split(/\s+/);
    const pid = Number(columns[pidIndex]);
    const sm = Number(columns[smIndex]);
    const mem = memIndex === -1 ? null : Number(columns[memIndex]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(sm)) continue;
    addProcessSample(processes, pid, {
      device: gpuIndex === -1 ? null : columns[gpuIndex],
      gpuPercent: sm,
      gpuMemoryPercent: Number.isFinite(mem) ? mem : null,
    });
  }
  return processes;
}

function parseWindowsGpuEngineJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return new Map();
  let rows;
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return new Map();
  }

  const processes = new Map();
  for (const row of rows) {
    const name = String(row?.Name || row?.name || "");
    const match = name.match(/pid_(\d+)/i);
    const value = Number(row?.UtilizationPercentage ?? row?.utilizationPercentage ?? row?.Value);
    if (!match || !Number.isFinite(value)) continue;
    addProcessSample(processes, Number(match[1]), { gpuPercent: value });
  }
  return processes;
}

async function queryNvidia() {
  const { stdout } = await execFileAsync("nvidia-smi", ["pmon", "-c", "1", "-s", "um"], {
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return {
    available: true,
    source: "nvidia-smi",
    processes: parseNvidiaPmon(stdout),
    error: null,
  };
}

async function queryWindowsGpuEngines() {
  if (process.platform !== "win32") throw new Error("Windows GPU counters are not available.");
  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name, UtilizationPercentage",
    "if ($null -eq $rows) { '[]' } else { $rows | ConvertTo-Json -Compress }",
  ].join("; ");
  const { stdout } = await execFileAsync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  return {
    available: true,
    source: "windows-gpu-engine",
    processes: parseWindowsGpuEngineJson(stdout),
    error: null,
  };
}

class ProcessGpuMonitor {
  constructor(options = {}) {
    this.refreshMs = Math.max(5_000, Number(options.refreshMs || DEFAULT_REFRESH_MS));
    this.nvidiaProvider = options.nvidiaProvider || queryNvidia;
    this.windowsProvider = options.windowsProvider || queryWindowsGpuEngines;
    this.lastSampleAt = 0;
    this.lastResult = {
      available: false,
      source: null,
      checkedAt: null,
      error: null,
      processes: new Map(),
    };
    this.refreshing = null;
  }

  async sample(pids = []) {
    const wanted = new Set(
      (Array.isArray(pids) ? pids : [])
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    const now = Date.now();
    if (this.lastSampleAt && now - this.lastSampleAt < this.refreshMs)
      return this._filteredResult(wanted);
    if (this.refreshing) {
      await this.refreshing;
      return this._filteredResult(wanted);
    }

    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this._filteredResult(wanted);
  }

  _filteredResult(wanted) {
    const processes = new Map();
    for (const [pid, stats] of this.lastResult.processes || []) {
      if (!wanted.size || wanted.has(pid))
        processes.set(pid, {
          ...stats,
          gpuDevices: [...(stats.gpuDevices || [])],
        });
    }
    return { ...this.lastResult, processes };
  }

  async _refresh() {
    const checkedAt = new Date().toISOString();
    const errors = [];
    let result = null;
    try {
      result = await this.nvidiaProvider();
    } catch (error) {
      errors.push(`nvidia-smi: ${error.message}`);
    }

    if (!result && process.platform === "win32") {
      try {
        result = await this.windowsProvider();
      } catch (error) {
        errors.push(`Windows GPU counters: ${error.message}`);
      }
    }

    this.lastSampleAt = Date.now();
    this.lastResult = result
      ? { ...result, checkedAt, processes: result.processes || new Map() }
      : {
          available: false,
          source: null,
          checkedAt,
          error: errors.join(" | ") || "No supported per-process GPU telemetry provider was found.",
          processes: new Map(),
        };
    return this.lastResult;
  }
}

module.exports = {
  ProcessGpuMonitor,
  addProcessSample,
  clampPercent,
  parseNvidiaPmon,
  parseWindowsGpuEngineJson,
  queryNvidia,
  queryWindowsGpuEngines,
};
