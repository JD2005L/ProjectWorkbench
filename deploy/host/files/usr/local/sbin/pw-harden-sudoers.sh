#!/usr/bin/env bash
# GOA hardening: remove the blanket passwordless-sudo grant for the 'admin' agent
# user from the named PW container so agents (which run as 'admin') cannot escalate
# to root (and, in a privileged container, thereby to host root).
# Idempotent. Invoked as an ExecStartPost hook with the container name.
set -u
PODMAN=/usr/bin/podman
c="${1:?usage: pw-harden-sudoers.sh <container>}"
for i in $(seq 1 10); do
  if "$PODMAN" exec "$c" true 2>/dev/null; then
    "$PODMAN" exec "$c" sed -i '/NOPASSWD:ALL/d' /etc/sudoers 2>/dev/null || true
    exit 0
  fi
  sleep 1
done
exit 0
