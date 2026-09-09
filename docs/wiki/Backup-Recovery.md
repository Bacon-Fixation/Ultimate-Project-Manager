# Backup Recovery

UPM recovery is layered so one missing source does not automatically mean the file is lost.

## Recovery sources

UPM can use:

1. verified backups
2. persistent delta/change journal history
3. Git history when available

## Safe workflow

1. Identify the project and missing/damaged path.
2. Open Recovery and analyze candidates.
3. Inspect the suggested source and timestamp.
4. Export/reconstruct into the recovery workspace first.
5. Review the recovered file.
6. Only then copy it back into the live project.

## Full backup restore

A full restore should be treated as a filesystem-changing operation. Confirm the selected archive, target path, verification status, and overwrite implications first.

## Damaged metadata

Backup index metadata and backup archives are separate. If index metadata is damaged, UPM attempts last-known-good and interrupted-write recovery and can rediscover managed archives rather than assuming the archives are lost.
