"use strict";

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { atomicWriteFile } = require("../filesystem/atomic-file");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_RETENTION_MS = 8 * DAY_MS;
const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000;
const MAX_QUERY_POINTS = 720;

function processKey(processInfo = {}) {
  const namespace = String(processInfo.namespace || "default");
  const name = String(processInfo.name || "unknown");
  const id = Number.isFinite(Number(processInfo.id)) ? Number(processInfo.id) : "na";
  return `${namespace}:${name}:${id}`;
}

function parseRange(value) {
  const text = String(value || "24h").toLowerCase();
  if (text === "7d") return { key: "7d", ms: 7 * DAY_MS };
  return { key: "24h", ms: DAY_MS };
}

function normalizeLegacyCpuSample(item) {
  if (!item || item.kind !== "sample" || item.cpuRawPercent != null) return item;
  const raw = Number(item.cpu);
  if (!Number.isFinite(raw)) return item;
  const logicalCpus = Math.max(1, os.cpus().length || 1);
  return {
    ...item,
    cpuRawPercent: raw,
    cpuLogicalCpus: logicalCpus,
    cpu: Math.max(0, Math.min(100, raw / logicalCpus)),
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class Pm2HistoryStore {
  constructor(options = {}) {
    this.file = path.resolve(options.file || path.join(process.cwd(), "pm2-history.jsonl"));
    this.retentionMs = Math.max(DAY_MS, Number(options.retentionMs || DEFAULT_RETENTION_MS));
    this.sampleIntervalMs = Math.max(
      10_000,
      Number(options.sampleIntervalMs || DEFAULT_SAMPLE_INTERVAL_MS),
    );
    this.records = [];
    this.lastSampleAt = 0;
    this.lastCompactAt = 0;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const cutoff = Date.now() - this.retentionMs;
      this.records = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((item) => item && new Date(item.timestamp).getTime() >= cutoff)
        .map(normalizeLegacyCpuSample);
      const lastSample = [...this.records].reverse().find((item) => item.kind === "sample");
      this.lastSampleAt = lastSample ? new Date(lastSample.timestamp).getTime() : 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.compact(true);
    return this;
  }

  _enqueue(task) {
    this.writeChain = this.writeChain.then(task, task);
    return this.writeChain;
  }

  async _append(records) {
    if (!records.length) return;
    this.records.push(...records);
    const text = records.map((item) => JSON.stringify(item)).join("\n") + "\n";
    await this._enqueue(() => fsp.appendFile(this.file, text, "utf8"));
    if (Date.now() - this.lastCompactAt >= HOUR_MS) await this.compact();
  }

  async recordSnapshot(snapshot = {}, options = {}) {
    const now = new Date(snapshot.checkedAt || Date.now()).getTime();
    const force = options.force === true;
    if (!force && this.lastSampleAt && now - this.lastSampleAt < this.sampleIntervalMs)
      return false;
    this.lastSampleAt = now;

    const timestamp = new Date(now).toISOString();
    const daemonPid = numberOrNull(snapshot.global?.daemonPid);
    const records = [];
    for (const project of snapshot.projects || []) {
      if (!project.monitored) continue;
      for (const proc of project.processes || []) {
        records.push({
          kind: "sample",
          timestamp,
          projectId: project.projectId,
          processKey: processKey(proc),
          pm2Id: numberOrNull(proc.id),
          name: proc.name,
          namespace: proc.namespace || "default",
          status: proc.status || "unknown",
          pid: numberOrNull(proc.pid),
          startedAt: proc.startedAt || null,
          execMode: proc.execMode || null,
          instances: numberOrNull(proc.instances),
          cwd: proc.cwd || null,
          script: proc.script || null,
          nodeVersion: proc.nodeVersion || null,
          version: proc.version || null,
          cpu: numberOrNull(proc.cpu),
          cpuRawPercent: numberOrNull(proc.cpuRawPercent),
          cpuLogicalCpus: numberOrNull(proc.cpuLogicalCpus),
          gpuPercent: numberOrNull(proc.gpuPercent),
          gpuRawPercent: numberOrNull(proc.gpuRawPercent),
          gpuMemoryPercent: numberOrNull(proc.gpuMemoryPercent),
          httpRequestsPerSecond: numberOrNull(proc.httpRequestsPerSecond),
          httpRequestsPerMinute: numberOrNull(proc.httpRequestsPerMinute),
          httpMeanLatencyMs: numberOrNull(proc.httpMeanLatencyMs),
          httpP95LatencyMs: numberOrNull(proc.httpP95LatencyMs),
          activeRequests: numberOrNull(proc.activeRequests),
          memoryBytes: numberOrNull(proc.memoryBytes),
          uptimeMs: numberOrNull(proc.uptimeMs),
          restarts: numberOrNull(proc.restarts),
          unstableRestarts: numberOrNull(proc.unstableRestarts),
          daemonPid,
        });
      }
    }
    await this._append(records);
    return records.length > 0;
  }

  async recordEvent(event = {}) {
    const record = {
      kind: "event",
      timestamp: event.timestamp || new Date().toISOString(),
      eventType: event.eventType || "pm2-event",
      severity: event.severity || "info",
      message: event.message || "PM2 event",
      unexpected: event.unexpected === true,
      plannedAction: event.plannedAction || null,
      projectIds: Array.isArray(event.projectIds) ? event.projectIds : [],
      processKey: event.process ? processKey(event.process) : event.processKey || null,
      pm2Id: event.process ? numberOrNull(event.process.id) : numberOrNull(event.pm2Id),
      name: event.process?.name || event.name || null,
      namespace: event.process?.namespace || event.namespace || null,
      previousStatus: event.previousStatus || null,
      status: event.status || event.process?.status || null,
      restarts: numberOrNull(event.restarts ?? event.process?.restarts),
      restartDelta: numberOrNull(event.restartDelta),
      daemonPid: numberOrNull(event.daemonPid),
      previousDaemonPid: numberOrNull(event.previousDaemonPid),
    };
    await this._append([record]);
    return record;
  }

  async compact(force = false) {
    const now = Date.now();
    if (!force && now - this.lastCompactAt < HOUR_MS) return false;
    this.lastCompactAt = now;
    const cutoff = now - this.retentionMs;
    this.records = this.records.filter((item) => new Date(item.timestamp).getTime() >= cutoff);
    const text = this.records.map((item) => JSON.stringify(item)).join("\n");
    await this._enqueue(() =>
      atomicWriteFile(this.file, text ? `${text}\n` : "", {
        encoding: "utf8",
        backup: true,
      }),
    );
    return true;
  }

  _eventsFor(projectId, cutoff) {
    return this.records.filter(
      (item) =>
        item.kind === "event" &&
        new Date(item.timestamp).getTime() >= cutoff &&
        (!projectId || (item.projectIds || []).includes(projectId)),
    );
  }

  getSummary(projectId = null, rangeValue = "24h") {
    const range = parseRange(rangeValue);
    const cutoff = Date.now() - range.ms;
    const samples = this.records.filter(
      (item) =>
        item.kind === "sample" &&
        new Date(item.timestamp).getTime() >= cutoff &&
        (!projectId || item.projectId === projectId),
    );
    const events = this._eventsFor(projectId, cutoff);

    return {
      range: range.key,
      sampleCount: samples.length,
      processCount: new Set(samples.map((item) => `${item.projectId}:${item.processKey}`)).size,
      peakCpu: samples.reduce((max, item) => (item.cpu == null ? max : Math.max(max, item.cpu)), 0),
      peakRawCpu: samples.reduce(
        (max, item) => (item.cpuRawPercent == null ? max : Math.max(max, item.cpuRawPercent)),
        0,
      ),
      peakGpu: samples.reduce(
        (max, item) => (item.gpuPercent == null ? max : Math.max(max, item.gpuPercent)),
        0,
      ),
      peakHttpRequestsPerSecond: samples.reduce(
        (max, item) =>
          item.httpRequestsPerSecond == null ? max : Math.max(max, item.httpRequestsPerSecond),
        0,
      ),
      peakHttpP95LatencyMs: samples.reduce(
        (max, item) => (item.httpP95LatencyMs == null ? max : Math.max(max, item.httpP95LatencyMs)),
        0,
      ),
      peakMemoryBytes: samples.reduce(
        (max, item) => (item.memoryBytes == null ? max : Math.max(max, item.memoryBytes)),
        0,
      ),
      maxUptimeMs: samples.reduce(
        (max, item) => (item.uptimeMs == null ? max : Math.max(max, item.uptimeMs)),
        0,
      ),
      maxRestartCounter: samples.reduce(
        (max, item) => (item.restarts == null ? max : Math.max(max, item.restarts)),
        0,
      ),
      crashes: events.filter(
        (item) =>
          ["process-crash", "process-down", "process-missing"].includes(item.eventType) &&
          item.unexpected,
      ).length,
      restartEvents: events.filter((item) => item.eventType === "process-restart").length,
      unexpectedRestarts: events.filter(
        (item) => item.eventType === "process-restart" && item.unexpected,
      ).length,
      daemonRestarts: events.filter((item) => item.eventType === "daemon-restart").length,
      eventCount: events.length,
    };
  }

  queryProject(projectId, options = {}) {
    const range = parseRange(options.range);
    const cutoff = Date.now() - range.ms;
    const processFilter = options.processKey ? String(options.processKey) : null;
    const maxPoints = Math.max(60, Math.min(MAX_QUERY_POINTS, Number(options.maxPoints) || 360));
    const samples = this.records.filter(
      (item) =>
        item.kind === "sample" &&
        item.projectId === projectId &&
        new Date(item.timestamp).getTime() >= cutoff &&
        (!processFilter || item.processKey === processFilter),
    );
    const events = this._eventsFor(projectId, cutoff)
      .filter((item) => !processFilter || !item.processKey || item.processKey === processFilter)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const processMap = new Map();
    for (const item of this.records) {
      if (
        item.kind !== "sample" ||
        item.projectId !== projectId ||
        new Date(item.timestamp).getTime() < cutoff
      )
        continue;
      if (!processMap.has(item.processKey)) {
        processMap.set(item.processKey, {
          processKey: item.processKey,
          pm2Id: item.pm2Id,
          name: item.name,
          namespace: item.namespace,
          sampleCount: 0,
          lastSeenAt: item.timestamp,
        });
      }
      const proc = processMap.get(item.processKey);
      proc.sampleCount += 1;
      if (new Date(item.timestamp) > new Date(proc.lastSeenAt)) proc.lastSeenAt = item.timestamp;
    }

    const bucketMs = Math.max(this.sampleIntervalMs, Math.ceil(range.ms / maxPoints));
    const buckets = new Map();
    const eventBuckets = new Map();
    for (const item of samples) {
      const time = new Date(item.timestamp).getTime();
      const bucket = Math.floor(time / bucketMs) * bucketMs;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(item);
    }
    for (const event of events) {
      const time = new Date(event.timestamp).getTime();
      const bucket = Math.floor(time / bucketMs) * bucketMs;
      if (!eventBuckets.has(bucket))
        eventBuckets.set(bucket, {
          processCrashes: 0,
          unexpectedRestarts: 0,
          daemonRestarts: 0,
        });
      const target = eventBuckets.get(bucket);
      if (
        ["process-crash", "process-down", "process-missing"].includes(event.eventType) &&
        event.unexpected
      )
        target.processCrashes += 1;
      if (event.eventType === "process-restart" && event.unexpected) target.unexpectedRestarts += 1;
      if (event.eventType === "daemon-restart") target.daemonRestarts += 1;
    }

    const bucketKeys = [...new Set([...buckets.keys(), ...eventBuckets.keys()])].sort(
      (a, b) => a - b,
    );
    const points = bucketKeys.map((bucket) => {
      const items = buckets.get(bucket) || [];
      const bucketEvents = eventBuckets.get(bucket) || {
        processCrashes: 0,
        unexpectedRestarts: 0,
        daemonRestarts: 0,
      };
      const numeric = (key) =>
        items
          .map((item) => item[key])
          .filter((value) => Number.isFinite(Number(value)))
          .map(Number);
      const cpus = numeric("cpu");
      const rawCpus = numeric("cpuRawPercent");
      const gpus = numeric("gpuPercent");
      const httpRates = numeric("httpRequestsPerSecond");
      const httpMeans = numeric("httpMeanLatencyMs");
      const httpP95s = numeric("httpP95LatencyMs");
      const memories = numeric("memoryBytes");
      const uptimes = numeric("uptimeMs");
      const restarts = numeric("restarts");
      const latest = items[items.length - 1];
      return {
        timestamp: new Date(bucket).toISOString(),
        cpuAverage: cpus.length ? cpus.reduce((sum, value) => sum + value, 0) / cpus.length : null,
        cpuPeak: cpus.length ? Math.max(...cpus) : null,
        cpuRawPeak: rawCpus.length ? Math.max(...rawCpus) : null,
        gpuAverage: gpus.length ? gpus.reduce((sum, value) => sum + value, 0) / gpus.length : null,
        gpuPeak: gpus.length ? Math.max(...gpus) : null,
        httpRequestsAveragePerSecond: httpRates.length
          ? httpRates.reduce((sum, value) => sum + value, 0) / httpRates.length
          : null,
        httpRequestsPeakPerSecond: httpRates.length ? Math.max(...httpRates) : null,
        httpMeanLatencyMs: httpMeans.length
          ? httpMeans.reduce((sum, value) => sum + value, 0) / httpMeans.length
          : null,
        httpP95LatencyMs: httpP95s.length ? Math.max(...httpP95s) : null,
        memoryAverageBytes: memories.length
          ? memories.reduce((sum, value) => sum + value, 0) / memories.length
          : null,
        memoryPeakBytes: memories.length ? Math.max(...memories) : null,
        uptimeMs: uptimes.length ? Math.max(...uptimes) : null,
        restarts: restarts.length ? Math.max(...restarts) : null,
        status: latest?.status || "unknown",
        sampleCount: items.length,
        processCrashes: bucketEvents.processCrashes,
        unexpectedRestarts: bucketEvents.unexpectedRestarts,
        daemonRestarts: bucketEvents.daemonRestarts,
      };
    });

    const filteredSummarySamples = processFilter
      ? samples
      : this.records.filter(
          (item) =>
            item.kind === "sample" &&
            item.projectId === projectId &&
            new Date(item.timestamp).getTime() >= cutoff,
        );
    const summaryEvents = events;
    const summary = {
      range: range.key,
      sampleCount: filteredSummarySamples.length,
      peakCpu: filteredSummarySamples.reduce(
        (max, item) => (item.cpu == null ? max : Math.max(max, item.cpu)),
        0,
      ),
      peakRawCpu: filteredSummarySamples.reduce(
        (max, item) => (item.cpuRawPercent == null ? max : Math.max(max, item.cpuRawPercent)),
        0,
      ),
      peakGpu: filteredSummarySamples.reduce(
        (max, item) => (item.gpuPercent == null ? max : Math.max(max, item.gpuPercent)),
        0,
      ),
      peakHttpRequestsPerSecond: filteredSummarySamples.reduce(
        (max, item) =>
          item.httpRequestsPerSecond == null ? max : Math.max(max, item.httpRequestsPerSecond),
        0,
      ),
      peakHttpP95LatencyMs: filteredSummarySamples.reduce(
        (max, item) => (item.httpP95LatencyMs == null ? max : Math.max(max, item.httpP95LatencyMs)),
        0,
      ),
      peakMemoryBytes: filteredSummarySamples.reduce(
        (max, item) => (item.memoryBytes == null ? max : Math.max(max, item.memoryBytes)),
        0,
      ),
      maxUptimeMs: filteredSummarySamples.reduce(
        (max, item) => (item.uptimeMs == null ? max : Math.max(max, item.uptimeMs)),
        0,
      ),
      maxRestartCounter: filteredSummarySamples.reduce(
        (max, item) => (item.restarts == null ? max : Math.max(max, item.restarts)),
        0,
      ),
      crashes: summaryEvents.filter(
        (item) =>
          ["process-crash", "process-down", "process-missing"].includes(item.eventType) &&
          item.unexpected,
      ).length,
      restartEvents: summaryEvents.filter((item) => item.eventType === "process-restart").length,
      unexpectedRestarts: summaryEvents.filter(
        (item) => item.eventType === "process-restart" && item.unexpected,
      ).length,
      daemonRestarts: summaryEvents.filter((item) => item.eventType === "daemon-restart").length,
      eventCount: summaryEvents.length,
    };

    const snapshots = [...samples]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 250)
      .map((item) => ({
        timestamp: item.timestamp,
        processKey: item.processKey,
        pm2Id: item.pm2Id,
        name: item.name,
        namespace: item.namespace,
        status: item.status,
        pid: item.pid,
        cpu: item.cpu,
        cpuRawPercent: item.cpuRawPercent ?? null,
        cpuLogicalCpus: item.cpuLogicalCpus ?? null,
        gpuPercent: item.gpuPercent ?? null,
        gpuRawPercent: item.gpuRawPercent ?? null,
        gpuMemoryPercent: item.gpuMemoryPercent ?? null,
        httpRequestsPerSecond: item.httpRequestsPerSecond ?? null,
        httpRequestsPerMinute: item.httpRequestsPerMinute ?? null,
        httpMeanLatencyMs: item.httpMeanLatencyMs ?? null,
        httpP95LatencyMs: item.httpP95LatencyMs ?? null,
        activeRequests: item.activeRequests ?? null,
        memoryBytes: item.memoryBytes,
        uptimeMs: item.uptimeMs,
        restarts: item.restarts,
        unstableRestarts: item.unstableRestarts,
        startedAt: item.startedAt || null,
        execMode: item.execMode || null,
        instances: item.instances ?? null,
        cwd: item.cwd || null,
        script: item.script || null,
        nodeVersion: item.nodeVersion || null,
        version: item.version || null,
        daemonPid: item.daemonPid ?? null,
      }));

    return {
      range: range.key,
      from: new Date(cutoff).toISOString(),
      to: new Date().toISOString(),
      processKey: processFilter,
      processes: [...processMap.values()].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      ),
      summary,
      points,
      events: events.slice(0, 250),
      snapshots,
      snapshotCount: samples.length,
    };
  }

  async clearProject(projectId) {
    this.records = this.records.filter(
      (item) => item.projectId !== projectId && !(item.projectIds || []).includes(projectId),
    );
    await this.compact(true);
  }

  async shutdown() {
    await this.writeChain;
    await this.compact(true);
  }
}

module.exports = {
  Pm2HistoryStore,
  parseRange,
  processKey,
  normalizeLegacyCpuSample,
};
