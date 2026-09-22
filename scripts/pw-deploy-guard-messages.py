#!/usr/bin/env python3
"""Reword the abort messages in Deploy Centre slot scripts.

Every slot script in /etc/project-workbench/deploy-config.json hand-rolls its own
preflight guards, and the messages they print were written for whoever wrote the
script. On 2026-09-22 two people burned half an hour on
"ERROR: Uncommitted changes; wait for the PW task to finish and commit." — read as
"the ProjectWorkbench project is blocking this", when it meant "this project's own
workspace has uncommitted files". The state was right; the sentence was not.

`report`/`apply` rewrite the known guards so each one says three things: what is
wrong, the specific detail (which files, which branch, which commits), and what the
person clicking Deploy has to do next. Those two modes change MESSAGES ONLY — never
a condition, an exit code, or an order of operations.

`report-gates`/`add-gates` are the other half, and they DO change behaviour: most
slots here never check what they are about to publish, so these add the missing
clean-tree / publish-branch / pushed preflight to the slots that lack it. A slot
that already makes a check keeps its own; `--only dirty,pushed` narrows the set.
Deploys that succeed today with a dirty or unmerged workspace will start failing —
that is the point, but it is worth saying out loud before running it.

Run on the workbench host as root; the config is 0600 root:

    sudo python3 /opt/project-workbench/workspaces/ProjectWorkbench/scripts/pw-deploy-guard-messages.py report
    sudo python3 /opt/project-workbench/workspaces/ProjectWorkbench/scripts/pw-deploy-guard-messages.py apply

`report` changes nothing. It lists which guards each slot carries, and — the point
of running it first — every OTHER abort site no rule here covers yet, so the
remaining ones can be added deliberately rather than guessed at.

`apply` backs the config up beside itself, runs `bash -n` over each rewritten
script and refuses to write a slot that no longer parses, then replaces the file
atomically. The dashboard re-reads the config per deploy, so no restart is needed.
"""

import argparse
import datetime
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

DEFAULT_CONFIG = '/etc/project-workbench/deploy-config.json'

