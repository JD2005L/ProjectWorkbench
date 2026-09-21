// Per-LAUNCHER credentials: a cockpit tab runs on the credentials of the person who
// opened it, not the project owner's.
//
// Why this exists: per-user credentials key a project's terminal to its primaryUser,
// so on a shared project every teammate's Claude and Copilot work is billed to the
// owner's seat — one person's rate limit gates the whole team, and the audit trail
// names the wrong person. Keying a tab to its launcher fixes both.
//
// The contract has three parts, and each is pinned here:
//   1. WHOSE identity  — resolveLauncherCredentialOwner, including the cases that must
//      fall back to the project owner rather than fail or go shared;
//   2. WHAT the pane gets — CLAUDE_CONFIG_DIR *and* COPILOT_HOME, plus the instruction
//      files a per-user dir would otherwise silently lose;
//   3. THAT it is recorded — every window stamps the identity it was created with,
//      because a strip of identical-looking tabs spending different people's seats is
//      exactly what this feature must not produce.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveLauncherCredentialOwner, resolveProjectCredentialOwner } from '../app/project-owner.js';
import {
  applyCredentialJob,
  ensureUserCredentials,
  spawnCredentialJob,
  userClaudeConfigDir,
  userCopilotConfigDir,
  credentialFingerprint,
  SEEDED_COPILOT_FILES,
} from '../app/user-credentials.js';

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const SRC = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

const USERS = [
  { username: 'james.levac', ghToken: 'enc-owner-token' },
  { username: 'kevin.charlebois', ghToken: 'enc-launcher-token' },
  { username: 'no.token' },
];
const decrypt = (v) => (v === 'enc-owner-token' ? 'gho_OWNER' : v === 'enc-launcher-token' ? 'ghp_LAUNCHER' : '');

// ---------------------------------------------------------------------------
// 1. Whose identity
// ---------------------------------------------------------------------------

test('the launcher, not the project owner, is the identity for a tab a person opened', () => {
  const owner = resolveLauncherCredentialOwner({
    perLauncherEnabled: true, username: 'kevin.charlebois', users: USERS, decrypt,
  });
  assert.deepEqual(owner, { username: 'kevin.charlebois', ghToken: 'ghp_LAUNCHER' });
});

test('no launcher identity means "use the project owner", not "use the shared login"', () => {
  // Each of these is a legitimate no-person case. They return null so the caller
  // falls back to the project owner — which is the pre-per-launcher behaviour, NOT
  // the silent shared-login fallback resolveProjectCredentialOwner forbids.
  const cases = [
    ['feature off', { perLauncherEnabled: false, username: 'kevin.charlebois' }],
    ['no username (scheduled task, boot reattach, bot)', { perLauncherEnabled: true, username: '' }],
    ['whitespace-only username', { perLauncherEnabled: true, username: '   ' }],
    ['username with no user record (an unauthenticated instance\'s implicit admin)',
      { perLauncherEnabled: true, username: 'ghost.admin' }],
  ];
  for (const [label, args] of cases) {
    assert.equal(resolveLauncherCredentialOwner({ users: USERS, decrypt, ...args }), null, label);
  }
  // …and the project owner still resolves for those panes.
  assert.deepEqual(
    resolveProjectCredentialOwner({
      perUserEnabled: true, project: { primaryUser: 'james.levac' }, users: USERS, decrypt,
    }),
    { username: 'james.levac', ghToken: 'gho_OWNER' },
  );
});

test('a launcher with no stored GitHub token is NOT an error', () => {
  // They get their own config dir with no GH_TOKEN, so the CLI asks them to sign in.
  // Refusing here would block a new teammate from opening a terminal at all; falling
  // back to the owner would silently spend the owner's seat — the bug being fixed.
  const owner = resolveLauncherCredentialOwner({
    perLauncherEnabled: true, username: 'no.token', users: USERS, decrypt,
  });
  assert.deepEqual(owner, { username: 'no.token', ghToken: '' });
});

