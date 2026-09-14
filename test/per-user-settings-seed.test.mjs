// REGRESSION (2026-09-14): enabling PW_PER_USER_CLAUDE silently killed every project's amber
// "turn done" flag.
//
// Cause: the per-user config dir is seeded with .claude.json only. The dashboard's turn-done
// notice depends on settings.json, in two independent ways:
//   * hooks.Stop runs pw-stop-hook.sh, which writes the marker under
//     /var/lib/project-workbench/pending that the rail renders as amber;
//   * preferredNotifChannel='terminal_bell' is what makes Claude ring the BEL that tmux records
//     as window_bell_flag -- the live half of the same flag.
// Both live in the shared ~/.claude/settings.json and neither was copied, so BOTH halves went
// dark at once and the flag stopped entirely rather than degrading.
//
// The subtle part, and the reason an "only if absent" guard like .claude.json's is not enough:
// Claude Code writes settings.json ITSELF the first time a user changes theme or model. The real
// per-user file existed, holding {model, theme, enabledPlugins} -- so a creation-time guard would
// have lost the race and seeded nothing. Seeding must MERGE absent keys into an existing file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyCredentialJob, userClaudeConfigDir, SEEDED_SETTINGS_KEYS } from '../app/user-credentials.js';

const SHARED = {
  model: 'shared-model',
  theme: 'shared-theme',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '/opt/project-workbench/scripts/pw-stop-hook.sh' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }],
  },
  preferredNotifChannel: 'terminal_bell',
  permissions: { defaultMode: 'bypassPermissions' },
  skipDangerousModePermissionPrompt: true,
};

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-settings-seed-'));
  const sharedSettings = path.join(dir, 'shared-settings.json');
  fs.writeFileSync(sharedSettings, JSON.stringify(SHARED, null, 2));
  return { dir, base: path.join(dir, 'pw-users'), sharedSettings };
}

const readSettings = (base, user) =>
  JSON.parse(fs.readFileSync(path.join(userClaudeConfigDir(base, user), 'settings.json'), 'utf8'));

test('seeding a fresh config dir installs the Stop hook and the bell channel', async () => {
  const { dir, base, sharedSettings } = scratch();
  try {
    await applyCredentialJob({ fsp, base, username: 'fresh.user', sharedSettings });
    const got = readSettings(base, 'fresh.user');
    assert.deepEqual(got.hooks, SHARED.hooks, 'hooks must be seeded or the marker is never written');
    assert.equal(got.preferredNotifChannel, 'terminal_bell', 'without this Claude never rings the BEL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REGRESSION: seeding MERGES into a settings.json Claude already wrote', async () => {
  // This is the exact shape of the file that broke it: real, pre-existing, preferences only.
  const { dir, base, sharedSettings } = scratch();
  try {
    const cfgDir = userClaudeConfigDir(base, 'existing.user');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'settings.json'),
      JSON.stringify({ model: 'my-own-model', theme: 'my-own-theme', enabledPlugins: ['x'] }, null, 2));

    await applyCredentialJob({ fsp, base, username: 'existing.user', sharedSettings });

    const got = readSettings(base, 'existing.user');
    assert.deepEqual(got.hooks, SHARED.hooks, 'an existing file must NOT block seeding the hooks');
    assert.equal(got.preferredNotifChannel, 'terminal_bell');
    // Preferences the user set must survive untouched.
    assert.equal(got.model, 'my-own-model', 'the user\'s model choice must not be clobbered');
    assert.equal(got.theme, 'my-own-theme', 'the user\'s theme must not be clobbered');
    assert.deepEqual(got.enabledPlugins, ['x']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an infrastructure key the user has deliberately set is left alone', async () => {
  const { dir, base, sharedSettings } = scratch();
  try {
    const cfgDir = userClaudeConfigDir(base, 'opinionated');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'settings.json'),
      JSON.stringify({ preferredNotifChannel: 'iterm2' }, null, 2));

    await applyCredentialJob({ fsp, base, username: 'opinionated', sharedSettings });

    const got = readSettings(base, 'opinionated');
    assert.equal(got.preferredNotifChannel, 'iterm2', 'only ABSENT keys are filled in');
    assert.deepEqual(got.hooks, SHARED.hooks, 'the absent one is still seeded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('authority and preference keys are deliberately NOT propagated', async () => {
  // permissions/skipDangerousModePermissionPrompt are an authority grant: propagating the admin's
  // bypassPermissions into every owner's config as a side effect of a credential job would widen
  // authority silently. Personal preferences are equally not ours to copy.
  const { dir, base, sharedSettings } = scratch();
  try {
    await applyCredentialJob({ fsp, base, username: 'narrow.user', sharedSettings });
    const got = readSettings(base, 'narrow.user');
    assert.equal(got.permissions, undefined, 'bypassPermissions must not ride along');
    assert.equal(got.skipDangerousModePermissionPrompt, undefined);
    assert.equal(got.model, undefined, 'the admin\'s model preference is not the owner\'s');
    assert.equal(got.theme, undefined);
    assert.deepEqual(SEEDED_SETTINGS_KEYS.slice(), ['hooks', 'preferredNotifChannel'],
      'if this list grows, it should be a deliberate argued change');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or unparseable shared settings file is not fatal', async () => {
  const { dir, base } = scratch();
  try {
    // Absent: seeding is skipped, the rest of the credential job still completes.
    await applyCredentialJob({ fsp, base, username: 'no.shared', sharedSettings: path.join(dir, 'nope.json') });
    assert.ok(fs.existsSync(userClaudeConfigDir(base, 'no.shared')), 'the config dir is still built');

    // Unparseable per-user file: treated as empty and re-seeded rather than refusing.
    const broken = path.join(dir, 'broken-shared.json');
    fs.writeFileSync(broken, '{not json');
    await applyCredentialJob({ fsp, base, username: 'broken.shared', sharedSettings: broken });
    assert.ok(fs.existsSync(userClaudeConfigDir(base, 'broken.shared')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
