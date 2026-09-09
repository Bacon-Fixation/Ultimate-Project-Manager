#!/usr/bin/env node
"use strict";

const path = require("path");
const { BackupManager } = require("./manager/backup-manager");
const { FileToolsService } = require("./file-tools/file-tools-service");
const { loadRuntimeConfig } = require("./config/runtime-config");

function usage() {
  console.log(`
Ultimate Project Manager CLI

Commands:
  list
  add <name> <projectPath> [primaryBackupPath] [secondaryBackupPath]
  remove <projectId>
  backup <projectId> [--force]
  inspect <projectId>
  diff <projectId> [relativeFilePath]
  feature-pack <projectId> [--output <folder>] [--name <pack-name>] [--no-added] [--no-modified] [--no-deleted] [--no-diffs] [--include-sensitive]
  recovery <projectId> [relativeFilePath] [--refresh]
  journal <projectId> [--limit <number>]
  journal-prune <projectId>
  recover <projectId> <relativeFilePath> [--candidate <candidateId>]
  recover-suggested <projectId> [--max-files <number>]
  config
  backups <projectId>
  verify <projectId> <backupFile>
  verify-all <projectId>
  restore <projectId> <backupFile> [destination] [--overwrite]
  stats [projectId]
  dependencies <projectId> [--refresh]
  dependency-versions <projectId> <package> [--prerelease] [--refresh]
  dependency-update <projectId> <package> <version> [--save-mode preserve|exact|caret|tilde] [--no-scripts]
  discover <parentPath...> [--depth <number>]
  pm2 [projectId] [--refresh]
  pm2-history <projectId> [--range 24h|7d] [--process <processKey>]
  pm2-logs <projectId> <pm2Id> [--stream both|stdout|stderr] [--lines <number>] [--refresh]
  pm2-action <projectId> <pm2Id> <restart|reload|stop|start|reset>
  pm2-start-project <projectId>
  open-editor <projectId>
  repo <projectId>
  backup-all [--force]
  verify-everything
  file-tools-preview <latest|comments|pipeline|inventory> <sourcePath|-> <outputPath|-> [--project <id>] [options]
  file-tools-run <latest|comments|pipeline|inventory> <sourcePath|-> <outputPath|-> [--project <id>] [options]
    --exclude <patterns>         Git-style file/folder patterns (comma/newline separated)
    --include <patterns>         Only process matching Git-style patterns
    --min-bytes <number>         Ignore files smaller than this size
    --max-bytes <number>         Ignore files larger than this size (0 = unlimited)
    --no-gitignore              Do not apply the source root .gitignore
    --no-project-excludes       Do not merge registered project Additional excludes
    --strip-license-comments    Remove legal/license comments too
    --comment-aggressiveness <safe|standard|aggressive>
                               Select comment preservation policy (default standard)
    --comment-max-mb <1-32>     Max file size for comment cleanup (default 4 MB)
  file-tools-history

Examples:
  node src/cli.js list
  node src/cli.js add "Bacons Helper" "C:\\Projects\\Bacons_Helper" "D:\\Backups\\Bacons_Helper" "E:\\Backup Mirror\\Bacons_Helper"
  node src/cli.js backup <project-id>
  node src/cli.js diff <project-id>
  node src/cli.js diff <project-id> src/index.js
  node src/cli.js feature-pack <project-id> --output "D:\\Exports"
  node src/cli.js recovery <project-id> src/index.js
  node src/cli.js journal <project-id> --limit 100
  node src/cli.js journal-prune <project-id>
  node src/cli.js recover <project-id> src/index.js --candidate <candidate-id>
  node src/cli.js recover-suggested <project-id> --max-files 100
  node src/cli.js config
  node src/cli.js verify-all <project-id>
  node src/cli.js restore <project-id> "MyProject_2026-08-19_12-00-00.tar.gz" "D:\\Restores\\MyProject"
  node src/cli.js stats
  node src/cli.js dependency-versions <project-id> express
  node src/cli.js dependency-update <project-id> express 5.1.0 --save-mode caret
  node src/cli.js discover "C:\\Projects" --depth 5
  node src/cli.js pm2 --refresh
  node src/cli.js pm2-history <project-id> --range 7d
  node src/cli.js pm2-logs <project-id> 2 --stream both --lines 200
  node src/cli.js pm2-action <project-id> 2 restart
  node src/cli.js pm2-start-project <project-id>
  node src/cli.js open-editor <project-id>
  node src/cli.js repo <project-id>
  node src/cli.js backup-all
  node src/cli.js file-tools-preview pipeline - - --project <project-id> --copy-unversioned
  node src/cli.js file-tools-run pipeline - - --project <project-id> --copy-unversioned --backup-first
  node src/cli.js file-tools-run inventory - - --project <project-id> --include "src/**,*.json"
`);
}

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function positionalArgs(args, optionsWithValues = []) {
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    if (optionsWithValues.includes(args[i])) {
      i += 1;
      continue;
    }
    if (args[i].startsWith("--")) continue;
    result.push(args[i]);
  }
  return result;
}

