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
#
# krb5-user is the MIT Kerberos client (kinit/klist/kdestroy/ktutil/kvno). It is
# baked in DELIBERATELY, for every project, because the alternative is worse:
# without a sanctioned way to obtain a Kerberos TGT, agents investigating a
# Windows-auth SQL Server or AD from these non-root panes reach for Impacket's
# getTGT.py — an offensive-security toolkit whose on-disk signatures trip GOA's
# EDR and generate a security incident every time. kinit is the legitimate,
# EDR-neutral equivalent: it produces the identical MIT ccache (which the .NET
# SqlClient `Integrated Security=true` path already consumes) using standard AD
# client traffic. The GSSAPI libraries it drives (libgssapi_krb5, libkrb5) are
# already present via the base image. See TeamKB "Kerberos Authentication to GOA
# SQL Server from a Non-Root Linux Workbench" for the full, Impacket-free recipe.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git sudo curl ca-certificates bash tmux jq ldap-utils procps python3 locales \
      krb5-user bzip2 && \
    rm -rf /var/lib/apt/lists/*

# go-sqlcmd: a single static SQL Server client so any project can run an ad-hoc
# query against an external DB without hand-rolling a throwaway .NET harness. The
# Go rewrite (not the ODBC mssql-tools) is chosen precisely because it is one
# binary with no EULA and no repo, and it authenticates with the Kerberos ccache
# kinit produces (`KRB5CCNAME=… sqlcmd -S host.fqdn -d DB -E -Q "…"`). Pinned;
# the layer fails loudly rather than shipping a half-download.
RUN set -eux; \
    url="https://github.com/microsoft/go-sqlcmd/releases/download/v1.10.0/sqlcmd-linux-amd64.tar.bz2"; \
    curl -fsSL "$url" -o /tmp/sqlcmd.tar.bz2; \
    tar -xjf /tmp/sqlcmd.tar.bz2 -C /usr/local/bin sqlcmd; \
    rm -f /tmp/sqlcmd.tar.bz2; \
    chmod 0755 /usr/local/bin/sqlcmd; \
    /usr/local/bin/sqlcmd --version

# --- OPTIONAL: site Kerberos realm (for kinit against your AD) ------------------
# krb5-user above is generic; the realm/KDC mapping is site-specific, so it is NOT
# hardcoded in this shared image (same reasoning as the CA block below). Either
# bake a site /etc/krb5.conf here, or have callers point KRB5_CONFIG at their own.
# With `dns_lookup_kdc = true` the KDCs are discovered from SRV records, so the
# file is tiny. Example (GOA):
# RUN printf '[libdefaults]\n    default_realm = GOA.DS.GOV.AB.CA\n    dns_lookup_kdc = true\n    rdns = false\n    udp_preference_limit = 1\n[domain_realm]\n    .goa.ds.gov.ab.ca = GOA.DS.GOV.AB.CA\n    goa.ds.gov.ab.ca = GOA.DS.GOV.AB.CA\n' > /etc/krb5.conf
# -------------------------------------------------------------------------------

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
#
# window-size smallest, NOT tmux's `latest` default. Every browser tab that opens a
# project terminal is its own ttyd child running `tmux attach-session` (server.js),
# so it is its own tmux client with its own browser-derived size — two people, or
# one person with two tabs, means two clients on one window. A window has exactly
# ONE size, so tmux has to choose, and under `latest` it re-chooses on every
# keystroke: measured 7 resizes in 8 keystrokes with an 80x24 and a 160x48 client
# attached. Each one SIGWINCHes the pane, a full-screen TUI (copilot, claude)
# repaints its whole frame, and tmux redraws the `·` U+00B7 padding it fills the
# oversized client's uncovered area with — the reported "screen shaking, dots
# everywhere", visible only while two clients are attached at once.
#
# `smallest` pads the larger client with a STATIC margin instead of thrashing, and
# nobody loses content. `largest` is the other stable choice and was rejected: it
# clips the smaller client to the top-left of the window, so part of the TUI is
# simply off-screen and a tmux client cannot be panned. Either way tmux recomputes
# on attach AND detach, so a client left alone goes back to its own full size.
RUN printf 'set -g default-terminal "xterm-256color"\nset -ga terminal-overrides ",xterm-256color:Tc"\nset -g mouse on\nset -gq allow-passthrough on\nset -g status off\nset -g window-size smallest\n' > /etc/tmux.conf

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
