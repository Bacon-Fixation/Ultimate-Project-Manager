# Ultimate Project Manager v0.10.10

Ultimate Project Manager (UPM) is a local desktop dashboard for managing, monitoring, backing up, and recovering multiple Node.js projects from one place.

---

# Goal

Ultimate Project Manager is designed to make running multiple Node.js projects less fragile.

Instead of relying on only Git, only PM2, or only a normal backup folder, UPM combines multiple management and recovery layers in one dashboard so there is usually another place to look when something goes wrong.

---

## Highlights

- Native Electron desktop application
- Multi-project dashboard
- Automatic verified backups
- Optional secondary backup destinations
- AES-256-GCM encrypted backups
- Individual-file and full-project recovery
- Persistent delta/change journal
- Git-assisted recovery
- PM2 monitoring and controls
- Docker readiness and startup gating
- Redis, MariaDB/MySQL, PostgreSQL, Docker, HTTP/HTTPS, and TCP health checks
- Interactive PM2 CPU, GPU, memory, HTTP, uptime, restart, and health-event history charts
- Interactive host CPU, memory, per-core, uptime, and history charts with exact-value hover tooltips
- LAN Remote Agents for projects on other PCs
- TODO / FIX / NOTE project tracker
- Dependency viewer
- Project diff tools
- Export Changes Feature Packs
- Duplicate, timestamp, comment, inventory, and batch File Tools
- Unicode / AI-symbol Text Sanitizer
- Setup import/export
- Editor and GitHub shortcuts
- Searchable activity and diagnostics
- Built-in Help, Tips, onboarding, and accessibility options
- GitHub-ready issue, pull-request, support, security, and wiki documentation

## Project & Support

- Repository: <https://github.com/Bacon-Fixation/Ultimate-Project-Manager>
- Issues: <https://github.com/Bacon-Fixation/Ultimate-Project-Manager/issues>
- Support development: <https://ko-fi.com/baconfixation>

The repository URL is included ahead of the public repository launch so releases, package metadata, desktop menus, and community templates are ready when the repository goes live.

---

# Desktop Releases

The Electron version can be distributed as a normal desktop release for **Windows, Linux, and macOS**.

Current Electron 44 builds target modern 64-bit systems:

- Windows: x64 and ARM64
- Linux: x64 and ARM64
- macOS: Intel x64, Apple Silicon ARM64, or a combined Universal build

Release artifacts are architecture-specific by default so users only download the Electron runtime they actually need. Windows can also use a small NSIS web-installer bootstrap that downloads the matching x64 or ARM64 application package during installation. Linux releases can use AppImage for convenience or `tar.xz` for a smaller compressed download.

### Build-host rules

**Release safety:** package builds explicitly run electron-builder with `--publish never`. GitHub Actions collects artifacts first and only the separate tag-only release job receives temporary `contents: write` permission to publish them. No Personal Access Token is required for the standard release workflow.

Electron packaging is not fully cross-compilable. In particular, AppImage requires Linux tooling. UPM now enforces the supported host before launching electron-builder so unsupported cross-builds fail with a useful message instead of a missing `mksquashfs` executable.

```bash
# Native Windows build
npm run desktop:build -- --platform win --arch x64

# Native Linux build
npm run desktop:build -- --platform linux --arch x64

# Linux build from Windows/macOS through Docker Desktop / Docker
npm run desktop:build -- --platform linux --arch x64 --docker
```

For macOS DMG/ZIP output, build on macOS. For release-quality multi-platform output, use `.github/workflows/desktop-multiarch.yml`, which runs each target on an appropriate native runner. The Docker Linux path uses `electronuserland/builder:24` by default; set `UPM_ELECTRON_DOCKER_IMAGE` to override the image when needed.

The desktop application includes the UPM web backend internally, so the normal dashboard remains available while the Electron application is running.

UPM is **local-only by default**.

### Desktop-specific features

The Electron release adds:

- Compact, edge-to-edge desktop application layout
- Main navigation with project actions and a direct Browser Dashboard option
- Traditional desktop menu hidden by default but still available with the normal menu key
- System tray controls
- Optional close-to-tray behavior
- Launch-at-login support on Windows and macOS
- Native folder selection
- Desktop notifications
- Secure same-process desktop authentication
- External links opened in the operating-system browser
- Normal browser/LAN dashboard access when explicitly enabled

Installed desktop builds keep writable runtime data in the application's per-user data directory instead of modifying the installed program files.

