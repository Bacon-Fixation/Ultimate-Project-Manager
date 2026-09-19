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


## Runnable backup builds

Local PM2-managed projects can prepare a verified backup as a runnable **Build Slot**. This extracts the archive into UPM's runtime data area instead of restoring over the registered project folder. The original backup archive is not modified.

From **Backups**:

- **Prepare Build** extracts and verifies a reusable runtime copy.
- **Run Build** prepares the copy when needed and hot-swaps the matched PM2 project to it.
- **Reset Build** recreates an existing runtime copy from the verified archive.
- **Build Slots** lets you move between prepared builds or return to **Production Source**.

A switch removes only PM2 processes matched to the project, starts the selected ecosystem from the target runtime root, verifies the resulting PM2 working directory, and automatically restores the previous build if startup fails. The active build selection is persisted so PM2 auto-start continues to use the selected slot after UPM restarts.

Under **Edit Project → Runtime → Runnable backup builds**, configure project-relative live overlay paths. `.env` is the default so secrets and current environment settings do not need to be stored in every backup. Add files such as `config.json` when desired. UPM can also reuse production `node_modules` with a filesystem junction/symlink for fast switching; it warns when the selected build's package metadata differs from production.

Prepared slots are working copies and may accumulate runtime changes. Reset the slot whenever you need a clean copy of the backup. Runnable build slots currently apply to local projects; LAN Remote Agent projects are not switched through the local PM2 daemon.
