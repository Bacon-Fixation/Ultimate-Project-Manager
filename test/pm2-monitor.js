"use strict";

const assert = require("assert/strict");
const path = require("path");
const {
  Pm2Monitor,
  pm2NodeCandidates,
  pm2NodeExecutable,
  unpackedElectronPath,
} = require("../src/pm2/pm2-monitor");

async function main() {
  assert.equal(pm2NodeExecutable({}, true), process.execPath);
  assert.equal(
    pm2NodeExecutable({ UPM_NODE_EXECUTABLE: "C:\\Node\\node.exe" }, true),
    "C:\\Node\\node.exe",
  );
  const electronCandidates = pm2NodeCandidates({ PATH: "test" }, true);
  assert.equal(electronCandidates.length, 2);
  assert.equal(electronCandidates[0].executable, process.execPath);
  assert.equal(electronCandidates[0].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(electronCandidates[0].asarAware, true);
  assert.equal(electronCandidates[1].executable, "node");
  assert.equal(electronCandidates[1].asarAware, false);
  assert.equal(pm2NodeCandidates({ UPM_NODE_EXECUTABLE: "C:\\Node\\node.exe" }, true).length, 1);
  assert.equal(
    unpackedElectronPath(
      "C:\\Program Files\\UPM\\resources\\app.asar\\node_modules\\pm2\\bin\\pm2",
      true,
    ),
    "C:\\Program Files\\UPM\\resources\\app.asar.unpacked\\node_modules\\pm2\\bin\\pm2",
  );
  assert.equal(
    unpackedElectronPath("/opt/upm/resources/app.asar/node_modules/pm2/bin/pm2", true),
    "/opt/upm/resources/app.asar.unpacked/node_modules/pm2/bin/pm2",
  );

  const parent = path.resolve("/tmp/projects/parent");
  const child = path.join(parent, "packages", "child");
  const projects = [
    {
      id: "parent",
      name: "Parent",
      projectRoot: parent,
      pm2Monitoring: true,
      pm2ControlsEnabled: true,
      pm2ProcessNames: [],
    },
    {
      id: "child",
      name: "Child",
      projectRoot: child,
      pm2Monitoring: true,
      pm2ControlsEnabled: true,
      pm2ProcessNames: [],
    },
    {
      id: "alias",
      name: "Alias",
      projectRoot: path.resolve("/tmp/elsewhere"),
      pm2Monitoring: true,
      pm2ControlsEnabled: false,
      pm2ProcessNames: ["named-worker"],
    },
  ];

  let daemonPid = 500;
  const processes = [
    {
      pm_id: 0,
      name: "parent-api",
      pid: 111,
      pm2_env: {
        status: "online",
        namespace: "default",
        pm_cwd: parent,
        pm_exec_path: path.join(parent, "server.js"),
        pm_out_log_path: path.join(parent, "logs", "out.log"),
        pm_err_log_path: path.join(parent, "logs", "error.log"),
        pm_uptime: Date.now() - 5000,
        restart_time: 2,
        exec_mode: "fork_mode",
        axm_monitor: {
          "Used Heap Size": { value: "18.50", unit: "MiB" },
          "Heap Size": { value: "40.00", unit: "MiB" },
          "Heap Usage": { value: 46.25, unit: "%" },
          "Event Loop Latency p95": { value: "2.40", unit: "ms" },
          "Active handles": { value: 7 },
          "Active requests": { value: 2 },
          HTTP: { value: 120, unit: "req/min" },
          "HTTP Mean Latency": { value: 12.5, unit: "ms" },
          "HTTP P95 Latency": { value: 31.2, unit: "ms" },
        },
      },
      monit: { cpu: 240, memory: 32 * 1024 * 1024 },
    },
    {
      pm_id: 1,
      name: "child-api",
      pid: 222,
      pm2_env: {
        status: "online",
        namespace: "default",
        pm_cwd: child,
        pm_exec_path: path.join(child, "index.js"),
        pm_uptime: Date.now() - 10000,
        restart_time: 0,
        exec_mode: "fork_mode",
      },
      monit: { cpu: 0.3, memory: 20 * 1024 * 1024 },
    },
    {
      pm_id: 2,
      name: "named-worker",
      pid: 333,
      pm2_env: {
        status: "stopped",
        namespace: "default",
        pm_cwd: path.resolve("/tmp/shared"),
        pm_exec_path: path.resolve("/tmp/shared/worker.js"),
        restart_time: 4,
        exec_mode: "fork_mode",
      },
      monit: { cpu: 0, memory: 0 },
    },
  ];

  const events = [];
  const monitor = new Pm2Monitor({
    refreshMs: 60000,
    actionDelayMs: 0,
    runner: async () => processes,
    daemonPidProvider: async () => daemonPid,
    logicalCpuCount: 8,
    gpuMonitor: {
      sample: async () => ({
        available: true,
        source: "test-gpu",
        checkedAt: new Date().toISOString(),
        error: null,
        processes: new Map([
          [
            111,
            {
              gpuPercent: 42,
              gpuRawPercent: 42,
              gpuMemoryPercent: 18,
              gpuDevices: [{ device: "0", gpuPercent: 42, gpuMemoryPercent: 18 }],
            },
          ],
        ]),
      }),
    },
    actionRunner: async (action, id) => {
      const raw = processes.find((item) => item.pm_id === id);
      if (!raw) throw new Error("missing process");
      if (action === "restart" || action === "reload") {
        raw.pm2_env.restart_time += 1;
        raw.pm2_env.pm_uptime = Date.now();
        raw.pm2_env.status = "online";
      } else if (action === "stop") raw.pm2_env.status = "stopped";
      else if (action === "start") raw.pm2_env.status = "online";
      else if (action === "reset") raw.pm2_env.restart_time = 0;
      return { stdout: `pm2 ${action} ${id}` };
    },
  });
  monitor.on("event", (event) => events.push(event));

  await monitor.start(() => projects);
  try {
    const global = monitor.getStatus();
    assert.equal(global.available, true);
    assert.equal(global.processCount, 3);
    assert.equal(global.online, 2);
    assert.equal(global.daemonPid, 500);

    const parentStatus = monitor.getProjectStatus("parent");
    assert.deepEqual(
      parentStatus.processes.map((item) => item.name),
      ["parent-api"],
    );
    assert.equal(parentStatus.controlsEnabled, true);
    assert.equal(parentStatus.processes[0].outLogPath, path.join(parent, "logs", "out.log"));
    assert.equal(parentStatus.processes[0].errLogPath, path.join(parent, "logs", "error.log"));
    assert.equal(parentStatus.processes[0].heapUsedBytes, Math.round(18.5 * 1024 * 1024));
    assert.equal(parentStatus.processes[0].heapTotalBytes, 40 * 1024 * 1024);
    assert.equal(parentStatus.processes[0].heapUsagePercent, 46.25);
    assert.equal(parentStatus.processes[0].eventLoopLatencyP95Ms, 2.4);
    assert.equal(parentStatus.processes[0].activeHandles, 7);
    assert.equal(parentStatus.processes[0].activeRequests, 2);
    assert.equal(parentStatus.processes[0].cpuRawPercent, 240);
    assert.equal(parentStatus.processes[0].cpuPercent, 30);
    assert.equal(parentStatus.processes[0].cpu, 30);
    assert.equal(parentStatus.processes[0].cpuLogicalCpus, 8);
    assert.equal(parentStatus.processes[0].gpuPercent, 42);
    assert.equal(parentStatus.processes[0].gpuMemoryPercent, 18);
    assert.equal(parentStatus.processes[0].httpRequestsPerSecond, 2);
    assert.equal(parentStatus.processes[0].httpRequestsPerMinute, 120);
    assert.equal(parentStatus.processes[0].httpMeanLatencyMs, 12.5);
    assert.equal(parentStatus.processes[0].httpP95LatencyMs, 31.2);

    const childStatus = monitor.getProjectStatus("child");
    assert.deepEqual(
      childStatus.processes.map((item) => item.name),
      ["child-api"],
    );
    assert.equal(childStatus.status, "online");

    const aliasStatus = monitor.getProjectStatus("alias");
    assert.deepEqual(
      aliasStatus.processes.map((item) => item.name),
      ["named-worker"],
    );
    assert.equal(aliasStatus.status, "degraded");

    processes[1].pm2_env.restart_time = 1;
    processes[1].pm2_env.pm_uptime = Date.now();
    daemonPid = 501;
    await monitor.refresh();
    assert.ok(events.some((event) => event.eventType === "daemon-restart" && event.unexpected));
    assert.ok(
      events.some(
        (event) =>
          event.eventType === "process-restart" &&
          event.process?.name === "child-api" &&
          event.unexpected,
      ),
    );

    const before = events.length;
    const currentParent = monitor.getProjectStatus("parent").processes[0];
    await monitor.executeAction(currentParent, "restart");
    const planned = events
      .slice(before)
      .find(
        (event) => event.eventType === "process-restart" && event.process?.name === "parent-api",
      );
    assert.ok(planned);
    assert.equal(planned.unexpected, false);
    assert.equal(planned.plannedAction, "restart");

    console.log("PM2 monitor test passed.");
  } finally {
    monitor.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
