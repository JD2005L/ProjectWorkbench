#!/usr/bin/env bash
# Claude Code Stop hook for Project Workbench: marks the current project as
# having an "unread completion" so the dashboard landing page shows an
# indicator. The marker is cleared when the user opens the project's
# terminal in the browser (or via heartbeat while it's visible).
set -e
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$DIR" in
  /opt/project-workbench/workspaces/*)
    NAME=$(basename "$DIR")
    mkdir -p /var/lib/project-workbench/pending 2>/dev/null || true
    date -u +%FT%TZ > "/var/lib/project-workbench/pending/$NAME" 2>/dev/null || true
    ;;
esac
exit 0
