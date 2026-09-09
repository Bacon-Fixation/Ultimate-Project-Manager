# LAN Remote Agent

The LAN Remote Agent lets a central UPM dashboard observe/manage supported project operations on another trusted PC.

## Typical uses

- report remote PM2 status
- run backups on the machine that owns the project files
- expose optional remote service/runtime health
- register LAN-hosted projects in the main dashboard

## Design expectations

A remote project is not assumed to have the same filesystem as the dashboard host. Source-only tools remain local unless the specific Remote Agent capability explicitly implements them.

## Security

Use the Remote Agent only on trusted networks. Treat its credentials/tokens as secrets, restrict listening interfaces appropriately, and avoid exposing the agent to the public Internet.

## Troubleshooting

When a remote project is unavailable, check network reachability, agent process status, configured host/port, authentication, firewall rules, and whether the remote project path exists on the agent machine.
