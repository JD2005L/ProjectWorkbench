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

## Promote approvals — "the agent asks, an administrator approves"

Promoting Project Workbench means agent-written code becomes the live dashboard, which runs in
a `--privileged --pid=host` container: effectively host root. So the agent can **ask** for a
promote and follow it, and only an **administrator signed in to the dashboard** can approve it.

**The flow.** The agent runs `scripts/pw-promote request "note"`. The host service snapshots
the workspace and dry-runs the promote against that snapshot. An administrator opens
**Settings → System & Updates → Promote Project Workbench**, reads the dry run, enters their
password and approves. The host service then promotes **exactly that snapshot**, and records
the result. The promote restarts the dashboard's node process; the runner is a host service,
so it finishes on its own and the dashboard shows the result after its restart.

**Why the agent cannot approve.** Each layer closes a specific route:

- **The approve route admits only a person.** It needs a real dashboard session: the opaque
  server-side id the login issued, for a non-implicit admin, arriving through nginx.
  - **Refused:** on-box callers to `127.0.0.1:3000` (the agent can reach it and set any
    header), the soft-mode implicit admin, `PW_AUTH_HEADER` / `PW_DEV_USER` identities (no
    session), API tokens and non-admins.
  - **Password:** it also re-checks the administrator's password, so script running in a page
    on this origin with their cookie still cannot approve. That could be an agent's preview,
    or a file it left in a box (those are now served sandboxed as well).
  - **Lockout:** five wrong passwords lock that session out for 15 minutes.
- **The approval is pinned to what was reviewed.** It records the approver and the snapshot's
  digest, and expires after 24 hours. A dry run more than a day old cannot be approved.
- **The runner re-verifies before promoting.** It checks the approval, the digest and the
  expiry, recomputes the digest of the snapshot on disk, and only then promotes it.
- **The spool `/etc/project-workbench/promote` is 0700 root.** The dashboard (root in its
  container) writes requests, approvals and queue entries there, and the runner writes status
  and logs. The agent account can neither read nor write it.
- **The dry run hands the agent no root power.**
  - The workspace is read **as its owner** (`setpriv --reuid --regid --clear-groups
    --no-new-privs tar`); a root-owned workspace is refused.
  - The archive goes into a root-owned file under a size cap, and root never runs `tar` over
    it. The runner parses the ustar headers itself and accepts only regular files and
    directories under `app/` and `scripts/`, with plain names. It refuses symlinks, hard
    links, devices, FIFOs, extension headers, absolute or `..` paths, dash-leading names and
    duplicates.
  - HEAD comes from parsing `.git/HEAD` and refs as plain files, also as the owner; `git` is
    never run as root in the agent's repo.
- **The code that decides what root runs is installed by a human.** `pw-promote-app` (the
  pinned `deploy/promote-app.sh`) and `pw-promote-runner` live root-owned in `/usr/local/sbin`,
  and nothing refreshes them automatically: updating either is a human `sudo install`. Don't
  promote from a copy under `persistent/admin-home`: that is `/home/admin`, which the agent
  can write.

**What an approval does not check: it trusts the content.** A promote can ship any code,
including a change to the approval route itself. The dry run lists every new and changed file;
review the commit before approving.

**Install, once** (from a host shell on vnl2422; `install.sh` refuses if the gate could not
hold — `/etc/project-workbench` must be root-owned and not group/other-writable, and host `node`
and `/usr/bin/setpriv` must exist):

    sudo bash /opt/project-workbench/workspaces/ProjectWorkbench/deploy/host/install.sh
    systemctl status pw-promote.path

Or just the promote pieces:

    R=/opt/project-workbench/workspaces/ProjectWorkbench
    sudo install -m 0755 -o root -g root $R/deploy/promote-app.sh /usr/local/sbin/pw-promote-app
    sudo install -m 0755 -o root -g root $R/deploy/host/files/usr/local/sbin/pw-promote-runner /usr/local/sbin/pw-promote-runner
    sudo install -d -m 0700 -o root -g root /etc/project-workbench/promote /etc/project-workbench/promote/requests /etc/project-workbench/promote/queue
    sudo install -m 0644 $R/deploy/host/files/etc/systemd/system/pw-promote.path $R/deploy/host/files/etc/systemd/system/pw-promote.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now pw-promote.path

The runner's own output is in `journalctl -u pw-promote.service`; each request's dry-run and
promote logs are in its spool directory and in the Settings card.
