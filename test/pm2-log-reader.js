"use strict";

const assert = require("assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { normalizeStream, tailFile, readProcessLogs } = require("../src/pm2/pm2-log-reader");

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pm2-log-reader-"));
  try {
    const outLog = path.join(root, "app-out.log");
    const errLog = path.join(root, "app-error.log");
    await fsp.writeFile(
      outLog,
      Array.from({ length: 250 }, (_, index) => `out line ${index + 1}`).join("\n") + "\n",
      "utf8",
    );
    await fsp.writeFile(errLog, "first error\nsecond error\n", "utf8");

    assert.equal(normalizeStream("STDOUT"), "stdout");
    assert.throws(() => normalizeStream("invalid"));

    const tail = await tailFile(outLog, { lines: 3 });
    assert.equal(tail.available, true);
    assert.equal(tail.linesReturned, 3);
    assert.equal(tail.content, "out line 248\nout line 249\nout line 250");

    const missing = await tailFile(path.join(root, "missing.log"), {
      lines: 10,
    });
    assert.equal(missing.configured, true);
    assert.equal(missing.available, false);

    const logs = await readProcessLogs(
      {
        id: 2,
        name: "demo",
        namespace: "default",
        status: "online",
        pid: 1234,
        outLogPath: outLog,
        errLogPath: errLog,
      },
      { lines: 2, stream: "both" },
    );

    assert.equal(logs.process.id, 2);
    assert.equal(logs.stdout.content, "out line 249\nout line 250");
    assert.equal(logs.stderr.content, "first error\nsecond error");

    const stdoutOnly = await readProcessLogs(
      {
        id: 2,
        name: "demo",
        outLogPath: outLog,
        errLogPath: errLog,
      },
      { lines: 1, stream: "stdout" },
    );
    assert.equal(stdoutOnly.stderr, null);
    assert.equal(stdoutOnly.stdout.content, "out line 250");

    console.log("PM2 log reader test passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
