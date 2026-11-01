"use strict";

const assert = require("assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { DependencyInspector } = require("../src/dependencies/dependency-inspector");

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dependency-inspector-test-"));
  try {
    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "sample-app",
          version: "1.2.3",
          dependencies: { express: "^5.0.0", lodash: "^4.17.0" },
          devDependencies: { mocha: "^10.0.0" },
        },
        null,
        2,
      ),
    );
    for (const [name, version] of Object.entries({
      express: "5.0.0",
      lodash: "4.17.21",
      mocha: "10.8.2",
    })) {
      const dir = path.join(root, "node_modules", name);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version }));
    }

    await fsp.writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": { name: "sample-app", version: "1.2.3" },
            "node_modules/express": { version: "5.0.0" },
            "node_modules/lodash": { version: "4.17.21" },
            "node_modules/mocha": { version: "10.8.2" },
          },
        },
        null,
        2,
      ),
    );

    let calls = 0;
    const inspector = new DependencyInspector({
      cacheMs: 600000,
      runner: async () => {
        calls += 1;
        return {
          ok: true,
          command: "npm outdated --json --long",
          data: {
            express: { current: "5.0.0", wanted: "5.1.0", latest: "5.1.0" },
            mocha: { current: "10.8.2", wanted: "10.8.2", latest: "11.7.1" },
          },
        };
      },
    });

    const result = await inspector.inspect("project-1", root, {
      refresh: true,
    });
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.outdated, 2);
    assert.equal(result.summary.current, 1);
    assert.equal(result.registryAvailable, true);
    assert.equal(result.dependencies.find((item) => item.name === "express").outdated, true);
    assert.equal(result.dependencies.find((item) => item.name === "lodash").upToDate, true);
    assert.equal(result.dependencies.find((item) => item.name === "lodash").current, "4.17.21");
    assert.equal(
      result.dependencies.find((item) => item.name === "mocha").types.includes("development"),
      true,
    );

    await inspector.inspect("project-1", root);
    assert.equal(calls, 1, "cached dependency results should avoid another registry check");
    await inspector.inspect("project-1", root, { refresh: true });
    assert.equal(calls, 2, "refresh should force another registry check");

    const offline = new DependencyInspector({
      runner: async () => ({
        ok: false,
        data: {},
        error: "offline",
        command: "npm outdated",
      }),
    });
    const offlineResult = await offline.inspect("project-2", root, {
      refresh: true,
    });
    assert.equal(offlineResult.registryAvailable, false);
    assert.equal(offlineResult.summary.total, 3);
    assert.equal(
      offlineResult.dependencies.find((item) => item.name === "lodash").current,
      "4.17.21",
    );

    let versionCalls = 0;
    let npmInstallCalls = 0;
    const updater = new DependencyInspector({
      runner: async () => ({
        ok: true,
        data: {},
        command: "npm outdated --json --long",
      }),
      versionRunner: async (_projectRoot, packageName) => {
        versionCalls += 1;
        assert.equal(packageName, "express");
        return {
          ok: true,
          versions: ["5.0.0", "5.1.0", "6.0.0-beta.1"],
          command: "npm view express versions --json",
        };
      },
      npmRunner: async (_projectRoot, args) => {
        npmInstallCalls += 1;
        assert.equal(args.includes("express@5.1.0"), true);
        await fsp.writeFile(
          path.join(root, "node_modules", "express", "package.json"),
          JSON.stringify({ name: "express", version: "5.1.0" }),
        );
        return { stdout: "updated", stderr: "" };
      },
    });
    const stableVersions = await updater.getVersions("project-3", root, "express");
    assert.deepEqual(stableVersions.versions, ["5.1.0", "5.0.0"]);
    const prereleaseVersions = await updater.getVersions("project-3", root, "express", {
      includePrerelease: true,
    });
    assert.equal(prereleaseVersions.versions.includes("6.0.0-beta.1"), true);
    assert.equal(versionCalls, 1, "published versions should be cached");

    const update = await updater.updateDependency("project-3", root, "express", "5.1.0", {
      saveMode: "preserve",
      runScripts: false,
    });
    assert.equal(update.version, "5.1.0");
    assert.equal(update.declaration, "^5.1.0");
    assert.equal(npmInstallCalls, 1);
    const updatedPackageJson = JSON.parse(
      await fsp.readFile(path.join(root, "package.json"), "utf8"),
    );
    assert.equal(updatedPackageJson.dependencies.express, "^5.1.0");
    console.log("Dependency inspector test passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
