# shellcheck shell=bash
# Project Workbench: load the authoritative non-secret environment contract.
#
# Sourced by the shell entry points (pw-tmux-restore, pw-tmux-save, project-terminal-start,
# pw-tmux-assert-owner) so they resolve the SAME paths, mode and per-user flag the dashboard does.
# The contract itself — the key list, the defaults, the validation rules — is documented in
# app/pw-env.js; this file is its shell half and must not disagree with it.
#
# Two behaviours matter and are tested:
#
#   1. ALREADY-SET WINS. systemd has already applied `EnvironmentFile=` by the time a unit's script
#      runs, an operator's explicit export is a deliberate override, and a test that sets a path
#      must never have it replaced by the host's real one.
#   2. MISCONFIGURATION IS NOT "NOTHING TO DO". pw_env_require_* exits EX_CONFIG (78) with a message
#      naming the variable and the path. Exiting 0 having done nothing is the GOA-1 failure: a
#      restore that could not find the registry looked exactly like a restore with nothing to do.
#
# Nothing secret is read from, or written to, this file's target.

PW_ENV_EXIT_CONFIG=78

pw_env_path() {
	printf '%s' "${PW_ENV_FILE:-/etc/project-workbench/pw.env}"
}

# Load the env file without clobbering anything already set. Absent file is fine — the compiled-in
# defaults in each consumer still apply, exactly as before this contract existed. A file that exists
# but cannot be READ is a real misconfiguration and is reported.
pw_env_load() {
	local file line key value cur
	file=$(pw_env_path)
	[ -e "$file" ] || return 0
	if [ ! -r "$file" ]; then
		printf '[pw-env] %s exists but is not readable\n' "$file" >&2
		return 1
	fi
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
			''|'#'*) continue ;;
		esac
		case "$line" in
			*=*) ;;
			*) continue ;;
		esac
		key=${line%%=*}
		value=${line#*=}
		# Trim surrounding whitespace on the key; reject anything that is not a variable name.
		key=${key#"${key%%[![:space:]]*}"}
		key=${key%"${key##*[![:space:]]}"}
		case "$key" in
			[A-Za-z_]*) ;;
			*) continue ;;
		esac
		case "$key" in
			*[!A-Za-z0-9_]*) continue ;;
		esac
		value=${value#"${value%%[![:space:]]*}"}
		value=${value%"${value##*[![:space:]]}"}
		# Optional single/double quotes, matching systemd EnvironmentFile= and podman --env-file.
		case "$value" in
			\"*\") value=${value#\"}; value=${value%\"} ;;
			\'*\') value=${value#\'}; value=${value%\'} ;;
		esac
		# Only a NON-EMPTY existing value counts as "already set". An exported-but-empty variable is
		# how every consumer in this repo spells "unset" (`${PW_PER_USER_CLAUDE:-}`), and letting an
		# empty string win would silently mask the authoritative value — which for the per-user flag
		# means restoring under the shared login. Matches resolvePwEnv() in app/pw-env.js.
		eval "cur=\${$key:-}"
		[ -n "$cur" ] && continue
		export "$key=$value"
	done < "$file"
	return 0
}

# Refuse, loudly and non-zero, when an authoritative path is missing or the wrong type.
# Usage: pw_env_require_file PW_REGISTRY_PATH "the project registry"
pw_env_require_file() {
	local name="$1" purpose="${2:-}" value
	eval "value=\${$name:-}"
	if [ -z "$value" ]; then
		printf '[pw-env] %s is not set (%s). Set it in %s.\n' "$name" "$purpose" "$(pw_env_path)" >&2
		exit "$PW_ENV_EXIT_CONFIG"
	fi
	if [ ! -f "$value" ]; then
		printf '[pw-env] %s=%s does not exist (%s). Refusing to continue as though there were nothing to do.\n' \
			"$name" "$value" "$purpose" >&2
		exit "$PW_ENV_EXIT_CONFIG"
	fi
}

pw_env_require_dir() {
	local name="$1" purpose="${2:-}" value
	eval "value=\${$name:-}"
	if [ -z "$value" ]; then
		printf '[pw-env] %s is not set (%s). Set it in %s.\n' "$name" "$purpose" "$(pw_env_path)" >&2
		exit "$PW_ENV_EXIT_CONFIG"
	fi
	if [ ! -d "$value" ]; then
		printf '[pw-env] %s=%s is not a directory (%s). Refusing to continue as though there were nothing to do.\n' \
			"$name" "$value" "$purpose" >&2
		exit "$PW_ENV_EXIT_CONFIG"
	fi
}

# The deploy mode, or a refusal. Mirrors app/deploy-mode.js: an explicit recognised value is always
# honoured; unset with no container evidence is host; anything else is ambiguous and must not be
# guessed. Prints the mode on stdout.
pw_env_deploy_mode() {
	local raw evidence
	raw=$(printf '%s' "${PW_DEPLOY_MODE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
	case "$raw" in
		host|container) printf '%s' "$raw"; return 0 ;;
		'') ;;
		*)
			printf '[pw-env] PW_DEPLOY_MODE=%s is not one of host|container.\n' "${PW_DEPLOY_MODE}" >&2
			return 1
			;;
	esac
	evidence=""
	[ -n "${container:-}" ] && evidence="container=${container}"
	[ -n "${PW_TERMINAL_UID:-}" ] && evidence="${evidence:+$evidence; }PW_TERMINAL_UID is set"
	[ -e /run/.containerenv ] && evidence="${evidence:+$evidence; }/run/.containerenv"
	[ -e /.dockerenv ] && evidence="${evidence:+$evidence; }/.dockerenv"
	if [ -n "$evidence" ]; then
		printf '[pw-env] PW_DEPLOY_MODE is unset but this runtime looks containerised (%s). Set PW_DEPLOY_MODE=host|container.\n' \
			"$evidence" >&2
		return 1
	fi
	printf 'host'
	return 0
}
