# Getting Started

## 1. Launch UPM

The Electron desktop app is the recommended normal experience. It runs the UPM backend internally and provides native folder selection, tray integration, notifications, application menus, and an option to open the same dashboard in your normal browser.

The browser dashboard remains useful for LAN access or when you prefer a browser window.

## 2. Add a project

Open the **Projects** tab and select **Add Project** beside **Refresh**. You can also use **More → Projects → Add Project** or project discovery.

At minimum confirm:

- project name
- project root
- primary backup folder
- retention count
- local or LAN execution target

## 3. Create a baseline backup

Use **Backup Now** on the project card. UPM scans the project, creates an archive only when needed unless forced, verifies the archive, and records backup metadata.

Before enabling automatic schedules or write-oriented File Tools, confirm one backup is marked **Verified**.

## 4. Add optional runtime integrations

Only configure the features your project actually uses:

- PM2 process matching and controls
- Docker/Docker Desktop startup gate
- Redis, MariaDB/MySQL, PostgreSQL, Docker, HTTP/HTTPS, or TCP service health
- backup encryption
- secondary backup destination
- persistent delta journal
- LAN Remote Agent

## 5. Learn the recovery path before you need it

Open backup history and the Recovery tools once during setup. Knowing where verified backups, journal history, and Git-assisted recovery live is much easier before an emergency.
