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
#
# Getting the BEL onto the pane's pty is the whole job, and the obvious routes are
# all dead in this topology (verified on GOA 2026-09-14, Copilot CLI 1.0.83):
#   * `> /dev/tty` — Copilot runs the hook with no controlling terminal, so opening
#     /dev/tty fails "No such device or address". (It worked on 1.0.80, which ran
#     hooks with the pane as controlling tty; the CLI changed under us.)
#   * `tmux` by pane id — the pane cannot reach the tmux socket (owner-gated), so
#     `display-message '#{pane_tty}'` is Permission denied.
#   * the pending-marker dir — not mounted into the pane in container mode.
#
# What DOES work is what Claude Code relies on: a BEL written to the pane's pty
# (its master side is what tmux reads for window_bell_flag). Claude is the pane's
# foreground process, so its own stdout IS that pty. The hook's stdout is a pipe
# the CLI captures, but an ANCESTOR of the hook (the pane's shell, at minimum) still
# holds the pane pty on fd 1. Walk up the process tree and write the BEL to the
# first ancestor whose stdout is a terminal. Same uid throughout, so the write is
# permitted; a lone BEL is non-printing, so it does not disturb that process.
ppid_of() {
  # PPID is field 4 of /proc/<pid>/stat, but field 2 (comm) is parenthesized and may
  # itself contain spaces or ')', which breaks naive column splitting. comm is bounded
  # by the FIRST '(' and the LAST ')', so strip through the last ') ' and read the
  # remainder as "state ppid ...".
  local stat after
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  after=${stat##*) }
  set -- $after
  printf '%s' "$2"
}
ring_bell() {
  local pid=$PPID hop fd1
  for hop in 1 2 3 4 5 6 7 8; do
    case $pid in ''|0|1) break;; esac
    fd1="/proc/$pid/fd/1"
    if [ -c "$fd1" ] && printf '\a' > "$fd1" 2>/dev/null; then
      return 0
    fi
    pid=$(ppid_of "$pid")
  done
  # Last-ditch: the controlling terminal, for host/interactive contexts where the
  # walk found nothing but a tty is still attached.
  printf '\a' > /dev/tty 2>/dev/null || true
}
ring_bell

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
