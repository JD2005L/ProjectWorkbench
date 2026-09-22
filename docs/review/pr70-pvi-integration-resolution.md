# PR #70 PVI integration resolution gate

## Scope

This handoff records what remains before the contained deployment service in PR #70 can be integrated into canonical ProjectWorkbench and adopted by the PVI Workbench deployment.

Evidence is pinned to:

- Canonical `main`: `cfe0689f976b99dddaeda389af8eb7cb0cc1c756`
- PR #70 head: `2527db958517e2a7230779d460632be5f5daed09`
- PR merge base: `0fd2243539946b2d5e6b9d1d1422ab0ef1993a81`
- Current PVI host-mode deployment: `cfe0689f976b99dddaeda389af8eb7cb0cc1c756`, release `1.26.0921.2221`

The PVI deployment is now byte-for-byte aligned with canonical `main`. This document does not authorize activation of a contained deployment backend or any production application cutover.

## Blocking items for PR #70

### 1. Reconcile current canonical main

GitHub currently reports PR #70 as `CONFLICTING` / `DIRTY`. The conflict surface includes `app/server.js` and `DEVELOPMENT-COORDINATION.md`.

Resolve against current `main` without losing the per-person GitHub CLI authorization and persistent GitHub CLI installation work added after the PR's last common base. In particular, preserve:

- per-user `GH_CONFIG_DIR` isolation;
- privilege-dropped token capture through the credential helper;
- ambient GitHub token stripping before `gh auth token` is read;
- target-user authorization and project filtering;
- the current host/container readiness behavior and documentation.

After reconciliation, publish a new exact head and rerun both host and container GitHub checks on that head.

### 2. Bind acceptance to the exact final packaged image

The accepted native-service evidence cited in PR #70 is associated with the earlier `dc46f073...` source/image artifact. Changes after that artifact modify packaged runtime inputs, including:

- `app/VERSION`
- `app/deployment/pw.js`
- `app/deployment/routes.js`
- `app/deployment/settings.js`

Build the final reconciled head, publish its immutable image digest, and run the accepted lifecycle against that exact digest. Evidence from an older image is useful diagnostic history but cannot establish release acceptance for the amended head.

### 3. Complete the signed-in ProjectWorkbench slot canary

The PR handoff explicitly leaves one gate open: a disposable canary launched through an actual authenticated PW slot after the normal PW update.

The canary must prove the real browser-to-PW-to-contained-service path, not only direct service jobs or isolated route fixtures:

1. Save the contained connection as an administrator while global routing remains `LOCAL`.
2. Assign only a disposable managed slot.
3. Execute the repository-managed recipe through that signed-in slot.
4. Verify build, activation, version/health acceptance, cancellation, independent deadline behavior, controller stop/start recovery, and failed-health rollback.
5. Verify existing application slots, mappings and runtime state are unchanged.
6. Return the disposable slot to `LOCAL` and confirm no backend remains selected unintentionally.

### 4. Commission the PVI target deliberately

Neither pvi2 nor CT2115 currently provides the Podman/Quadlet service boundary, dedicated deployment identities, installed connector units, or operator-owned policy required by this feature. Do not infer target readiness from source or CI.

Before PVI activation, record and verify:

- selected deployment-service host;
- Podman and Quadlet versions;
- builder/runtime Unix identities and subordinate-ID ranges;
- user manager/linger state;
- fixed SSH connector identities and fingerprints;
- installed unit names and immutable release path;
- configuration/policy paths and ownership/modes;
- private proxy/auth route;
- backup, restore and rollback procedure.

Keep `PW_DEPLOY_MODE=host`, global destination `LOCAL`, and all existing slots unchanged until this commissioning and the signed-in canary are accepted.

## Required completion report

GOA should update PR #70 with:

1. the reconciled exact head and merge base;
2. green host/container checks for that head;
3. final image digest built from that head;
4. unskipped exact-image lifecycle evidence;
5. signed-in PW disposable-slot canary evidence;
6. target commissioning identities and rollback evidence;
7. an independent exact-head review verdict;
8. explicit confirmation that production application activation remains separately authorized.

## Non-blocking repository note

PR #69 is independent of this feature. It remains a small mergeable hardening fix for creating a private backup in a non-writable public directory and should be assessed/landed separately rather than folded into PR #70 conflict resolution.
