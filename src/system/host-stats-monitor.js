"use strict";

const os = require("os");
const path = require("path");
const { atomicWriteJson, readJsonRecoverable } = require("../filesystem/atomic-file");

function cpuTimes(cpu) {
  const times = cpu?.times || {};
  return {
    idle: Number(times.idle || 0),
    total: Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0),
  };
}

function cpuSnapshot() {
  const cores = os.cpus().map(cpuTimes);
  return cores.reduce(
    (total, core) => {
      total.idle += core.idle;
      total.total += core.total;
      return total;
    },
    { idle: 0, total: 0, cores },
  );
}

function cpuPercentBetween(previous, next) {
  const totalDelta = Number(next?.total || 0) - Number(previous?.total || 0);
  const idleDelta = Number(next?.idle || 0) - Number(previous?.idle || 0);
  return totalDelta > 0 ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100) : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function normalizePercent(value) {
  if (value === null || value === undefined || value === "") return null;
  return clampPercent(Number(value));
}

class HostStatsMonitor {
  constructor({ dataDir, sampleIntervalMs = 60000, retentionHours = 168 } = {}) {
    this.file = path.join(dataDir, "host-stats-history.json");
    this.sampleIntervalMs = Math.max(10000, Number(sampleIntervalMs) || 60000);
    this.retentionMs = Math.max(24, Number(retentionHours) || 168) * 60 * 60 * 1000;
    this.history = [];
    this.timer = null;
    this.lastCpu = cpuSnapshot();
    this.current = this.readCurrent(null);
    this.writePending = Promise.resolve();
  }

  async init() {
    try {
      const parsed = await readJsonRecoverable(this.file, [], {
        recover: true,
        validator: Array.isArray,
      });
      this.history = parsed.filter((item) => item && item.timestamp);
    } catch (error) {
      console.warn("Unable to read host stats history:", error.message);
    }
    await this.sample();
    this.timer = setInterval(
      () =>
        this.sample().catch((error) => console.warn("Host stats sample failed:", error.message)),
      this.sampleIntervalMs,
    );
    this.timer.unref?.();
    return this;
  }

  readCurrent(cpuPercent, coreCpuPercent = []) {
    const cpus = os.cpus();
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
    const processMemory = process.memoryUsage();
    return {
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model?.trim() || "Unknown CPU",
      logicalCpus: cpus.length,
      cpuPercent: clampPercent(cpuPercent),
      coreCpuPercent: cpus.map((_, index) => normalizePercent(coreCpuPercent[index])),
      cpuCores: cpus.map((cpu, index) => ({
        index,
        model: cpu?.model?.trim() || null,
        speedMhz: Number.isFinite(Number(cpu?.speed)) ? Number(cpu.speed) : null,
        percent: normalizePercent(coreCpuPercent[index]),
      })),
      totalMemoryBytes,
      freeMemoryBytes,
      usedMemoryBytes,
      memoryPercent: totalMemoryBytes
        ? clampPercent((usedMemoryBytes / totalMemoryBytes) * 100)
        : null,
      systemUptimeMs: os.uptime() * 1000,
      processUptimeMs: process.uptime() * 1000,
      processRssBytes: processMemory.rss,
      processHeapUsedBytes: processMemory.heapUsed,
      loadAverage: os.loadavg(),
      nodeVersion: process.version,
    };
  }

  async sample() {
    const nextCpu = cpuSnapshot();
    const cpuPercent = cpuPercentBetween(this.lastCpu, nextCpu);
    const coreCpuPercent = nextCpu.cores.map((core, index) =>
      cpuPercentBetween(this.lastCpu.cores?.[index], core),
    );
    this.lastCpu = nextCpu;
    this.current = this.readCurrent(cpuPercent, coreCpuPercent);
    this.history.push({
      timestamp: this.current.timestamp,
      cpuPercent: this.current.cpuPercent,
      coreCpuPercent: this.current.coreCpuPercent,
      memoryPercent: this.current.memoryPercent,
      usedMemoryBytes: this.current.usedMemoryBytes,
      processRssBytes: this.current.processRssBytes,
    });
    const cutoff = Date.now() - this.retentionMs;
    this.history = this.history.filter((item) => new Date(item.timestamp).getTime() >= cutoff);
    this.writePending = this.writePending.then(() => this.persist()).catch(() => {});
    await this.writePending;
    return this.current;
  }

  async persist() {
    await atomicWriteJson(this.file, this.history, {
      backup: true,
      validator: Array.isArray,
    });
  }

  getCurrent() {
    return { ...this.current };
  }

  getHistory(hours = 24) {
    const safeHours = Math.max(1, Math.min(168, Number(hours) || 24));
    const cutoff = Date.now() - safeHours * 60 * 60 * 1000;
    const points = this.history.filter((item) => new Date(item.timestamp).getTime() >= cutoff);
    const summarize = (key) => {
      const values = points.map((item) => Number(item[key])).filter(Number.isFinite);
      if (!values.length) return { min: null, max: null, average: null };
      return {
        min: Math.min(...values),
        max: Math.max(...values),
        average: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    };
    const coreCount = points.reduce(
      (max, item) =>
        Math.max(max, Array.isArray(item.coreCpuPercent) ? item.coreCpuPercent.length : 0),
      Number(this.current?.logicalCpus || 0),
    );
    const coreCpuPercent = Array.from({ length: coreCount }, (_, index) => {
      const values = points
        .map((item) => normalizePercent(item.coreCpuPercent?.[index]))
        .filter(Number.isFinite);
      if (!values.length) return { index, min: null, max: null, average: null };
      return {
        index,
        min: Math.min(...values),
        max: Math.max(...values),
        average: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    });
    return {
      hours: safeHours,
      sampleIntervalMs: this.sampleIntervalMs,
      points,
      summary: {
        cpuPercent: summarize("cpuPercent"),
        coreCpuPercent,
        memoryPercent: summarize("memoryPercent"),
      },
    };
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.writePending.catch(() => {});
  }
}

module.exports = { HostStatsMonitor };
