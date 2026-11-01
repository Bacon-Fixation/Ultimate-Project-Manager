"use strict";

const assert = require("assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pm2HistoryStore, normalizeLegacyCpuSample } = require("../src/pm2/pm2-history-store");

async function main() {
  const migrated = normalizeLegacyCpuSample({ kind: "sample", cpu: 240 });
  assert.equal(migrated.cpuRawPercent, 240);
  assert.ok(migrated.cpu >= 0 && migrated.cpu <= 100);
  assert.ok(migrated.cpuLogicalCpus >= 1);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pm2-history-test-"));
  const file = path.join(dir, "history.jsonl");
  const store = new Pm2HistoryStore({ file, sampleIntervalMs: 10000 });
  await store.init();

  const base = Date.now() - 120000;
  const project = {
    projectId: "project-a",
    monitored: true,
    processes: [
      {
        id: 2,
        name: "api",
        namespace: "default",
        status: "online",
        pid: 100,
        cpu: 2.5,
        cpuRawPercent: 20,
        cpuLogicalCpus: 8,
        gpuPercent: 15,
        gpuRawPercent: 15,
        gpuMemoryPercent: 6,
        httpRequestsPerSecond: 1.5,
        httpRequestsPerMinute: 90,
        httpMeanLatencyMs: 11,
        httpP95LatencyMs: 25,
        activeRequests: 2,
        memoryBytes: 20 * 1024 * 1024,
        uptimeMs: 60000,
        restarts: 1,
        unstableRestarts: 0,
        startedAt: new Date(base - 60000).toISOString(),
        execMode: "fork_mode",
        instances: 1,
        cwd: "/srv/api",
        script: "/srv/api/index.js",
        nodeVersion: "22.0.0",
        version: "1.4.0",
      },
    ],
  };

  await store.recordSnapshot(
    {
      checkedAt: new Date(base).toISOString(),
      global: { daemonPid: 900 },
      projects: [project],
    },
    { force: true },
  );
  project.processes[0].cpu = 8.5;
  project.processes[0].cpuRawPercent = 68;
  project.processes[0].gpuPercent = 42;
  project.processes[0].httpRequestsPerSecond = 3.25;
  project.processes[0].httpRequestsPerMinute = 195;
  project.processes[0].httpMeanLatencyMs = 14;
  project.processes[0].httpP95LatencyMs = 44;
  project.processes[0].memoryBytes = 32 * 1024 * 1024;
  project.processes[0].uptimeMs = 120000;
  project.processes[0].restarts = 2;
  await store.recordSnapshot(
    {
      checkedAt: new Date(base + 60000).toISOString(),
      global: { daemonPid: 900 },
      projects: [project],
    },
    { force: true },
  );
  await store.recordEvent({
    timestamp: new Date(base + 61000).toISOString(),
    eventType: "process-restart",
    severity: "warning",
    unexpected: true,
    message: "api restarted",
    projectIds: ["project-a"],
    process: project.processes[0],
    restartDelta: 1,
  });
  await store.recordEvent({
    timestamp: new Date(base + 62000).toISOString(),
    eventType: "daemon-restart",
    severity: "warning",
    unexpected: true,
    message: "daemon restarted",
    projectIds: ["project-a"],
    daemonPid: 901,
    previousDaemonPid: 900,
  });

  const history = store.queryProject("project-a", {
    range: "24h",
    processKey: "default:api:2",
    maxPoints: 120,
  });
  assert.equal(history.summary.peakCpu, 8.5);
  assert.equal(history.summary.peakRawCpu, 68);
  assert.equal(history.summary.peakGpu, 42);
  assert.equal(history.summary.peakHttpRequestsPerSecond, 3.25);
  assert.equal(history.summary.peakHttpP95LatencyMs, 44);
  assert.equal(history.summary.peakMemoryBytes, 32 * 1024 * 1024);
  assert.equal(history.summary.unexpectedRestarts, 1);
  assert.equal(history.summary.daemonRestarts, 1);
  assert.equal(history.processes.length, 1);
  assert.ok(history.points.length >= 1);
  assert.ok(history.points.some((point) => point.unexpectedRestarts === 1));
  assert.ok(history.points.some((point) => point.daemonRestarts === 1));
  assert.ok(history.points.some((point) => point.gpuPeak === 42));
  assert.ok(history.points.some((point) => point.httpRequestsPeakPerSecond === 3.25));
  assert.ok(history.points.some((point) => point.httpP95LatencyMs === 44));
  assert.equal(history.snapshots.length, 2);
  assert.equal(history.snapshots[0].script, "/srv/api/index.js");
  assert.equal(history.snapshots[0].nodeVersion, "22.0.0");
  assert.equal(history.snapshots[0].version, "1.4.0");
  assert.equal(history.snapshots[0].execMode, "fork_mode");
  assert.equal(history.snapshots[0].cpuRawPercent, 68);
  assert.equal(history.snapshots[0].gpuPercent, 42);
  assert.equal(history.snapshots[0].httpRequestsPerSecond, 3.25);
  assert.equal(history.snapshots[0].httpP95LatencyMs, 44);

  const summary = store.getSummary(null, "24h");
  assert.equal(summary.unexpectedRestarts, 1);
  assert.equal(summary.daemonRestarts, 1);

  await store.clearProject("project-a");
  assert.equal(store.queryProject("project-a", { range: "24h" }).summary.sampleCount, 0);
  await store.shutdown();
  await fsp.rm(dir, { recursive: true, force: true });
  console.log("PM2 history test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
