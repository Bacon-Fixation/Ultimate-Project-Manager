"use strict";

const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeStream(value) {
  const stream = String(value || "both")
    .trim()
    .toLowerCase();
  if (!["both", "stdout", "stderr"].includes(stream)) {
    throw new Error("PM2 log stream must be both, stdout, or stderr.");
  }
  return stream;
}

function splitTrailingLines(text, maxLines) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines);
}

async function tailFile(filePath, options = {}) {
  const lines = clampInteger(options.lines, DEFAULT_LINES, 1, MAX_LINES);
  const maxBytes = clampInteger(options.maxBytes, DEFAULT_MAX_BYTES, 4096, MAX_MAX_BYTES);
  const resolved = filePath ? path.resolve(String(filePath)) : null;

  if (!resolved) {
    return {
      configured: false,
      available: false,
      path: null,
      sizeBytes: 0,
      modifiedAt: null,
      linesRequested: lines,
      linesReturned: 0,
      truncated: false,
      content: "",
      error: null,
    };
  }

  let handle = null;
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) {
      return {
        configured: true,
        available: false,
        path: resolved,
        sizeBytes: stat.size || 0,
        modifiedAt: stat.mtime?.toISOString?.() || null,
        linesRequested: lines,
        linesReturned: 0,
        truncated: false,
        content: "",
        error: "PM2 log path is not a file.",
      };
    }

    handle = await fsp.open(resolved, "r");
    const chunks = [];
    let position = stat.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;

    while (position > 0 && bytesReadTotal < maxBytes && newlineCount <= lines) {
      const remainingBudget = maxBytes - bytesReadTotal;
      const chunkSize = Math.min(READ_CHUNK_BYTES, position, remainingBudget);
      if (chunkSize <= 0) break;

      position -= chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (!bytesRead) break;
      const slice = bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(slice);
      bytesReadTotal += bytesRead;
      for (let index = 0; index < slice.length; index += 1) {
        if (slice[index] === 0x0a) newlineCount += 1;
      }
    }

    let raw = Buffer.concat(chunks).toString("utf8");
    if (position > 0) {
      const firstNewline = raw.indexOf("\n");
      if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
    }
    const trailingLines = splitTrailingLines(raw, lines);
    const truncated = position > 0 || newlineCount > lines;

    return {
      configured: true,
      available: true,
      path: resolved,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime?.toISOString?.() || null,
      linesRequested: lines,
      linesReturned: trailingLines.length,
      truncated,
      content: trailingLines.join("\n"),
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      path: resolved,
      sizeBytes: 0,
      modifiedAt: null,
      linesRequested: lines,
      linesReturned: 0,
      truncated: false,
      content: "",
      error: error.code === "ENOENT" ? "PM2 log file does not exist yet." : error.message,
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readProcessLogs(processInfo, options = {}) {
  if (!processInfo || !Number.isFinite(Number(processInfo.id))) {
    throw new Error("A valid matched PM2 process is required.");
  }

  const stream = normalizeStream(options.stream);
  const lines = clampInteger(options.lines, DEFAULT_LINES, 1, MAX_LINES);
  const maxBytes = clampInteger(options.maxBytes, DEFAULT_MAX_BYTES, 4096, MAX_MAX_BYTES);
  const stdoutPath = processInfo.outLogPath || null;
  const stderrPath = processInfo.errLogPath || null;

  const [stdout, stderr] = await Promise.all([
    stream === "stderr" ? Promise.resolve(null) : tailFile(stdoutPath, { lines, maxBytes }),
    stream === "stdout" ? Promise.resolve(null) : tailFile(stderrPath, { lines, maxBytes }),
  ]);

  return {
    process: {
      id: Number(processInfo.id),
      name: processInfo.name,
      namespace: processInfo.namespace || "default",
      status: processInfo.status || "unknown",
      pid: Number(processInfo.pid || 0),
    },
    stream,
    lines,
    maxBytes,
    checkedAt: new Date().toISOString(),
    stdout,
    stderr,
  };
}

module.exports = {
  DEFAULT_LINES,
  MAX_LINES,
  DEFAULT_MAX_BYTES,
  MAX_MAX_BYTES,
  normalizeStream,
  splitTrailingLines,
  tailFile,
  readProcessLogs,
};
