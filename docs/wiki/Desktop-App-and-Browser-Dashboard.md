# Desktop App and Browser Dashboard

UPM uses one backend and dashboard codebase with runtime-aware presentation.

## Desktop app

The Electron app provides:

- compact edge-to-edge layout
- native application and tray menus
- native folder selection
- desktop notifications
- launch-at-login support on Windows/macOS and close-to-tray options
- protected Electron IPC
- operating-system handling for external links
- **Open Dashboard In Browser**
- an application-only **About Ultimate Project Manager** dialog

The normal menu bar may be hidden until the platform menu key is used.

## Desktop release platforms

The desktop packaging configuration supports:

- Windows x64 and ARM64 via NSIS
- Linux x64 and ARM64 via AppImage and `tar.xz`
- macOS Intel x64 and Apple Silicon ARM64 via DMG/ZIP
- macOS Universal for one larger package that contains both Mac architectures

Architecture-specific releases are preferred when download size matters. Electron 44 no longer supplies Windows ia32 or Linux armv7l binaries, so UPM does not advertise unsupported 32-bit targets.

## Browser dashboard

The browser view provides the same core project operations and is useful for:

- a normal browser-based workflow on the host PC
- explicitly enabled LAN access
- keeping the Electron window closed while using the backend through a browser

## Security note

UPM is local-only by default. Do not expose the dashboard to untrusted networks without understanding the authentication, bind-address, proxy, and cookie/security settings documented in Configuration and Security.
