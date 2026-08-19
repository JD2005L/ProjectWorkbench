#!/usr/bin/env bash
# Promote the whole checkout app/ tree into the live app, reconciling the drift
# that blocks any normal server.js change, then restart node.
#
# Run from a HOST shell on vnl2422 as james.levac.z:
#   sudo bash /opt/project-workbench/persistent/admin-home/promote-app.sh --dry-run
#   sudo bash /opt/project-workbench/persistent/admin-home/promote-app.sh
#
# Why a whole-tree promote and not just server.js: the live build is far behind
# the checkout and lacks modules the current server.js imports (user-credentials,
# project-owner, tmux-owner-gate, orchestrator/...). Copying server.js alone
# crashes node on ERR_MODULE_NOT_FOUND and respawn-loops the dashboard.
#
# Why this is safer than the line count suggests, both verified before writing:
#   * the only npm dependency anywhere in app/ is express — everything else is
#     node builtins — so the destination's existing node_modules suffices;
#   * the two new subsystems are off unless explicitly enabled. orchestrator/
#     config.js reads bool(PW_ORCHESTRATOR_ENABLED, false) and per-user
#     credentials read PW_PER_USER_CLAUDE === 'true'; neither var is in the
#     container env, so both boot inert.
# The script re-checks both of these at runtime rather than trusting the above.
#
# node_modules is never touched: not copied, not backed up, not deleted.

set -uo pipefail

SRC=/opt/project-workbench/workspaces/ProjectWorkbench/app
DST=/opt/project-workbench/workspaces/canonical/app
STAMP=$(date +%Y%m%d-%H%M%S)
BAK="/opt/project-workbench/workspaces/canonical/app-backup-$STAMP.tar"
SELF=/opt/project-workbench/persistent/admin-home/promote-app.sh
CONTAINER=project-workbench
HEALTH_URL='https://127.0.0.1/workbench/'
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

die(){ printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }
say(){ printf '[promote] %s\n' "$*"; }
hr(){  printf '\n[promote] ---- %s ----\n' "$*"; }

# ---------------------------------------------------------------- guards -----
if [ -f /run/.containerenv ]; then
  die "running inside a container. Use a HOST shell on vnl2422:
      sudo bash $SELF"
fi
[ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash $SELF [--dry-run])"
[ -d "$SRC" ] || die "source tree not found: $SRC"
[ -d "$DST" ] || die "live tree not found: $DST"
command -v node >/dev/null 2>&1 || die "node not on the host PATH; cannot syntax-check before promoting"

[ "$DRY" -eq 1 ] && say "DRY RUN — nothing will be written."

# ------------------------------------------------------------- manifest ------
# Everything in the checkout app/ except node_modules.
mapfile -t ITEMS < <(cd "$SRC" && ls -A | grep -vx 'node_modules')
[ "${#ITEMS[@]}" -gt 0 ] || die "manifest is empty; refusing"
say "manifest: ${#ITEMS[@]} top-level entries ($(cd "$SRC" && find "${ITEMS[@]}" -type f | wc -l) files)"

# ------------------------------------------------------- preflight: syntax ---
hr "preflight: syntax-check the source"
FAIL=0
while IFS= read -r f; do
  node --check "$f" >/dev/null 2>&1 || { printf '  BAD SYNTAX: %s\n' "$f"; FAIL=1; }
done < <(cd "$SRC" && find "${ITEMS[@]}" -type f \( -name '*.js' -o -name '*.mjs' \) -printf "$SRC/%p\n")
[ "$FAIL" -eq 0 ] || die "source has syntax errors; nothing changed"
say "all source .js/.mjs parse"

