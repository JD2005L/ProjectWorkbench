#!/bin/bash
# The tmux OWNER: the process whose cgroup the shared tmux server lives in.
#
# Every project's shells, running agents and scrollback live in one tmux server.
# Whichever process creates that server decides which cgroup it lands in, and
# therefore what can reap it. Historically a ttyd terminal could win that race and
# create it inside its own unit, so restarting one project's terminal took down
# every project's sessions.
#
# HOST MODE   — runs as ExecStart of pw-tmux-server.service (Type=notify), so the
#               server lands in that unit's cgroup and survives app restarts.
# CONTAINER   — runs as the foreground process of the pw-tmux sidecar, exactly as
#               before; the sidecar's cgroup is the owner.
#
# ============================================================================
# WHY READINESS IS NOT "A SESSION EXISTS"
#
# Independent review of the superseded candidate (PR #24, reference-only) showed
# that asking "does a `_keepalive` session exist on this socket" proves the wrong
# thing: with a client-created server already present, the owner reported ready —
# releasing the `After=` barrier for every terminal — while supervising a FOREIGN
# server in a ttyd's cgroup.
#
# So this signals readiness only after proving, about the LIVE server:
#   1. it exists on the intended socket;
#   2. it carries our owner marker (a tmux SERVER option, so no client can have
#      inherited it); and
#   3. its process really lives in the expected owner cgroup.
#
# A server that predates this unit is REFUSED, not adopted — the consequence is
# deliberate and documented: such a host must perform the save/kill/restart
# migration before the owner can start.
#
# GOA constraint (Round 2): the readiness mechanism must never be mandatory in
# container mode — there is no systemd in the sidecar. `systemd-notify` is
# therefore conditional and its absence is tolerated; it is never on an exit path
# that would stop supervision.
#
# CONTAINER SESSION PERSISTENCE (added 2026-09-02, superseding the GOA-2
# disposition that deliberately left it out): the sidecar now snapshots sessions
# periodically and on SIGTERM, and replays the manifest once at start, because a
# container recreate — which a plain image rebuild requires — otherwise destroyed
# every session with nothing saved and nothing to replay. Host mode is untouched;
# there pw-tmux-persist.service and pw-tmux-save.timer already do this. See the
# `session persistence` block near the bottom for why the state dir and the
# Claude dirs both have to be redirected.
# ============================================================================
set -u

# --- configuration (no deployment is named here) ------------------------------
OWNER_MARKER_OPTION='@pw_owner'
OWNER_MARKER_VALUE='pw-owner'
HOST_MODE="${PW_TMUX_HOST_MODE:-0}"
PROC_ROOT="${PW_TMUX_PROC_ROOT:-/proc}"

# WHICH SOCKET DIRECTORY? The two deployments answer differently, and answering
# with the container's value on a host is how the owner ends up supervising a
# server that nothing else can see.
#
# HOST: the seams reach the server through `sudo -u <account> tmux` with no
# TMUX_TMPDIR, i.e. that account's PER-USER DEFAULT socket (/tmp/tmux-<uid>/…).
# So the owner must use the per-user default too — which means actively clearing
# any TMUX_TMPDIR it inherited, not merely declining to set one. Defaulting it to
# the container's bind-mount path put the host owner on <prefix>/run/tmux, a
# directory a host install never even creates, while every terminal, the restore
# path and the dashboard's probe looked at the per-user socket. The unit then
# reported active and ready about a server no seam could reach.
#
# CONTAINER: the sidecar passes an explicit -e TMUX_TMPDIR pointing at the
# bind-mounted socket dir, and that must be honoured exactly as before. The
# fallback below only applies when the sidecar did not set one.
if [[ "$HOST_MODE" == 1 ]]; then
	unset TMUX_TMPDIR
else
	: "${TMUX_TMPDIR:=/opt/project-workbench/run/tmux}"
	export TMUX_TMPDIR
	mkdir -p "$TMUX_TMPDIR" 2>/dev/null || true
	chmod 0700 "$TMUX_TMPDIR" 2>/dev/null || true
fi

# An explicit socket PATH (tests, and any deployment that wants one) or the
# deployment's normal default socket.
tmux_args=(-u)
if [[ -n "${PW_TMUX_SOCKET_PATH:-}" ]]; then
	tmux_args+=(-S "$PW_TMUX_SOCKET_PATH")