# PW injects DEPLOY_PROJECT, DEPLOY_TARGET and DEPLOY_USER into every slot script
# (app/server.js, the deploy route's executionEnv), so a message can name the
# project and the account without the script tracking either itself. The `:-`
# defaults matter: these scripts run under `set -u`, and a message that crashes
# the shell is worse than the message it replaced.
RULES = [
    {
        'id': 'dirty-workspace',
        'old': '[ -z "$dirty" ] || { echo "ERROR: Uncommitted changes; wait for the PW task to finish and commit." >&2; exit 1; }',
        'new': [
            'if [ -n "$dirty" ]; then',
            '  {',
            '    echo "DEPLOY BLOCKED - the ${DEPLOY_PROJECT:-project} workspace has uncommitted changes, so there is no committed version to deploy. Nothing was published."',
            '    echo "Not yet committed:"',
            '    printf \'%s\\n\' "$dirty" | sed \'s/^/    /\'',
            '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, have the agent commit and push this work (or discard it), then deploy again."',
            '  } >&2',
            '  exit 1',
            'fi',
        ],
    },
    {
        'id': 'wrong-branch',
        'old': '[ "$(git branch --show-current)" = main ] || { echo "ERROR: Finish/merge work and select main before deploying." >&2; exit 1; }',
        'new': [
            '_pw_branch=$(git branch --show-current)',
            'if [ "$_pw_branch" != main ]; then',
            '  {',
            '    echo "DEPLOY BLOCKED - the ${DEPLOY_PROJECT:-project} workspace is on branch \'$_pw_branch\', and a deploy publishes main. Nothing was published."',
            '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, merge that branch into main (or switch the workspace to main), then deploy again."',
            '  } >&2',
            '  exit 1',
            'fi',
        ],
    },
    {
        'id': 'unpushed-commits',
        'old': '[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "ERROR: Local main has unpublished commits; push them first." >&2; exit 1; }',
        'new': [
            'if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then',
            '  {',
            '    echo "DEPLOY BLOCKED - ${DEPLOY_PROJECT:-this project} has commits on main that were never pushed, and a deployed build has to be reproducible from the repository. Nothing was published."',
            '    echo "Not yet pushed:"',
            '    git log --oneline origin/main..HEAD | sed \'s/^/    /\'',
            '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, push main to the remote, then deploy again."',
            '  } >&2',
            '  exit 1',
            'fi',
        ],
    },
    # The launcher slots check that the repository actually carries the script
    # they are about to exec. "missing in $WS" told the operator a path, not a
    # remedy, and the remedy is in a different place entirely (the project's repo).
    {
        'id': 'missing-deploy-script-dev',
        'old': '[ -f deploy-dev.sh ] || { echo "ERROR: deploy-dev.sh missing in $WS" >&2; exit 1; }',
        'new': [
            'if [ ! -f deploy-dev.sh ]; then',
            '  {',
            '    echo "DEPLOY BLOCKED - ${DEPLOY_PROJECT:-this project} has no deploy-dev.sh at the top of its repository ($WS), so there is nothing to run. Nothing was published."',
            '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, have the agent add or restore deploy-dev.sh on main and push it, then deploy again."',
            '  } >&2',
            '  exit 1',
            'fi',
        ],
    },
    {
        'id': 'missing-deploy-script-prod',
        'old': '[ -f deploy-prod.sh ] || { echo "ERROR: deploy-prod.sh missing in $WS" >&2; exit 1; }',
        'new': [
            'if [ ! -f deploy-prod.sh ]; then',
            '  {',
            '    echo "DEPLOY BLOCKED - ${DEPLOY_PROJECT:-this project} has no deploy-prod.sh at the top of its repository ($WS), so there is nothing to run. Nothing was published."',
            '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, have the agent add or restore deploy-prod.sh on main and push it, then deploy again."',
            '  } >&2',
            '  exit 1',
            'fi',
        ],
    },
    # The app server's own words, relayed. The remote message is the useful part,
    # so this only makes clear WHO is speaking — no invented remedy, because a
    # WinRM/PowerShell failure can be anything from a locked DLL to a bad path.
    {
        'id': 'remote-command-failed',
        'old': 'print(f"ERROR: {result.std_err.decode()}", file=sys.stderr)',
        'new': [
            'print(f"DEPLOY FAILED - the app server rejected a remote command. It said: {result.std_err.decode()}", file=sys.stderr)',
        ],
    },
    # PowerShell, inside a doubled-brace payload template: the braces must stay
    # doubled, and the text must contain no apostrophe (single-quoted PS string).
    {
        'id': 'worker-still-running',
        'old': "if ($w) {{ Write-Error 'Worker still running after pool stop; DLLs may be locked.'; exit 1 }}",
        'new': [
            "if ($w) {{ Write-Error 'DEPLOY BLOCKED - the app pool worker is still running after the stop request, so the site DLLs are locked and cannot be replaced. Nothing was published. NEEDED: an admin has to stop this app pool in IIS Manager on the server (or end its w3wp process), then deploy again.'; exit 1 }}",
        ],
    },
    {
        'id': 'pool-restart-on-abort',
        'old': 'echo "Deploy aborted \u2014 restarting app pool to restore service\u2026" >&2',
        'new': [
            'echo "DEPLOY ABORTED - restarting the app pool so the previous build keeps serving." >&2',
        ],
    },
    {
        'id': 'copy-failures',
        'old': 'echo "ERROR: some files failed to copy:" >&2',
        'new': [
            'echo "DEPLOY FAILED - some files could not be copied to the app server, so the site is still running its previous build." >&2',
            'echo "Files that did not copy:" >&2',
        ],
    },
    {
        # Paired with copy-failures: the remedy belongs AFTER the file list.
        'id': 'copy-failures-remedy',
        'old': 'cat "$FAIL_LIST" >&2',
        'new': [
            'cat "$FAIL_LIST" >&2',
            'echo "NEEDED: a file held open on the server usually copies on a second attempt. If the same files keep failing, an admin has to stop the app pool (or release the file) on the server, then deploy again." >&2',
        ],
    },
    {
        # Message-only: this echo sits inside the script's own if/fi, and the
        # condition is not this tool's business.
        'id': 'missing-deploy-password',
        'old': 'echo "ERROR: DEPLOY_PASSWORD not set. Store it in Settings > Users or enter when prompted." >&2',
        'new': [
            'echo "DEPLOY BLOCKED - PW supplied no password for the deploy account ${DEPLOY_USER:-(none selected)}, so the app server cannot be reached. Nothing was published." >&2',
            'echo "NEEDED: save that account\'s password in PW under Settings > Users (your own row), or enter it when PW prompts for it, then deploy again." >&2',
        ],
    },
]

