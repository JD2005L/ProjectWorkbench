# Project Workbench

LAN-internal web workbench for project repos with password-protected browser terminals backed by Claude Code CLI.

## Components

- Node/Express dashboard (`app/`)
- nginx reverse proxy + basic auth (`nginx/project-workbench.conf`)
- per-project ttyd terminals backed by persistent tmux sessions
- project CRUD manager (`/manage`)
- file inbox shade for dropping/uploading files into each project workspace
- daily Claude Code updater (`systemd/claude-code-update.*`)

## Runtime paths on CT2115

- App: `/opt/project-workbench/app`
- Projects registry: `/opt/project-workbench/projects.json`
- Workspaces: `/opt/project-workbench/workspaces`
- Terminal launcher: `/usr/local/bin/project-terminal-start`
- Claude updater: `/usr/local/sbin/update-claude-code`

## Notes

This repo intentionally excludes local workspaces, credentials, nginx htpasswd, and Git credential files.