elif [[ -n "${PW_TMUX_SOCKET:-}" ]]; then
	tmux_args+=(-L "$PW_TMUX_SOCKET")
fi

tmux_() { tmux "${tmux_args[@]}" "$@"; }

die() { echo "[pw-tmux-owner] $*" >&2; exit 1; }

expected_owner_cgroup() {
	if [[ -n "${PW_TMUX_OWNER_CGROUP:-}" ]]; then echo "$PW_TMUX_OWNER_CGROUP"; return; fi
	if [[ "$(printf '%s' "${PW_DEPLOY_MODE:-host}" | tr '[:upper:]' '[:lower:]')" == container ]]; then
		echo 'pw-tmux.slice'
	else
		echo 'pw-tmux-server.service'
	fi
}

owner_remediation() {
	local mode default_cgroup
	mode="$(printf '%s' "${PW_DEPLOY_MODE:-host}" | tr '[:upper:]' '[:lower:]')"
	if [[ "$mode" == container ]]; then default_cgroup='pw-tmux.slice'; else default_cgroup='pw-tmux-server.service'; fi
	if [[ -n "${PW_TMUX_OWNER_CGROUP:-}" && "$PW_TMUX_OWNER_CGROUP" != "$default_cgroup" ]]; then
		echo "restart the configured tmux owner supervisor for cgroup $PW_TMUX_OWNER_CGROUP, then retry"
	elif [[ "$mode" == container ]]; then
		echo 'pw-tmux-save && tmux kill-server && systemctl restart pw-tmux.service'
	else
		echo 'pw-tmux-save && tmux kill-server && systemctl restart pw-tmux-server.service'
	fi
}

# --- refuse a pre-existing foreign server -------------------------------------
# If a server is already live on this socket, it is ours only if it carries the
# marker. Anything else is the adopt-don't-move case and must not be adopted.
had_server=0
if tmux_ list-sessions >/dev/null 2>&1; then
	had_server=1
	existing_marker=$(tmux_ show-options -sv "$OWNER_MARKER_OPTION" 2>/dev/null || true)
	if [[ "$existing_marker" != "$OWNER_MARKER_VALUE" ]]; then
		die "refusing to adopt a foreign tmux server already running on this socket (no owner marker).
  It was created by something other than this owner unit, so its sessions live in the wrong cgroup.
  Migrate deliberately, then start this unit again:
    $(owner_remediation)"
	fi
fi

# --- bring up the server, in OUR cgroup ---------------------------------------
if [[ "${PW_TMUX_FORCE_SERVER_FAILURE:-0}" == 1 ]]; then
	# Test hook only: prove readiness is not signalled without a live server.
	die "server creation failed (forced)"
fi

# ORDER MATTERS, and not for the reason you would guess: `tmux start-server` does
# NOT hold a server open with no sessions — it exits immediately, so a marker set
# straight after it has nothing to attach to. Verified directly against tmux 3.4.
# The session is therefore what brings the server into existence, in THIS cgroup,
# and only then is there a server to stamp and to prove.
#
# `_keepalive` does not start with `pw_`, so server.js's orphan sweep leaves it be.
if ! tmux_ has-session -t _keepalive 2>/dev/null; then
	tmux_ new-session -d -s _keepalive 'while true; do sleep 3600; done' 2>/dev/null || true
fi

# DID WE CREATE THIS SERVER, OR JOIN SOMEONE ELSE'S?
#
# The check at the top of this script runs before we create anything, so on a
# cold start it correctly finds nothing. But between that check and the
# new-session above, a client can win the race and create the server — and we
# would then be talking to ITS server. Stamping the marker at that point would
# bless a foreign server as our own, which is precisely the adopt-don't-move
# failure this unit exists to prevent. (Found by mutating readiness back to the
# unrepaired Type=simple ordering: without this check the race test passes
# against the defect, which is the vacuity Round 8 recorded.)
#
# If no server was live when we started, the only session on it now must be ours.
if [[ "$had_server" == 0 ]]; then
	foreign_sessions=$(tmux_ list-sessions -F '#{session_name}' 2>/dev/null | grep -vx '_keepalive' || true)
	if [[ -n "$foreign_sessions" ]]; then
		die "refusing to adopt a tmux server created by another process while this unit was starting.
  Sessions present that this owner did not create: $(echo "$foreign_sessions" | tr '\n' ' ')
  Migrate deliberately, then start this unit again:
    $(owner_remediation)"
	fi
