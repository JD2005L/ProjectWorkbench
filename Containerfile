# Container image for running Project Workbench with PW_DEPLOY_MODE=container.
# The app runs in the container and spawns project terminals as node-managed ttyd
# processes attached to a tmux server (typically a persistent sidecar on a shared
# socket via TMUX_TMPDIR). nginx runs wherever the deployment puts it; point the
# app at it with PW_NGINX_TEST_CMD / PW_NGINX_RELOAD_CMD if it isn't reachable via
# a plain `systemctl reload nginx` from the app's namespace.
#
# This is the generic base. Environment-specific extras (an internal/AD CA for
# LDAPS, or the Windows deploy toolchain for PW_DEPLOY_CENTRE) are optional and
# left commented below — enable only what your deployment needs.
FROM node:20-slim

# Runtime dependencies. ldap-utils is only needed for PW_AUTH_MODE=ldap.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git sudo curl ca-certificates bash tmux jq ldap-utils procps python3 locales && \
    rm -rf /var/lib/apt/lists/*

# --- OPTIONAL: trust an internal / AD CA for LDAPS (PW_AUTH_MODE=ldap) ----------
# LDAPS binds validate the DC certificate against the system CA store. If your
# directory's CA does not chain to a public root, copy its certs into the image.
# Place the .crt files under config/ca/ and uncomment:
# COPY config/ca/*.crt /usr/local/share/ca-certificates/extra/
# RUN update-ca-certificates
# -------------------------------------------------------------------------------

# --- OPTIONAL: Deployment Centre toolchain (PW_DEPLOY_CENTRE=true) --------------
# Still off by default — the Windows (WinRM/SMB) deploy flow is the only thing
# that needs it and the .NET SDKs are large — but enabled by a BUILD ARG rather
# than by editing this file, because "uncomment these lines" is a local diff every
# such instance has to carry, and an instance that skips the diff installs the
# toolchain by hand instead. One did exactly that: the SDK went into /root/.dotnet
# (mode 0750), so `dotnet` was Permission-denied in every agent pane while
# `which dotnet` found nothing, and a host systemd drop-in re-symlinked it and
# re-apt-installed libicu/smbclient on every container start to compensate.
#
#   podman build -t project-workbench:latest \
#     --build-arg PW_DEPLOY_TOOLCHAIN=1 \
#     --build-arg PW_DOTNET_CHANNELS="8.0 10.0" .
#
# Installs to /usr/share/dotnet and world-readable, so the pane account can
# actually run it — the whole point of not putting it in a private home.
#
# python3-pip is installed here rather than in the base layer because pip is only
# needed for pywinrm: node:20-slim ships python3 but NOT pip3, so the previous
# `pip3 install pywinrm` line could not have worked as written.
ARG PW_DEPLOY_TOOLCHAIN=0
ARG PW_DOTNET_CHANNELS="8.0"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
RUN if [ "$PW_DEPLOY_TOOLCHAIN" = "1" ]; then \
      set -eux; \
      apt-get update && \
      apt-get install -y --no-install-recommends smbclient libicu72 python3-pip && \
      rm -rf /var/lib/apt/lists/* && \
      pip3 install --no-cache-dir --break-system-packages pywinrm && \
      curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && \
      for channel in $PW_DOTNET_CHANNELS; do \
        bash /tmp/dotnet-install.sh --channel "$channel" --install-dir /usr/share/dotnet; \
      done && \
      rm -f /tmp/dotnet-install.sh && \
      ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet && \
      chmod -R a+rX /usr/share/dotnet && \
      dotnet --list-sdks && \
      python3 -c 'import winrm' && \
      command -v smbclient >/dev/null; \
    fi
# -------------------------------------------------------------------------------

# UTF-8 locale
RUN sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# ttyd (static binary) — serves each project's terminal.
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd

# admin user for host-parity. Container terminals/agents run as this NON-root
# user (the app drops to it via `sudo -u admin`). We intentionally grant NO
# passwordless-root sudo here: nothing in PW needs admin-initiated sudo, and in a
# --privileged deployment admin->root would become host root (via nsenter).
# GOA hosts also enforce this at container start via pw-harden-sudoers.sh.
RUN useradd -m -s /bin/bash admin

# This container is a single-tenant sandbox: the AI CLI runs with skip-permissions,
# which Claude Code only allows under root when IS_SANDBOX=1. Inherited by
# entrypoint -> node -> tmux -> shells.
ENV IS_SANDBOX=1
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Keep the GitHub Copilot CLI on its embedded version when the container has no
# outbound registry access (a failed self-update leaves a broken pkg dir).
ENV COPILOT_AUTO_UPDATE=false
RUN echo "precedence ::ffff:0:0/96 100" >> /etc/gai.conf
ENV NPM_CONFIG_PREFIX=/opt/npm-global
RUN echo 'export PATH="/opt/npm-global/bin:$PATH"' > /etc/profile.d/npm-global.sh

# tmux: unicode/truecolor; hide the status bar (the workbench has its own tab strip).
RUN printf 'set -g default-terminal "xterm-256color"\nset -ga terminal-overrides ",xterm-256color:Tc"\nset -g mouse on\nset -gq allow-passthrough on\nset -g status off\n' > /etc/tmux.conf

WORKDIR /opt/project-workbench/app

# App + scripts (a volume mount typically overrides these at runtime).
COPY app/ ./
COPY scripts/ /opt/project-workbench/scripts/
# The stdio MCP adapter documented in docs/orchestrator-api.md.
COPY bin/ /opt/project-workbench/bin/
RUN chmod +x /opt/project-workbench/scripts/* 2>/dev/null || true

RUN mkdir -p /opt/project-workbench/workspaces /opt/project-workbench/memory \
    /etc/project-workbench /etc/nginx/conf.d /opt/npm-global/bin /opt/npm-global/lib

CMD ["/opt/project-workbench/scripts/entrypoint.sh"]
