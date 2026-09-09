## Summary

Describe what this pull request changes and why.

## Scope

- [ ] UI / UX
- [ ] Backup / recovery
- [ ] PM2 / process monitoring
- [ ] Docker / service health
- [ ] File Tools / Text Sanitizer
- [ ] Desktop / Electron
- [ ] Browser dashboard
- [ ] LAN Remote Agent
- [ ] Security / authentication
- [ ] Documentation
- [ ] Tests / tooling

## Validation

List the checks you ran and the results.

```text
npm run check
npm run lint
npm test
```

If the full suite could not run, state exactly which dependency/environment limitation prevented it and which targeted tests were run instead.

## Safety checklist

- [ ] No secrets, tokens, passwords, session keys, encryption keys, or private user data are committed.
- [ ] Filesystem writes remain constrained to intended project/data/output paths.
- [ ] Backup/restore behavior preserves verification and path-safety checks.
- [ ] Desktop IPC or external-link changes keep sender and URL validation intact.
- [ ] Remote/LAN behavior does not silently expand write or process-control permissions.
- [ ] Existing configuration remains backward compatible or the migration is documented.

## UI checklist

Complete when relevant.

- [ ] Desktop and browser modes were both considered.
- [ ] Small-window/responsive behavior was checked.
- [ ] Keyboard/focus behavior remains usable.
- [ ] New controls use existing UPM styling and icon conventions.

## Documentation

Describe README, Help, wiki, migration, or release-note changes included with this PR.

## Screenshots / notes

Add screenshots or additional review notes when they materially help explain the change.
