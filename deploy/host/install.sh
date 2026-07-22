#!/usr/bin/env bash
# Install/restore the GOA host hooks to their real paths. Idempotent. Run as root.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$here/files/usr/local/sbin/pw-harden-sudoers.sh" /usr/local/sbin/pw-harden-sudoers.sh
install -m 0755 "$here/files/usr/local/sbin/pw-ensure-dotnet.sh"  /usr/local/sbin/pw-ensure-dotnet.sh
mkdir -p /etc/systemd/system/project-workbench.service.d /etc/systemd/system/pw-tmux.service.d
for u in project-workbench pw-tmux; do
  install -m 0644 "$here/files/etc/systemd/system/$u.service.d/hardening.conf" "/etc/systemd/system/$u.service.d/hardening.conf"
  install -m 0644 "$here/files/etc/systemd/system/$u.service.d/runtime.conf"   "/etc/systemd/system/$u.service.d/runtime.conf"
done
systemctl daemon-reload
echo "Installed host hooks + reloaded systemd. They apply on next container (re)start; run the scripts manually to apply now."
