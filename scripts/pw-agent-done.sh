#!/usr/bin/env bash
# (repo copy — installed to panes via /opt/project-workbench/scripts)
# "Agent turn finished" notifier for Project Workbench panes.
#
# Why this exists: the dashboard learns a turn ended from tmux's window_bell_flag
# (see parseTmuxWindows/projectSignals in app/server.js). Claude Code sets that flag
# because it has preferredNotifChannel=terminal_bell. GitHub Copilot CLI has no
# bell/notification setting, so its panes never signalled — the tab and the project
# key stayed dark. Copilot DOES have an `agentStop` hook, so we ring the bell here.
#
# stdin is the hook's JSON payload (sessionId, cwd, transcriptPath, stopReason).
# stdout is captured by the CLI, so the BEL must go to the controlling terminal:
# /dev/tty is the pane's pty even though stdin is a pipe.
{ printf '\a' > /dev/tty; } 2>/dev/null || true

# Best effort: also drop the pending marker the dashboard reads in deployments where
# that directory is reachable from the pane (host mode). In the container topology it
# is not, and every failure here is deliberately silent — the bell above is the signal.
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$DIR" in
  /opt/project-workbench/workspaces/*)
    # First path segment under the workspaces root, so a nested cwd (…/Project/app)
    # still resolves to "Project" rather than "app".
    REST=${DIR#/opt/project-workbench/workspaces/}
    NAME=${REST%%/*}
    [ -n "$NAME" ] && [ -d /var/lib/project-workbench/pending ] && \
      date -u +%FT%TZ > "/var/lib/project-workbench/pending/$NAME" 2>/dev/null || true
    ;;
esac
exit 0