Use:

**More → Desktop → Open Data Folder**

to open that location.

---

# Projects

Use **Add Project** to register a project with UPM.

Each project can have its own:

- Project folder
- Primary backup folder
- Optional secondary backup folder
- Backup retention amount
- Automatic change watcher
- Backup schedule
- Backup encryption
- Persistent change journal
- File and folder exclusions
- Backup include overrides
- PM2 process configuration
- PM2 auto-start behavior
- Optional Docker startup gate
- Service-health checks
- TODO / FIX / NOTE task list
- Editor shortcut
- Repository shortcut

Projects can also be discovered from parent folders containing `package.json` files.

Project cards can be collapsed, and their state is remembered between visits.

---

# Dashboard

The main dashboard is organized into four primary areas:

### Projects

Manage projects, backups, PM2 processes, health checks, tasks, recovery, dependencies, and project tools.

### Overview

View project activity, PM2 state, host CPU and memory usage, service-health summaries, warnings, errors, and system history.

### Storage

Monitor primary and secondary backup locations, archive usage, disk capacity, and mirror availability.

### Activity

Review backups, restores, PM2 events, settings changes, File Tools runs, warnings, errors, and other operational events.

The dashboard is designed for desktop, tablet, and mobile layouts.

---

# Project Actions

Common actions are available directly from each project card.

Depending on the project, these can include:

- Backup
- Check Changes
- Backup History
- Diff
- Recovery
- Journal
- Dependencies
- Tasks
- PM2 Health
- PM2 Logs
- Open in Editor
- Open Repository
- Edit Project

Less frequently used actions are grouped under **More Actions**.

---

# Backups

UPM can automatically create compressed project backups when file contents change.

A normal backup can:

1. Scan the project
2. Detect real file-content changes
3. Create a stable snapshot
4. Build the archive
5. Verify the archive
6. Save it to the primary backup location
7. Mirror it to a secondary location when configured
8. Record change information in the persistent journal when enabled

Changing only a file timestamp does not normally create another backup.

Manual backups can still be forced whenever needed.

### Backup features

- Automatic change-based backups
- Scheduled backups
- Manual backups
- Configurable retention
- Primary and secondary destinations
- Archive verification
- Optional encryption
- Backup history
- Backup mirroring
- Selected `.gitignore` overrides
- Windows/NAS-safe metadata recovery
- Remote backups through LAN Agents

---

# Backup Verification

New backups are checked before being accepted.

Verification can include:

- Archive readability
- Archive checksum
- Unsafe archive paths
- Symlink safety
- Snapshot contents
- Encrypted archive decryption

Backups are shown as:

- **Verified**
- **Unverified**
- **Failed**

---

# Two Backup Locations

Each project can use:

**Primary Backup → Main backup folder**

and optionally:

**Secondary Backup → Second drive, USB device, NAS path, or other folder**

The secondary location is best-effort. If it is temporarily unavailable, the primary backup can still succeed.

When the secondary destination becomes available again, UPM can catch it back up from verified primary backups.

---

# Encrypted Backups

Backups can optionally use **AES-256-GCM** encryption.

Encryption is useful when archives may contain private source code, configuration files, credentials, tokens, or other sensitive data.

Keep the encryption key somewhere safe. Existing encrypted backups still require the key that was used when they were created.

---

# Backup Include Overrides

UPM normally respects `.gitignore` and project backup exclusions.

When a specific ignored file or folder must still be backed up, add it under:

**Project Settings → Backups → Backup Include Overrides**

Examples include:

```text
.env.example
dist/important.json
config/required/
generated/*.json
```

UPM still prevents unsafe inclusions such as `.git/` and backup destinations located inside the project tree.

Sensitive files such as `.env` should only be explicitly included when necessary, preferably with backup encryption enabled.

---

# Recovery

Recovery is layered so one missing or damaged source does not automatically mean a file is lost.

UPM can search:

1. Verified backups
2. Persistent delta/change journal history
3. Git history when available

Individual files can be reconstructed into a safe recovery workspace before being copied back into the live project.

This is especially useful for files that were:

- Deleted accidentally
- Ignored by Git
- Never committed
- Removed by backup retention
- Lost during incomplete repository operations
- Changed between full backups

---

# Persistent Change Journal

The persistent delta journal stores compressed changes between normal snapshots.

This gives UPM another recovery source even after an older full archive has been removed by normal backup retention.

