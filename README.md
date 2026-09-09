# Ultimate Project Manager v0.10.8 (BETA)

**Ultimate Project Manager (UPM)** is a local-first desktop application for managing, monitoring, backing up, and recovering multiple Node.js projects from one dashboard.

UPM brings project backups, PM2 process management, Docker readiness, service monitoring, recovery tools, project utilities, remote LAN systems, and operational history together in a single application.

It is based on the project-management tooling used for Bacons Helper, adapted into a more general-purpose application for managing multiple Node.js projects and the services around them.

> **UPM is local-only by default.**
> Remote dashboard and LAN Agent features must be explicitly enabled.

---

## Why Ultimate Project Manager?

Running several Node.js applications often means managing more than just source code.

A project may depend on:

- PM2
- Docker
- Redis
- MariaDB / MySQL
- PostgreSQL
- External or local HTTP services
- Backup drives
- NAS storage
- Environment-specific files
- Files intentionally excluded from Git
- Other PCs on the local network

UPM provides a central place to see and manage those pieces while adding multiple recovery layers if something goes wrong.

Rather than relying entirely on Git, PM2, or a normal backup directory, UPM combines:

- Verified backups
- Backup mirrors
- Persistent change history
- Git-assisted recovery
- Process monitoring
- Dependency health checks
- Operational history
- Project utilities
- Remote-host monitoring

The goal is to make maintaining multiple projects less fragile and easier to understand.

---

# Highlights

## Project Management

- Multi-project dashboard
- Project discovery from folders containing `package.json`
- Collapsible project cards
- Remembered interface state
- Project-specific settings
- Project search and navigation
- Editor shortcuts
- GitHub repository shortcuts
- Built-in TODO / FIX / NOTE tracker
- Dependency viewer
- Project diff tools

## Backup & Recovery

- Automatic change-based backups
- Scheduled backups
- Manual backups
- Verified archive creation
- Configurable retention
- Primary and secondary backup destinations
- Secondary backup catch-up
- AES-256-GCM encrypted backups
- Individual-file recovery
- Full-project recovery
- Persistent delta/change journal
- Git-assisted recovery
- Backup include overrides
- Backup history
- Archive integrity checking
- Recovery workspaces

## Process & Runtime Management

- PM2 process monitoring
- PM2 start, stop, restart, and reload controls
- PM2 crash and restart history
- PM2 logs
- Docker / Docker Desktop readiness monitoring
- Optional Docker startup gating
- Process CPU and memory telemetry
- GPU telemetry when supported
- HTTP performance telemetry when available
- Host CPU, memory, uptime, and per-core monitoring

## Service Monitoring

Built-in health probes are available for:

- Redis
- MariaDB / MySQL
- PostgreSQL
- Docker
- HTTP / HTTPS
- TCP services

Each dependency is monitored independently so one failed service does not make unrelated services appear unavailable.

## LAN Remote Agents

Manage projects located on another computer without mounting their project directories as network shares.

Remote Agents can provide:

- Project discovery
- PM2 status
- Docker status
- Service-health information
- Remote backups
- Backup verification
- Backup encryption
- Backup retention
- Secondary mirroring
- Storage-capacity information

## File Tools

UPM includes project-focused file utilities such as:

- Duplicate-file detection
- Timestamped-file cleanup
- Timestamped-file renaming
- File inventory
- Comment removal
- Multi-step processing pipelines
- Unicode / AI-symbol Text Sanitizer
- Export Changes Feature Packs

File Tools use separate output directories so source files can remain untouched.

## Interface & Accessibility

- Electron desktop application
- Browser dashboard option
- Responsive desktop, tablet, and mobile layouts
- Interactive charts
- Exact-value chart hover information
- Keyboard-accessible controls
- Reduced-motion support
- Forced-color support
- Colorblind-friendly palettes
- High-contrast and monochrome options
- Status indicators that do not depend on color alone
- Built-in Help, Tips, and onboarding

---

# Desktop Application

UPM is primarily designed as a standalone Electron desktop application.

Desktop releases are available for modern 64-bit systems:

