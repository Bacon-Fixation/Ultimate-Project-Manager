# Developing & Building Ultimate Project Manager

This document contains the source-development, local testing, Electron compilation, architecture, and release-building information for Ultimate Project Manager.

For application features and normal usage, see [`README.md`](README.md).

For contribution requirements, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

# Requirements

Ultimate Project Manager uses Node.js and CommonJS.

The current source toolchain requires:

- Node.js **22.18+**
- or Node.js **24.11+**

Use the Node.js versions declared or supported by `package.json` unless the project is deliberately being migrated.

---

# Install Dependencies

From the project root:

```bash
npm install
```

Before making changes, it is also useful to verify the existing project:

```bash
npm run check
npm run lint
npm test
```

---

# Development Modes

## Electron Desktop

Launch the desktop application with:

```bash
npm run desktop
```

This starts the Electron version of Ultimate Project Manager.

## Browser Dashboard

Launch the browser/server version with:

```bash
npm run serve
```

Desktop and browser behavior should remain aligned unless a feature is intentionally desktop-only.

---

# Validation

Before producing a release or opening a pull request, run:

```bash
npm run check
npm run lint
npm test
```

Platform-specific changes should also be exercised on the target operating system whenever practical.

If a platform-specific feature cannot be run locally, add the strongest practical static or regression coverage and document the limitation.

---

# Electron Builds

UPM supports Electron packages for:

| Platform | Architecture        |
| -------- | ------------------- |
| Windows  | x64                 |
| Windows  | ARM64               |
| Linux    | x64                 |
| Linux    | ARM64               |
| macOS    | Intel x64           |
| macOS    | Apple Silicon ARM64 |
| macOS    | Universal           |

---

# Build Matrix

To run the project's build matrix helper:

```bash
npm run desktop:build:matrix
```

Individual platform and architecture targets can also be requested.

---

# Windows

## x64

```bash
npm run desktop:build -- --platform win --arch x64
```

## ARM64

```bash
npm run desktop:build -- --platform win --arch arm64
```

---

# Linux

## x64

```bash
npm run desktop:build -- --platform linux --arch x64
```

## ARM64

```bash
npm run desktop:build -- --platform linux --arch arm64
```

---

# macOS

## Intel x64

```bash
npm run desktop:build -- --platform mac --arch x64
```

## Apple Silicon ARM64

```bash
npm run desktop:build -- --platform mac --arch arm64
```

## Universal

```bash
npm run desktop:build -- --platform mac --arch universal
```

---

# Cross-Platform Release Builds

For release-quality cross-platform packages, prefer the GitHub Actions workflow:

```text
.github/workflows/desktop-multiarch.yml
```

Each architecture should be built on an appropriate GitHub-hosted runner.

In particular:

- Windows artifacts should normally be built on Windows.
- Linux artifacts should normally be built on Linux.
- macOS artifacts should be built on macOS.

This avoids relying on unsupported or incomplete cross-compilation behavior.

---

# Architecture-Specific Packages

UPM desktop packages are architecture-specific by default.

This keeps users from downloading Electron runtimes for architectures they do not need.

For example, a Windows x64 user only needs the Windows x64 application package.

The same principle applies to:

- Windows ARM64
- Linux x64
- Linux ARM64
- macOS Intel
- macOS Apple Silicon

A macOS Universal build can be provided when a single combined Intel/Apple Silicon application is desirable.

---

# Windows Packaging

Windows releases can provide architecture-specific application packages.

A small NSIS web-installer bootstrap may also be used to retrieve the matching x64 or ARM64 package during installation.

Keeping the full Electron runtime architecture-specific can reduce unnecessary release size.

---

# Linux Packaging

Linux releases can use formats such as:

- AppImage
- `tar.xz`

AppImage provides a convenient single-file application.

`tar.xz` can provide a smaller compressed download for users comfortable with archive-based installation.

---

# macOS Packaging

macOS releases can target:

- Intel x64
- Apple Silicon ARM64
- Universal

macOS artifacts should be produced on macOS.

Code signing and notarization can be added to the release workflow without changing the supported architecture matrix.

---

# Desktop Application Data

Installed desktop packages should not write changing runtime state into the installed program directory.

Writable information belongs in Electron's per-user application-data directory.

This includes application runtime state and other files that must survive application updates.

Users can access the active directory through:

**More → Desktop → Open Data Folder**

Development changes should preserve this separation between installed program files and writable runtime data.

---

# Desktop & Browser Compatibility

UPM includes both:

- Electron desktop operation
- Browser dashboard operation

Changes to shared functionality should normally work in both environments.

Desktop-only functionality may include capabilities such as:

- Native folder selection
- System tray behavior
- Launch at login
- Desktop notifications
- Opening local editors
- Opening application-data folders
- Desktop-specific authentication behavior

Shared dashboard components should not assume Electron APIs are available unless the feature is explicitly desktop-only.

---

# Source Expectations

When working on the source:

- Preserve CommonJS unless a deliberate module-system migration is being proposed.
- Keep supported Node.js versions aligned with `package.json`.
- Keep Electron and browser dashboard behavior aligned.
- Reuse existing dashboard components and controls.
- Preserve accessibility behavior.
- Preserve desktop IPC sender validation.
- Preserve external URL allow-listing.
- Validate filesystem paths.
- Do not weaken backup or recovery protections.
- Do not weaken encryption or archive verification.
- Preserve LAN Agent read/write capability boundaries.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the complete contribution guidelines.

---

# Accessibility Testing

UI changes should also be checked for accessibility.

In particular:

- Do not rely on color alone to communicate application state.
- Preserve colorblind-friendly palettes.
- Preserve text/icon/border status indicators.
- Check chart readability.
- Check keyboard focus.
- Check reduced-motion behavior where applicable.
- Check narrower desktop layouts.
- Check responsive dialogs and navigation.

Common color-vision-deficiency simulations such as protanopia, deuteranopia, and tritanopia are useful when changing palettes, status indicators, or charts.

---

# Release Checks

Before creating a release package, verify at minimum:

```bash
npm run check
npm run lint
npm test
```

Also check:

- Desktop application startup
- Browser dashboard startup
- Project loading
- Settings loading
- Add Project
- Backup creation
- Backup verification
- Recovery views
- PM2 detection when available
- Docker detection when available
- File Tools
- Help
- Accessibility options
- External links
- Application-data path handling

Platform-specific packages should receive a basic startup and navigation test on their target platform whenever possible.

---

# Generated Output

Do not commit generated release artifacts, temporary package output, runtime data, logs, backups, credentials, or local application state unless the repository specifically requires a generated asset.

Release packages should be produced by the build/release process rather than stored as normal source files.

---

# Security

Never include real:

- `.env` files
- Passwords
- Session secrets
- Backup encryption keys
- LAN Agent tokens
- Access tokens
- Private repository credentials
- User project data

Development and testing should use non-sensitive test values.

---

# GitHub Actions

The multi-platform release workflow is located at:

```text
.github/workflows/desktop-multiarch.yml
```

The workflow should remain the preferred approach for producing official cross-platform artifacts because each operating system can build its own native package.

---

# Related Documentation

- [`README.md`](README.md) - application overview and features
- [`CONTRIBUTING.md`](CONTRIBUTING.md) - contribution requirements
- `docs/wiki/` - detailed usage and support documentation
- `.github/workflows/desktop-multiarch.yml` - multi-platform build workflow
