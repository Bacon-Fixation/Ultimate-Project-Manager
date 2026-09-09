"use strict";

const { EventEmitter } = require("events");

class RemoteAgentMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.client = options.client;
    this.refreshMs = Math.max(3_000, Number(options.refreshMs || 10_000));
    this.projectProvider = null;
    this.timer = null;
    this.refreshing = null;
    this.projects = new Map();
    this.agents = new Map();
  }

  async start(projectProvider) {
    this.projectProvider = projectProvider;
    await this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getProjectStatus(projectId) {
    return (
      this.projects.get(projectId) || {
        projectId,
        remote: true,
        available: false,
        monitored: true,
        controlsEnabled: false,
        status: "unavailable",
        total: 0,
        online: 0,
        stopped: 0,
        errored: 0,
        other: 0,
        checkedAt: null,
        error: "LAN agent has not reported yet.",
        processes: [],
      }
    );
  }

  getAgentsStatus() {
    const configured = this.client?.listPublic?.() || [];
    return configured.map((agent) => ({
      ...agent,
      ...(this.agents.get(agent.id) || {
        available: false,
        checkedAt: null,
        error: "Not checked yet.",
      }),
    }));
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async _refresh() {
    const projects = typeof this.projectProvider === "function" ? this.projectProvider() || [] : [];
    const byAgent = new Map();
    for (const project of projects) {
      if (!project.remoteAgentId) continue;
      if (!byAgent.has(project.remoteAgentId)) byAgent.set(project.remoteAgentId, []);
      byAgent.get(project.remoteAgentId).push(project);
    }

    const configuredIds = new Set((this.client?.listPublic?.() || []).map((agent) => agent.id));
    for (const project of projects) {
      if (!configuredIds.has(project.remoteAgentId)) {
        this.projects.set(project.id, {
          projectId: project.id,
          remote: true,
          available: false,
          monitored: project.pm2Monitoring !== false,
          controlsEnabled: false,
          status: "unavailable",
          total: 0,
          online: 0,
          stopped: 0,
          errored: 0,
          other: 0,
          checkedAt: new Date().toISOString(),
          error: `LAN agent is not configured: ${project.remoteAgentId}`,
          processes: [],
        });
      }
    }

    await Promise.all(
      [...byAgent.entries()].map(async ([agentId, agentProjects]) => {
        const checkedAt = new Date().toISOString();
        try {
          const payload = await this.client.pm2Projects(agentId, agentProjects);
          this.agents.set(agentId, {
            available: true,
            checkedAt: payload.checkedAt || checkedAt,
            error: null,
            health: payload.health || null,
            pm2: payload.pm2 || null,
            dockerRuntime: payload.dockerRuntime || null,
          });
          for (const status of payload.projects || []) {
            this.projects.set(status.projectId, {
              ...status,
              remote: true,
              controlsEnabled: false,
            });
          }
        } catch (error) {
          this.agents.set(agentId, {
            available: false,
            checkedAt,
            error: error.message,
            health: null,
            pm2: null,
            dockerRuntime: null,
          });
          for (const project of agentProjects) {
            this.projects.set(project.id, {
              projectId: project.id,
              remote: true,
              available: false,
              monitored: project.pm2Monitoring !== false,
              controlsEnabled: false,
              status: project.pm2Monitoring === false ? "disabled" : "unavailable",
              total: 0,
              online: 0,
              stopped: 0,
              errored: 0,
              other: 0,
              checkedAt,
              error: error.message,
              processes: [],
            });
          }
        }
      }),
    );

    const idleAgents = (this.client?.listPublic?.() || []).filter(
      (agent) => !byAgent.has(agent.id),
    );
    await Promise.all(
      idleAgents.map(async (agent) => {
        const checkedAt = new Date().toISOString();
        try {
          const payload = await this.client.health(agent.id);
          this.agents.set(agent.id, {
            available: true,
            checkedAt: payload.checkedAt || checkedAt,
            error: null,
            health: payload.health || null,
            pm2: payload.pm2 || null,
            dockerRuntime: payload.dockerRuntime || null,
          });
        } catch (error) {
          this.agents.set(agent.id, {
            available: false,
            checkedAt,
            error: error.message,
            health: null,
            pm2: null,
            dockerRuntime: null,
          });
        }
      }),
    );

    const snapshot = {
      checkedAt: new Date().toISOString(),
      agents: this.getAgentsStatus(),
      projects: projects.map((p) => this.getProjectStatus(p.id)),
    };
    this.emit("sample", snapshot);
    return snapshot;
  }
}

module.exports = { RemoteAgentMonitor };
