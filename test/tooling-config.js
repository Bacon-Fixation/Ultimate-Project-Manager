"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const packageJson = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const prettier = JSON.parse(read(".prettierrc.json"));

assert.strictEqual(prettier.printWidth, 100);
assert.strictEqual(prettier.tabWidth, 2);
assert.strictEqual(prettier.useTabs, false);
assert.strictEqual(prettier.semi, true);
assert.strictEqual(prettier.singleQuote, false);
assert.strictEqual(prettier.trailingComma, "all");
assert.strictEqual(prettier.endOfLine, "lf");

for (const script of [
  "start",
  "restart",
  "stop",
  "logs",
  "status",
  "serve",
  "desktop",
  "desktop:pack",
  "desktop:build",
  "desktop:build:web",
  "desktop:build:matrix",
  "desktop:size",
  "config:init",
  "setup",
  "check",
  "test",
  "lint",
  "lint:fix",
  "lint:strict",
  "format",
  "format:check",
  "quality",
  "quality:fix",
  "auth:hash",
  "encryption:key",
  "agent",
  "agent:pm2",
]) {
  assert.ok(packageJson.scripts?.[script], `Missing npm script: ${script}`);
}

for (const removed of [
  "desktop:dev",
  "start:direct",
  "config:setup",
  "terminal",
  "desktop:build:win",
  "desktop:build:win:slim",
  "desktop:build:current:slim",
  "desktop:build:matrix:help",
  "desktop:size-report",
]) {
  assert.equal(packageJson.scripts?.[removed], undefined, `Legacy npm script remains: ${removed}`);
}

assert.deepStrictEqual(packageJson.bin, { "ultimate-project-manager": "src/cli.js" });
assert.equal(lock.version, packageJson.version);
assert.equal(lock.packages?.[""]?.version, packageJson.version);
assert.deepStrictEqual(lock.packages?.[""]?.bin, packageJson.bin);
assert.deepStrictEqual(lock.packages?.[""]?.devDependencies, packageJson.devDependencies);
assert.deepStrictEqual(lock.packages?.[""]?.dependencies, packageJson.dependencies);

assert.match(packageJson.devDependencies?.eslint || "", /^10\./);
assert.match(packageJson.devDependencies?.globals || "", /^17\./);
assert.match(packageJson.devDependencies?.prettier || "", /^3\./);
assert.match(packageJson.devDependencies?.electron || "", /^44\./);
assert.match(packageJson.devDependencies?.["electron-builder"] || "", /^26\./);
assert.strictEqual(packageJson.main, "desktop/main.js");
assert.strictEqual(packageJson.engines?.node, "^22.18.0 || >=24.11.0");

assert.strictEqual(packageJson.build?.appId, "com.baconfixation.ultimateprojectmanager");
assert.strictEqual(packageJson.desktopName, "com.baconfixation.ultimateprojectmanager.desktop");
assert.strictEqual(
  packageJson.build?.linux?.desktopName,
  undefined,
  "desktopName is package metadata and must not be nested under build.linux for electron-builder v26.",
);
assert.strictEqual(packageJson.build?.linux?.syncDesktopName, true);
assert.strictEqual(packageJson.build?.asarUnpack, undefined);
assert.strictEqual(packageJson.build?.asar?.smartUnpack, true);
assert.deepStrictEqual(packageJson.build?.electronLanguages, ["en-US"]);
assert.strictEqual(packageJson.build?.compression, "maximum");
assert.ok(packageJson.build?.files?.includes("!**/node_modules/**/*.map"));
assert.ok(packageJson.build?.files?.includes("!**/node_modules/**/*.d.ts"));
assert.ok(
  packageJson.build?.files?.includes(
    "!**/node_modules/**/{test,tests,__tests__,example,examples,benchmark,benchmarks}/**",
  ),
);
assert.ok(packageJson.build?.win?.target?.includes("nsis"));
assert.strictEqual(packageJson.build?.win?.icon, "icon.ico");
assert.ok(packageJson.build?.linux?.target?.includes("AppImage"));
assert.ok(packageJson.build?.linux?.target?.includes("tar.xz"));
assert.ok(packageJson.build?.mac?.target?.includes("dmg"));
assert.ok(packageJson.build?.mac?.target?.includes("zip"));
assert.strictEqual(packageJson.build?.mac?.minimumSystemVersion, "13.0");

const slimBuild = require(path.join(root, "build", "electron-builder-slim.cjs"));
assert.strictEqual(slimBuild.asarUnpack, undefined);
assert.deepStrictEqual(slimBuild.electronLanguages, ["en-US"]);
assert.strictEqual(slimBuild.asar?.smartUnpack, true);
assert.strictEqual(slimBuild.directories?.output, "release-slim");

