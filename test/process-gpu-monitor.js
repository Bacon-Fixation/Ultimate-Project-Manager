"use strict";

const assert = require("assert/strict");
const {
  ProcessGpuMonitor,
  parseNvidiaPmon,
  parseWindowsGpuEngineJson,
} = require("../src/system/process-gpu-monitor");

async function main() {
  const nvidia = parseNvidiaPmon(`
# gpu        pid  type    sm   mem   enc   dec   command
# Idx          #   C/G     %     %     %     %   name
    0       1234     C    35    12     -     -   node.exe
    1       1234     C    20     8     -     -   node.exe
    0       4321     C     7     3     -     -   worker.exe
`);
  assert.equal(nvidia.get(1234).gpuPercent, 55);
  assert.equal(nvidia.get(1234).gpuRawPercent, 55);
  assert.equal(nvidia.get(1234).gpuMemoryPercent, 12);
  assert.equal(nvidia.get(1234).gpuDevices.length, 2);
  assert.equal(nvidia.get(4321).gpuPercent, 7);

  const windows = parseWindowsGpuEngineJson(
    JSON.stringify([
      {
        Name: "pid_1234_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D",
        UtilizationPercentage: 72,
      },
      {
        Name: "pid_1234_luid_0x00000000_0x00000001_phys_0_eng_1_engtype_Copy",
        UtilizationPercentage: 45,
      },
      {
        Name: "pid_777_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D",
        UtilizationPercentage: 9,
      },
    ]),
  );
  assert.equal(windows.get(1234).gpuRawPercent, 117);
  assert.equal(windows.get(1234).gpuPercent, 100);
  assert.equal(windows.get(777).gpuPercent, 9);

  let calls = 0;
  const monitor = new ProcessGpuMonitor({
    refreshMs: 60_000,
    nvidiaProvider: async () => {
      calls += 1;
      return { available: true, source: "test", error: null, processes: nvidia };
    },
  });
  const first = await monitor.sample([1234]);
  const second = await monitor.sample([4321]);
  assert.equal(calls, 1);
  assert.equal(first.processes.has(1234), true);
  assert.equal(first.processes.has(4321), false);
  assert.equal(second.processes.has(4321), true);
  assert.equal(second.processes.has(1234), false);

  console.log("Process GPU monitor test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
