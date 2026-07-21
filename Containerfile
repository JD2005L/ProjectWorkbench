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
# The Windows (WinRM/SMB) deploy flow needs these; skip them otherwise.
# RUN apt-get update && apt-get install -y --no-install-recommends smbclient libicu72 && \
#     rm -rf /var/lib/apt/lists/*
# RUN pip3 install --no-cache-dir --break-system-packages pywinrm
# ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && \
#     bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet && \
#     ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet && rm -f /tmp/dotnet-install.sh
# -------------------------------------------------------------------------------

# UTF-8 locale
RUN sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# ttyd (static binary) — serves each project's terminal.
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd

# admin user for host-parity; container terminals run as root on the shared tmux.
RUN useradd -m -s /bin/bash admin && echo "admin ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

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
RUN chmod +x /opt/project-workbench/scripts/* 2>/dev/null || true

RUN mkdir -p /opt/project-workbench/workspaces /opt/project-workbench/memory \
    /etc/project-workbench /etc/nginx/conf.d /opt/npm-global/bin /opt/npm-global/lib

CMD ["/opt/project-workbench/scripts/entrypoint.sh"]
