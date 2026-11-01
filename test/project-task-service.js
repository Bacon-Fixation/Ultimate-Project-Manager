"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  ProjectTaskService,
  extractCommentTask,
  extractChecklistTask,
  extractTaskDocumentItem,
} = require("../src/tasks/project-task-service");

(async () => {
  assert.deepEqual(extractCommentTask("// TODO: finish API"), {
    kind: "todo",
    marker: "TODO",
    title: "finish API",
  });
  assert.equal(extractCommentTask("const x = 'TODO: not a comment';"), null);
  assert.equal(extractCommentTask("/* FIXME(parser): bad edge */").kind, "fix");
  assert.equal(extractCommentTask("# NOTE - keep this").kind, "note");
  assert.equal(extractCommentTask("// HACK: temporary").kind, "fix");
  assert.equal(extractChecklistTask("  - [ ] FIX: repair auth").depth, 1);
  assert.equal(extractTaskDocumentItem("- NOTE: migration reminder").kind, "note");

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-tasks-"));
  const dataDir = path.join(temp, "data");
  const projectRoot = path.join(temp, "project");
  await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, ".gitignore"), "ignored.js\n", "utf8");
  await fsp.writeFile(
    path.join(projectRoot, "src", "app.js"),
    [
      "// TODO: add retry",
      "const value = 1; // NOTE: intentionally simple",
      "/* FIXME: handle null */",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(path.join(projectRoot, "ignored.js"), "// TODO: do not import\n", "utf8");
  await fsp.writeFile(
    path.join(projectRoot, "TODO.md"),
    [
      "# Work",
      "- [ ] TODO: dashboard item",
      "  - [ ] FIX: nested bug",
      "- [x] NOTE: completed note",
    ].join("\n"),
    "utf8",
  );

  const service = await new ProjectTaskService({ dataDir }).init();
  const project = { id: "p1", name: "Demo", projectRoot, extraExcludes: [] };
  const first = await service.scanProject(project);
  assert.equal(first.discovered, 6);
  assert.equal(first.added, 6);
  assert.equal(first.summary.open, 5);
  assert.equal(first.summary.completed, 1);
  assert.equal(
    first.tasks.some((task) => task.title === "do not import"),
    false,
  );
  assert.equal(first.tasks.find((task) => task.title === "nested bug").source.depth, 1);

  const second = await service.scanProject(project);
  assert.equal(second.added, 0, "repeat scans should not duplicate discoveries");
  assert.equal(service.getTasks("p1").length, 6);

  const withIgnored = await service.scanProject(project, {
    includeGitignored: true,
  });
  assert.equal(withIgnored.added, 1, "optional scan should include gitignored source files");
  assert.equal(withIgnored.includeGitignored, true);
  assert.equal(
    service.getTasks("p1").some((task) => task.title === "do not import"),
    true,
  );

  const retry = service.getTasks("p1").find((task) => task.title === "add retry");
  await service.updateTask("p1", retry.id, {
    completed: true,
    title: "custom retry label",
  });
  await service.scanProject(project);
  const retryAfterScan = service.getTasks("p1").find((task) => task.id === retry.id);
  assert.equal(
    retryAfterScan.completed,
    true,
    "unchecked source marker must not reopen a completed task",
  );
  assert.equal(
    retryAfterScan.title,
    "custom retry label",
    "manual edits to discovered tasks should survive rescans",
  );

  await fsp.writeFile(
    path.join(projectRoot, "src", "app.js"),
    "/* FIXME: handle null */\n",
    "utf8",
  );
  const missing = await service.scanProject(project);
  assert.ok(missing.summary.missingSource >= 1);
  assert.equal(
    service.getTasks("p1").find((task) => task.title === "intentionally simple").source.present,
    false,
  );

  const manual = await service.addTask("p1", {
    kind: "note",
    title: "manual note",
  });
  assert.equal(manual.origin, "manual");
  await service.removeTask("p1", manual.id);
  assert.equal(
    service.getTasks("p1").some((task) => task.id === manual.id),
    false,
  );

  await fsp.rm(temp, { recursive: true, force: true });
  console.log("Project task service tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
