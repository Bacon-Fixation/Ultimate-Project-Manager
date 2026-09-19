# Security Policy

Ultimate Project Manager can access project files, backups, process controls, local services, and optional LAN agents. Treat a UPM installation as an administrative tool.

## Reporting a security issue

Do not publish exploitable security details, real credentials, session secrets, backup encryption keys, or private user data in a public issue.

When the repository is public, use GitHub's private security reporting feature if enabled. If private reporting is not available, open a minimal issue stating that you have a security report without including exploit details or secrets, so a private contact path can be established.

## Security-sensitive areas

Extra care is expected around:

- authentication and session-secret handling
- `.env` and setup import/export behavior
- Electron IPC and external navigation
- filesystem/path validation
- archive creation, extraction, and restore safety
- symlink handling
- backup encryption and key handling
- PM2/process controls
- remote access and LAN Remote Agent permissions
- HTTP/TCP service checks

## Secrets

Never commit or attach:

- `UPM_SESSION_SECRET`
- backup encryption keys
- passwords or password hashes intended for a real installation
- access tokens
- private keys
- authenticated cookies
- private repository credentials

Use `.env.example` and obviously non-secret placeholders when documentation needs an example.

## Privilege elevation

UPM runs with normal user privileges by default. Project-level elevation is opt-in and fail-closed. UPM does not store administrator/root passwords, does not inject sudo credentials, and does not suppress operating-system authorization prompts.

On Windows, a packaged desktop build can explicitly restart through the standard UAC `runas` flow. On macOS, the packaged desktop can request administrator authorization through the operating system. On Linux, the Electron desktop is intentionally not relaunched as root and UPM does not add `--no-sandbox`; if a project genuinely requires root, run the UPM server/CLI session explicitly as root and limit access to that instance.

For PM2-managed elevated projects, start the elevated UPM session before its PM2 daemon is created so the daemon and its child processes inherit the intended privilege context. Do not mix ordinary and elevated control of the same PM2 daemon unless you understand the resulting permission model.
