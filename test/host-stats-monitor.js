"use strict";

const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { HostStatsMonitor } = require("../src/system/host-stats-monitor");

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-host-stats-"));
  const monitor = await new HostStatsMonitor({
    dataDir: root,
    sampleIntervalMs: 60000,
    retentionHours: 24,
  }).init();

  const current = monitor.getCurrent();
  assert.equal(typeof current.hostname, "string");
  assert.ok(current.logicalCpus >= 1);
  assert.equal(current.coreCpuPercent.length, current.logicalCpus);
  assert.equal(current.cpuCores.length, current.logicalCpus);
  assert.ok(
    current.coreCpuPercent.every((value) => value === null || (value >= 0 && value <= 100)),
  );
  assert.ok(current.totalMemoryBytes > 0);
  assert.ok(current.usedMemoryBytes >= 0);
  assert.ok(current.memoryPercent >= 0 && current.memoryPercent <= 100);
  assert.ok(current.systemUptimeMs > 0);
  assert.ok(current.processRssBytes > 0);

  const history = monitor.getHistory(24);
  assert.equal(history.hours, 24);
  assert.ok(history.points.length >= 1);
  assert.ok(history.summary.memoryPercent.average >= 0);
  assert.equal(history.summary.coreCpuPercent.length, current.logicalCpus);
  assert.ok(Array.isArray(history.points[0].coreCpuPercent));

  await monitor.shutdown();
  const persisted = JSON.parse(
    await fsp.readFile(path.join(root, "host-stats-history.json"), "utf8"),
  );
  assert.ok(Array.isArray(persisted));
  assert.ok(persisted.length >= 1);
  await fsp.rm(root, { recursive: true, force: true });
  console.log("Host stats monitor tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
