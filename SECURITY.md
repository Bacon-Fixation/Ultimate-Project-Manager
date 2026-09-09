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
