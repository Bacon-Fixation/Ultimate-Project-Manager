"use strict";

const { Readable } = require("stream");

const DEFAULT_TIMEOUT_MS = 15_000;

function isLoopbackHostname(hostname) {
  const raw = String(hostname || "")
    .trim()
    .toLowerCase();
  const value = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

function validateAgentTransport(agent, options = {}) {
  let parsed;
  try {
    parsed = new URL(agent.url);
  } catch {
    throw new Error(`LAN agent ${agent.id} has an invalid URL.`);
  }
  if (parsed.protocol === "https:") return agent;
  if (parsed.protocol !== "http:")
    throw new Error(`LAN agent ${agent.id} requires an http:// or https:// URL.`);
  if (isLoopbackHostname(parsed.hostname)) return agent;
  if (options.allowInsecureHttp === true) return agent;
  throw new Error(
    `LAN agent ${agent.id} uses insecure HTTP for a non-loopback address. ` +
      "Use HTTPS or explicitly set UPM_LAN_ALLOW_INSECURE_HTTP=true for a trusted LAN.",
  );
}

function normalizeAgentDefinition(input = {}) {
  const id = String(input.id || "").trim();
  const name = String(input.name || id).trim() || id;
  const rawUrl = String(input.url || "").trim();
  const token = String(input.token || "").trim();
  if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id))
    throw new Error("LAN agent id must use only letters, numbers, dot, underscore, or dash.");
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl))
    throw new Error(`LAN agent ${id} requires an http:// or https:// URL.`);

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`LAN agent ${id} has an invalid URL.`);
  }
  if (parsed.username || parsed.password)
    throw new Error(`LAN agent ${id} URL must not contain embedded credentials.`);
  if (parsed.search || parsed.hash)
    throw new Error(`LAN agent ${id} URL must not contain a query string or fragment.`);
  if (parsed.pathname && !/^\/+$/u.test(parsed.pathname))
    throw new Error(`LAN agent ${id} URL must not contain a path.`);
  parsed.pathname = "";
  const url = parsed.toString().replace(/\/+$/, "");

  if (token.length < 32) throw new Error(`LAN agent ${id} token must be at least 32 characters.`);
  return { id, name, url, token };
}

function parseAgentList(raw, options = {}) {
  if (!raw) return [];
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`UPM_LAN_AGENTS_JSON is not valid JSON: ${error.message}`);
    }
  }
  if (!Array.isArray(value)) throw new Error("UPM_LAN_AGENTS_JSON must be a JSON array.");
  const seen = new Set();
  return value.map((entry) => {
    const agent = normalizeAgentDefinition(entry);
    validateAgentTransport(agent, options);
    if (seen.has(agent.id)) throw new Error(`Duplicate LAN agent id: ${agent.id}`);
    seen.add(agent.id);
    return agent;
  });
}

class RemoteAgentClient {
  constructor(options = {}) {
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
    this.allowInsecureHttp = options.allowInsecureHttp === true;
    this.agents = new Map(
      (options.agents || []).map((entry) => {
        const agent = normalizeAgentDefinition(entry);
        validateAgentTransport(agent, {
          allowInsecureHttp: this.allowInsecureHttp,
        });
        return [agent.id, agent];
      }),
    );
  }

  configure(options = {}) {
    const allowInsecureHttp = options.allowInsecureHttp === true;
    const entries = Array.isArray(options.agents) ? options.agents : [];
    const agents = new Map(
      entries.map((entry) => {
        const agent = normalizeAgentDefinition(entry);
        validateAgentTransport(agent, { allowInsecureHttp });
        return [agent.id, agent];
      }),
    );
    this.allowInsecureHttp = allowInsecureHttp;
    this.agents = agents;
    return this.listPublic();
  }

  listPublic() {
    return [...this.agents.values()].map(({ token: _token, ...agent }) => ({
      ...agent,
      secureTransport: /^https:\/\//i.test(agent.url),
      insecureHttpAllowed:
        /^http:\/\//i.test(agent.url) && !isLoopbackHostname(new URL(agent.url).hostname)
          ? this.allowInsecureHttp
          : false,
    }));
  }