async function main() {
  const [, , command, ...args] = process.argv;
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = path.join(rootDir, "data");
  const runtimeConfig = await loadRuntimeConfig({ rootDir, dataDir });
  const manager = new BackupManager({
    dataDir,
    backupRoot: runtimeConfig.backupRoot || path.join(dataDir, "backups"),
    restoreRoot: runtimeConfig.restoreRoot || path.join(dataDir, "restores"),
    backupEncryptionKey: runtimeConfig.backupEncryptionKey,
    defaultEditor: runtimeConfig.editor,
    customEditorCommand: runtimeConfig.editorCommand,
    remoteAgents: runtimeConfig.lanAgents,
    remoteAgentAllowInsecureHttp: runtimeConfig.lanAllowInsecureHttp,
  });
  await manager.init();
  const fileTools = await new FileToolsService({ manager, dataDir }).init();

  try {
    if (!command || command === "help" || command === "--help") return usage();

    if (command === "config") {
      console.log({
        host: runtimeConfig.host,
        port: runtimeConfig.port,
        backupRoot: runtimeConfig.backupRoot || manager.backupRoot,
        restoreRoot: runtimeConfig.restoreRoot || manager.restoreRoot,
        allowRemoteDashboard: runtimeConfig.allowRemoteDashboard,
        allowRemoteAdmin: runtimeConfig.allowRemoteAdmin,
        allowRemoteFilesystem: runtimeConfig.allowRemoteFilesystem,
        trustProxy: runtimeConfig.trustProxy,
        securityHeaders: runtimeConfig.securityHeaders,
        contentSecurityPolicy: runtimeConfig.contentSecurityPolicy,
        jsonLimit: runtimeConfig.jsonLimit,
        apiRateLimitWindowMs: runtimeConfig.apiRateLimitWindowMs,
        apiRateLimitMax: runtimeConfig.apiRateLimitMax,
        writeRateLimitMax: runtimeConfig.writeRateLimitMax,
        authenticationEnabled: runtimeConfig.authEnabled,
        authenticationUsername: runtimeConfig.authEnabled ? runtimeConfig.authUsername : null,
        authenticationCookieSecure: runtimeConfig.authCookieSecure,
        backupEncryptionConfigured: Boolean(runtimeConfig.backupEncryptionKey),
        editor: runtimeConfig.editor,
        customEditorConfigured: Boolean(runtimeConfig.editorCommand),
        configSource:
          runtimeConfig.configSource || (runtimeConfig.envLoaded ? ".env" : "built-in defaults"),
        environmentOverrides: runtimeConfig.environmentOverrideKeys || [],
      });
      return;
    }

    if (command === "list") {
      console.table(
        manager.getProjects().map((p) => ({
          id: p.id,
          name: p.name,
          path: p.projectRoot,
          watch: p.watch,
          keep: p.keep,
          schedule: p.scheduleDescription,
          pm2: p.pm2?.available ? `${p.pm2.online}/${p.pm2.total} online` : "unavailable",
          nextScheduledAt: p.runtime.nextScheduledAt || "",
        })),
      );
      return;
    }

    if (command === "add") {
      const [name, projectRoot, backupDir, backupDirSecondary] = args;
      if (!name || !projectRoot)
        throw new Error(
          "add requires <name> <projectPath> [primaryBackupPath] [secondaryBackupPath].",
        );
      const project = await manager.addProject({
        name,
        projectRoot,
        backupDir: backupDir || null,
        backupDirSecondary: backupDirSecondary || null,
        watch: true,
        keep: 10,
      });
      console.log("Added:", project);
      return;
    }

    if (command === "remove") {
      if (!args[0]) throw new Error("remove requires <projectId>.");
      await manager.removeProject(args[0]);
      console.log("Project removed. Backup files were left untouched.");
      return;
    }

    if (command === "backup") {
      if (!args[0]) throw new Error("backup requires <projectId>.");
      console.log(
        await manager.runBackup(args[0], {
          force: args.includes("--force"),
          source: "cli",
        }),
      );
      return;
    }

    if (command === "inspect") {
      if (!args[0]) throw new Error("inspect requires <projectId>.");
      console.log(await manager.inspectProject(args[0]));
      return;
    }

    if (command === "diff") {
      if (!args[0]) throw new Error("diff requires <projectId> [relativeFilePath].");
      if (args[1]) console.log(await manager.getProjectFileDiff(args[0], args[1]));
      else console.log(await manager.getProjectDiff(args[0]));
      return;
    }

    if (command === "feature-pack") {
      const [projectId] = positionalArgs(args, ["--output", "--name"]);
      if (!projectId) throw new Error("feature-pack requires <projectId>.");
      const options = {
        outputDir: path.resolve(optionValue(args, "--output", process.cwd())),
        packName: optionValue(args, "--name", ""),
        includeAdded: !args.includes("--no-added"),
        includeModified: !args.includes("--no-modified"),
        includeDeleted: !args.includes("--no-deleted"),
        includeTextDiffs: !args.includes("--no-diffs"),
        excludeSensitive: !args.includes("--include-sensitive"),
      };
      const preview = await manager.previewFeaturePack(projectId, options);
      console.log({
        project: preview.projectName,
        baseline: preview.baseline?.backupFile || null,
        selectedChanges: preview.counts.selected,
        includedRegularFiles: preview.counts.includedRegularFiles,
        deletedManifestEntries: preview.counts.deletedManifestEntries,
        omittedSensitive: preview.counts.omittedSensitive,
        estimatedBytes: preview.estimatedBytes,
        warnings: preview.warnings,
      });
      const pack = await manager.exportFeaturePack(projectId, options);
      console.log({
        featurePack: pack.archivePath,
        fileName: pack.fileName,
        size: pack.size,
        featurePackId: pack.manifest.featurePackId,
      });
      return;
    }

    if (command === "recovery") {
      const [projectId, relativePath] = positionalArgs(args);
      if (!projectId) throw new Error("recovery requires <projectId> [relativeFilePath].");
      const recovery = await manager.inspectRecovery(projectId, {
        path: relativePath || null,
        refresh: args.includes("--refresh"),
      });
      console.log({
        project: recovery.projectName,
        path: recovery.path,
        current: recovery.current,
        baseline: recovery.baseline,
        git: recovery.git
          ? {
              available: recovery.git.available,
              branch: recovery.git.branch,
              head: recovery.git.head,
              error: recovery.git.error || null,
            }
          : null,
        recommended: recovery.recommended,
        recoveryRoot: recovery.recoveryRoot,
      });
      console.table(
        (recovery.suggestions || []).map((item) => ({
          status: item.status,
          path: item.path,
        })),
      );
      console.table(
        [
          ...(recovery.backupCandidates || []),
          ...(recovery.journal?.candidates || []),
          ...(recovery.git?.candidates || []),
        ].map((item) => ({
          id: item.id,
          source: item.source,
          createdAt: item.createdAt || item.authoredAt || "",
          reference: item.backupFile || item.journalEntryId || item.shortCommit || "",
          verified: item.verificationStatus || item.confidence || "",
          size: item.size ?? "",
          label: item.label || "",
        })),
      );
      return;
    }

    if (command === "journal") {
      const [projectId] = positionalArgs(args, ["--limit"]);
      if (!projectId) throw new Error("journal requires <projectId>.");
      const journal = await manager.getDeltaJournal(projectId, {
        limit: optionValue(args, "--limit", 100),
      });
      console.log({
        project: journal.projectName,
        journalDir: journal.journalDir,
        stats: journal.stats,
      });
      console.table(
        journal.entries.map((entry) => ({
          id: entry.id,
          createdAt: entry.createdAt,
          changed: entry.changedFiles,
          recoverable: entry.reconstructableFiles,
          metadataOnly: entry.skippedFiles,
          compressedBytes: entry.size,
          fromBackup: entry.fromBackupFile || "",
          toBackup: entry.toBackupFile || "",
        })),
      );
      return;
    }

    if (command === "journal-prune") {
      const [projectId] = positionalArgs(args);
      if (!projectId) throw new Error("journal-prune requires <projectId>.");
      console.log(await manager.pruneDeltaJournal(projectId));
      return;
    }

    if (command === "recover") {
      const [projectId, relativePath] = positionalArgs(args, ["--candidate"]);
      if (!projectId || !relativePath)
        throw new Error(
          "recover requires <projectId> <relativeFilePath> [--candidate <candidateId>].",
        );
      console.log(
        await manager.recoverFileCandidate(projectId, relativePath, {
          id: optionValue(args, "--candidate", null),
        }),
      );
      return;
    }

    if (command === "recover-suggested") {
      const [projectId] = positionalArgs(args, ["--max-files"]);
      if (!projectId) throw new Error("recover-suggested requires <projectId>.");
      console.log(
        await manager.recoverSuggestedFiles(projectId, {
          maxFiles: optionValue(args, "--max-files", 100),
          refresh: args.includes("--refresh"),
        }),
      );
      return;
    }

    if (command === "backups") {
      if (!args[0]) throw new Error("backups requires <projectId>.");
      console.table((await manager.listBackups(args[0])).map(({ path: _path, ...item }) => item));
      return;
    }

    if (command === "verify") {
      if (!args[0] || !args[1]) throw new Error("verify requires <projectId> <backupFile>.");
      console.log(await manager.verifyBackup(args[0], args[1]));
      return;
    }

    if (command === "verify-all") {
      if (!args[0]) throw new Error("verify-all requires <projectId>.");
      console.table(await manager.verifyAllBackups(args[0]));
      return;
    }

    if (command === "restore") {
      const overwrite = args.includes("--overwrite");
      const positional = positionalArgs(args);
      const [projectId, backupFile, destination] = positional;
      if (!projectId || !backupFile)
        throw new Error("restore requires <projectId> <backupFile> [destination].");
      console.log(
        await manager.restoreBackup(projectId, backupFile, {
          destination: destination || null,
          overwrite,
        }),
      );
      return;
    }

    if (command === "stats") {
      if (args[0]) console.log(await manager.getProjectStorageStats(args[0]));
      else console.log(await manager.getStorageStats());
      return;
    }

    if (command === "dependencies") {
      if (!args[0]) throw new Error("dependencies requires <projectId>.");
      const result = await manager.inspectDependencies(args[0], {
        refresh: args.includes("--refresh"),
      });
      console.log({
        package: result.packageName,
        version: result.packageVersion,
        checkedAt: result.checkedAt,
        registryAvailable: result.registryAvailable,
        registryError: result.registryError,
        summary: result.summary,
      });
      console.table(
        result.dependencies.map((dep) => ({
          package: dep.name,
          type: dep.types.join(","),
          declared: dep.declared,
          current: dep.current || "",
          wanted: dep.wanted || "",
          latest: dep.latest || "",
          status: dep.missing
            ? "missing"
            : dep.outdated
              ? "outdated"
              : dep.upToDate
                ? "current"
                : "unknown",
        })),
      );
      return;
    }

    if (command === "dependency-versions") {
      const [projectId, packageName] = positionalArgs(args);
      if (!projectId || !packageName)
        throw new Error("dependency-versions requires <projectId> <package>.");
      const result = await manager.getDependencyVersions(projectId, packageName, {
        refresh: args.includes("--refresh"),
        includePrerelease: args.includes("--prerelease"),
      });
      console.log({
        package: result.name,
        checkedAt: result.checkedAt,
        count: result.versions.length,
      });
      console.table(result.versions.map((version) => ({ version })));
      return;
    }

    if (command === "dependency-update") {
      const [projectId, packageName, version] = positionalArgs(args, ["--save-mode"]);
      if (!projectId || !packageName || !version)
        throw new Error("dependency-update requires <projectId> <package> <version>.");
      const saveMode = optionValue(args, "--save-mode", "preserve");
      console.log(
        await manager.updateDependency(projectId, packageName, version, {
          saveMode,
          runScripts: !args.includes("--no-scripts"),
        }),
      );
      return;
    }

    if (command === "backup-all") {
      const results = await manager.runAllBackups({
        force: args.includes("--force"),
      });
      console.table(
        results.map((item) => ({
          project: item.projectName,
          ok: item.ok,
          created: item.result?.created ?? false,
          reason: item.error || item.result?.reason || "",
        })),
      );
      return;
    }

    if (command === "verify-everything") {
      console.table(await manager.verifyAllProjects());
      return;
    }

    if (command === "file-tools-history") {
      console.table(
        fileTools.getHistory(100).map((item) => ({
          timestamp: item.finishedAt || item.startedAt,
          status: item.status,
          workflow: item.mode,
          project: item.projectName || item.projectId || "",
          source: item.sourceRoot,
          output: item.outputRoot,
          copied: item.summary?.copied ?? "",
          commentsRemoved: item.summary?.commentsRemoved ?? "",
          errors: item.summary?.errors ?? "",
        })),
      );
      return;
    }

    if (command === "file-tools-preview" || command === "file-tools-run") {
      const [mode, sourceArg, outputArg] = positionalArgs(args, [
        "--project",
        "--exclude",
        "--include",
        "--min-bytes",
        "--max-bytes",
        "--comment-aggressiveness",
        "--comment-max-mb",
      ]);
      if (!["latest", "comments", "pipeline", "inventory"].includes(mode))
        throw new Error("File Tools mode must be latest, comments, pipeline, or inventory.");
      const projectId = optionValue(args, "--project", null);
      const sourceRoot = sourceArg && sourceArg !== "-" ? sourceArg : "";
      const outputRoot = outputArg && outputArg !== "-" ? outputArg : "";
      if (!projectId && !sourceRoot)
        throw new Error("A source path is required when --project is not supplied.");
      const payload = {
        mode,
        projectId,
        sourceRoot,
        outputRoot,
        excludes: optionValue(args, "--exclude", ""),
        includes: optionValue(args, "--include", ""),
        minFileBytes: Math.max(0, Number(optionValue(args, "--min-bytes", 0)) || 0),
        maxFileBytes: Math.max(0, Number(optionValue(args, "--max-bytes", 0)) || 0),
        respectGitignore: !args.includes("--no-gitignore"),
        useProjectExcludes: !args.includes("--no-project-excludes"),
        copyUnversioned: args.includes("--copy-unversioned"),
        copyUnsupported: !args.includes("--skip-unsupported"),
        preserveLinePositions: !args.includes("--compact-comments"),
        preserveLicenseComments: !args.includes("--strip-license-comments"),
        commentAggressiveness: optionValue(args, "--comment-aggressiveness", "standard"),
        maxCommentFileBytes:
          Math.max(1, Math.min(32, Number(optionValue(args, "--comment-max-mb", 4)) || 4)) *
          1024 *
          1024,
        overwrite: !args.includes("--no-overwrite"),
        writeManifest: !args.includes("--no-manifest"),
        backupBeforeRun: args.includes("--backup-first"),
        dryRun: args.includes("--dry-run"),
        previewLimit: 500,
      };
      const result =
        command === "file-tools-preview"
          ? await fileTools.preview(payload)
          : await fileTools.run(payload);
      console.log({
        workflow: result.mode,
        project: result.projectName || result.projectId || "",
        source: result.sourceRoot,
        output: result.outputRoot,
        manifest: result.manifestPath || "",
        warnings: result.warnings || [],
        summary: result.summary,
      });
      console.table(
        (result.operations || result.results || []).map((item) => ({
          status: item.status || "planned",
          source: item.sourceRelativePath,
          destination: item.destinationRelativePath,
          timestamp: item.timestamp || "",
          versions: item.versionsFound || 1,
          commentStyle: item.commentStyle || "",
          commentsRemoved: item.commentsRemoved ?? "",
          error: item.error || item.reason || "",
        })),
      );
      return;
    }

    if (command === "pm2-history") {
      const projectId = positionalArgs(args, ["--range", "--process"])[0];
      if (!projectId) throw new Error("pm2-history requires <projectId>.");
      const history = manager.getProjectPm2History(projectId, {
        range: optionValue(args, "--range", "24h"),
        processKey: optionValue(args, "--process", null),
        maxPoints: 120,
      });
      console.log(history.summary);
      console.table(
        history.events.slice(0, 30).map((event) => ({
          timestamp: event.timestamp,
          type: event.eventType,
          process: event.name || "",
          unexpected: event.unexpected,
          plannedAction: event.plannedAction || "",
          message: event.message,
        })),
      );
      console.table(
        (history.snapshots || []).slice(0, 30).map((item) => ({
          timestamp: item.timestamp,
          process:
            item.namespace && item.namespace !== "default"
              ? `${item.namespace}/${item.name}`
              : item.name,
          id: item.pm2Id,
          status: item.status,
          pid: item.pid,
          cpu: item.cpu,
          memoryBytes: item.memoryBytes,
          uptimeMs: item.uptimeMs,
          restarts: item.restarts,
          nodeVersion: item.nodeVersion || "",
          appVersion: item.version || "",
          execMode: item.execMode || "",
          script: item.script || item.cwd || "",
        })),
      );
      return;
    }

    if (command === "pm2-logs") {
      const [projectId, pm2Id] = positionalArgs(args, ["--stream", "--lines"]);
      if (!projectId || pm2Id === undefined)
        throw new Error("pm2-logs requires <projectId> <pm2Id>.");
      const logs = await manager.getProjectPm2Logs(projectId, Number(pm2Id), {
        stream: optionValue(args, "--stream", "both"),
        lines: optionValue(args, "--lines", "200"),
        refresh: args.includes("--refresh"),
      });
      const processName =
        logs.process.namespace && logs.process.namespace !== "default"
          ? `${logs.process.namespace}/${logs.process.name}`
          : logs.process.name;
      console.log(`${logs.projectName} · ${processName} · PM2 ID ${logs.process.id}`);
      console.log(`Read: ${logs.checkedAt}`);
      if (logs.stdout) {
        console.log(`\n--- STDOUT ${logs.stdout.path || "(not configured)"} ---`);
        console.log(
          logs.stdout.available ? logs.stdout.content : logs.stdout.error || "Unavailable",
        );
      }
      if (logs.stderr) {
        console.log(`\n--- STDERR ${logs.stderr.path || "(not configured)"} ---`);
        console.log(
          logs.stderr.available ? logs.stderr.content : logs.stderr.error || "Unavailable",
        );
      }
      return;
    }

    if (command === "pm2-action") {
      const [projectId, pm2Id, action] = positionalArgs(args);
      if (!projectId || pm2Id === undefined || !action)
        throw new Error("pm2-action requires <projectId> <pm2Id> <action>.");
      console.log(await manager.runPm2Action(projectId, Number(pm2Id), action));
      return;
    }

    if (command === "pm2-start-project") {
      const projectId = positionalArgs(args)[0];
      if (!projectId) throw new Error("pm2-start-project requires <projectId>.");
      console.log(await manager.startProjectInPm2(projectId, { refresh: true }));
      return;
    }

    if (command === "open-editor") {
      const projectId = positionalArgs(args)[0];
      if (!projectId) throw new Error("open-editor requires <projectId>.");
      console.log(await manager.openProjectInEditor(projectId));
      return;
    }

    if (command === "repo") {
      const projectId = positionalArgs(args)[0];
      if (!projectId) throw new Error("repo requires <projectId>.");
      console.log(await manager.getProjectRepository(projectId));
      return;
    }

    if (command === "pm2") {
      const projectId = positionalArgs(args)[0] || null;
      if (args.includes("--refresh")) await manager.refreshPm2();
      if (projectId) {
        const status = manager.getProjectPm2Status(projectId);
        console.log({
          available: status.available,
          status: status.status,
          checkedAt: status.checkedAt,
          error: status.error,
        });
        console.table(
          status.processes.map((proc) => ({
            id: proc.id,
            name:
              proc.namespace && proc.namespace !== "default"
                ? `${proc.namespace}/${proc.name}`
                : proc.name,
            status: proc.status,
            pid: proc.pid,
            cpu: proc.cpu,
            memoryBytes: proc.memoryBytes,
            uptimeMs: proc.uptimeMs,
            restarts: proc.restarts,
            cwd: proc.cwd,
            script: proc.script,
          })),
        );
      } else {
        const status = manager.getPm2Status();
        console.log({
          available: status.available,
          checkedAt: status.checkedAt,
          error: status.error,
          processCount: status.processCount,
          online: status.online,
          stopped: status.stopped,
          errored: status.errored,
        });
        console.table(
          status.processes.map((proc) => ({
            id: proc.id,
            name:
              proc.namespace && proc.namespace !== "default"
                ? `${proc.namespace}/${proc.name}`
                : proc.name,
            status: proc.status,
            pid: proc.pid,
            cpu: proc.cpu,
            memoryBytes: proc.memoryBytes,
            uptimeMs: proc.uptimeMs,
            restarts: proc.restarts,
            cwd: proc.cwd,
            script: proc.script,
          })),
        );
      }
      return;
    }

    if (command === "discover") {
      const depth = Number(optionValue(args, "--depth", 5));
      const roots = positionalArgs(args, ["--depth"]);
      if (!roots.length) throw new Error("discover requires at least one parent folder.");
      const result = await manager.discoverProjects(roots, { maxDepth: depth });
      console.table(
        result.projects.map((project) => ({
          name: project.name,
          path: project.projectRoot,
          version: project.version || "",
          registered: project.registered,
          validPackageJson: project.validPackageJson,
        })),
      );
      if (result.errors.length) console.log("Scan errors:", result.errors);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await manager.shutdown();
  }
}

main().catch((error) => {
  console.error("Error:", error.message || error);
  process.exitCode = 1;
});