| Platform | Architectures                             |
| -------- | ----------------------------------------- |
| Windows  | x64, ARM64                                |
| Linux    | x64, ARM64                                |
| macOS    | Intel x64, Apple Silicon ARM64, Universal |

The desktop application contains the UPM backend internally, allowing the normal browser dashboard to remain available while UPM is running.

### Desktop features

The desktop application adds:

- Compact application-focused layout
- Native application navigation
- Browser Dashboard shortcut
- System tray controls
- Optional close-to-tray behavior
- Launch-at-login support on Windows and macOS
- Native folder selection
- Desktop notifications
- Same-process desktop authentication
- External links opened in the operating-system browser
- Optional browser and LAN dashboard access

Installed builds keep writable runtime information in the application's per-user data directory instead of modifying installed program files.

Use:

**More → Desktop → Open Data Folder**

to open the active application-data location.

---

# Getting Started

## 1. Add a Project

Open **Projects** and select:

**Add Project**

A project can be configured with its own:

- Project directory
- Primary backup location
- Secondary backup location
- Backup retention
- Backup schedule
- Automatic change watcher
- Backup encryption
- Persistent change journal
- Backup exclusions
- Backup include overrides
- PM2 configuration
- PM2 auto-start behavior
- Docker startup gate
- Service-health checks
- Tasks
- Editor
- Repository

UPM can also discover projects by scanning parent folders for `package.json` files.

---

## 2. Configure Backups

UPM can monitor a project for real file-content changes and automatically create a verified backup.

A normal backup can:

1. Scan the project.
2. Detect file-content changes.
3. Create a stable snapshot.
4. Build the archive.
5. Verify the archive.
6. Store it in the primary backup location.
7. Mirror it to the secondary location when configured.
8. Record changes in the persistent journal when enabled.

Changing only a file timestamp does not normally create another backup.

Manual backups can always be forced when needed.

---

## 3. Configure Runtime Monitoring

Projects that use PM2, Docker, databases, or other services can expose their runtime state directly in UPM.

This allows the project card and Overview page to show both the application and the infrastructure it depends on.

---

# Dashboard

The main application is divided into four primary areas.

## Projects

The main working area for:

- Project configuration
- Backups
- Recovery
- PM2
- Health checks
- Tasks
- Dependencies
- File Tools
- Project utilities

Common actions can be launched directly from each project card.

Less frequently used operations are grouped under **More Actions**.

## Overview

A system-wide view of:

- Registered projects
- Running processes
- Project health
- PM2 status
- Host CPU usage
- Host memory usage
- Docker state
- Service-health status
- Backup status
- Recent warnings
- Recent errors
- System history

## Storage

Monitor backup destinations and archive storage.

UPM can display:

- Host
- Backup path
- Filesystem root
- Free capacity
- Total capacity
- Disk usage
- Archive count
- Managed archive size
- Destination availability

Primary and secondary backup destinations are shown separately.

## Activity

UPM maintains searchable operational history for events such as:

- Backups
- Backup verification
- Restores
- Recovery operations
- PM2 events
- Settings changes
- File Tools runs
- Warnings
- Errors

---

# Backup Verification

Backups are checked before they are accepted.

Verification can include:

- Archive readability
- Archive checksums
- Unsafe archive paths
- Symlink safety
- Snapshot contents
- Encrypted archive decryption

Backups can be reported as:

- **Verified**
- **Unverified**
- **Failed**

Verification helps prevent a damaged archive from silently replacing a usable recovery point.

---

# Primary & Secondary Backups

Each project can have:

**Primary Backup → Main backup destination**

and optionally:

**Secondary Backup → Another drive, USB device, NAS path, or folder**

The secondary destination operates independently from the primary backup.

If the secondary location is unavailable, the primary backup can still succeed.

When the destination returns, UPM can catch the secondary location back up using verified primary backups.

---

# Encrypted Backups

UPM supports optional **AES-256-GCM** backup encryption.

Encryption can protect archives containing:

- Private source code
- Configuration
- Tokens
- Credentials
- Internal data
- Other sensitive project files

Keep encryption keys somewhere safe.

