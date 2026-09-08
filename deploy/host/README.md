# GOA deployment — host hooks

Host-level files for the Project Workbench deployment that runs as **rootful podman +
systemd**, with the app/terminal containers created from `project-workbench:latest`.

They are **not** part of the container image or the Node app. They run on the **host** as
systemd `ExecStartPost` hooks on `project-workbench.service` and `pw-tmux.service`,
re-applying deployment-specific state every time a container is (re)created — `podman run`
recreates the container from the image on each (re)start, so anything not baked into the
image (or kept in a persistent mount) is otherwise lost.

Files are mirrored under `files/` at their real host paths.

## Hooks
- `usr/local/sbin/pw-harden-sudoers.sh <container>` — **security**: removes the image's
  baked `admin ALL=(ALL) NOPASSWD:ALL` grant so the agent user (`admin`) cannot `sudo` to
  root. In a `--privileged` deployment that escalation would reach host root. Nothing in
  PW needs admin-initiated sudo (the app runs as root and drops to admin via `sudo -u admin`).
- `usr/local/sbin/pw-ensure-dotnet.sh <container>` — **runtime**: restores the .NET deploy
  toolchain the image does not bake — symlinks the persistent `/root/.dotnet` SDK onto PATH
  and `apt-get install`s `libicu72` + `smbclient`.
- `*.service.d/hardening.conf` and `*.service.d/runtime.conf` — drop-ins that wire each
  script as an `ExecStartPost` (with a `-` prefix, so failures are non-fatal) on both units.
  They append to the existing `ExecStartPost` list; they do not replace it.
- `usr/local/sbin/pw-host-alias-check` — **manual preflight**, not the gate: validates a
  host-alias drop-in by hand before a restart. Installed from the repo
  (`scripts/pw-host-alias-check` beside `app/host-alias.js`, under
  `/usr/local/lib/project-workbench/`, symlinked onto `sbin`) rather than mirrored under
  `files/`, so it and the product share one verdict function. The authoritative gate is
  `pw-tmux.service`'s own `ExecStartPre`, which runs this same checker out of the container
  image on every start.

## Host aliases — deployment-specific, and not in this tree

`systemd/pw-tmux.service` carries an empty `PW_TMUX_HOST_ALIAS_ARGS` and expands it into
`podman run`, so the shared container artifact carries the mechanism and no site's hostname.
A deployment that needs to take DNS out of the path for a name (an MCP client resolves each
server **once** at session start and never retries, so one transient NXDOMAIN disables every
name-configured server for that session) supplies its own mapping:

    sudo cp files/etc/systemd/system/pw-tmux.service.d/host-alias.conf.example \
            /etc/systemd/system/pw-tmux.service.d/host-alias.conf
    sudoedit /etc/systemd/system/pw-tmux.service.d/host-alias.conf   # put the real hostname here
    sudo systemctl daemon-reload

`install.sh` deliberately does **not** install that drop-in: only the `.example` template is
tracked, the real value lives on the host, and a placeholder that resolves nowhere must never
be installed in front of a running unit.

**The drop-in carries the value only.** Validation is not something each deployment has to
remember to wire: `pw-tmux.service` runs `pw-host-alias-check` itself, as a non-`-`
`ExecStartPre`, out of the container image — so *every* supported route to the value (this
drop-in, or the `EnvironmentFile` at `/etc/project-workbench/pw.env`) is checked before podman
sees it. An earlier revision gated only the drop-in, which left the documented environment-file
path unvalidated. A malformed mapping, or a loopback address on a sidecar that does not share
the host network namespace, exits 78 (`EX_CONFIG`) and fails the unit rather than starting a
container whose clients fail later, one at a time. The empty default passes unchanged, so a
deployment that configures nothing is unaffected.

To check an edit before `systemctl restart` takes every terminal down with it:

    sudo PW_TMUX_HOST_ALIAS_ARGS='--add-host your.host.here:127.0.0.1' \
         PW_TMUX_NETWORK_MODE=host /usr/local/sbin/pw-host-alias-check

A related pre-existing host hook installed the same way (not tracked here) is
`pw-trust-goa-ca.sh`, which loads the internal CA into the container trust store.

## Install / DR restore
    sudo bash install.sh

Copies the files to their host paths and runs `systemctl daemon-reload`. This does **not**
restart the services; the hooks apply on the next container (re)start. To apply immediately,
run the scripts against the live containers, e.g. `sudo /usr/local/sbin/pw-ensure-dotnet.sh project-workbench`.
