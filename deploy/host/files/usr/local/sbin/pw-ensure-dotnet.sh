#!/usr/bin/env bash
# GOA runtime restore for PW agent containers, re-applied at each container start
# (podman recreates from the image, losing ephemeral bits). Idempotent.
#  - .NET SDK (persistent /root/.dotnet) symlinked onto PATH + libicu/smbclient.
#  - copilot/claude symlinked into /usr/local/bin: root-context terminals get a
#    PATH without /opt/npm-global/bin (server.js hardcodes the terminal PATH), so
#    the CLIs must be reachable via a dir that IS on every terminal PATH.
set -u
PODMAN=/usr/bin/podman
c="${1:?usage: pw-ensure-dotnet.sh <container>}"
for i in $(seq 1 15); do "$PODMAN" exec "$c" true 2>/dev/null && break; sleep 1; done
"$PODMAN" exec "$c" sh -c '[ -x /root/.dotnet/dotnet ] && ln -sf /root/.dotnet/dotnet /usr/local/bin/dotnet' 2>/dev/null || true
"$PODMAN" exec "$c" sh -c 'ldconfig -p 2>/dev/null | grep -qi libicu && command -v smbclient >/dev/null 2>&1' 2>/dev/null \
  || "$PODMAN" exec "$c" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1; apt-get install -y --no-install-recommends libicu72 smbclient >/dev/null 2>&1' 2>/dev/null || true
"$PODMAN" exec "$c" sh -c '[ -e /opt/npm-global/bin/copilot ] && ln -sf /opt/npm-global/bin/copilot /usr/local/bin/copilot; [ -e /opt/npm-global/bin/claude ] && ln -sf /opt/npm-global/bin/claude /usr/local/bin/claude' 2>/dev/null || true
exit 0
