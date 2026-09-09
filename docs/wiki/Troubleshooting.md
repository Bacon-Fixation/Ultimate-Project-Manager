# Troubleshooting

## Desktop app does not launch

1. Start from a terminal or the provided launcher so startup errors remain visible.
2. Check the desktop data directory and `.env` for malformed runtime values.
3. If authentication/session-secret settings were recently changed, use the current Settings/rotation flow rather than manually pasting a short secret.
4. Confirm the configured port is not already occupied.

## Browser dashboard cannot connect

- Confirm the UPM backend is running.
- Verify the host/port in Settings or `.env`.
- For LAN access, verify bind address and firewall rules.
- For reverse proxies, verify forwarded host/protocol/origin and cookie settings.

## Backup fails verification

Open the backup error details and check archive readability, source permissions, destination free space, encryption-key configuration, path/symlink safety errors, and temporary antivirus/file-lock interference.

## PM2 process is missing

Use **Refresh PM2**, confirm PM2 is available on PATH, and compare the configured process name/ecosystem file with `pm2 list` / `pm2 show`.

## Project waits for Docker forever

Confirm Docker/Docker Desktop is actually running and healthy on the same execution host as the project. A LAN project checks the remote host, not the dashboard PC.

## UI looks stale after a change

Use **Refresh** in the current tab or **More → Dashboard & Service → Refresh Dashboard**. For process-specific data use **Refresh PM2** when needed.

## When opening an issue

Include UPM version, operating system, desktop/browser mode, reproduction steps, and a sanitized diagnostic/log excerpt. Never post secrets or full `.env` files.
