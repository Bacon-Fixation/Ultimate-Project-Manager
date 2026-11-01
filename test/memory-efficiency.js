"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { atomicWriteFile } = require("../src/filesystem/atomic-file");
const { Pm2HistoryStore } = require("../src/pm2/pm2-history-store");
const { HostStatsMonitor } = require("../src/system/host-stats-monitor");
const { BackupManager } = require("../src/manager/backup-manager");

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-memory-"));
  try {
    const target = path.join(root, "atomic.txt");
    await atomicWriteFile(target, "original");
    async function* broken() {
      yield "partial";
      throw new Error("stream interrupted");
    }
    await assert.rejects(atomicWriteFile(target, broken(), { backup: true }), /interrupted/);
    assert.equal(await fsp.readFile(target, "utf8"), "original");
    async function* complete() {
      yield "first\n";
      yield "second\n";
    }
    await atomicWriteFile(target, complete(), { backup: true });
    assert.equal(await fsp.readFile(target, "utf8"), "first\nsecond\n");
    assert.equal(await fsp.readFile(`${target}.bak`, "utf8"), "original");

    const file = path.join(root, "history.jsonl");
    const timestamp = new Date().toISOString();
    const sample = {
      kind: "sample",
      timestamp,
      projectId: "p1",
      cpu: 7,
      cpuRawPercent: 14,
      script: "路".repeat(30000),
    };
    await fsp.writeFile(
      file,
      [
        JSON.stringify({ ...sample, timestamp: "2000-01-01" }),
        "broken",
        JSON.stringify(sample),
        JSON.stringify({ ...sample, cpu: 9 }),
      ].join("\r\n"),
    );
    const store = await new Pm2HistoryStore({ file }).init();
    assert.equal(store.records.length, 2);
    assert.equal(
      store.records[0].script,
      sample.script,
      "multibyte strings crossing stream chunks survive",
    );
    const compact = store.compact(true);
    const append = store.recordEvent({ message: "appended during compaction", projectIds: ["p1"] });
    await Promise.all([compact, append]);
    await store.shutdown();
    const restored = await new Pm2HistoryStore({ file }).init();
    assert.equal(restored.records.length, 3);
    assert.equal(restored.records[2].message, "appended during compaction");
    await restored.shutdown();

    const monitor = new HostStatsMonitor({ dataDir: root });
    monitor.history = Array.from({ length: 1200 }, (_, i) => ({
      timestamp,
      cpuPercent: i % 101,
      memoryPercent: 60,
      coreCpuPercent: [i % 101, null],
      processRssBytes: 1000,
      usedMemoryBytes: 2000,
    }));
    const raw = monitor.getHistory(24);
    const chart = monitor.getHistory(24, { maxPoints: 120 });
    assert.equal(raw.points.length, 1200);
    assert.equal(chart.points.length, 120);
    assert.equal(chart.sourcePointCount, 1200);
    assert.deepEqual(chart.summary, raw.summary, "summaries use all original samples");
    assert.equal(chart.points[0].cpuPercent, 4.5);
    assert.equal(chart.points[0].coreCpuPercent[1], null);
    assert.equal(monitor.history.length, 1200, "chart aggregation never deletes raw samples");

    const manager = Object.create(BackupManager.prototype);
    manager.diffCache = new Map([["expired", { expiresAt: 0, value: {} }]]);
    for (let i = 0; i < 20; i += 1)
      manager.diffCache.set(`p${i}`, { expiresAt: Date.now() + 10000, value: {} });
    manager._pruneDiffCache();
    assert.equal(manager.diffCache.size, 8);
    assert.equal(manager.diffCache.has("expired"), false);
    assert.equal(manager.diffCache.has("p19"), true);

    const source = await fsp.readFile(path.join(__dirname, "../public/app.js"), "utf8");
    let release;
    let calls = 0;
    const context = vm.createContext({
      state: { refreshPending: null },
      refreshDashboard: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    vm.runInContext(
      source.slice(
        source.indexOf("function refresh() {"),
        source.indexOf("async function refreshDashboard() {"),
      ),
      context,
    );
    const first = context.refresh();
    const second = context.refresh();
    assert.equal(first, second);
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(context.state.refreshPending, null);

    let historyCalls = 0;
    const historyContext = vm.createContext({
      state: { hostHistoryLoadedAt: 0 },
      Date,
      $: () => ({ value: "24" }),
      api: async () => {
        historyCalls += 1;
        return { history: {} };
      },
      renderHostHistory: () => {},
    });
    vm.runInContext(
      source.slice(
        source.indexOf("async function loadHostHistory("),
        source.indexOf("function filesystemPercent("),
      ),
      historyContext,
    );
    await Promise.all([historyContext.loadHostHistory(), historyContext.loadHostHistory()]);
    assert.equal(historyCalls, 1);
    await historyContext.loadHostHistory();
    assert.equal(historyCalls, 1, "unchanged host history is cached for a minute");
    assert.ok(fs.existsSync(file));
    console.log("Memory efficiency regression tests passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
