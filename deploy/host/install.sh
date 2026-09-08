#!/usr/bin/env bash
# Install/restore the GOA host hooks to their real paths. Idempotent. Run as root.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
install -m 0755 "$here/files/usr/local/sbin/pw-harden-sudoers.sh" /usr/local/sbin/pw-harden-sudoers.sh
install -m 0755 "$here/files/usr/local/sbin/pw-ensure-dotnet.sh"  /usr/local/sbin/pw-ensure-dotnet.sh

# The host-alias checker as a MANUAL PREFLIGHT — not the gate.
#
# The authoritative gate is pw-tmux.service's own ExecStartPre, which runs this
# same checker out of the container image on every start, so it cannot be missing
# while the unit can still run. This copy exists so an operator can validate an
# edited host-alias.conf BEFORE `systemctl restart` takes every terminal down
# with it:
#
#   sudo PW_TMUX_HOST_ALIAS_ARGS='--add-host your.host:127.0.0.1' \
#        PW_TMUX_NETWORK_MODE=host /usr/local/sbin/pw-host-alias-check
#
# It is installed BESIDE app/ and reached through a symlink. pw-host-alias-check
# is an ES module that imports ../app/host-alias.js RELATIVE TO ITSELF, so the
# preflight and the product share one verdict function and cannot drift.
# Installed flat into /usr/local/sbin that import resolves
# /usr/local/app/host-alias.js, which no deployment has, and the helper dies
# ERR_MODULE_NOT_FOUND on every invocation. Under this prefix app/ is exactly one
# level up, so the import is correct by construction; node resolves an ES
# module's imports against its REALPATH, so reaching it through the link lands on
# the same app/ directory.
prefix=/usr/local/lib/project-workbench
install -d -m 0755 "$prefix/app" "$prefix/scripts"
install -m 0644 "$repo/app/host-alias.js"          "$prefix/app/host-alias.js"
install -m 0755 "$repo/scripts/pw-host-alias-check" "$prefix/scripts/pw-host-alias-check"
ln -sfn "$prefix/scripts/pw-host-alias-check" /usr/local/sbin/pw-host-alias-check

mkdir -p /etc/systemd/system/project-workbench.service.d /etc/systemd/system/pw-tmux.service.d
for u in project-workbench pw-tmux; do
  install -m 0644 "$here/files/etc/systemd/system/$u.service.d/hardening.conf" "/etc/systemd/system/$u.service.d/hardening.conf"
  install -m 0644 "$here/files/etc/systemd/system/$u.service.d/runtime.conf"   "/etc/systemd/system/$u.service.d/runtime.conf"
done

# host-alias.conf is NOT installed from this tree, and there is no `.example`
# fallback: the mapping names one deployment's host, so the canonical tree ships
# the template and the operator writes the real value on the host. Installing the
# example would put a placeholder that resolves nowhere in front of a running
# unit. Restoring an existing one is a copy the operator makes deliberately.
if [ -f /etc/systemd/system/pw-tmux.service.d/host-alias.conf ]; then
  echo "Keeping the existing host-alias.conf drop-in (deployment-specific; not managed here)."
else
  echo "No host-alias drop-in configured. To add one:"
  echo "  cp $here/files/etc/systemd/system/pw-tmux.service.d/host-alias.conf.example \\"
  echo "     /etc/systemd/system/pw-tmux.service.d/host-alias.conf   # then edit the hostname"
fi

systemctl daemon-reload
echo "Installed host hooks + reloaded systemd. They apply on next container (re)start; run the scripts manually to apply now."