test('a corrupt stored token still fails loudly', () => {
  const boom = () => { throw new Error('unsupported state or unable to authenticate data'); };
  assert.throws(() => resolveLauncherCredentialOwner({
    perLauncherEnabled: true, username: 'kevin.charlebois', users: USERS, decrypt: boom,
  }), /authenticate data/);
});

test('two launchers get two different identities, and so two different fingerprints', () => {
  const base = '/tmp/pw-users';
  const a = resolveLauncherCredentialOwner({ perLauncherEnabled: true, username: 'james.levac', users: USERS, decrypt });
  const b = resolveLauncherCredentialOwner({ perLauncherEnabled: true, username: 'kevin.charlebois', users: USERS, decrypt });
  const fp = (o) => credentialFingerprint({ username: o.username, configDir: userClaudeConfigDir(base, o.username), ghToken: o.ghToken });
  assert.notEqual(fp(a), fp(b), 'identical fingerprints would make two people look like one session');
});

// ---------------------------------------------------------------------------
// 2. What the pane gets
// ---------------------------------------------------------------------------

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-per-launcher-'));
  const sharedCopilotHome = path.join(dir, 'shared-copilot');
  fs.mkdirSync(sharedCopilotHome, { recursive: true });
  fs.writeFileSync(path.join(sharedCopilotHome, 'copilot-instructions.md'), '# stay in your workspace\n');
  fs.writeFileSync(path.join(sharedCopilotHome, 'mcp-config.json'), '{"mcpServers":{"teamkb":{}}}\n');
  // Per-person state that must NOT be copied into someone else's dir.
  fs.writeFileSync(path.join(sharedCopilotHome, 'config.json'), '{"token":"shared-login"}\n');
  fs.writeFileSync(path.join(sharedCopilotHome, 'session-store.db'), 'sqlite\n');
  const sharedClaudeMd = path.join(dir, 'shared-CLAUDE.md');
  fs.writeFileSync(sharedClaudeMd, '# Workspace boundary\nStay inside your project.\n');
  return { dir, base: path.join(dir, 'pw-users'), sharedCopilotHome, sharedClaudeMd };
}

