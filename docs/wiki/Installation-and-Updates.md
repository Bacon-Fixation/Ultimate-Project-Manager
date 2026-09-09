# Installation and Updates

## Electron desktop release

Use the packaged Electron release for the most standalone-app-like experience. UPM can be packaged for Windows, Linux, and macOS. Installed builds keep writable runtime data in the per-user application data directory rather than modifying installed program files.

Electron 44 provides 64-bit x64 and ARM64 binaries. Windows and Linux therefore ship as x64 or ARM64 builds. macOS can ship separate Intel x64 and Apple Silicon ARM64 builds, or a larger Universal build containing both architectures. Electron 44 requires macOS 13 or later.

Use **More → Desktop → Open Data Folder** to locate desktop runtime data.

### Release-size choices

- Prefer architecture-specific packages for the smallest normal download.
- The Windows NSIS web installer is the smallest initial installer because it downloads the matching application package during setup.
- Linux `tar.xz` is useful when download size matters more than one-file AppImage convenience.
- macOS Universal is convenient but necessarily larger than separate x64 and ARM64 downloads.
- UPM keeps the application in ASAR, ships only the `en-US` Electron locale, and excludes common test/example/source-map/type-definition content from packaged dependencies.
- `maximum` electron-builder compression is enabled for release profiles, but Electron/Chromium remains the dominant size floor.

## Source / development install

Source installs require Node.js 22.18+ or 24.11+ to match the locked Babel parser/toolchain.

```bash
npm install
npm run serve
```

Electron development mode:

```bash
npm run desktop
```

PM2-managed mode:

```bash
npm start
```

### Source command surface

UPM uses npm scripts rather than platform-specific batch launchers. The common commands are:

```bash
npm run setup
npm run serve
npm run desktop
npm start
npm run status
npm run logs
npm run agent
```

Electron builds use one cross-platform helper. For example:

```bash
npm run desktop:build -- --platform win --arch x64
npm run desktop:build -- --platform linux --arch arm64
# On Windows/macOS, use Docker for Linux/AppImage:
npm run desktop:build -- --platform linux --arch x64 --docker
npm run desktop:build -- --platform mac --arch universal
npm run desktop:build:matrix
```

AppImage requires Linux tooling and cannot be built directly on Windows or macOS. UPM detects this before launching electron-builder. Use `--docker` for a local Linux build from Windows/macOS, or use the native multi-platform GitHub Actions workflow. macOS DMG/ZIP output requires macOS.

## Updating

Before replacing an existing installation:

1. Create a verified backup of important managed projects.
2. Export UPM setup when moving to another machine or installation.
3. Preserve the desktop data directory / `.env` as appropriate for your installation method.
4. Keep backup encryption keys separately. Old encrypted backups require the key used to create them.
5. Read release notes for configuration migrations.

Do not copy `node_modules` between substantially different Node.js/Electron environments; reinstall dependencies instead.
