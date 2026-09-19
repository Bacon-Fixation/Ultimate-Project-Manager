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
- saved **Remote UPM** connections for opening another full UPM dashboard on the LAN

The normal menu bar may be hidden until the platform menu key is used.

## Desktop release platforms

The desktop packaging configuration supports:

- Windows x64 and ARM64 via NSIS
- Linux x64 and ARM64 via AppImage and `tar.xz`
- macOS Intel x64 and Apple Silicon ARM64 via DMG/ZIP
- macOS Universal for one larger package that contains both Mac architectures

Architecture-specific releases are preferred when download size matters. Electron 44 no longer supplies Windows ia32 or Linux armv7l binaries, so UPM does not advertise unsupported 32-bit targets.

## Remote UPM connections

The Electron application can open another UPM instance without requiring a separate companion client. Open **More → Desktop → Remote UPM Connections**, **Remote UPM → Connect / Manage Remote UPMs**, or the equivalent tray menu.

A saved connection contains:

- a display name
- the remote UPM root URL, such as `https://192.168.1.50:4310`
- whether that remote Electron browser session should persist across UPM restarts

The connection manager can test `/api/auth/status` before opening the dashboard. The remote server's normal login screen handles its username and password; the connection profile does not store those credentials. If session persistence is enabled, Electron stores the resulting remote session in a dedicated per-connection browser partition. Removing the connection clears that stored browser session.

### Isolation model

Remote dashboards run in separate BrowserWindows with context isolation, Chromium sandboxing, Node integration disabled, and no UPM desktop preload. This means a remote dashboard cannot inherit the local desktop token or call local-only Electron actions such as folder selection, local path opening, elevation/restart, or desktop settings IPC. Navigation is constrained to the configured remote origin and external HTTP(S) links are handed to the operating-system browser.

The remote UPM server remains authoritative for permissions:

- `UPM_ALLOW_REMOTE_DASHBOARD=true` allows the dashboard to load remotely.
- `UPM_AUTH_ENABLED=true` is required for remote admin/filesystem features.
- `UPM_ALLOW_REMOTE_ADMIN=true` enables authenticated remote write/control actions.
- `UPM_ALLOW_REMOTE_FILESYSTEM=true` enables authenticated remote filesystem/archive details.

The remote host must also bind to a LAN-accessible address, for example `UPM_HOST=0.0.0.0` or a specific LAN interface. Prefer HTTPS. A direct `http://` LAN connection works when the remote cookie settings permit it, but the username/password and cookie are not encrypted in transit.

### Remote UPM vs LAN Remote Agent

Use **Remote UPM** when the other machine already runs a complete UPM instance and you want its full dashboard. Use a **LAN Remote Agent** when you want one central UPM dashboard to control a smaller set of project, PM2, backup, and service-health operations on another machine.

## Browser dashboard

The browser view provides the same core project operations and is useful for:

- a normal browser-based workflow on the host PC
- explicitly enabled LAN access
- keeping the Electron window closed while using the backend through a browser

## Security note

UPM is local-only by default. Do not expose the dashboard to untrusted networks without understanding the authentication, bind-address, proxy, and cookie/security settings documented in Configuration and Security.