# --------------------------------------------- preflight: npm deps resolve ---
hr "preflight: npm dependencies present in the LIVE node_modules"
mapfile -t BARE < <(cd "$SRC" && node -e '
const fs=require("fs"),path=require("path");
const pat=/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'"'"']([^"'"'"']+)["'"'"']/g;
const out=new Set();
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if(e.name==="node_modules")continue; const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);
  else if(/\.(js|mjs)$/.test(e.name)){
    const s=fs.readFileSync(p,"utf8"); let m;
    while((m=pat.exec(s))){const q=m[1];
      if(/^[.\/]/.test(q)||q.startsWith("node:"))continue;
      if(!/^(@[\w.-]+\/)?[\w.-]+([\/][\w.\/-]*)?$/.test(q))continue;   // skip prose caught in strings
      out.add(q.startsWith("@")?q.split("/").slice(0,2).join("/"):q.split("/")[0]);}}
}})(".");
console.log([...out].filter(m=>!require("module").isBuiltin(m)).sort().join("\n"));
')
if [ "${#BARE[@]}" -eq 0 ] || [ -z "${BARE[0]:-}" ]; then
  say "no external npm imports found"
else
  for m in "${BARE[@]}"; do
    [ -z "$m" ] && continue
    if [ -d "$DST/node_modules/$m" ]; then
      printf '  ok      %s\n' "$m"
    else
      printf '  MISSING %s\n' "$m"; FAIL=1
    fi
  done
fi
[ "$FAIL" -eq 0 ] || die "the live node_modules lacks a package the new code imports.
      Promoting would crash node on ERR_MODULE_NOT_FOUND. Nothing changed."

# ------------------------------------------- preflight: feature flags off ----
hr "preflight: new subsystems must boot inert"
ENVDUMP=$(tr '\0' '\n' < /proc/"$(pgrep -o -f "podman run --name $CONTAINER" || echo 1)"/cmdline 2>/dev/null || true)
for v in PW_ORCHESTRATOR_ENABLED PW_PER_USER_CLAUDE; do
  if printf '%s' "$ENVDUMP" | grep -q "$v"; then
    printf '  WARNING %s is set in the container env — that subsystem will boot ACTIVE\n' "$v"
  else
    printf '  ok      %s unset (subsystem inert)\n' "$v"
  fi
done

# --------------------------------------------------- preflight: what moves ---
hr "preflight: change summary"
NEW=0; CHANGED=0; SAME=0
while IFS= read -r rel; do
  if [ ! -e "$DST/$rel" ]; then NEW=$((NEW+1)); printf '  new      %s\n' "$rel"
  elif ! cmp -s "$SRC/$rel" "$DST/$rel"; then CHANGED=$((CHANGED+1)); printf '  changed  %s\n' "$rel"
  else SAME=$((SAME+1)); fi
done < <(cd "$SRC" && find "${ITEMS[@]}" -type f -printf '%p\n')
say "new=$NEW changed=$CHANGED unchanged=$SAME"

# Files the live tree has that the checkout does not. Reported, never deleted —
# server.js is the only entry point, so stale extras are inert.
hr "preflight: live-only files (left in place, not deleted)"
STALE=0
while IFS= read -r rel; do
  [ -e "$SRC/$rel" ] || { printf '  live-only %s\n' "$rel"; STALE=$((STALE+1)); }
done < <(cd "$DST" && find . -type f -not -path './node_modules/*' -printf '%P\n')
say "live-only files: $STALE"

if [ "$NEW" -eq 0 ] && [ "$CHANGED" -eq 0 ]; then
  say "live tree already matches the checkout — nothing to promote."
  [ "$DRY" -eq 1 ] && exit 0
  say "Skipping copy and restart. Exiting."
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  hr "DRY RUN complete"
  say "Re-run without --dry-run to promote, back up to $BAK, and restart node."
  exit 0
fi

# --------------------------------------------------------------- backup ------
hr "backup"
tar -C "$DST" --exclude=node_modules -cf "$BAK" . || die "backup failed; nothing changed"
chmod 600 "$BAK"
say "live tree backed up -> $BAK ($(du -h "$BAK" | cut -f1))"

rollback(){ tar -C "$DST" -xf "$BAK"; }

# -------------------------------------------------------------- promote ------
hr "promote"
# tar src -> dst preserves the tree; ownership is then normalised to root, because
# the source is admin-owned and the live tree must not become agent-writable.
( cd "$SRC" && tar -cf - "${ITEMS[@]}" ) | ( cd "$DST" && tar -xf - ) \
  || { rollback; die "copy failed; restored from backup"; }