Existing encrypted archives require the key that was used when the archive was created.

---

# Backup Include Overrides

UPM normally respects `.gitignore` and project backup exclusions.

Individual ignored files or directories can be explicitly included through:

**Project Settings → Backups → Backup Include Overrides**

Example:

```text
.env.example
dist/important.json
config/required/
generated/*.json
```

Unsafe inclusions such as `.git/` and backup destinations inside the project directory remain blocked.

Sensitive files such as `.env` should only be included when necessary and are best combined with encrypted backups.

---

# Recovery

UPM uses multiple recovery sources.

When available, recovery can search:

1. Verified backups
2. Persistent change-journal history
3. Git history

Files can first be reconstructed inside a recovery workspace instead of being written directly over the live project.

Recovery can help with files that were:

- Accidentally deleted
- Ignored by Git
- Never committed
- Removed by backup retention
- Lost during an incomplete repository operation
- Modified between full backups

---

# Persistent Change Journal

The optional persistent journal records compressed project changes between normal snapshots.

This provides another recovery source even after an older full backup has been removed by normal retention.

The journal can be enabled independently for each project.

---

# Project Diff

UPM can compare the live project against its latest available backup.

The comparison can identify:

- Added files
- Modified files
- Deleted files
- Work not yet included in a backup
- Unexpected changes

This can be useful before performing a restore, deployment, or large project change.

---

# Export Changes Feature Packs

Feature Packs allow a set of changes to be moved between project copies without transferring the complete project.

A Feature Pack can contain:

- Added files
- Modified files
- Deleted-file information
- Manifest
- Verification hashes
- Change metadata

Sensitive files are filtered from normal exports.

Feature Packs are particularly useful for moving offline changes between computers.

---

# PM2 Management

When PM2 is installed, UPM can:

- Match projects to PM2 processes
- Show process state
- Start processes
- Stop processes
- Restart processes
- Reload processes
- Auto-start configured projects
- Track crashes
- Track unexpected restarts
- Detect PM2 daemon restarts
- Maintain health history
- Display PM2 logs

PM2 is optional.

Backup, recovery, tasks, File Tools, and most other UPM features work without it.

---

# Process Telemetry

UPM can expand normal PM2 information with additional telemetry when supported by the host.

Available information can include:

- CPU usage
- Original PM2 CPU value
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

HTTP information is available when the monitored application exposes compatible PM2 / AXM metrics.

---

# Interactive Charts

UPM includes interactive charts for both project and host metrics.

Charts can display:

- CPU usage
- Memory usage
- Per-core CPU activity
- Process performance
- HTTP activity
- Uptime
- Restart events
- Health events
- Historical system information

Hovering a chart can expose the exact value represented by a point instead of requiring the value to be estimated visually.

Historical system views can include:

- Last hour
- Last 6 hours
- Last 24 hours
- Last 3 days
- Last 7 days

---

# PM2 Logs

PM2 output and error logs can be viewed directly inside UPM.

Available log features include:

- Output view
- Error view
- Combined view
- ANSI terminal-color parsing
- Output/error differentiation
- Severity highlighting
- Access while project cards are collapsed

---

# Docker Runtime & Startup Gate

UPM tracks Docker runtime readiness separately from ordinary project-health probes.

On Windows it can distinguish between:

- Docker Desktop stopped
- Docker Desktop starting
- Docker daemon ready

Projects can enable:

**Runtime → Wait for Docker / Docker Desktop daemon readiness**

to prevent supported PM2 actions from executing before Docker is actually ready.

The startup gate can apply to:

- PM2 auto-start
- Start in PM2
- Process Start
- Process Restart
- Process Reload

Docker is considered ready only after the daemon responds successfully.

---

# Service Health Monitoring

Each project can monitor the supporting services it requires.

Built-in probes support:

- Redis
- MariaDB / MySQL
- PostgreSQL
- Docker
- HTTP / HTTPS
- TCP

Services are reported independently as:

- **Healthy**
- **Degraded**
- **Down**

UPM can also show:

- Probe latency
- Last available detail
- Check interval
- Timeout
- Manual refresh