# ─── Gate insertion (`report-gates` / `add-gates`) ──────────────────────────
#
# Most slots on this instance never check what they are about to publish: of 23,
# only four (AITDataHub, SponsorPortal) refuse a dirty workspace, a non-publish
# branch or unpushed commits. The rest will deploy whatever happens to be sitting
# in the workspace, which is how a half-finished agent task reaches an app server.
#
# THE BRANCH IS NOT ALWAYS `main`. Four of the projects that need gates
# (AIT-Interpreter-Tracker, AITCtrl, Bi-Tools, MySTNAdmin) are on `master` with no
# origin/main at all, so a hardcoded `= main` gate would block every one of their
# deploys forever. The block resolves the branch the clone itself publishes —
# origin/HEAD, else the current branch's upstream, else main.
#
# Every git call is `git -C "$_pw_ws" -c safe.directory="$_pw_ws"`, because these
# slots run as the pane account against a tree that has had root-owned drift
# before, and one `dubious ownership` refusal must not read as "nothing to deploy".
GATE_MARKER = '# --- PW preflight (added by pw-deploy-guard-messages.py) ---'
GATE_NAMES = ('dirty', 'branch', 'pushed')

GATE_HEADER = [
    GATE_MARKER,
    '_pw_ws={WS}',
    '_pw_git() { git -C "$_pw_ws" -c safe.directory="$_pw_ws" "$@"; }',
    '_pw_publish=$(_pw_git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)',
    '_pw_publish=${_pw_publish#origin/}',
    'if [ -z "$_pw_publish" ]; then',
    '  _pw_publish=$(_pw_git rev-parse --abbrev-ref --symbolic-full-name \'@{upstream}\' 2>/dev/null || true)',
    '  _pw_publish=${_pw_publish#origin/}',
    'fi',
    ': "${_pw_publish:=main}"',
]

GATE_BODY = {
    'dirty': [
        # The PW Files tray (_inbox) and the agent's hand-off tray (_outbox) are
        # workbench scaffolding, not project source, and half the projects here do
        # not gitignore them. Counting them would mean one dropped screenshot
        # blocks every deploy with `?? _inbox/` — the same unreadable failure this
        # whole exercise started from. Real changes still surface: the exclusion is
        # a pathspec, not a blanket -uno.
        '_pw_dirty=$(_pw_git status --porcelain -- . \':(exclude)_inbox\' \':(exclude)_inbox/*\' \':(exclude)_outbox\' \':(exclude)_outbox/*\')',
        'if [ -n "$_pw_dirty" ]; then',
        '  {',
        '    echo "DEPLOY BLOCKED - the ${DEPLOY_PROJECT:-project} workspace has uncommitted changes, so there is no committed version to deploy. Nothing was published."',
        '    echo "Not yet committed:"',
        '    printf \'%s\\n\' "$_pw_dirty" | sed \'s/^/    /\'',
        '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, have the agent commit and push this work (or discard it), then deploy again."',
        '  } >&2',
        '  exit 1',
        'fi',
    ],
    'branch': [
        '_pw_branch=$(_pw_git branch --show-current)',
        'if [ "$_pw_branch" != "$_pw_publish" ]; then',
        '  {',
        '    echo "DEPLOY BLOCKED - the ${DEPLOY_PROJECT:-project} workspace is on branch \'$_pw_branch\', and this project publishes \'$_pw_publish\'. Nothing was published."',
        '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, merge that branch into $_pw_publish (or switch the workspace to it), then deploy again."',
        '  } >&2',
        '  exit 1',
        'fi',
    ],
    'pushed': [
        'if ! _pw_git fetch --quiet origin; then',
        '  echo "DEPLOY BLOCKED - could not reach the remote, so the pushed commit cannot be verified. Nothing was published." >&2',
        '  echo "NEEDED: restore repository access, then deploy again." >&2',
        '  exit 1',
        'fi',
        'if [ "$(_pw_git rev-parse HEAD)" != "$(_pw_git rev-parse "origin/$_pw_publish")" ]; then',
        '  {',
        '    echo "DEPLOY BLOCKED - ${DEPLOY_PROJECT:-this project} has commits on $_pw_publish that are not on the remote, and a deployed build has to be reproducible from the repository. Nothing was published."',
        '    echo "Not yet pushed:"',
        '    _pw_git log --oneline "origin/$_pw_publish"..HEAD | sed \'s/^/    /\'',
        '    echo "NEEDED: in the ${DEPLOY_PROJECT:-project} terminal, push $_pw_publish to the remote, then deploy again."',
        '  } >&2',
        '  exit 1',
        'fi',
    ],
}
GATE_FOOTER = ['# --- end PW preflight ---']

# What already counts as that gate, however it is worded: the condition, not the
# message. A slot that hand-rolls its own clean-tree check keeps it.
ALREADY = {
    'dirty': ('status --porcelain',),
    'branch': ('branch --show-current',),
    'pushed': ('rev-parse HEAD',),
}

