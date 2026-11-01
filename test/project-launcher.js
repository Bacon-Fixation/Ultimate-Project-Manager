"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  ProjectLauncher,
  normalizeRepositoryUrl,
  isGitHubUrl,
  windowsEditorCandidates,
} = require("../src/integrations/project-launcher");

async function main() {
  assert.equal(
    normalizeRepositoryUrl("git@github.com:Bacon-Fixation/example.git"),
    "https://github.com/Bacon-Fixation/example",
  );
  assert.equal(
    normalizeRepositoryUrl("ssh://git@github.com/Bacon-Fixation/example.git"),
    "https://github.com/Bacon-Fixation/example",
  );
  assert.equal(
    normalizeRepositoryUrl("https://github.com/Bacon-Fixation/example.git"),
    "https://github.com/Bacon-Fixation/example",
  );
  assert.equal(isGitHubUrl("https://github.com/Bacon-Fixation/example"), true);
  assert.equal(normalizeRepositoryUrl("file:///tmp/repo"), null);

  const vscodeWindows = windowsEditorCandidates("vscode", "", {
    LOCALAPPDATA: "C:\\Users\\Bacon\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
  });
  assert.ok(vscodeWindows.some((candidate) => candidate.endsWith("Microsoft VS Code\\Code.exe")));
  assert.equal(vscodeWindows.at(-1), "code");
  assert.deepEqual(windowsEditorCandidates("custom", "C:\\Tools\\My Editor\\editor.exe", {}), [
    "C:\\Tools\\My Editor\\editor.exe",
  ]);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "upm-launcher-"));
  const launched = [];
  const launcher = new ProjectLauncher({
    defaultEditor: "vscode",
    customEditorCommand: "my-editor",
    gitRunner: async (cwd, args) => {
      assert.equal(cwd, root);
      assert.deepEqual(args, ["remote", "get-url", "origin"]);
      return "git@github.com:Bacon-Fixation/ultimate-project-manager.git";
    },
    spawnRunner: async (editorId, projectRoot, custom) =>
      launched.push({ editorId, projectRoot, custom }),
  });

  try {
    const project = {
      id: "p1",
      projectRoot: root,
      editor: "default",
      repositoryUrl: null,
    };
    const info = await launcher.launchInfo(project);
    assert.equal(info.editor.id, "vscode");
    assert.equal(info.repository.url, "https://github.com/Bacon-Fixation/ultimate-project-manager");
    assert.equal(info.repository.github, true);

    await launcher.openEditor(project);
    assert.deepEqual(launched[0], {
      editorId: "vscode",
      projectRoot: root,
      custom: "my-editor",
    });

    const configured = await launcher.repositoryInfo({
      ...project,
      repositoryUrl: "https://github.com/Bacon-Fixation/custom.git",
    });
    assert.equal(configured.source, "project-config");
    assert.equal(configured.url, "https://github.com/Bacon-Fixation/custom");

    const customInfo = launcher.effectiveEditor({ editor: "custom" });
    assert.equal(customInfo.configured, true);
    console.log("Project launcher test passed.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