Lightweight built-in database reachability checks do not require database passwords to be stored.

---

# LAN Remote Agents

Projects can be managed on another trusted LAN computer without mounting their project directories as network shares.

A remote system runs an authenticated UPM LAN Agent.

Remote features can include:

- Project scanning
- PM2 status
- Docker status
- Service health
- Backup creation
- Backup verification
- Backup retention
- Backup encryption
- Secondary mirroring
- Storage-capacity reporting

Project and backup paths remain local to the remote computer.

### Remote limitations

Remote PM2 process controls are intentionally read-only in this version.

These operations remain local-host only:

- PM2 start / stop / restart / reload
- Editor launching
- Source diff and recovery
- Dependency changes
- File Tools
- Text Sanitizer

LAN Agents use bearer-token authentication, restricted filesystem roots, and HTTPS by default for non-loopback addresses.

UPM is designed for trusted local networks and should not be exposed directly to the public internet.

---

# TODO / FIX / NOTE Tracker

Each project includes a lightweight task system.

Supported task types are:

- **TODO** - normal work
- **FIX** - bugs, broken behavior, or cleanup
- **NOTE** - reminders and project notes

Tasks can be:

- Added
- Edited
- Completed
- Searched
- Filtered
- Deleted

UPM can also scan project files for markers including:

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

Common task and roadmap files can also be scanned.

Discovered entries retain their source file and line information.

Completing a discovered task inside UPM does not modify the original project source.

---

# Dependencies

The dependency viewer reads each project's `package.json`.

It can display:

- Requested versions
- Installed versions
- Available npm versions
- Outdated packages

Updates can be selected individually instead of forcing the complete project onto the newest available versions.

Dependency changes through LAN Remote Agents are intentionally disabled.

---

# File Tools

UPM includes a collection of utilities for working with project files.

Available tools include:

- Timestamped-file cleanup
- Timestamped-file renaming
- Duplicate detection
- File inventory
- Comment removal
- Multi-step processing pipelines
- Text Sanitizer

File Tools write to separate output folders so original project files can remain untouched.

---

# Comment Remover

JavaScript-aware comment processing can use `@babel/parser`.

Multiple removal levels allow users to control how aggressively comments are removed instead of treating every comment identically.

---

# Text Sanitizer

Open:

**File Tools → Text Sanitizer**

The Text Sanitizer scans projects for problematic Unicode, rich-text symbols, invisible characters, common AI-generated punctuation and symbols, and other text issues.

### Presets

- Standard
- Expanded
- Invisible Only
- Report Only

### Features

- 290+ explicit replacement rules
- ASCII-equivalent cleanup
- Smart-punctuation replacement
- Bullet and separator normalization
- Fullwidth and compatibility normalization
- Arrow and math-symbol handling
- Status-symbol handling
- Invisible/control-character detection
- Zero-width character detection
- Bidirectional-control detection
- Unicode tag detection
- Variation-selector detection
- Searchable findings
- Highlighted Original / Sanitized previews
- Previous/next change navigation
- Line and column information
- Unicode code points
- Replacement risk levels
- Remaining non-ASCII reporting
- JSON reports
- CSV reports
- SHA-256 stale-file protection
- Optional verified backup before processing
- Separate output tree
- Run manifests

High-risk semantic replacements are disabled by default.

Legitimate non-English and accented text is reported rather than automatically destroyed.

The Text Sanitizer operates on local files and does not currently process projects through LAN Remote Agents.

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

Projects with detected or configured repositories can provide an **Open Repository** shortcut.

This offers quick access to GitHub for:

- Commits
- Branches
- Issues
- Pull requests
- Repository history

---

# Setup Import / Export

Use:

**Settings → Setup Transfer**

to move UPM configuration between installations.

Exports can contain:

- Project definitions
- Project paths
- Backup locations
- Include/exclude rules
- Retention settings
- Watch intervals
- Backup schedules
- PM2 settings
- Service-health settings
- Recovery-journal settings
- Non-secret runtime settings

For safety, exports do **not** include:

- Dashboard password hashes
- Session secrets
- Backup encryption keys
- LAN Agent tokens