The journal can be enabled or disabled per project.

---

# Project Diff

UPM can compare the live project against its latest available backup.

This makes it easier to identify:

- Added files
- Modified files
- Deleted files
- Work that has not yet reached a backup
- Unexpected changes before restore or deployment

---

# Export Changes Feature Pack

Feature Packs make it easier to move manual or offline changes between copies of a project.

A Feature Pack can include:

- Added files
- Modified files
- Deleted-file information
- Manifest
- Verification hashes
- Change metadata

Sensitive files are filtered from normal exports.

This is useful when changes were made offline or on another PC and you only want to transfer the changed files instead of the entire project.

---

# PM2 Management

When PM2 is available, UPM can:

- Match projects to PM2 processes
- Show online/offline status
- Start stopped projects
- Restart processes
- Reload processes
- Stop processes
- Auto-start configured projects
- Track crashes and unexpected restarts
- Detect PM2 daemon restarts
- Keep PM2 health history
- Read PM2 logs

PM2 is optional. Backup, recovery, File Tools, tasks, and most other UPM features continue to work without it.

---

# Process Telemetry

UPM expands the normal PM2 view with additional per-process information when the host supports it.

Available telemetry can include:

- Normalized CPU usage
- Original PM2 raw CPU value
- RAM usage
- V8 heap usage
- GPU utilization
- HTTP request rate
- Mean HTTP latency
- p95 HTTP latency
- Active HTTP requests
- Crash history
- Restart history

GPU telemetry is best-effort and depends on available NVIDIA or Windows GPU-engine information.

HTTP telemetry appears when the monitored application exposes PM2/AXM HTTP metrics.

---

# PM2 Logs

UPM can display PM2 output and error logs directly inside the dashboard.

Log features include:

- Split output/error views
- Combined log view
- ANSI terminal color parsing
- Output/error differentiation
- Common severity highlighting
- Quick access while project cards are collapsed

---

# Docker Runtime & Startup Gate

UPM monitors Docker runtime readiness independently from project health checks.

On Windows it can distinguish between:

- Docker Desktop stopped
- Docker Desktop starting
- Docker daemon ready

For local projects, enable:

**Runtime → Wait for Docker / Docker Desktop daemon readiness**

to prevent PM2 operations from running before Docker is actually ready.

The gate can apply to:

- PM2 auto-start
- Start In PM2
- Process Start
- Process Restart
- Process Reload

UPM considers Docker ready only after the Docker daemon responds successfully.

LAN Remote Agents also report Docker status for their host.

---

# Service Health Monitoring

Each project can monitor the supporting services it depends on.

Built-in probes are available for:

- **Redis**
- **MariaDB / MySQL**
- **PostgreSQL**
- **Docker**
- **HTTP / HTTPS**
- **TCP**

Each service is reported independently as:

- **Healthy**
- **Degraded**
- **Down**

UPM can also show:

- Probe latency
- Last available detail
- Configurable check interval
- Configurable timeout
- Manual refresh

A failed dependency does not automatically mark unrelated services as failed.

Database passwords are not required or stored for the lightweight built-in database reachability probes.

---

# LAN Remote Agents

A project can live on another PC on the same local network without mounting that project's folder as a network share.

The remote PC can run an authenticated UPM LAN Agent.

Remote-agent features include:

- Project scanning
- PM2 status reporting
- Docker runtime reporting
- Service-health checks
- Backup creation
- Backup verification
- Backup retention
- Backup encryption
- Secondary backup mirroring
- Remote storage-capacity reporting

Project and backup paths remain paths on the remote PC.

### Remote limitations

Remote PM2 controls are intentionally read-only in this version.

The following actions remain local-host only:

- PM2 start/stop/restart/reload
- Editor launching
- Source diff/recovery
- Dependency changes
- File Tools
- Text Sanitizer

LAN Agent connections use bearer-token authentication, restricted filesystem roots, and HTTPS by default for non-loopback addresses.

UPM is intended for trusted local networks and should not be exposed directly to the public internet.

---

# TODO / FIX / NOTE Tracker

Each project has its own lightweight task list.

Open **Tasks** from the project card to:

- Add items
- Edit items
- Complete items
- Search
- Filter
- Delete items
- Scan the project for existing markers

Supported task types are:

- **TODO** — normal work
- **FIX** — bugs, broken behavior, and cleanup
- **NOTE** — reminders and project notes

The project scanner can discover markers such as:

