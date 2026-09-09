"use strict";

const path = require("path");
const fsp = require("fs/promises");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 8000;
const MAX_BUFFER = 1024 * 1024;
const EDITOR_LAUNCH_TIMEOUT_MS = 8000;

const EDITORS = Object.freeze({
  vscode: {
    label: "Visual Studio Code",
    command: "code",
    windowsCommand: "code",
  },
  "vscode-insiders": {
    label: "VS Code Insiders",
    command: "code-insiders",
    windowsCommand: "code-insiders",
  },
  cursor: { label: "Cursor", command: "cursor", windowsCommand: "cursor" },
  windsurf: {
    label: "Windsurf",
    command: "windsurf",
    windowsCommand: "windsurf",
  },
  sublime: { label: "Sublime Text", command: "subl", windowsCommand: "subl" },
  webstorm: {
    label: "WebStorm",
    command: "webstorm",
    windowsCommand: "webstorm64.exe",
  },
  custom: { label: "Custom editor", command: null, windowsCommand: null },
});

function normalizeEditorId(value, fallback = "vscode") {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(EDITORS, id) ? id : fallback;
}

function normalizeRepositoryUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let normalized = raw;
  const scpLike = /^git@([^:]+):(.+)$/.exec(raw);
  if (scpLike) normalized = `https://${scpLike[1]}/${scpLike[2]}`;
  else {
    const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/i.exec(raw);
    if (ssh) normalized = `https://${ssh[1]}/${ssh[2]}`;
  }

  normalized = normalized.replace(/\.git\/?$/i, "").replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/, "");
}

function isGitHubUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)github\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsEditorCandidates(editorId, customEditorCommand, env = process.env) {
  const localAppData = String(env.LOCALAPPDATA || "").trim();
  const programFiles = String(env.ProgramFiles || env.PROGRAMFILES || "").trim();
  const programFilesX86 = String(env["ProgramFiles(x86)"] || env.PROGRAMFILES_X86 || "").trim();
  const candidates = [];
  const add = (value) => {
    const candidate = String(value || "").trim();
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  if (editorId === "custom") {
    add(customEditorCommand);
    return candidates;
  }

  if (editorId === "vscode") {
    if (localAppData)
      add(path.win32.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"));
    if (programFiles) add(path.win32.join(programFiles, "Microsoft VS Code", "Code.exe"));
    if (programFilesX86) add(path.win32.join(programFilesX86, "Microsoft VS Code", "Code.exe"));
  } else if (editorId === "vscode-insiders") {
    if (localAppData)
      add(
        path.win32.join(
          localAppData,
          "Programs",
          "Microsoft VS Code Insiders",
          "Code - Insiders.exe",
        ),
      );
    if (programFiles)
      add(path.win32.join(programFiles, "Microsoft VS Code Insiders", "Code - Insiders.exe"));
  } else if (editorId === "cursor" && localAppData) {
    add(path.win32.join(localAppData, "Programs", "cursor", "Cursor.exe"));
    add(path.win32.join(localAppData, "Programs", "Cursor", "Cursor.exe"));
  } else if (editorId === "windsurf" && localAppData) {
    add(path.win32.join(localAppData, "Programs", "Windsurf", "Windsurf.exe"));
  } else if (editorId === "sublime" && programFiles) {
    add(path.win32.join(programFiles, "Sublime Text", "sublime_text.exe"));
  }

  add(EDITORS[editorId]?.windowsCommand);
  return candidates;
}

async function existingFile(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

class ProjectLauncher {
  constructor(options = {}) {
    this.defaultEditor = normalizeEditorId(options.defaultEditor || "vscode");
    this.customEditorCommand = String(options.customEditorCommand || "").trim();
    this.gitRunner =
      options.gitRunner ||
      (async (cwd, args) => {
        const { stdout } = await execFileAsync("git", args, {
          cwd,
          windowsHide: true,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        });
        return String(stdout || "").trim();
      });
    this.spawnRunner = options.spawnRunner || this._spawnEditor.bind(this);
  }

  editorOptions() {
    return Object.entries(EDITORS).map(([id, value]) => ({
      id,
      label: value.label,
      available: id !== "custom" || Boolean(this.customEditorCommand),
    }));
  }

  effectiveEditor(project = {}) {
    const requested = String(project.editor || "default").toLowerCase();
    const id =
      requested === "default"
        ? this.defaultEditor
        : normalizeEditorId(requested, this.defaultEditor);
    const spec = EDITORS[id] || EDITORS.vscode;
    return {
      id,
      label: spec.label,
      configured: id !== "custom" || Boolean(this.customEditorCommand),
    };
  }

  async repositoryInfo(project) {
    const configured = normalizeRepositoryUrl(project.repositoryUrl);
    if (configured)
      return {
        available: true,
        url: configured,
        source: "project-config",
        github: isGitHubUrl(configured),
      };

    try {
      const remote = await this.gitRunner(project.projectRoot, ["remote", "get-url", "origin"]);
      const url = normalizeRepositoryUrl(remote);
      if (!url)
        return {
          available: false,
          url: null,
          source: "git-origin",
          github: false,
          reason: "The Git origin URL is not an HTTP(S), SSH, or GitHub-style repository URL.",
        };
      return {
        available: true,
        url,
        source: "git-origin",
        github: isGitHubUrl(url),
      };
    } catch (error) {
      return {
        available: false,
        url: null,
        source: "git-origin",
        github: false,
        reason:
          error.code === "ENOENT" ? "Git is not available." : "No Git origin repository was found.",
      };
    }
  }

  async launchInfo(project) {
    const [repository] = await Promise.all([this.repositoryInfo(project)]);
    return {
      projectId: project.id,
      projectRoot: project.projectRoot,
      editor: this.effectiveEditor(project),
      editors: this.editorOptions(),
      repository,
    };
  }

  async openEditor(project) {
    const root = path.resolve(project.projectRoot);
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error("Project root is not a directory.");
    const editor = this.effectiveEditor(project);
    if (!editor.configured)
      throw new Error("The custom editor is selected but UPM_EDITOR_COMMAND is not configured.");
    await this.spawnRunner(editor.id, root, this.customEditorCommand);
    return { projectId: project.id, projectRoot: root, editor };
  }

  async _resolveWindowsEditor(editorId, customEditorCommand) {
    const candidates = windowsEditorCandidates(editorId, customEditorCommand, process.env);
    if (!candidates.length) throw new Error("Editor command is not configured.");

    for (const candidate of candidates) {
      const direct = await existingFile(candidate);
      if (direct) return direct;
      if (path.isAbsolute(candidate)) continue;

      try {
        const { stdout } = await execFileAsync("where.exe", [candidate], {
          windowsHide: true,
          timeout: EDITOR_LAUNCH_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        });
        const resolved = String(stdout || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);
        if (resolved) return resolved;
      } catch {}
    }

    const label = EDITORS[editorId]?.label || "selected editor";
    throw new Error(
      `${label} could not be found. Install it, add its CLI command to PATH, or configure UPM_EDITOR_COMMAND with the full executable path.`,
    );
  }

  async _spawnEditor(editorId, projectRoot, customEditorCommand) {
    const spec = EDITORS[editorId];
    if (!spec) throw new Error("Unsupported editor selection.");

    if (process.platform === "win32") {
      const command = await this._resolveWindowsEditor(editorId, customEditorCommand);
      const powershell = process.env.SystemRoot
        ? path.join(
            process.env.SystemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          )
        : "powershell.exe";
      const script = `Start-Process -FilePath ${psLiteral(command)} -ArgumentList @(${psLiteral(projectRoot)}) -ErrorAction Stop`;
      try {
        await execFileAsync(
          powershell,
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
          {
            windowsHide: true,
            timeout: EDITOR_LAUNCH_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
          },
        );
      } catch (error) {
        const detail = String(error.stderr || error.message || "").trim();
        throw new Error(`Unable to launch ${spec.label}${detail ? `: ${detail}` : "."}`);
      }
      return;
    }

    const command = editorId === "custom" ? String(customEditorCommand || "").trim() : spec.command;
    if (!command) throw new Error("Editor command is not configured.");

    await new Promise((resolve, reject) => {
      const child = spawn(command, [projectRoot], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}

module.exports = {
  EDITORS,
  ProjectLauncher,
  normalizeEditorId,
  normalizeRepositoryUrl,
  isGitHubUrl,
  windowsEditorCandidates,
};