  get(id) {
    return this.agents.get(String(id || "")) || null;
  }

  require(id) {
    const agent = this.get(id);
    if (!agent) throw new Error(`LAN remote agent is not configured: ${id}`);
    return agent;
  }

  async request(agentId, pathname, options = {}) {
    const agent = this.require(agentId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    timeout.unref?.();
    try {
      const headers = {
        Authorization: `Bearer ${agent.token}`,
        "User-Agent": "Ultimate-Project-Manager-LAN-Controller/1.0",
        ...(options.headers || {}),
      };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${agent.url}${pathname}`, {
        method: options.method || (options.body !== undefined ? "POST" : "GET"),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      if (options.raw === true) {
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `LAN agent ${agent.name} returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
          );
        }
        return response;
      }
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { error: text };
        }
      }
      if (!response.ok) {
        const error = new Error(
          payload?.error || `LAN agent ${agent.name} returned HTTP ${response.status}.`,
        );
        error.statusCode = response.status;
        error.code = payload?.code || null;
        throw error;
      }
      return payload || {};
    } catch (error) {
      if (error?.name === "AbortError")
        throw new Error(`LAN agent request timed out: ${agent.name}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  health(agentId) {
    return this.request(agentId, "/api/agent/health");
  }
  pm2Projects(agentId, projects, options = {}) {
    return this.request(agentId, "/api/agent/pm2/projects", {
      body: { projects, refresh: options.refresh === true },
    });
  }
  serviceHealth(agentId, project) {
    return this.request(agentId, "/api/agent/projects/services/health", {
      body: { project },
      timeoutMs: 60_000,
    });
  }
  validateProject(agentId, project) {
    return this.request(agentId, "/api/agent/projects/validate", {
      body: { project },
    });
  }
  inspectProject(agentId, project) {
    return this.request(agentId, "/api/agent/projects/inspect", {
      body: { project },
      timeoutMs: 120_000,
    });
  }
  backupProject(agentId, project, options = {}) {
    return this.request(agentId, "/api/agent/projects/backup", {
      body: { project, force: options.force === true },
      timeoutMs: Math.max(120_000, Number(options.timeoutMs || 0)),
    });
  }
  listBackups(agentId, project) {
    return this.request(agentId, "/api/agent/projects/backups", {
      body: { project },
    });
  }
  verifyBackup(agentId, project, file) {
    return this.request(agentId, "/api/agent/projects/backups/verify", {
      body: { project, file },
      timeoutMs: 120_000,
    });
  }
  verifyAllBackups(agentId, project) {
    return this.request(agentId, "/api/agent/projects/backups/verify-all", {
      body: { project },
      timeoutMs: 300_000,
    });
  }
  deleteBackup(agentId, project, file) {
    return this.request(agentId, "/api/agent/projects/backups/delete", {
      body: { project, file },
      method: "POST",
    });
  }
  restoreBackup(agentId, project, file, options = {}) {
    return this.request(agentId, "/api/agent/projects/backups/restore", {
      body: {
        project,
        file,
        destination: options.destination || null,
        overwrite: options.overwrite === true,
        backupDestination: options.backupDestination || null,
      },
      timeoutMs: 300_000,
    });
  }
  storage(agentId, project) {
    return this.request(agentId, "/api/agent/projects/storage", {
      body: { project },
    });
  }
  download(agentId, project, file, destination = null) {
    const query = new URLSearchParams({ file });
    if (destination) query.set("destination", destination);
    return this.request(agentId, `/api/agent/projects/backups/download?${query}`, {
      method: "POST",
      body: { project },
      raw: true,
      timeoutMs: 300_000,
    });
  }

  static nodeStream(response) {
    return response.body ? Readable.fromWeb(response.body) : Readable.from([]);
  }
}

module.exports = {
  RemoteAgentClient,
  normalizeAgentDefinition,
  parseAgentList,
  validateAgentTransport,
  isLoopbackHostname,
};
