"use strict";

// Synthetic PM2 history benchmark; never reads or modifies UPM's real data directory.
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

async function main() {
  if (process.argv[2] === "--worker") {
    const { Pm2HistoryStore } = require(path.resolve(process.argv[3]));
    global.gc?.();
    const before = process.memoryUsage();
    const started = performance.now();
    const store = await new Pm2HistoryStore({ file: process.argv[4] }).init();
    global.gc?.();
    const after = process.memoryUsage();
    console.log(
      JSON.stringify({
        records: store.records.length,
        retainedHeapMiB: Number(((after.heapUsed - before.heapUsed) / 1048576).toFixed(2)),
        peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
        durationMs: Math.round(performance.now() - started),
      }),
    );
    await store.shutdown();
    return;
  }
  const count = 24000;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-memory-benchmark-"));
  try {
    const input = path.join(root, "source.jsonl");
    const file = await fsp.open(input, "w");
    const now = Date.now();
    try {
      for (let batch = 0; batch < count; batch += 500) {
        let text = "";
        for (let i = batch; i < Math.min(batch + 500, count); i += 1) {
          const id = i % 20;
          text +=
            JSON.stringify({
              kind: "sample",
              timestamp: new Date(now - (count - i) * 1000).toISOString(),
              projectId: `project-${id}`,
              processKey: `default:project-${id}:${id}`,
              pm2Id: id,
              name: `project-${id}`,
              namespace: "default",
              status: "online",
              pid: 1000 + id,
              startedAt: new Date(now - 100000000).toISOString(),
              execMode: "fork_mode",
              instances: 1,
              cwd: `/projects/${"application-folder/".repeat(12)}project-${id}`,
              script: `/projects/${"application-folder/".repeat(12)}project-${id}/src/index.js`,
              nodeVersion: "24.0.0",
              version: "1.0.0",
              cpu: i % 100,
              cpuRawPercent: i % 100,
              cpuLogicalCpus: 16,
              memoryBytes: 100000000 + i,
              uptimeMs: 100000 + i,
              restarts: 0,
            }) + "\n";
        }
        await file.writeFile(text);
      }
    } finally {
      await file.close();
    }
    const modules = process.argv.slice(2);
    if (!modules.length) modules.push(path.join(__dirname, "../src/pm2/pm2-history-store.js"));
    const results = [];
    for (let i = 0; i < modules.length; i += 1) {
      const target = path.join(root, `history-${i}.jsonl`);
      await fsp.copyFile(input, target);
      const result = spawnSync(
        process.execPath,
        ["--expose-gc", __filename, "--worker", modules[i], target],
        { encoding: "utf8", timeout: 120000 },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr || "Benchmark worker failed");
      results.push({ module: modules[i], ...JSON.parse(result.stdout) });
    }
    console.log(
      JSON.stringify(
        {
          scenario: "24,000 PM2 samples; 20 processes; repeated long metadata paths; fresh workers",
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