CD_TO_VAR = re.compile(r'^\s*cd\s+"\$(\w+)"\s*$')
WS_ASSIGN = re.compile(r'^\s*(WS|WORKSPACE|SCRIPT_DIR|PROJECT_DIR)=(?!\s*$)\S+\s*$')


def plan_gates(script, wanted):
    """Which gates this slot is missing, and where they can go.

    Returns (index, ws_expr, missing, skip_reason). The anchor is deliberately
    conservative: a `cd "$VAR"` line means the script has already put itself in
    the workspace, so the gates go straight after it; otherwise the first
    workspace-path assignment is used and the gates address it by path. Anything
    else is skipped WITH A REASON rather than guessed at — a wrong insertion here
    lands in a production deploy."""
    if GATE_MARKER in script:
        return None, None, [], 'already carries the PW preflight'
    missing = [name for name in wanted if not any(token in script for token in ALREADY[name])]
    if not missing:
        return None, None, [], 'already checks all of these itself'
    lines = script.split('\n')
    for index in range(len(lines) - 1, -1, -1):
        if CD_TO_VAR.match(lines[index]):
            return index + 1, '"$PWD"', missing, None
    for index, line in enumerate(lines):
        if WS_ASSIGN.match(line):
            return index + 1, '"$' + line.strip().split('=')[0] + '"', missing, None
    return None, None, missing, 'no workspace anchor (no `cd "$VAR"` and no WS=/SCRIPT_DIR= line)'


def gate_lines(ws_expr, missing, indent):
    body = list(GATE_HEADER)
    for name in GATE_NAMES:
        if name in missing:
            body.extend(GATE_BODY[name])
    body.extend(GATE_FOOTER)
    return [(indent + line.replace('{WS}', ws_expr) if line else '') for line in body]


def insert_gates(script, wanted):
    index, ws_expr, missing, reason = plan_gates(script, wanted)
    if index is None:
        return script, [], reason
    lines = script.split('\n')
    indent = lines[index - 1][:len(lines[index - 1]) - len(lines[index - 1].lstrip())]
    return '\n'.join(lines[:index] + gate_lines(ws_expr, missing, indent) + lines[index:]), missing, None


# An abort site worth reporting: it stops the deploy, or it writes to stderr.
ABORT_HINT = re.compile(r'(^|[;&|\s])exit\s+1\b|>&2|ERROR:|DEPLOY BLOCKED')
# A bare `exit 1` (or a lone brace) is control flow, not a message: reporting it
# as a raw abort site just buried the lines that actually needed rewording.
CONTROL_ONLY = re.compile(r'^(exit\s+1;?|\}|\};?|fi;?|\)|done)$')
# Keep a literal credential out of the report, if a slot ever grows one.
SECRETISH = re.compile(r'((?:password|passwd|secret|token|apikey|api_key)\s*=\s*)([\'"]?)(?!\$)(\S+)', re.I)


def rewrite(script):
    """Return (new_script, applied_rule_ids). Matching is per line and ignores the
    line's own indentation, so a guard nested inside an if/case is still found and
    the replacement is re-indented to sit where the original sat."""
    applied, out = [], []
    for line in script.split('\n'):
        stripped = line.strip()
        indent = line[:len(line) - len(line.lstrip())]
        for rule in RULES:
            if stripped == rule['old']:
                out.extend(indent + new_line if new_line else '' for new_line in rule['new'])
                applied.append(rule['id'])
                break
        else:
            out.append(line)
    return '\n'.join(out), applied


def slots(config):
    for project in sorted(config):
        targets = config[project]
        if not isinstance(targets, dict):
            continue
        for target in sorted(targets):
            slot = targets[target]
            if isinstance(slot, dict) and isinstance(slot.get('script'), str):
                yield project, target, slot


def bash_syntax_ok(script):
    with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as handle:
        handle.write(script)
        path = handle.name
    try:
        result = subprocess.run(['bash', '-n', path], capture_output=True, text=True)
        return result.returncode == 0, (result.stderr or '').strip()
    finally:
        os.unlink(path)


