"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backup = fs.readFileSync(path.join(root, "src", "backup", "project-backup.js"), "utf8");
const manager = fs.readFileSync(path.join(root, "src", "manager", "backup-manager.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");

assert.match(backup, /new DeltaJournal\(/);
assert.match(backup, /recordTransition\(/);
assert.match(backup, /readBefore:/);
assert.match(backup, /readAfter:/);
const journalTransitionIndex = backup.indexOf("recordTransition({");
const backupPruneIndex = backup.indexOf("await this.prune()", journalTransitionIndex);
assert.ok(
  journalTransitionIndex >= 0 && backupPruneIndex > journalTransitionIndex,
  "journal transition must be recorded before normal backup pruning",
);
assert.match(manager, /deltaJournalEnabled/);
assert.match(manager, /deltaJournalRetentionDays/);
assert.match(manager, /deltaJournalMaxEntries/);
assert.match(manager, /deltaJournalMaxStorageMB/);
assert.match(manager, /deltaJournalMaxFileMB/);
assert.match(manager, /this\._journalDirFor\(project\)/);
assert.match(server, /\/api\/projects\/:id\/journal/);
assert.match(server, /journal\/prune/);

console.log("Delta journal backup-integration surface checks passed.");