### Import modes

**Merge / Update Existing**

Updates matching projects and adds new projects without removing unrelated entries.

**Replace All Project Setups**

Replaces the project list after imported paths and LAN Agent settings can be validated.

---

# Help & Onboarding

UPM includes its own searchable help system.

Open:

**Help**

or:

**More → Help & Tips**

Topics include:

- First-run setup
- Adding projects
- Project discovery
- Backups and restores
- Backup mirroring
- Verification
- Encryption
- Include/exclude rules
- PM2
- Logs
- Docker startup gating
- Service monitoring
- File Tools
- Text Sanitizer
- Recovery
- Persistent journals
- Project Diff
- Feature Packs
- LAN Remote Agents
- Authentication
- Reverse proxies
- Setup Transfer
- Diagnostics
- Common 401/403 problems

The Projects page also includes a dismissible **Start Here** guide.

Contextual **?** controls provide shorter explanations for individual options.

Tour and Tip panels use a visually distinct presentation so help content is not confused with normal application controls.

---

# Accessibility

Accessibility is considered part of normal application behavior rather than a separate visual theme.

Available display palettes include:

- Default Purple
- Red-Green Friendly
- Blue-Yellow Friendly
- High Contrast
- Monochrome

Charts can use:

- Solid lines
- Dashed lines
- Dotted lines
- Labels
- Exact-value tooltips

Important application states are not communicated through color alone.

Status indicators combine color with elements such as:

- Text
- Icons
- Borders
- Shapes
- Labels

Additional accessibility behavior includes:

- Keyboard-focusable contextual help
- Visible focus states
- Reduced-motion support
- Forced-color support
- Mobile-friendly touch targets
- Responsive dialogs
- Scrollable navigation on small screens

---

# Remote Access & Security

Remote dashboard access is disabled by default.

UPM is primarily intended for local use or trusted local networks.

Security protections include:

- Optional dashboard authentication
- Expiring signed sessions
- Login lockout protection
- Remote administrative permission checks
- Remote filesystem permission checks
- Restricted-client path redaction
- Secret-value filtering
- LAN Agent bearer-token authentication
- LAN Agent filesystem allowlists
- HTTPS requirements for remote LAN Agents by default
- Electron renderer isolation
- Electron sandboxing
- External-link isolation
- Backup archive path validation
- Symlink protections
- Backup verification

Do **not** expose Ultimate Project Manager directly to the public internet without an appropriately secured surrounding network and authentication configuration.

---

# Optional Integrations

UPM can make use of additional software when available.

### PM2

Process monitoring and control.

### Git

Repository detection and an additional recovery source.

### Docker / Docker Desktop

Runtime monitoring and project startup gating.

### NVIDIA / Windows GPU Telemetry

Additional per-process GPU information.

### Editors

Direct local project launching.

### GitHub

Repository shortcuts and project navigation.

These integrations are optional.

UPM's project, backup, recovery, storage, task, and File Tools features do not require every integration to be installed.

---

# Before Updating or Moving UPM

Keep copies of anything that cannot easily be recreated.

Important items can include:

- UPM runtime settings
- Backup encryption keys
- Important backup folders
- UPM application data
- Project state

Never assume Git contains ignored files, local configuration, secrets, or uncommitted work.

---

# Source & Development

Ultimate Project Manager is developed as an Electron and Node.js application.

Developer setup, source requirements, build commands, supported build architectures, and release-building information are intentionally kept separate from this application-focused README.

See:

- [`BUILDING.md`](BUILDING.md) - source setup, development, compiling, and packaging
- [`CONTRIBUTING.md`](CONTRIBUTING.md) - contribution guidelines and project expectations

---

# Project & Support

**Repository**

https://github.com/Bacon-Fixation/Ultimate-Project-Manager

**Issues**

https://github.com/Bacon-Fixation/Ultimate-Project-Manager/issues

**Support development**

https://ko-fi.com/baconfixation

The repository URL may appear in application metadata and documentation ahead of the public repository launch so releases and community resources are ready when the repository becomes available.

---

**Much Love,**
**-Bacon**
