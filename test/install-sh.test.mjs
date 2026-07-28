// The installer aborts partway through when it references an undefined variable.
//
// Regression: install.sh runs under `set -euo pipefail`, and the block that
// copies bin/ (the stdio MCP adapter documented in docs/orchestrator-api.md)
// used $INSTALL_DIR — a name that is never assigned anywhere. Under `set -u`
// that is a fatal error, so any install whose source tree contains bin/ died
// after copying the app but before configuring anything. Only PW_INSTALL_DIR
// exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const installShPath = fileURLToPath(new URL('../install.sh', import.meta.url));
const src = fs.readFileSync(installShPath, 'utf8');

test('install.sh is syntactically valid', async () => {
  await execFileAsync('bash', ['-n', installShPath]);
});

test('install.sh still runs under set -u, which is what makes this fatal', () => {
  assert.match(src, /^set -euo pipefail$/m);
});

test('REGRESSION: no undefined *INSTALL_DIR variable is referenced', () => {
  const referenced = [...src.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]);
  const offenders = [...new Set(referenced.filter((n) => n.endsWith('INSTALL_DIR') && n !== 'PW_INSTALL_DIR'))];
  assert.deepEqual(offenders, [], `install.sh references undefined variable(s): ${offenders.join(', ')}`);
});

test('every variable the installer expands is assigned or is a documented input', () => {
  const assigned = new Set([...src.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]));
  // Shell builtins / positional-ish names that are always defined.
  const builtin = new Set(['0', '1', '2', '@', '*', '#', '?', '$', 'HOME', 'PATH', 'USER', 'PWD', 'SHELL', 'UID', 'EUID', 'RANDOM', 'LINENO', 'BASH_SOURCE', 'FUNCNAME', 'IFS', 'PS1', 'LANG', 'LC_ALL', 'TERM', 'SUDO_USER']);
  const referenced = [...new Set([...src.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]))];
  const unresolved = referenced.filter((n) => !assigned.has(n) && !builtin.has(n) && n.startsWith('PW_') === false && n.endsWith('_DIR'));
  assert.deepEqual(unresolved, [], `unassigned *_DIR variables: ${unresolved.join(', ')}`);
});

test('the bin/ copy targets PW_INSTALL_DIR', () => {
  const block = src.match(/if \[ -d "\$SRC_DIR\/bin" \];[\s\S]*?\nfi/);
  assert.ok(block, 'the bin/ copy block should still exist');
  assert.ok(block[0].includes('"$PW_INSTALL_DIR/bin"'));
  assert.ok(!/\$\{?INSTALL_DIR/.test(block[0]));
});
