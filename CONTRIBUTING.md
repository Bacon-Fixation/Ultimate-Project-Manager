# Contributing to Ultimate Project Manager

Thanks for helping improve Ultimate Project Manager (UPM). The project manages backups, restores, local files, PM2 processes, services, and optional remote agents, so changes should favor predictable behavior, accessibility, and safe failure modes over clever shortcuts.

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

npm run desktop:build -- --platform mac --arch x64
npm run desktop:build -- --platform mac --arch arm64
npm run desktop:build -- --platform mac --arch universal
```

For release-quality cross-platform output, prefer `.github/workflows/desktop-multiarch.yml`, which builds each architecture on an appropriate GitHub-hosted runner. macOS artifacts should be built on macOS. Signing/notarization can be added later without changing the architecture matrix.

PM2 users can use the scripts documented in the README.

## Project expectations

- Preserve CommonJS and the supported Node.js versions in `package.json` unless a deliberate migration is being proposed. The current source toolchain requires Node.js 22.18+ or 24.11+.
- Keep Electron desktop and browser dashboard behavior aligned unless a feature is explicitly desktop-only.
- Reuse the existing dashboard components, control styles, icon registry, dialogs, and accessibility behavior.
- Preserve accessibility for users with color-vision deficiencies. Color must not be the only way that status, severity, selection, success, warning, failure, or other important information is communicated.
- Pair meaningful colors with text, icons, shapes, patterns, borders, or other non-color indicators where practical.
- Maintain sufficient contrast between text, controls, backgrounds, borders, chart elements, focus states, and interactive states.
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

If a platform-specific feature cannot be executed locally, add the strongest static or targeted regression test practical and describe the limitation in the pull request.

## UI and accessibility changes

Check both Electron and browser modes. Also check a narrower desktop window so navigation, dialogs, toolbars, dropdowns, charts, and project cards do not overflow or hide required actions.

When changing UI behavior or styling, also verify:

- Statuses remain understandable without relying on color alone.
- Success, warning, error, offline, degraded, active, selected, and disabled states have non-color cues where appropriate.
- Project health indicators and service/process states remain distinguishable for users with common forms of color-vision deficiency.
- Charts and graphs do not depend solely on similar colors to distinguish datasets. Use labels, values, markers, line styles, patterns, tooltips, or other identifiers where appropriate.
- Chart hover and focus states expose the relevant value or label rather than requiring the user to infer it from color.
- Buttons, links, dropdown items, tabs, toggles, and other controls have visible hover, focus, active, and disabled states.
- Text and important UI controls retain suitable contrast against their backgrounds.
- Focus indicators are visible and are not removed without an accessible replacement.
- Information shown through badges, borders, highlights, or notification colors is also understandable through text, icons, or another visual distinction.
- Any existing colorblind or accessibility options continue to work after the change.

Where practical, test UI changes using simulations for common color-vision deficiencies such as protanopia, deuteranopia, and tritanopia.

Accessibility fixes should be treated as functional improvements rather than cosmetic-only changes when they affect a user's ability to understand status or operate the application.

## Documentation

User-visible behavior should be reflected in at least one appropriate place: README, built-in Help, `docs/wiki`, configuration examples, or migration notes.

Accessibility-related behavior or new accessibility options should also be documented when they affect how users configure or interact with the interface.

## Pull requests

Use the pull request template. Keep commits free of generated release output, personal runtime data, logs, credentials, and local backups.

For UI changes, briefly note any relevant accessibility checks performed, especially when the change affects colors, charts, status indicators, alerts, navigation, or interactive control states.