fi

tmux_ set-option -s exit-empty off 2>/dev/null || true
# Set HERE, not only in a tmux.conf, because this is the one place that runs in
# both deployments and is not baked into the container image — the sidecar
# bind-mounts this script from the host, so a recreated container picks the
# setting up without an image rebuild.
#
# WHY: every browser tab that opens a project terminal is its own ttyd child
# running `tmux attach-session`, so it is its own tmux client carrying its own
# browser-derived size. A window has exactly ONE size. tmux's `latest` default
# re-picks it from whichever client last had activity, which with two clients
# attached means a resize PER KEYSTROKE — measured 7 in 8 with an 80x24 and a
# 160x48 client. Each one SIGWINCHes the pane, so a full-screen agent TUI
# repaints its whole frame, and tmux redraws the `·` U+00B7 padding it fills an
# oversized client's uncovered area with: reported as the screen shaking with
# dots everywhere, and only ever visible while two clients are attached at once.
#
# `smallest` pads the larger client with a STATIC margin and costs nobody any
# content. `largest` is the other stable choice and is worse: it clips the
# smaller client to the top-left of the window, so part of the TUI is off-screen
# and a tmux client cannot be panned. tmux recomputes on detach as well as
# attach, so a client left alone returns to its own full size.
tmux_ set-option -g window-size smallest 2>/dev/null || true
# The marker goes on the SERVER, so it cannot be inherited by a client.
tmux_ set-option -s "$OWNER_MARKER_OPTION" "$OWNER_MARKER_VALUE" 2>/dev/null || true

# --- prove ownership of the LIVE server BEFORE signalling ----------------------
server_pid=$(tmux_ display-message -p '#{pid}' 2>/dev/null || true)
[[ "$server_pid" =~ ^[0-9]+$ ]] || die "no live tmux server after start-server — refusing to signal readiness"

live_marker=$(tmux_ show-options -sv "$OWNER_MARKER_OPTION" 2>/dev/null || true)
[[ "$live_marker" == "$OWNER_MARKER_VALUE" ]] || die "the live tmux server carries no owner marker — refusing to signal readiness"

tmux_ has-session -t _keepalive 2>/dev/null || die "the keepalive session is not present — refusing to signal readiness"

# The cgroup half. A strict deployment must prove the process cgroup; unreadable
# metadata is a refusal, never permission to stamp or supervise the server.
expected_owner=$(expected_owner_cgroup)
if [[ "${PW_TMUX_REQUIRE_CGROUP:-0}" == 1 && ! -r "$PROC_ROOT/$server_pid/cgroup" ]]; then
	die "the live tmux server cgroup is not readable at $PROC_ROOT/$server_pid/cgroup — refusing to signal readiness"
fi
if [[ -r "$PROC_ROOT/$server_pid/cgroup" ]]; then
	live_cgroup=''
	fallback_cgroup=''
	while IFS=: read -r hierarchy controllers cgroup_path; do
		if [[ "$hierarchy" == 0 && -z "$controllers" ]]; then
			live_cgroup="$cgroup_path"
			break
		fi
		[[ -n "$cgroup_path" ]] && fallback_cgroup="$cgroup_path"
	done < "$PROC_ROOT/$server_pid/cgroup"
	[[ -n "$live_cgroup" ]] || live_cgroup="$fallback_cgroup"
	if [[ "${PW_TMUX_REQUIRE_CGROUP:-0}" == 1 ]]; then
		case "/$live_cgroup/" in
			*"/$expected_owner/"*) : ;;
			*) die "the live tmux server (pid $server_pid) is in cgroup ${live_cgroup:-unknown}, not $expected_owner — refusing to signal readiness" ;;
		esac
	fi
fi

