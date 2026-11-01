"use strict";

const assert = require("node:assert/strict");
const {
  DockerRuntimeMonitor,
  parseDockerInfo,
  parseWindowsService,
  taskListHasDockerDesktop,
  normalizeContainerNames,
  parseContainerInspect,
} = require("../src/system/docker-runtime-monitor");

async function main() {
  assert.deepEqual(parseWindowsService("STATE              : 4  RUNNING"), {
    installed: true,
    state: "RUNNING",
    running: true,
  });
  assert.equal(
    taskListHasDockerDesktop('"Docker Desktop.exe","1234","Console","1","100,000 K"'),
    true,
  );
  assert.equal(
    taskListHasDockerDesktop("INFO: No tasks are running which match the specified criteria."),
    false,
  );
  assert.equal(
    parseDockerInfo('{"ServerVersion":"28.0.1","Containers":4,"ContainersRunning":2}')
      .serverVersion,
    "28.0.1",
  );

  assert.deepEqual(normalizeContainerNames(["redis", "db-1", "redis", "abc123"]), [
    "redis",
    "db-1",
    "abc123",
  ]);
  assert.throws(() => normalizeContainerNames(["--format"]), /Invalid Docker container/);

  const inspected = parseContainerInspect(
    JSON.stringify([
      {
        Id: "abcdef1234567890",
        Name: "/redis",
        State: { Status: "running", Running: true },
      },
      {
        Id: "123456abcdef7890",
        Name: "/database",
        State: {
          Status: "running",
          Running: true,
          Health: { Status: "starting" },
        },
      },
    ]),
    ["redis", "database"],
  );
  assert.equal(inspected[0].ready, true);
  assert.equal(inspected[0].healthcheck, false);
  assert.equal(inspected[1].ready, false);
  assert.equal(inspected[1].healthStatus, "starting");

  const ready = new DockerRuntimeMonitor({
    platform: "win32",
    execFileAsync: async (file) => {
      if (file === "docker.exe") {
        return {
          stdout: JSON.stringify({
            ServerVersion: "28.0.1",
            OperatingSystem: "Docker Desktop",
            Name: "docker-desktop",
            Containers: 4,
            ContainersRunning: 2,
          }),
          stderr: "",
        };
      }
      if (file === "sc.exe") return { stdout: "STATE              : 4  RUNNING", stderr: "" };
      if (file === "tasklist.exe") {
        return { stdout: '"Docker Desktop.exe","1234","Console","1","100,000 K"', stderr: "" };
      }
      throw new Error(`Unexpected command: ${file}`);
    },
  });
  const dependencyMonitor = new DockerRuntimeMonitor({
    platform: "linux",
    execFileAsync: async (file, args) => {
      assert.equal(file, "docker");
      assert.deepEqual(args, ["inspect", "--type=container", "redis", "database"]);
      return {
        stdout: JSON.stringify([
          { Id: "a".repeat(64), Name: "/redis", State: { Status: "running", Running: true } },
          {
            Id: "b".repeat(64),
            Name: "/database",
            State: { Status: "running", Running: true, Health: { Status: "healthy" } },
          },
        ]),
        stderr: "",
      };
    },
  });
  const dependencies = await dependencyMonitor.inspectContainers(["redis", "database"]);
  assert.equal(dependencies.ready, true);
  assert.equal(dependencies.containers.length, 2);

  const readyStatus = await ready.refresh();
  assert.equal(readyStatus.daemonReady, true);
  assert.equal(readyStatus.running, true);
  assert.equal(readyStatus.serviceRunning, true);
  assert.equal(readyStatus.desktopProcessRunning, true);
  assert.equal(readyStatus.state, "ready");
  assert.equal(readyStatus.serverVersion, "28.0.1");

  const starting = new DockerRuntimeMonitor({
    platform: "win32",
    execFileAsync: async (file) => {
      if (file === "docker.exe") {
        const error = new Error("error during connect");
        error.stderr = "error during connect: Docker daemon is not ready";
        throw error;
      }
      if (file === "sc.exe") return { stdout: "STATE              : 4  RUNNING", stderr: "" };
      if (file === "tasklist.exe") return { stdout: '"Docker Desktop.exe","1234"', stderr: "" };
      throw new Error(`Unexpected command: ${file}`);
    },
  });
  const startingStatus = await starting.refresh();
  assert.equal(startingStatus.daemonReady, false);
  assert.equal(startingStatus.running, true);
  assert.equal(startingStatus.state, "starting");

  const missing = new DockerRuntimeMonitor({
    platform: "win32",
    execFileAsync: async (file) => {
      if (file === "docker.exe") {
        const error = new Error("spawn docker.exe ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      if (file === "sc.exe") {
        const error = new Error("OpenService FAILED 1060: The specified service does not exist.");
        error.stderr = error.message;
        throw error;
      }
      if (file === "tasklist.exe") {
        return {
          stdout: "INFO: No tasks are running which match the specified criteria.",
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${file}`);
    },
  });
  const missingStatus = await missing.refresh();
  assert.equal(missingStatus.daemonReady, false);
  assert.equal(missingStatus.running, false);
  assert.equal(missingStatus.cliAvailable, false);
  assert.equal(missingStatus.serviceInstalled, false);
  assert.equal(missingStatus.state, "not-installed");

  console.log("Docker runtime monitor tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
