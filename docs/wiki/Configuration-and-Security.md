# Configuration and Security

## Runtime configuration

UPM uses `.env` as the primary runtime configuration source for current installations. Use `.env.example` as the reference and the Settings UI for supported runtime changes.

## Session secret

`UPM_SESSION_SECRET` protects authenticated browser sessions. UPM can rotate the file-backed session secret and verifies the saved value. Desktop startup also protects against invalid stale inherited overrides so a malformed value does not unnecessarily prevent launch.

Rotating the secret invalidates existing browser sessions.

Never publish the session secret.

## Remote access

UPM is local-only by default. Enabling LAN or reverse-proxy access changes the threat model. Use authentication, appropriate bind settings, and trusted proxy/origin configuration. Do not expose UPM directly to the public Internet without an intentional security design.

## Backup encryption

Backup encryption keys are separate from session authentication. Keep encryption keys outside normal source control and preserve old keys for old encrypted backups.

## Electron security

The desktop shell validates IPC senders and constrains external navigation to HTTP/HTTPS URLs. New desktop features should preserve those boundaries.
