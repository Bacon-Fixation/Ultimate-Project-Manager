"use strict";

const assert = require("assert");
const net = require("net");
const http = require("http");
const {
  ServiceHealthMonitor,
  normalizeServiceHealthConfig,
  probeProjectServices,
} = require("../src/services/service-health-monitor");

async function listen(server) {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

(async () => {
  const redisServer = net.createServer((socket) => {
    socket.once("data", () => socket.end("+PONG\r\n"));
  });
  const mariaServer = net.createServer((socket) => {
    const version = Buffer.from("11.4.2-MariaDB\0", "utf8");
    const payload = Buffer.concat([Buffer.from([10]), version]);
    const packet = Buffer.alloc(4 + payload.length);
    packet.writeUIntLE(payload.length, 0, 3);
    packet[3] = 0;
    payload.copy(packet, 4);
    socket.end(packet);
  });
  const postgresServer = net.createServer((socket) => {
    socket.once("data", () => socket.end(Buffer.from("N")));
  });
  const tcpServer = net.createServer((socket) => socket.end());
  const httpServer = http.createServer((req, res) => {
    res.statusCode = req.url === "/health" ? 204 : 404;
    res.end();
  });

  const [redisPort, mariaPort, postgresPort, tcpPort, httpPort] = await Promise.all([
    listen(redisServer),
    listen(mariaServer),
    listen(postgresServer),
    listen(tcpServer),
    listen(httpServer),
  ]);

  try {
    const project = {
      id: "health-test",
      name: "Health Test",
      serviceHealth: {
        enabled: true,
        intervalSeconds: 10,
        timeoutMs: 1000,
        services: [
          { id: "redis", name: "Redis", type: "redis", host: "127.0.0.1", port: redisPort },
          { id: "mariadb", name: "MariaDB", type: "mariadb", host: "127.0.0.1", port: mariaPort },
          {
            id: "postgres",
            name: "Postgres",
            type: "postgres",
            host: "127.0.0.1",
            port: postgresPort,
          },
          { id: "tcp", name: "TCP", type: "tcp", host: "127.0.0.1", port: tcpPort },
          { id: "http", name: "HTTP", type: "http", url: `http://127.0.0.1:${httpPort}/health` },
        ],
      },
    };

    const health = await probeProjectServices(project);
    assert.equal(health.status, "healthy");
    assert.equal(health.summary.healthy, 5);
    assert.equal(health.services.find((item) => item.id === "redis").message, "PING → PONG");
    assert.match(health.services.find((item) => item.id === "mariadb").version, /MariaDB/);
    assert.equal(health.services.find((item) => item.id === "postgres").sslSupported, false);
    assert.equal(health.services.find((item) => item.id === "http").httpStatus, 204);

    const originalFetch = global.fetch;
    let responseBodyCancelled = false;
    try {
      global.fetch = async () => ({
        status: 204,
        statusText: "No Content",
        body: {
          cancel: async () => {
            responseBodyCancelled = true;
          },
        },
      });
      const cancelledProbe = await probeProjectServices({
        id: "http-cancel-test",
        name: "HTTP Cancel Test",
        serviceHealth: {
          enabled: true,
          intervalSeconds: 10,
          timeoutMs: 1000,
          services: [
            {
              id: "http-cancel",
              name: "HTTP Cancel",
              type: "http",
              url: "http://example.invalid/health",
            },
          ],
        },
      });
      assert.equal(cancelledProbe.status, "healthy");
      assert.equal(responseBodyCancelled, true);
    } finally {
      global.fetch = originalFetch;
    }

    const normalized = normalizeServiceHealthConfig({
      enabled: true,
      intervalSeconds: 1,
      timeoutMs: 999999,
      services: [{ id: "x", name: "Example", type: "tcp", host: "localhost", port: 1234 }],
    });
    assert.equal(normalized.intervalSeconds, 10);
    assert.equal(normalized.timeoutMs, 30000);

    const remoteMonitor = new ServiceHealthMonitor({
      remoteProbe: async () => ({
        enabled: true,
        checkedAt: new Date().toISOString(),
        status: "healthy",
        summary: { total: 1, enabled: 1, healthy: 1, degraded: 0, unhealthy: 0, status: "healthy" },
        services: [],
      }),
    });
    const remote = await remoteMonitor.refreshProject({
      id: "remote",
      name: "Remote",
      executionTarget: "lan",
      serviceHealth: { enabled: true, services: [] },
    });
    assert.equal(remote.status, "healthy");
    remoteMonitor.stop();

    console.log("service health monitor tests passed");
  } finally {
    await Promise.all([
      close(redisServer),
      close(mariaServer),
      close(postgresServer),
      close(tcpServer),
      close(httpServer),
    ]);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