const previousWebPackageUrl = process.env.UPM_WEB_PACKAGE_URL;
process.env.UPM_WEB_PACKAGE_URL = "https://downloads.example.test/upm/latest";
const webConfigPath = path.join(root, "build", "electron-builder-web.cjs");
delete require.cache[require.resolve(webConfigPath)];
const webBuild = require(webConfigPath);
assert.strictEqual(webBuild.nsisWeb?.appPackageUrl, process.env.UPM_WEB_PACKAGE_URL);
assert.strictEqual(webBuild.directories?.output, "release-web");
assert.ok(webBuild.win?.target?.includes("nsis-web"));
if (previousWebPackageUrl === undefined) delete process.env.UPM_WEB_PACKAGE_URL;
else process.env.UPM_WEB_PACKAGE_URL = previousWebPackageUrl;

for (const required of [
  "build/icon.ico",
  "build/icon.png",
  "build/electron-builder-slim.cjs",
  "build/electron-builder-web.cjs",
  "scripts/electron-build.js",
  "scripts/electron-size-report.js",
  "scripts/run-tests.js",
  "scripts/check-js-syntax.js",
  "scripts/project-audit.js",
  ".github/workflows/desktop-multiarch.yml",
  ".env.agent.example",
  "public/favicon.png",
]) {
  assert.ok(fs.existsSync(path.join(root, required)), `Missing required file: ${required}`);
}
assert.equal(
  fs.existsSync(path.join(root, "icon.ico")),
  false,
  "Unused root icon.ico should be removed.",
);
assert.deepStrictEqual(
  fs.readdirSync(root).filter((name) => name.toLowerCase().endsWith(".bat")),
  [],
  "Root batch launchers should not be restored.",
);

const desktopMain = read("desktop/main.js");
assert.ok(desktopMain.includes("contextIsolation: true"));
assert.ok(desktopMain.includes("nodeIntegration: false"));
assert.ok(desktopMain.includes("sandbox: true"));
assert.ok(desktopMain.includes("setWindowOpenHandler"));
assert.ok(desktopMain.includes("requireTrustedIpcSender"));
assert.ok(desktopMain.includes("X-UPM-Desktop-Token"));

const server = read("src/index.js");
assert.ok(server.includes("maxBuckets = 5000"));
assert.ok(
  server.includes(
    'error: exposeDetails ? error.message || "Request failed." : "Internal server error."',
  ),
);
assert.ok(server.includes("server.maxHeadersCount = 100"));
assert.ok(server.includes("server.maxRequestsPerSocket = 1000"));

const agentServer = read("src/remote-agent/server.js");
assert.ok(agentServer.includes("createRequestLimiter"));
assert.ok(agentServer.includes("Content-Security-Policy"));
assert.ok(agentServer.includes("Too many LAN agent requests"));
const agentEntry = read("src/remote-agent/index.js");
assert.ok(agentEntry.includes('minVersion: "TLSv1.2"'));
assert.ok(agentEntry.includes("server.headersTimeout = 10_000"));

const buildHelper = read("scripts/electron-build.js");
assert.ok(buildHelper.includes("--platform win --arch x64"));
assert.ok(buildHelper.includes("universal"));
assert.ok(buildHelper.includes("electron-builder"));
assert.match(
  buildHelper,
  /["']--publish["'],\s*["']never["']/,
  "desktop packaging must explicitly disable electron-builder publishing",
);
assert.ok(buildHelper.includes("build.linux.desktopName is invalid for electron-builder 26"));
assert.ok(buildHelper.includes("build.linux.syncDesktopName is enabled"));
assert.ok(buildHelper.includes("Linux AppImage cannot be built directly"));
assert.ok(buildHelper.includes("electronuserland/builder:24"));
assert.ok(buildHelper.includes("--docker"));
assert.ok(buildHelper.includes("UPM_ELECTRON_DOCKER_IMAGE"));
const workflow = read(".github/workflows/desktop-multiarch.yml");
assert.ok(workflow.includes("npm run desktop:build -- --platform win --arch x64"));
assert.ok(workflow.includes("npm run desktop:build -- --platform mac --arch universal"));
assert.ok(workflow.includes("npm run desktop:size"));

const eslintConfig = read("eslint.config.js");
assert.ok(eslintConfig.includes('sourceType: "commonjs"'));
assert.ok(eslintConfig.includes('"no-undef": "error"'));
assert.ok(eslintConfig.includes('"no-eval": "error"'));
assert.ok(eslintConfig.includes('"scripts/**/*.js"'));
assert.ok(eslintConfig.includes('"build/**/*.cjs"'));

const prettierIgnore = read(".prettierignore");
for (const ignored of ["node_modules/", "data/", ".env", "*.zip", "*.log", "release/"]) {
  assert.ok(prettierIgnore.includes(ignored), `Prettier ignore missing: ${ignored}`);
}

const editorConfig = read(".editorconfig");
assert.ok(editorConfig.includes("indent_size = 2"));
assert.ok(editorConfig.includes("end_of_line = lf"));
assert.doesNotMatch(editorConfig, /\[\*\.bat\]/);
assert.doesNotMatch(read(".gitattributes"), /\*\.bat/);
assert.doesNotMatch(read(".gitignore"), /^test\/$/m);

console.log("Tooling configuration tests passed.");
