# CI results back to the session that made the commit

When a GitHub Actions run finishes, pass or fail, its result is routed back to the ProjectWorkbench Claude window whose commit triggered it. The session that already has the context can then fix the failure and push again by itself.

```
PW Claude window ──commit (signed: PW-Session: <instance>/<tmux session>/<window>)──▶ GitHub
GitHub App (workflow_run: completed) ──▶ n8n "PW_GitHubCIResults" ──▶ POST /api/ci/github on each PW instance
PW: verify GitHub's signature ▸ find the window ▸ wait until it is idle with an empty composer ▸ paste a fixed-format status
```

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
   - Optionally set `PW_INSTANCE_ID` in both places to the same short name. Otherwise both use the hostname.
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
  - A signature must name a window in the project whose registered repository is the run's repository. Otherwise it escalates rather than delivering.
  - Delivery waits until the window's Claude has finished its turn, its foreground is Claude (not a shell), and its composer is empty. Somebody's half-typed message is never submitted. Claude's dim suggestion text does not count as typing.
  - A hibernated window is woken first.
- **Repeats:**
  - A newer result for the same window, repo, branch and workflow replaces one not yet delivered.
  - After **3** consecutive failures in a lane, PW stops delivering and escalates. A pass resets the count.
- **Escalation:** if the window is gone, the repository is wrong, the retry cap is hit, or it waits more than 24 hours, PW lights the project in the dashboard (its pending marker) and records the reason in the audit log (`ci_result_escalated`) and the service log. When the Paperclip AI org's intake is wired, escalations will go there as well.
- **Deploy approvals:** none change. A passing run only reports.

## Turning it off

Remove `PW_CI_RESULTS=on` from either place: the drop-in stops receiving, and the wrapper stops signing for Claude sessions started afterwards. To stop at the source, uninstall the GitHub App or deactivate the n8n workflow.
