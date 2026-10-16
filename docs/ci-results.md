# CI results back to the session that made the commit

When a GitHub Actions run finishes, pass or fail, its result is routed back to the ProjectWorkbench Claude window whose commit triggered it. The session that already has the context can then fix the failure and push again by itself.

```
PW Claude window ──commit──▶ GitHub          (the git hook records <sha> <window> <pane> in a local ledger,
                                              and labels the commit PW-Session: <instance>/<session>/<window>)
GitHub App (workflow_run: completed) ──▶ n8n "PW_GitHubCIResults" ──▶ POST /api/ci/github on each PW instance
PW: verify GitHub's signature ▸ look the head SHA up in ITS OWN ledger ▸ same window, same pane?
    ▸ wait until Claude is idle with an empty composer ▸ paste a fixed-format status
```

**The ledger decides, never the commit message.** A run is delivered only if its exact head SHA was recorded by this instance's git hook, and only to the window and pane that recorded it. The `PW-Session` trailer is a visible label and nothing more. A commit message is text anyone can write, including a fork's pull request, which could copy a real trailer from a public repo's history. The ledger records what this machine saw its own sessions do.

Nothing is needed in any repository. No workflow edits are required, and repos created later are covered automatically.

## Off by default, everywhere

Two switches turn this on, and an instance gets neither by upgrading. **GOA pulls the same code and stays exactly as it was:** commits are not signed, the route answers 404, and nothing runs.

| Switch | Where | Effect |
|---|---|---|
| `PW_CI_RESULTS=on` | `/etc/project-workbench/claude-wrapper.env` | Claude's git uses PW's hook directory, so its commits are signed. Applies to Claude sessions started after the change (a hibernation resume counts). |
| `PW_CI_RESULTS=on` | dashboard environment (systemd drop-in), plus the secret file below | Opens `POST /api/ci/github` and the delivery sweep. |

## Setting it up (once per instance)

1. **Webhook secret.** Generate a random secret and save it root-only:
   ```
   sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/project-workbench/github-webhook-secret'
   ```
   The same value goes into the GitHub App (step 3).
2. **Switch it on.**
   - Add `PW_CI_RESULTS=on` to `/etc/project-workbench/claude-wrapper.env`. Dashboard Settings saves keep it.
   - Add `Environment=PW_CI_RESULTS=on` to a drop-in, for example `/etc/systemd/system/project-workbench.service.d/ci-results.conf`.
   - Set `PW_INSTANCE_ID` in both places to the same short name (for example `pvi2`). Otherwise both use the hostname. That works, but the name shows on every commit trailer.
   - Run `daemon-reload` and restart `project-workbench`.
3. **GitHub App** (one per GitHub account; JD2005L is a personal account, so there is no org-wide webhook):
   1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   2. Name it, for example "ProjectWorkbench CI results". The homepage URL can be anything.
   3. **Webhook:** set it active, with URL `https://hooks.provisioni.ca/webhook/pw-github-ci-results` and the secret from step 1.
   4. **Permissions:** Repository → Actions: *Read-only*. Metadata (read) is added automatically.
   5. **Subscribe to events:** *Workflow run*.
   6. **Where can this app be installed:** *Only on this account*.
   7. Create it, then use *Install App* → JD2005L → **All repositories**.

   The app needs no private key; PW never calls GitHub as the app.
4. **n8n.** Import `config/n8n/pw-github-ci-results.workflow.json` and activate it.
   - The Webhook node must keep its *Raw Body* option on, because PW verifies GitHub's signature over the exact bytes.
   - Add one line to `TARGETS` in the Code node for each PW instance.
   - n8n verifies nothing and needs no PW credential. A relay that changed or invented a result would fail PW's signature check.

## What a session receives

The session receives a status built only from validated fields: repo, workflow name, branch, short SHA, conclusion and run link. Commit messages and logs are never pasted. For example:

```
[PW CI] Run FAILED (failure) — JD2005L/TryggbuiltPortal · workflow "deploy" · branch main · commit a1b2c3d. Run: https://github.com/…
This is an automated CI status from ProjectWorkbench, not a message from James. A commit signed by this window triggered it.
If this change is still yours: inspect it with `gh run view <id> --repo <repo> --log-failed`, fix the cause, and push again.
Automatic retry 1 of 3; if it fails again after that, it stops coming here and goes to James.
```

A passing run gets a one-line "Run passed … nothing is needed unless you were waiting on this run." Cancelled, skipped and neutral runs are not reported.

## Safeguards

- **The results:** only bodies that verify against the webhook secret are accepted, and redeliveries are ignored. A run signed for another instance is ignored.
- **Deliveries:**
  - Only runs a commit caused are reported: a `push`, or a pull request from a branch of the *same* repository. Fork pull requests, schedules and manual dispatches are ignored.
  - The head SHA must be in this instance's ledger. The ledger's window must belong to the project whose registered repository is the run's repository, and it must still have the same pane process; tmux reuses window ids after a restart. Otherwise the result escalates rather than being delivered.
  - Delivery waits until all of these are true:
    - the window's Claude has finished its turn;
    - the screen shows no "esc to interrupt";
    - its foreground is Claude, not a shell;
    - its composer is empty.

    Somebody's half-typed message, or a pasted-text or image placeholder, is never submitted. Claude's dim suggestion text does not count as typing.
  - A hibernated window is woken first.
- **Repeats:**
  - A newer result for the same window, repo, branch and workflow replaces one not yet delivered.
  - After **3** consecutive failures in a lane, PW stops delivering and escalates. A pass resets the count.
- **Escalation:** if the window is gone, the repository is wrong, the retry cap is hit, or it waits more than 24 hours, PW lights the project in the dashboard (its pending marker) and records the reason in the audit log (`ci_result_escalated`) and the service log. When the Paperclip AI org's intake is wired, escalations will go there as well.
- **Deploy approvals:** none change. A passing run only reports.

## Known limits

- **`pre-commit install` refuses to run** inside a Claude session on an opted-in instance, because it sees `core.hooksPath` set. Hooks already installed keep running, since the dispatcher chains to them. Install new ones from a plain terminal.
- **Commits made outside Claude are not reported.** A person typing `git commit` in a shell isn't recorded, and neither is a squash merge done on GitHub, because those commits aren't in the ledger.
- **Only new sessions sign commits.** Sessions started before the wrapper switch was set don't sign theirs; a restart, or a hibernation resume, picks the switch up.

## Turning it off

Remove `PW_CI_RESULTS=on` from either place: the drop-in stops receiving, and the wrapper stops signing for Claude sessions started afterwards. To stop at the source, uninstall the GitHub App or deactivate the n8n workflow.
