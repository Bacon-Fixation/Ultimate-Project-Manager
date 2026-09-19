"use strict";

const crypto = require("crypto");

const MAX_CONNECTIONS = 32;

function normalizeRemoteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("A Remote UPM URL is required.");
  if (raw.length > 2048) throw new Error("The Remote UPM URL is too long.");
  if (/[\u0000-\u001f\u007f]/u.test(raw))
    throw new Error("Remote UPM URLs must not contain control characters.");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Enter a valid http:// or https:// URL for the Remote UPM server.");
  }

  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Remote UPM connections must use HTTP or HTTPS.");
  if (parsed.username || parsed.password)
    throw new Error("Do not put usernames or passwords in the Remote UPM URL.");
  if (parsed.search || parsed.hash)
    throw new Error("Remote UPM URLs must not include a query string or fragment.");
  if (parsed.pathname && !/^\/+$/u.test(parsed.pathname))
    throw new Error("Remote UPM must be hosted at the root of the selected address.");

  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/u, "");
}

function defaultConnectionName(url) {
  const parsed = new URL(url);
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

function validConnectionId(value) {
  return /^[A-Za-z0-9._-]{1,80}$/u.test(String(value || ""));
}

function normalizeRemoteConnection(input = {}, options = {}) {
  const url = normalizeRemoteUrl(input.url);
  const suppliedId = String(input.id || "").trim();
  const id = validConnectionId(suppliedId)
    ? suppliedId
    : typeof options.idFactory === "function"
      ? String(options.idFactory())
      : crypto.randomUUID();
  if (!validConnectionId(id)) throw new Error("Remote UPM connection id is invalid.");

  const name = String(input.name || defaultConnectionName(url)).trim().slice(0, 80);
  if (!name) throw new Error("A Remote UPM connection name is required.");
  if (/[\u0000-\u001f\u007f]/u.test(name))
    throw new Error("Remote UPM connection names must not contain control characters.");

  return {
    id,
    name,
    url,
    rememberSession: input.rememberSession !== false,
  };
}

function sanitizeRemoteConnections(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const usedIds = new Set();
  const usedUrls = new Set();
  for (const candidate of value) {
    if (output.length >= MAX_CONNECTIONS) break;
    try {
      const connection = normalizeRemoteConnection(candidate, options);
      const urlKey = connection.url.toLowerCase();
      if (usedIds.has(connection.id) || usedUrls.has(urlKey)) continue;
      usedIds.add(connection.id);
      usedUrls.add(urlKey);
      output.push(connection);
    } catch {
      // Ignore malformed persisted entries instead of preventing desktop startup.
    }
  }
  return output;
}

function remoteSessionPartition(connection) {
  const normalized = normalizeRemoteConnection(connection);
  const digest = crypto.createHash("sha256").update(normalized.id).digest("hex").slice(0, 24);
  return `${normalized.rememberSession ? "persist:" : ""}upm-remote-${digest}`;
}

function sameRemoteOrigin(connection, candidateUrl) {
  try {
    return new URL(candidateUrl).origin === new URL(normalizeRemoteConnection(connection).url).origin;
  } catch {
    return false;
  }
}

function isPlainHttpRemote(connection) {
  return new URL(normalizeRemoteConnection(connection).url).protocol === "http:";
}

module.exports = {
  MAX_CONNECTIONS,
  normalizeRemoteUrl,
  normalizeRemoteConnection,
  sanitizeRemoteConnections,
  remoteSessionPartition,
  sameRemoteOrigin,
  isPlainHttpRemote,
};
