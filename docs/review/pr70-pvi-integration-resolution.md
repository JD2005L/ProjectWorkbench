# PR #70 PVI integration resolution record

## Scope

This record separates **canonical merge compatibility** from **contained-backend activation** for PR #70.

Evidence used for the reconciliation:

- Canonical `main` merged through PR #71: `6878edb71e42dc1bac0a3e5cfa3f843ed3aed939`
- PR #70 pre-reconciliation head: `2527db958517e2a7230779d460632be5f5daed09`
- Original PR #70 merge base: `0fd2243539946b2d5e6b9d1d1422ab0ef1993a81`
- Current PVI host-mode deployment before PR #70 release: `cfe0689f976b99dddaeda389af8eb7cb0cc1c756`, release `1.26.0921.2221`

## Canonical merge resolution

The current canonical branch was merged into PR #70 without rewriting its history. The only textual Git conflict was `app/VERSION`; it was resolved with a new forward-moving release identifier.

The automatic merge preserved both sides of the integration:

- PR #70's contained deployment engine, console, SDK, and per-slot backend controls;
- per-person and per-launcher terminal identity;
- per-user `GH_CONFIG_DIR` isolation;
- privilege-dropped GitHub token capture through the credential helper;
- ambient GitHub token stripping before `gh auth token` is read;
- target-user authorization and project filtering;
- persistent GitHub CLI installation/readiness behavior;
- the PR #71 review and operational handoff.

Focused integration verification passed 559 runnable tests with 11 environment-declared skips. The canonical full suite passed 2,080 runnable tests with 17 environment-declared skips. Syntax and diff checks passed.

## Merge-safe activation boundary

Merging this feature does not select or activate a contained backend:

- global routing remains `LOCAL`;
- existing ordinary and managed slots retain their current routing;
- a manifest cannot choose a backend;
- connection drafts remain distinct from active slot routing;
- external failures do not silently fall back to local execution;
- production application activation remains a separate human-authorized operation.

This default-off boundary makes canonical integration safe independently of commissioning a PVI deployment-service host.

## Post-merge contained-backend activation gate

The native service evidence in PR #70 remains valid evidence for the earlier installed `dc46f073...` / `4a722e8b...` artifact. Later PW routing and settings changes do not authorize treating a newly built image as already accepted.

Before any PVI slot is switched from `LOCAL` to the contained backend, complete these operational gates against the exact canonical release image:

1. Build the canonical head and record its immutable image digest.
2. Commission the selected deployment-service host with Podman/Quadlet, dedicated identities, subordinate-ID ranges, user manager/linger, fixed connector fingerprints, installed units, policy/configuration ownership, private proxy/auth, backup, restore, and rollback.
3. Run an authenticated disposable PW slot canary through the actual browser-to-PW-to-contained-service path.
4. Verify dependency build, activation, version/health acceptance, cancellation, independent deadline behavior, controller stop/start recovery, and failed-health rollback.
5. Confirm existing application slots, mappings, workspaces, and runtime state are unchanged.
6. Return the disposable slot to `LOCAL` and verify no unintended external selection remains.

These are **activation gates**, not permission for an unreviewed branch to diverge from canonical main.

## GOA morning handoff

After GitHub reports PR #70 merged and canonical CI is green, GOA should use the ordinary fast-forward workflow:

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
```

GOA should continue from canonical `main`, not from the retired PR #70 feature head. No force-push, history rewrite, private inbox recovery, or manual conflict replay is required.
