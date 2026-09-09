# Contributing to Ultimate Project Manager

Thanks for helping improve Ultimate Project Manager (UPM). The project manages backups, restores, local files, PM2 processes, services, and optional remote agents, so changes should favor predictable behavior and safe failure modes over clever shortcuts.

## Before opening a change

1. Search existing issues and pull requests.
2. Keep a change focused on one problem or closely related feature set.
3. For large behavior changes, open an issue first so the workflow and compatibility impact can be discussed.
4. Never include real `.env` files, passwords, session secrets, backup encryption keys, access tokens, private repository credentials, or user project data.

## Development setup

```bash
npm install
npm run check
npm run lint
npm test
```

Useful launch modes:

```bash
npm run desktop
npm run serve
```

Electron release helpers:

```bash
npm run desktop:build:matrix
npm run desktop:build -- --platform win --arch x64
npm run desktop:build -- --platform win --arch arm64
npm run desktop:build -- --platform linux --arch x64
npm run desktop:build -- --platform linux --arch arm64
# From Windows/macOS, add --docker to Linux commands
npm run desktop:build -- --platform mac --arch x64
npm run desktop:build -- --platform mac --arch arm64
npm run desktop:build -- --platform mac --arch universal
```

For release-quality cross-platform output, prefer `.github/workflows/desktop-multiarch.yml`, which builds each architecture on an appropriate GitHub-hosted runner. AppImage must be built on Linux or through the helper's explicit `--docker` path. macOS DMG/ZIP artifacts should be built on macOS. Signing/notarization can be added later without changing the architecture matrix.

PM2 users can use the scripts documented in the README.

## Project expectations

- Preserve CommonJS and the supported Node.js versions in `package.json` unless a deliberate migration is being proposed. The current source toolchain requires Node.js 22.18+ or 24.11+.
- Keep Electron desktop and browser dashboard behavior aligned unless a feature is explicitly desktop-only.
- Reuse the existing dashboard components, control styles, icon registry, dialogs, and accessibility behavior.
- Keep local filesystem and archive paths validated. Never trust a browser-supplied path simply because the UI normally generates it.
- Keep desktop IPC sender validation and external URL allow-listing intact.
- Do not weaken archive verification, backup checksum, restore path, symlink, encryption, or recovery protections.
- Remote Agent changes should stay explicit about read-only versus write/process-control capabilities.

## Tests

Add or update regression coverage for behavior changes. At minimum run:

```bash
npm run check
npm run lint
npm test
```

If a platform-specific feature cannot be executed locally, add the strongest static/targeted regression test practical and describe the limitation in the pull request.

## UI changes

Check both Electron and browser modes. Also check a narrower desktop window so navigation, dialogs, toolbars, dropdowns, charts, and project cards do not overflow or hide required actions.

## Documentation

User-visible behavior should be reflected in at least one appropriate place: README, built-in Help, `docs/wiki`, configuration examples, or migration notes.

## Pull requests

Use the pull request template. Keep commits free of generated release output, personal runtime data, logs, credentials, and local backups.
