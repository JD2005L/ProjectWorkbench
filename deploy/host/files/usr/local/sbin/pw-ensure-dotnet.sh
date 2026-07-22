#!/usr/bin/env bash
# GOA runtime restore: the canonical image (node:20-slim) does not bake the .NET
# deploy toolchain (it is the optional/commented section of the Containerfile). The
# .NET SDK lives in persistent /root/.dotnet (root-home mount) and survives recreates,
# but the ephemeral bits (libicu, smbclient, and the /usr/local/bin/dotnet symlink) are
# lost on each container recreate. Restore them at start so the Deployment Centre's
# `dotnet publish` works. Idempotent; safe to run repeatedly.
set -u
PODMAN=/usr/bin/podman
c="${1:?usage: pw-ensure-dotnet.sh <container>}"
for i in $(seq 1 15); do "$PODMAN" exec "$c" true 2>/dev/null && break; sleep 1; done
# 1) dotnet symlink (no network) when the persistent SDK is present
"$PODMAN" exec "$c" sh -c '[ -x /root/.dotnet/dotnet ] && ln -sf /root/.dotnet/dotnet /usr/local/bin/dotnet' 2>/dev/null || true
# 2) runtime libs, only if missing (needs apt/network; a few seconds)
"$PODMAN" exec "$c" sh -c 'ldconfig -p 2>/dev/null | grep -qi libicu && command -v smbclient >/dev/null 2>&1' 2>/dev/null \
  || "$PODMAN" exec "$c" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1; apt-get install -y --no-install-recommends libicu72 smbclient >/dev/null 2>&1' 2>/dev/null || true
exit 0