```text
TODO
FIX
FIXME
NOTE
BUG
HACK
XXX
@todo
```

It can also inspect common task files including:

```text
TODO.md
TODOS.md
TASK.md
TASKS.md
ROADMAP.md
NOTES.md
TODO.txt
TASKS.txt
.todo
.todo.md
```

Markdown checklists and nested task trees are supported.

Discovered tasks retain their source file and line number. Re-scanning updates existing discoveries instead of creating duplicates.

Task state is stored separately from the project source, so completing a discovered task in UPM does not rewrite the original file.

---

# Dependencies

The dependency viewer reads a project's `package.json` and can show:

- Requested versions
- Installed versions
- Available npm versions
- Outdated dependencies

Updates can be selected individually instead of forcing every dependency to the newest release.

Remote dependency changes are not allowed through LAN Agents.

---

# File Tools

UPM includes a collection of project file utilities.

Available tools include:

- Timestamped-file cleanup
- Timestamped-file renaming
- Duplicate-file detection
- File inventory
- Comment removal
- Multi-step processing pipelines
- Text Sanitizer

All File Tools, including Text Sanitizer, use separate output folders so the original source can be left untouched.

---

# Comment Remover

The comment-removal tool can use `@babel/parser` for JavaScript-aware processing.

Different removal levels are available so users can choose how aggressively comments should be removed rather than treating every comment the same way.

---

# Text Sanitizer

Open:

**File Tools → Text Sanitizer**

to scan a project for problematic Unicode, rich-text symbols, common AI-generated punctuation/symbols, invisible characters, and other text issues.

### Presets

- Standard
- Expanded
- Invisible Only
- Report Only

### Features

- 290+ explicit replacement rules
- ASCII-equivalent cleanup
- Smart punctuation replacement
- Bullet and separator normalization
- Fullwidth/compatibility normalization
- Arrow and math-symbol handling
- Status-symbol handling
- Invisible/control-character detection
- Zero-width character detection
- Bidirectional-control detection
- Unicode tag detection
- Variation-selector detection
- Searchable findings
- Per-file output selection
- Highlighted Original / Sanitized previews
- Previous/next change navigation
- Line and column information
- Searchable replacement catalog
- Unicode code points
- Replacement risk levels
- Remaining non-ASCII reporting
- JSON report export
- CSV report export
- SHA-256 stale-file protection
- Separate File Tools output tree with preserved relative paths
- Overwrite-or-skip behavior for existing output files
- JSON run manifest written to the output folder
- Optional full verified UPM backup before processing

High-risk semantic replacements are disabled by default.

Legitimate non-English and accented text is reported rather than automatically destroyed.

Text Sanitizer is currently a local-filesystem action and does not process projects through LAN Remote Agents. Sanitized files are written to a separate output tree; source files are not rewritten.

---

# System Overview & PC Stats

The Overview tab provides a centralized view of UPM and host activity.

### Operations

UPM can summarize:

- Registered projects
- Running projects
- Watched projects
- Scheduled projects
- Logical backups
- Stored backup copies
- Backup verification
- Secondary mirror health
- PM2 availability
- PM2 crashes
- Unexpected restarts
- Service-health status
- Recent warnings
- Recent errors
- Managed archive storage

### Host performance

Available host information includes:

- Overall CPU usage
- Per-core CPU usage
- RAM usage
- System uptime
- UPM uptime
- UPM process memory
- UPM heap usage
- System load average
- CPU model
- Logical processor count
- Operating system
- Architecture
- Node.js version
- Docker / Docker Desktop state

UPM keeps lightweight CPU and memory history for up to seven days.

History views include:

- Last hour
- Last 6 hours
- Last 24 hours
- Last 3 days
- Last 7 days

---

# Storage & Backup Drives

The Storage tab summarizes archive usage and backup destinations.

When filesystem information is available, UPM can show:

- Local PC or LAN Agent host
- Backup path
- Filesystem root
- Free capacity
- Total capacity
- Disk-used percentage
- Archive-copy count
- Managed archive size
- Destination availability

Primary and secondary locations are displayed independently so disconnected USB drives, NAS paths, or remote mirrors are easy to identify.

---

# Open in Editor

Local projects can be opened directly in a configured editor.

Supported choices include:

- VS Code
- VS Code Insiders
- Cursor
- Windsurf
- Sublime Text
- WebStorm
- Custom editor command

Editor launching is restricted to the local host.

---