def report(config):
    unmatched_total = 0
    for project, target, slot in slots(config):
        _, applied = rewrite(slot['script'])
        covered = {rule['old'] for rule in RULES if rule['id'] in applied}
        leftover = [
            SECRETISH.sub(lambda m: m.group(1) + m.group(2) + '<redacted>', line.strip())
            for line in slot['script'].split('\n')
            if ABORT_HINT.search(line) and line.strip() not in covered
            and not CONTROL_ONLY.match(line.strip())
        ]
        unmatched_total += len(leftover)
        print(f'### {project}/{target}  ({len(slot["script"].splitlines())} lines)')
        print(f'    reworded by this tool: {", ".join(applied) if applied else "nothing"}')
        for line in leftover:
            print(f'    STILL RAW: {line[:220]}')
    print(f'\n{unmatched_total} abort site(s) no rule covers yet.')


def report_gates(config, wanted):
    """What add-gates would do, slot by slot, changing nothing."""
    for project, target, slot in slots(config):
        _, ws_expr, missing, reason = plan_gates(slot['script'], wanted)
        if reason:
            print(f'{project}/{target}: skipped - {reason}')
        else:
            print(f'{project}/{target}: would add {", ".join(missing)} (addressing the workspace as {ws_expr})')


def transform(config, path, assume_yes, mutate, nothing_to_do):
    changed, refused = [], []
    for project, target, slot in slots(config):
        new_script, note, reason = mutate(slot['script'])
        if new_script == slot['script']:
            if reason:
                print(f'skipped {project}/{target}: {reason}')
            continue
        ok, error = bash_syntax_ok(new_script)
        if not ok:
            refused.append((project, target, error))
            continue
        diff = difflib.unified_diff(
            slot['script'].split('\n'), new_script.split('\n'),
            fromfile=f'{project}/{target} (before)', tofile=f'{project}/{target} (after)', lineterm='',
        )
        print('\n'.join(diff))
        print()
        slot['script'] = new_script
        changed.append(f'{project}/{target}: {", ".join(note)}')

    for project, target, error in refused:
        print(f'REFUSED {project}/{target}: rewritten script fails bash -n ({error})', file=sys.stderr)
    if not changed:
        print(nothing_to_do)
        return 1 if refused else 0

    print('About to rewrite:')
    for line in changed:
        print(f'  {line}')
    if not assume_yes:
        answer = input('Write these changes? [y/N] ').strip().lower()
        if answer not in ('y', 'yes'):
            print('Nothing written.')
            return 1

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = f'{path}.bak-guardmsg-{stamp}'
    shutil.copy2(path, backup)
    # Same shape saveDeployConfig() writes, so a later UI save produces no
    # gratuitous whitespace diff, and same 0600 the config already carries.
    directory = os.path.dirname(path) or '.'
    with tempfile.NamedTemporaryFile('w', dir=directory, delete=False) as handle:
        handle.write(json.dumps(config, indent=2, ensure_ascii=False) + '\n')
        temp = handle.name
    shutil.copymode(path, temp)
    os.replace(temp, path)
    print(f'\nWrote {path} (backup: {backup}).')
    print('The dashboard reads this file per deploy, so no restart is needed.')
    return 1 if refused else 0


def apply(config, path, assume_yes):
    return transform(
        config, path, assume_yes,
        lambda script: (*rewrite(script), None),
        'No slot needed rewording (already done, or none of the known guards are present).',
    )


def add_gates(config, path, assume_yes, wanted):
    return transform(
        config, path, assume_yes,
        lambda script: insert_gates(script, wanted),
        'No slot needed gates (every one already checks these, or none has a usable anchor).',
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['report', 'apply', 'report-gates', 'add-gates'])
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    parser.add_argument('--yes', action='store_true', help='skip the confirmation prompt')
    parser.add_argument('--only', default=','.join(GATE_NAMES),
                        help=f'gates to add, comma separated, from {",".join(GATE_NAMES)} (default: all three)')
    args = parser.parse_args()
    wanted = [name.strip() for name in args.only.split(',') if name.strip()]
    unknown = [name for name in wanted if name not in GATE_NAMES]
    if unknown:
        print(f'Unknown gate(s): {", ".join(unknown)}. Choose from {", ".join(GATE_NAMES)}.', file=sys.stderr)
        return 2

    try:
        with open(args.config) as handle:
            config = json.load(handle)
    except PermissionError:
        print(f'{args.config} is root-only; re-run with sudo.', file=sys.stderr)
        return 2
    except FileNotFoundError:
        print(f'No deploy config at {args.config}.', file=sys.stderr)
        return 2

    if args.mode == 'report':
        report(config)
        return 0
    if args.mode == 'report-gates':
        report_gates(config, wanted)
        return 0
    if args.mode == 'add-gates':
        return add_gates(config, args.config, args.yes, wanted)
    return apply(config, args.config, args.yes)


if __name__ == '__main__':
    sys.exit(main())