chown -R root:root "$DST" || { rollback; die "chown failed; restored from backup"; }
find "$DST" -path "$DST/node_modules" -prune -o -type d -exec chmod 755 {} +
find "$DST" -path "$DST/node_modules" -prune -o -type f -exec chmod 644 {} +
say "copied and ownership normalised to root:root"

hr "postflight: syntax-check the LIVE tree"
FAIL=0
while IFS= read -r f; do
  node --check "$f" >/dev/null 2>&1 || { printf '  BAD SYNTAX: %s\n' "$f"; FAIL=1; }
done < <(find "$DST" -path "$DST/node_modules" -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print)
[ "$FAIL" -eq 0 ] || { rollback; die "live tree failed syntax check; restored from backup"; }
say "live tree parses"

# --------------------------------------------------------------- restart -----
hr "restart"
ENTRY=$(pgrep -o -f scripts/entrypoint.sh) || { rollback; die "no entrypoint.sh found; restored from backup"; }
mapfile -t NODES < <(pgrep -P "$ENTRY" -x node)
if [ "${#NODES[@]}" -ne 1 ]; then
  pgrep -a -P "$ENTRY" -x node
  rollback
  die "expected exactly 1 node child of entrypoint $ENTRY, found ${#NODES[@]}. Restored from backup, nothing killed."
fi
OLD=${NODES[0]}
say "restarting node pid $OLD — tmux sessions survive (parented to conmon)"
kill "$OLD"

NEW_PID=""
for _ in $(seq 1 25); do
  sleep 1
  NEW_PID=$(pgrep -P "$ENTRY" -x node | head -1)
  [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD" ] && break
done

healthy(){
  local c
  c=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null)
  case "$c" in 200|301|302|401|403) return 0;; *) return 1;; esac
}

OK=1
if [ -z "$NEW_PID" ]; then OK=0; else
  OK=0
  for _ in $(seq 1 25); do sleep 1; if healthy; then OK=1; break; fi; done
fi

if [ "$OK" -ne 1 ]; then
  hr "ROLLING BACK — the dashboard did not come back"
  podman logs --tail 60 "$CONTAINER" 2>&1 | tail -40
  rollback
  E2=$(pgrep -o -f scripts/entrypoint.sh); P2=$(pgrep -P "$E2" -x node | head -1)
  [ -n "$P2" ] && kill "$P2"
  sleep 10
  healthy && say "rolled back and the dashboard is serving again" \
           || say "rolled back but the dashboard is STILL not answering — check: podman logs --tail 80 $CONTAINER"
  die "promote reverted. The backup is still at $BAK"
fi

say "node respawned as pid $NEW_PID and the dashboard is serving"
sleep 8

# ---------------------------------------------------------------- verify -----
hr "verification"
code(){ curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$1/" 2>/dev/null; }
printf '  dashboard  %s   (200/302/401 = serving)\n' "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL")"
printf '  ttyd 7686  %s   (404 = healthy)\n' "$(code 7686)"
printf '  ttyd 7693  %s   (404 = AITPulse 502 cleared, 000 = still down)\n' "$(code 7693)"
printf '  live VERSION: %s\n' "$(cat "$DST/VERSION" 2>/dev/null || echo unknown)"

hr "boot log"
podman logs --tail 200 "$CONTAINER" 2>&1 | grep -iE '\[boot\]|\[orchestrator\]|\[deploy\]|error|ERR_' | tail -20

cat <<EOF

[promote] DONE — the live app now matches the checkout.

What to look at:
  * open a project and toggle the Files drawer — it should read as a raised
    surface with visible row borders (the contrast change);
  * the auto-update nag is gone in NEW tmux sessions (pane env is captured at
    'tmux new-session', so recycle a project's terminal to clear an old one).

Rollback:
  tar -C '$DST' -xf '$BAK' && kill \$(pgrep -P \$(pgrep -o -f scripts/entrypoint.sh) -x node)
EOF
