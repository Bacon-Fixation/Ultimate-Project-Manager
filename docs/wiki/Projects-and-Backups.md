# Projects and Backups

## Project registration

A UPM project points to a source directory and stores project-specific backup/runtime settings. Register projects from **Projects → Add Project** or use project discovery.

## Backup behavior

A normal backup:

1. scans project contents
2. checks whether meaningful contents changed
3. creates a stable snapshot
4. builds the archive
5. verifies the archive
6. stores it in the primary destination
7. mirrors it to the secondary destination when configured
8. records journal/change information when enabled

Timestamp-only changes normally do not create a new archive.

## Retention

Retention limits how many managed backups remain. UPM keeps backup metadata and verifies replacement writes so temporary Windows file locks are less likely to corrupt the index.

## Secondary destination

The secondary destination is optional and best-effort. A missing USB drive or secondary disk should not prevent a valid primary backup. When available again, UPM can catch up from verified primary backups.

## Encryption

Encrypted backups use AES-256-GCM. Store the encryption key safely and separately. Losing the key can make old encrypted archives unrecoverable.