# --- session persistence (CONTAINER MODE ONLY) --------------------------------
#
# Host mode already has this: pw-tmux-persist.service runs pw-tmux-restore on
# ExecStart and pw-tmux-save on ExecStop, and pw-tmux-save.timer snapshots every
# two minutes. The container sidecar has NO systemd, so none of that machinery
# ran here — a `podman rm`/recreate destroyed every session with nothing saved
# and nothing to replay. This block is the sidecar's stand-in for those units.
#
# WHERE THE SNAPSHOT LIVES IS THE WHOLE BALL GAME. The default state dir,
# /var/lib/project-workbench/tmux-persist, is on the container's OVERLAY — it is
# destroyed by the very recreate the snapshot exists to survive, so wiring this up
# without moving it produces a feature that looks like it works and silently
# loses everything. /root IS a bind mount (persistent/root-home in
# pw-tmux.service) and this script runs as root, so the state goes there. If a
# deployment overrides PW_TMUX_STATE_DIR, that wins and we only warn.
#
# The Claude dirs must ALSO be redirected: panes run as `admin` with
# HOME=/home/admin, so the sessionIds pw-tmux-save records (and pw-tmux-restore
# resumes via `claude --resume`) live under /home/admin/.claude — while this
# script's own HOME is /root, which has no .claude at all. Left at the default,
# restore would bring back window layout but silently no conversations.
#
# And PW_REGISTRY_PATH is the documented cause of the container-mode
# fail-close: restore resolves the HOST default (/opt/project-workbench/projects.json),
# finds nothing, refuses EVERY session and still exits 0 — a total refusal that
# reads as a clean no-op. Exporting the real path is the fix.
PERSIST_ENABLED=0
# Read by the supervise loop in BOTH modes — must not live in the branch below,
# or `set -u` aborts host mode on the first tick.
: "${PW_TMUX_SAVE_INTERVAL:=120}"
#
# NO ENVIRONMENT-SPECIFIC PATH OR IDENTITY IS NAMED HERE. This file is shared with
# deployments that look nothing like the one it was written on, and
# test/tmux-owner-dispositions.test.mjs pins that: a hardcoded `/home/admin`,
# `/root/...` or `/etc/project-workbench/...` default would make the shared owner
# script carry one site's layout. So persistence engages ONLY when the DEPLOYMENT
# supplies the four paths, and declines (loudly, harmlessly) when it does not.
# The deployment-specific file is the unit — systemd/pw-tmux.service — which
# already carries TMUX_TMPDIR, PW_DEPLOY_MODE and the owner cgroup for the same
# reason.
#
# WHY THE STATE DIR MUST BE SUPPLIED AND NOT DEFAULTED. The scripts' own default,
# /var/lib/project-workbench/tmux-persist, is inside the container in container
# mode — destroyed by the very recreate the snapshot exists to survive. A default
# would therefore produce a feature that looks like it works and silently loses
# everything, which is worse than declining. The unit must point it at a mount
# that outlives the container.
#
# The Claude dirs must be the PANE ACCOUNT's, not this script's: panes run as the
# unprivileged terminal user, so the sessionIds pw-tmux-save records (and
# pw-tmux-restore resumes via `claude --resume`) live under that account's home,
# while this script's own HOME is root's. Left to default, restore would bring
# back window layout and silently no conversations.
if [[ "$HOST_MODE" != 1 ]]; then
	persist_missing=()
	for v in PW_TMUX_STATE_DIR PW_CLAUDE_SESSIONS_DIR PW_CLAUDE_PROJECTS_DIR PW_REGISTRY_PATH PW_APP_DIR; do
		[[ -n "${!v:-}" ]] || persist_missing+=("$v")
	done
	if (( ${#persist_missing[@]} > 0 )); then
		echo "[pw-tmux-owner] session persistence OFF: the deployment did not supply ${persist_missing[*]}" >&2
		echo "[pw-tmux-owner]   set them in the unit (see systemd/pw-tmux.service) to enable snapshot/replay" >&2
	else
		PERSIST_ENABLED=1
		SCRIPT_DIR="$(cd -- "$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")" && pwd)"
		# pw-tmux-restore's ownership gate does `command -v pw-tmux-assert-owner`
		# and treats a MISSING helper as a refusal — and nothing need put these on
		# PATH. Without this prefix the replay below would decline every time.
		export PATH="$SCRIPT_DIR:$PATH"
		export PW_TMUX_STATE_DIR PW_CLAUDE_SESSIONS_DIR PW_CLAUDE_PROJECTS_DIR PW_REGISTRY_PATH PW_APP_DIR
		mkdir -p "$PW_TMUX_STATE_DIR" 2>/dev/null || true
		chmod 0700 "$PW_TMUX_STATE_DIR" 2>/dev/null || true
		# Loud, because a snapshot on a container-local filesystem is
		# indistinguishable from a working one until the recreate you counted on.
		if [[ "$(findmnt -no FSTYPE -T "$PW_TMUX_STATE_DIR" 2>/dev/null)" == overlay ]]; then
			echo "[pw-tmux-owner] WARNING: PW_TMUX_STATE_DIR=$PW_TMUX_STATE_DIR is on the container overlay;" >&2
			echo "[pw-tmux-owner]          snapshots there will NOT survive a container recreate." >&2
		fi
	fi
fi

RESTORE_STATE_OPTION='@pw_restore_state'

# Publish the replay outcome as a tmux SERVER option so the app container can fence
# on it. Round 19 review found the previous barrier was `_keepalive` — which this
# script creates BEFORE replay — so the dashboard could boot first, create a blank
# pw_* session, and pw-tmux-restore would then skip it as "already exists". That
# defeated the whole feature. A server option is the right medium: it lives and
# dies with the server, so unlike a marker file it can never be stale, and both
# containers reach the same socket.
publish_restore_state() {
	tmux_ set-option -s "$RESTORE_STATE_OPTION" "$1" 2>/dev/null || true
	echo "[pw-tmux-owner] restore state: $1" >&2
}

pw_snapshot() {
	[[ "$PERSIST_ENABLED" == 1 ]] || return 0
	local why="$1" out
	if out=$("$SCRIPT_DIR/pw-tmux-save" 2>&1); then
		echo "[pw-tmux-owner] snapshot ($why) ok" >&2
	else
		echo "[pw-tmux-owner] snapshot ($why) failed: ${out##*$'\n'}" >&2
	fi
}

if [[ "$PERSIST_ENABLED" == 1 ]]; then
	# Replay BEFORE publishing the barrier state, so the app cannot boot first.
	if [[ -f "$PW_TMUX_STATE_DIR/manifest.tsv" ]]; then
		if restore_out=$("$SCRIPT_DIR/pw-tmux-restore" 2>&1); then
			publish_restore_state complete
		else
			rc=$?
			# 78 is EX_CONFIG from pw-tmux-restore: a manifest was present but the
			# configuration was unusable, or it refused on identity/privilege
			# grounds, so it restored NOTHING. Never fatal here — a replay failure
			# must not tear down the server that owns every live session — but it
			# must not be silent, and the barrier must still release or the app
			# would never start.
			publish_restore_state "failed-$rc"
			[[ -n "$restore_out" ]] && echo "[pw-tmux-owner]   ${restore_out##*$'\n'}" >&2
		fi
	else
		publish_restore_state no-manifest
	fi
else
	# Persistence off (host mode, or the deployment supplied no paths). Publish
	# immediately so a container fencing on this never waits for a replay that is
	# not coming.
	publish_restore_state off
fi

# --- readiness ----------------------------------------------------------------
# Host mode only, and tolerated-absent: never an exit path (GOA constraint).
if [[ "$HOST_MODE" == 1 ]]; then
	if command -v systemd-notify >/dev/null 2>&1; then
		systemd-notify --ready --status="tmux server pid $server_pid owned by $expected_owner" 2>/dev/null || true
	fi
fi

# Test-only: supervise-and-return, so the readiness contract is testable without
# a systemd unit. Never set in production.
[[ "${PW_TMUX_EXIT_AFTER_READY:-0}" == 1 ]] && exit 0

# --- supervise ----------------------------------------------------------------
# Idle in the foreground so the owner (and the server's cgroup) stay up; on
# SIGTERM/SIGINT snapshot once more, then exit cleanly. The final snapshot is the
# container-mode equivalent of pw-tmux-persist.service's ExecStop, and it is what
# makes a PLANNED rebuild lose nothing: `podman stop` sends SIGTERM here first.
term() { pw_snapshot shutdown; exit 0; }
trap term TERM INT
while :; do
	# `sleep & wait` rather than a bare sleep: bash only runs a trap once the
	# current foreground command finishes, so a bare `sleep 120` would delay
	# shutdown — and the final snapshot — by up to the whole interval.
	sleep "$PW_TMUX_SAVE_INTERVAL" &
	wait $! || true
	pw_snapshot periodic
done
