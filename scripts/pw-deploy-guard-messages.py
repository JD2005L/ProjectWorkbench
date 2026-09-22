#!/usr/bin/env python3
"""Reword the abort messages in Deploy Centre slot scripts.

Every slot script in /etc/project-workbench/deploy-config.json hand-rolls its own
preflight guards, and the messages they print were written for whoever wrote the
script. On 2026-09-22 two people burned half an hour on
"ERROR: Uncommitted changes; wait for the PW task to finish and commit." — read as
"the ProjectWorkbench project is blocking this", when it meant "this project's own
workspace has uncommitted files". The state was right; the sentence was not.

This rewrites the known guards so each one says three things: what is wrong, the
specific detail (which files, which branch, which commits), and what the person
clicking Deploy has to do next. It changes MESSAGES ONLY — never a condition, an
exit code, or an order of operations.

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

# An abort site worth reporting: it stops the deploy, or it writes to stderr.
ABORT_HINT = re.compile(r'(^|[;&|\s])exit\s+1\b|>&2|ERROR:|DEPLOY BLOCKED')
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
        ]
        unmatched_total += len(leftover)
        print(f'### {project}/{target}  ({len(slot["script"].splitlines())} lines)')
        print(f'    reworded by this tool: {", ".join(applied) if applied else "nothing"}')
        for line in leftover:
            print(f'    STILL RAW: {line[:220]}')
    print(f'\n{unmatched_total} abort site(s) no rule covers yet.')


def apply(config, path, assume_yes):
    changed, refused = [], []
    for project, target, slot in slots(config):
        new_script, applied = rewrite(slot['script'])
        if not applied:
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
        changed.append(f'{project}/{target}: {", ".join(applied)}')

    for project, target, error in refused:
        print(f'REFUSED {project}/{target}: rewritten script fails bash -n ({error})', file=sys.stderr)
    if not changed:
        print('No slot needed rewording (already done, or none of the known guards are present).')
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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['report', 'apply'])
    parser.add_argument('--config', default=DEFAULT_CONFIG)
    parser.add_argument('--yes', action='store_true', help='skip the confirmation prompt')
    args = parser.parse_args()

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
    return apply(config, args.config, args.yes)


if __name__ == '__main__':
    sys.exit(main())