test('a per-user dir gets its own COPILOT_HOME, seeded with instructions and MCP', async () => {
  const { dir, base, sharedCopilotHome, sharedClaudeMd } = scratch();
  try {
    const result = await applyCredentialJob({ fsp, base, username: 'kevin.charlebois', sharedCopilotHome, sharedClaudeMd });
    const home = userCopilotConfigDir(base, 'kevin.charlebois');
    assert.equal(result.copilotHome, home, 'the caller needs the path to set COPILOT_HOME');
    assert.equal((await fsp.stat(home)).isDirectory(), true);
    for (const name of SEEDED_COPILOT_FILES) {
      assert.equal(fs.existsSync(path.join(home, name)), true, `${name} must be seeded`);
    }
    // Copilot's instructions are the other live copy of this workbench's standing
    // agent guardrails; an unseeded COPILOT_HOME would silently drop them.
    assert.match(fs.readFileSync(path.join(home, 'copilot-instructions.md'), 'utf8'), /stay in your workspace/);
    // Per-person state is deliberately NOT copied: a shared stored login is exactly
    // what splitting the directory exists to stop.
    assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'a stored login must not be cloned');
    assert.equal(fs.existsSync(path.join(home, 'session-store.db')), false, 'conversation history must not be cloned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLAUDE.md is seeded — a per-user dir must not silently lose the standing instructions', async () => {
  const { dir, base, sharedClaudeMd, sharedCopilotHome } = scratch();
  try {
    await applyCredentialJob({ fsp, base, username: 'kevin.charlebois', sharedClaudeMd, sharedCopilotHome });
    const got = fs.readFileSync(path.join(userClaudeConfigDir(base, 'kevin.charlebois'), 'CLAUDE.md'), 'utf8');
    assert.match(got, /Workspace boundary/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seeding is fill-only: a file the user has edited is never clobbered', async () => {
  const { dir, base, sharedClaudeMd, sharedCopilotHome } = scratch();
  try {
    await applyCredentialJob({ fsp, base, username: 'kevin.charlebois', sharedClaudeMd, sharedCopilotHome });
    const mine = path.join(userClaudeConfigDir(base, 'kevin.charlebois'), 'CLAUDE.md');
    const copilotMine = path.join(userCopilotConfigDir(base, 'kevin.charlebois'), 'copilot-instructions.md');
    await fsp.writeFile(mine, '# my own notes\n');
    await fsp.writeFile(copilotMine, '# my own copilot notes\n');
    await applyCredentialJob({ fsp, base, username: 'kevin.charlebois', sharedClaudeMd, sharedCopilotHome });
    assert.equal(await fsp.readFile(mine, 'utf8'), '# my own notes\n');
    assert.equal(await fsp.readFile(copilotMine, 'utf8'), '# my own copilot notes\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing shared seed source is simply not seeded, never a failure', async () => {
  const { dir, base } = scratch();
  try {
    const result = await applyCredentialJob({
      fsp, base, username: 'kevin.charlebois',
      sharedClaudeMd: path.join(dir, 'does-not-exist.md'),
      sharedCopilotHome: path.join(dir, 'no-such-dir'),
    });
    assert.ok(result.copilotHome, 'the dir is still created so COPILOT_HOME is always set');
    assert.equal(fs.existsSync(path.join(userClaudeConfigDir(base, 'kevin.charlebois'), 'CLAUDE.md')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the privilege-dropped helper forwards the new seed inputs (it ENUMERATES job fields)', async () => {
  // credential-writer.mjs lists the job's fields by hand rather than spreading them,
  // so a new input silently arrives EMPTY in the dropped path — the path that runs in
  // production — while working fine in-process. That trap has bitten this feature
  // before, so the helper is exercised over its real stdin protocol.
  const { dir, base, sharedClaudeMd, sharedCopilotHome } = scratch();
  try {
    const result = await spawnCredentialJob({
      spawn,
      argv: [process.execPath, path.join(APP_DIR, 'credential-writer.mjs')],
      job: { action: 'ensure', base, username: 'over.stdin', sharedClaudeMd, sharedCopilotHome },
    });
    assert.equal(result.copilotHome, userCopilotConfigDir(base, 'over.stdin'));
    assert.equal(fs.existsSync(path.join(userClaudeConfigDir(base, 'over.stdin'), 'CLAUDE.md')), true,
      'sharedClaudeMd must reach the helper');
    assert.equal(fs.existsSync(path.join(result.copilotHome, 'copilot-instructions.md')), true,
      'sharedCopilotHome must reach the helper');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureUserCredentials reports copilotHome, and tolerates an older helper that does not', async () => {
  const { dir, base, sharedCopilotHome, sharedClaudeMd } = scratch();
  try {
    const real = await ensureUserCredentials({ fsp, base, username: 'kevin.charlebois', sharedCopilotHome, sharedClaudeMd });
    assert.equal(real.copilotHome, userCopilotConfigDir(base, 'kevin.charlebois'));

    // A rolling deploy can pair a new dashboard with an older writer. '' (never
    // undefined) is what keeps `COPILOT_HOME=undefined` out of a pane's env.
    const stale = await ensureUserCredentials({
      fsp, base, username: 'kevin.charlebois',
      owner: { uid: 1001, gid: 1001, user: 'admin', source: 'passwd' }, currentUid: 0,
      runJob: async () => ({ configDir: '/x', envFile: '' }),
    });
    assert.equal(stale.copilotHome, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. That it is recorded
//
// These paths need a live tmux server and a privilege drop, so the wiring is pinned
// by source assertion — the same style test/per-user-stale-grandfather.test.mjs uses.
// ---------------------------------------------------------------------------

test('the pane gets COPILOT_HOME alongside CLAUDE_CONFIG_DIR', () => {
  assert.match(SRC, /tokens: \['CLAUDE_CONFIG_DIR=' \+ cred\.configDir, \.\.\.\(cred\.copilotHome \? \['COPILOT_HOME=' \+ cred\.copilotHome\] : \[\]\)\]/,
    'without COPILOT_HOME, per-user tokens still leave everyone sharing $HOME/.copilot');
  // The token itself must still never travel as an env/argv token (tmux keeps a
  // pane's start command for its lifetime, readable by every other pane).
  assert.doesNotMatch(SRC, /'GH_TOKEN=' \+/, 'the GitHub token must stay in the 0600 rcfile');
});

test('the new-tab route hands newTmuxWindow the person who asked for it', () => {
  assert.match(SRC, /await newTmuxWindow\(p, req\.body\?\.name \|\| 'new task', req\.body\?\.cmd \|\| '', req\.user\?\.implicit \? '' : \(req\.user\?\.username \|\| ''\)\)/,
    'without the launcher the tab silently runs on the project owner\'s seat');
  // An instance with auth disabled has an IMPLICIT_ADMIN whose username is a
  // placeholder, not a person. Attributing its tabs to a user record of the same name
  // would invent an identity, so it must pass as "no launcher".
  assert.match(SRC, /req\.user\?\.implicit \? ''/,
    'the implicit admin must not be attributed to a real user record');
  assert.match(SRC, /async function newTmuxWindow\(p,name='new task',cmd='',launcher=''\)/);
  // Default '' so every non-human caller (scheduled tasks, bots) keeps owner keying.
  assert.match(SRC, /await newTmuxWindow\(p, task\.window, buildTaskCommand\(task\)\)/,
    'a scheduled task has no launcher and must stay on the project owner');
});

test('every window records the identity it was created with', () => {
  assert.match(SRC, /const CRED_USER_OPTION = '@pw_cred_user'/);
  assert.match(SRC, /await stampWindowCredIdentity\(newWindowId \|\| `\$\{sess\}:\$\{idx\}`, cred\.key, cred\.username\)/);
  // Read back after writing, like the session stamp: a dropped set-option must not
  // leave a pane running under an unrecorded identity.
  assert.match(SRC, /could not verify the \$\{option\} stamp on window/);
  // Unrecordable identity => the window is destroyed, not handed over unlabelled.
  assert.match(SRC, /await tmux\(\['kill-window','-t',newWindowId \|\| `\$\{sess\}:\$\{idx\}`\]\)/,
    'an unlabelled window spending someone\'s seat is the thing this feature must not ship');
  // The strip reads the stamp back per poll, so a colour change needs no recycle.
  assert.match(SRC, /#\{@pw_cred_user\}/, 'the window list must carry the identity');
});

test('mixed attribution is now RECORDED rather than refused', () => {
  // The old rule ("a new window must match the session's fingerprint") was the guard
  // against unlabelled mixed panes. Per-launcher mode makes the mix intentional, so
  // the guard moved to per-window stamping above. Both halves are asserted so the
  // refusal cannot quietly come back and re-break the "+" menu.
  assert.doesNotMatch(SRC, /Refusing to create a mixed-attribution window/);
  assert.match(SRC, /every pane records the identity it was created with/);
});

test('the still-fail-closed case is preserved: an identity that cannot be resolved', () => {
  assert.match(SRC, /Refusing to fall back to the shared Claude\/GitHub login/,
    'a resolution failure must never silently become the shared login');
  assert.match(SRC, /cannot resolve its credential owner \(launcher "\$\{launcher \|\| ''\}", primaryUser/,
    'the error must name which identity could not be resolved');
});

test('per-launcher mode rides on per-user mode and can be pinned off without a revert', () => {
  assert.match(SRC, /const PER_LAUNCHER_CLAUDE = PER_USER_CLAUDE\s*\n\s*&& String\(process\.env\.PW_PER_LAUNCHER_CLAUDE \?\? 'true'\)\.toLowerCase\(\) !== 'false'/,
    'it must be impossible to get per-launcher credentials without per-user credentials');
});
