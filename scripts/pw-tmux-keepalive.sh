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
# GOA-2 disposition: container supervision is retained as it was. No replay and no
# opt-in restore-on-start is added here; container mid-uptime replay remains a
# separate feature.
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
# SIGTERM/SIGINT exit cleanly.
term() { exit 0; }
trap term TERM INT
tail -f /dev/null &
wait $!