# Open Repository

Projects with a detected or configured repository can provide an **Open Repository** shortcut.

This gives quick access to GitHub for:

- Commits
- Branches
- Issues
- Pull requests
- Repository history

---

# Setup Import / Export

Open:

**Settings → Setup Transfer**

to export or restore a portable UPM setup.

Exports can include:

- Project definitions
- Project paths
- Primary and secondary backup settings
- Backup include/exclude rules
- Retention settings
- Watch intervals
- Backup schedules
- PM2 settings
- Service-health settings
- Recovery-journal settings
- Non-secret runtime settings

For safety, exports do **not** contain:

- Dashboard password hashes
- Session secrets
- Backup encryption keys
- LAN Agent tokens

### Import modes

**Merge / Update Existing**

Updates matching projects and adds new ones while leaving unrelated projects alone.

**Replace All Project Setups**

Replaces the project list only after imported paths and LAN Agent configuration can be validated.

---

# Activity & Diagnostics

UPM keeps a searchable operational history.

Recorded events can include:

- Backups
- Backup verification
- Restores
- Recovery operations
- PM2 events
- Settings changes
- File Tools runs
- Warnings
- Errors

The dashboard provides both general activity history and a more focused diagnostics view.

---

# Help & Tips

UPM includes an in-app guide so common setup and troubleshooting information stays with the installed version.

Open:

**Help**

or:

**More → Help & Tips**

The Help system includes:

- First-run guidance
- Searchable help topics
- Add Project guidance
- Discover Projects guidance
- Backup and restore help
- Mirror and verification help
- Encryption guidance
- Include/exclude guidance
- PM2 matching and controls
- PM2 logs and history
- Docker startup-gate help
- Redis/MariaDB/PostgreSQL/Docker/HTTP/TCP health guidance
- File Tools help
- Text Sanitizer safety guidance
- Recovery and journal guidance
- Project Diff guidance
- Feature Pack guidance
- LAN Remote Agent guidance
- Reverse-proxy guidance
- Authentication guidance
- Common 401/403 troubleshooting
- Setup Transfer guidance
- Diagnostics workflows

The Projects page also includes a dismissible **Start Here** card.

Contextual **?** markers provide short explanations for important settings, while the Help page contains the longer guidance.

Tour and Tip panels use a distinct border, badge, and visual treatment so guidance is clearly separated from normal settings and action cards.

---

# Accessibility

UPM includes several accessibility-focused display options.

Available palettes include:

- Default Purple
- Red-Green Friendly
- Blue-Yellow Friendly
- High Contrast
- Monochrome

Charts can also use solid, dashed, and dotted line differentiation.

Status badges include text plus shape/border cues so state is not communicated by color alone.

The dashboard also includes:

- Keyboard-focusable contextual help
- Reduced-motion support
- Forced-color support
- Mobile-friendly touch targets
- Responsive dialogs
- Scrollable navigation on smaller screens

---

# Remote Access & Security

Remote dashboard access is disabled by default.

UPM is intended primarily for local or trusted-LAN use.

Important protections include:

- Optional dashboard authentication
- Expiring signed sessions
- Login lockout protection
- Remote administrative permission checks
- Remote filesystem permission checks
- Local-path redaction for restricted remote clients
- Secret values excluded from Settings responses
- LAN Agent bearer-token authentication
- LAN Agent filesystem allowlists
- HTTPS requirements for remote LAN Agents by default
- Electron renderer isolation and sandboxing
- External-link isolation

Do **not** expose Ultimate Project Manager directly to the public internet unless the surrounding network and authentication configuration are properly secured.

---

# Optional Integrations

UPM can make use of several external tools when they are available:

- **PM2** — process monitoring and control
- **Git** — repository detection and additional recovery history
- **Docker / Docker Desktop** — runtime monitoring and startup gating
- **NVIDIA / Windows GPU telemetry** — per-process GPU usage
- **VS Code and other editors** — local project launching
- **GitHub repositories** — repository shortcuts

These integrations are optional. UPM's core project, backup, recovery, task, storage, and file-management features can still be used without all of them.

---

# Before Updating or Moving UPM

Keep copies of anything that cannot easily be recreated, especially:

- UPM runtime settings
- Backup encryption keys
- Important backup folders
- UPM application data and project state you want to preserve

Never assume Git contains ignored files, local configuration, secrets, or files that have not been committed.

---


**Much Love,**  
**-Bacon**
