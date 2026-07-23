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

A related pre-existing host hook installed the same way (not tracked here) is
`pw-trust-goa-ca.sh`, which loads the internal CA into the container trust store.

## Install / DR restore
    sudo bash install.sh

Copies the files to their host paths and runs `systemctl daemon-reload`. This does **not**
restart the services; the hooks apply on the next container (re)start. To apply immediately,
run the scripts against the live containers, e.g. `sudo /usr/local/sbin/pw-ensure-dotnet.sh project-workbench`.
