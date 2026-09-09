# FAQ

## Does UPM replace Git?

No. Git tracks source history and collaboration. UPM adds operational backups, recovery layers, runtime/process visibility, file tools, and project-management conveniences. Git is one possible recovery source, not a replacement for backups.

## Does every scan create a backup?

No. Normal backups are content-aware and usually skip archive creation when meaningful file contents have not changed. You can still force a backup.

## Can I use both the Electron app and browser dashboard?

Yes. The Electron app runs the backend and can open the same dashboard in your normal browser.

## Where does the installed desktop app store writable data?

In the per-user application data directory. Use **More → Desktop → Open Data Folder**.

## What happens when I rotate the session secret?

Existing authenticated browser sessions become invalid and must sign in again. UPM verifies the newly saved secret and hardens startup against invalid stale environment overrides.

## Is the secondary backup destination required?

No. It is optional and best-effort. The primary destination remains the authoritative local backup target.

## Are LAN Remote Agent projects fully writable from the dashboard?

Only for capabilities intentionally implemented by the agent. UPM keeps local-only tools and remote/process-control boundaries explicit rather than assuming all actions are safe remotely.

## Where can I report a bug or request a feature?

https://github.com/Bacon-Fixation/Ultimate-Project-Manager/issues

## How can I support development?

https://ko-fi.com/baconfixation
