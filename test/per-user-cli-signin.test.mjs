// Signing in is a property of a PERSON; installing a CLI is a property of the machine.
//
// The Setup Wizard has always answered the machine question, and its "Sign in" button
// authenticates the box's one shared identity in a shared setup terminal. Since
// per-launcher credentials landed, that identity no longer runs anybody's project tabs
// — it is the seed a per-user config dir is built from — so the UI had to stop
// presenting it as a person's login, and a per-person path had to exist.
//
// Three things are pinned here:
//   1. the Copilot state machine, which is NOT "signed in or not": a stored GitHub
//      token overrides any login, and a classic ghp_ PAT is one Copilot refuses, so
//      the states have to say what will actually happen;
//   2. reading a person's own copilot login off disk, defensively, in a tree the
//      unprivileged pane account controls;
//   3. the self-service sign-in route, end to end — including that it refuses the
//      cases where a login could not take effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_TOKEN_KINDS, COPILOT_AUTH_STATES,
  classifyGithubToken, resolveCopilotAuthState, copilotLoginWouldTakeEffect, resolveCliAuthCell,
} from '../app/cli-auth-status.js';
import { userCopilotSignedIn, userCopilotConfigDir, spawnCredentialJob } from '../app/user-credentials.js';
import vm from 'node:vm';
import { withCockpit } from './cockpit-instance-fixture.mjs';

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const SRC = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 1. The Copilot state machine
// ---------------------------------------------------------------------------

test('a token is classified by prefix alone, and an empty one is not a type', () => {
  assert.equal(classifyGithubToken('github_pat_11ABCDEF'), GITHUB_TOKEN_KINDS.fineGrained);
  assert.equal(classifyGithubToken('gho_abc'), GITHUB_TOKEN_KINDS.oauth);
  assert.equal(classifyGithubToken('ghu_abc'), GITHUB_TOKEN_KINDS.oauth);
  assert.equal(classifyGithubToken('ghp_abc'), GITHUB_TOKEN_KINDS.classic);
  assert.equal(classifyGithubToken('ghs_abc'), GITHUB_TOKEN_KINDS.server);
  assert.equal(classifyGithubToken('ghr_abc'), GITHUB_TOKEN_KINDS.refresh);
  assert.equal(classifyGithubToken('hunter2'), GITHUB_TOKEN_KINDS.unknown);
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(classifyGithubToken(empty), GITHUB_TOKEN_KINDS.none);
  }
});

test('a classic PAT reads as REJECTED, not as "signed in" — the whole point of the column', () => {
  // A classic ghp_ authenticates git perfectly well, so it looks correct everywhere
  // else on the workbench and fails only for inference. If this reported "via token"
  // the UI would actively hide the cause of a broken Copilot tab.
  const got = resolveCopilotAuthState({ tokenKind: GITHUB_TOKEN_KINDS.classic });
  assert.equal(got.state, COPILOT_AUTH_STATES.tokenRejected);
});

test('a stored token beats a login, because that is the order Copilot reads them in', () => {
  // COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN take precedence over stored
  // credentials, and per-user credentials export the person's token as GH_TOKEN. So a
  // login that exists alongside a rejected token is NOT the answer to "how will this
  // authenticate" — it is being ignored, and the state has to say the ignored part.
  const got = resolveCopilotAuthState({ tokenKind: GITHUB_TOKEN_KINDS.classic, hasLogin: true });
  assert.equal(got.state, COPILOT_AUTH_STATES.tokenRejected);
  assert.equal(got.overridesLogin, true, 'a login being overridden must be visible, not silently dropped');
});

test('the remaining states', () => {
  assert.equal(resolveCopilotAuthState({ tokenKind: GITHUB_TOKEN_KINDS.oauth }).state, COPILOT_AUTH_STATES.viaToken);
  assert.equal(resolveCopilotAuthState({ tokenKind: GITHUB_TOKEN_KINDS.fineGrained }).state, COPILOT_AUTH_STATES.viaToken);
  assert.equal(resolveCopilotAuthState({ tokenKind: GITHUB_TOKEN_KINDS.unknown }).state, COPILOT_AUTH_STATES.tokenUnknown);
  assert.equal(resolveCopilotAuthState({ hasLogin: true }).state, COPILOT_AUTH_STATES.signedIn);
  assert.equal(resolveCopilotAuthState({}).state, COPILOT_AUTH_STATES.none);
  // An undecryptable token is its own state: "no token" and "a token we cannot read"
  // need different remedies, and conflating them would tell an admin to do nothing.
  assert.equal(resolveCopilotAuthState({ tokenUnreadable: true }).state, COPILOT_AUTH_STATES.unreadable);
});

test('a sign-in is only offered when it could actually take effect', () => {
  assert.equal(copilotLoginWouldTakeEffect(COPILOT_AUTH_STATES.none).ok, true);
  assert.equal(copilotLoginWouldTakeEffect(COPILOT_AUTH_STATES.signedIn).ok, true, 're-signing in is allowed');
  for (const blocked of [COPILOT_AUTH_STATES.viaToken, COPILOT_AUTH_STATES.tokenRejected,
    COPILOT_AUTH_STATES.tokenUnknown, COPILOT_AUTH_STATES.unreadable]) {
    const got = copilotLoginWouldTakeEffect(blocked);
    assert.equal(got.ok, false, `${blocked} must not offer a sign-in that the token would override`);
    assert.ok(got.reason.length > 20, 'the refusal has to say what to do instead');
  }
  // The rejected-token reason must name the actual remedy, not just the problem.
  assert.match(copilotLoginWouldTakeEffect(COPILOT_AUTH_STATES.tokenRejected).reason, /Copilot Requests|clear it/);
});

test('one person + one CLI resolves to one cell, and the same one for both surfaces', () => {
  // The admin table and a person's own page render from THIS function, so a
  // disagreement between them is impossible by construction rather than by review.
  const cell = (over) => resolveCliAuthCell({ cli: 'claude', perUserEnabled: true, userAuthSupported: true, ...over });

  assert.equal(cell({ claudeSignedIn: true }).label, 'signed in');
  assert.equal(cell({ claudeSignedIn: true }).tone, 'ok');
  assert.equal(cell({ claudeSignedIn: false }).canSelfSignIn, true, 'not signed in is exactly when signing in helps');

  // An uninstalled CLI has nothing to sign in to; the machine has to be fixed first.
  assert.equal(cell({ installed: false }).label, 'not installed');
  assert.equal(cell({ installed: false }).canSelfSignIn, false);

  // With the feature off, a per-person answer would be a fiction: every terminal runs
  // on the one shared login, so the cell says which mode is in force instead.
  const shared = resolveCliAuthCell({ cli: 'claude', perUserEnabled: false, userAuthSupported: true });
  assert.equal(shared.label, 'shared login');
  assert.equal(shared.canSelfSignIn, false);

  // A CLI with no per-user config dir (Codex today) must not offer a "personal" login
  // that would actually write the shared one.
  const notWired = resolveCliAuthCell({ cli: 'codex', perUserEnabled: true, userAuthSupported: false });
  assert.equal(notWired.label, 'not personal yet');
  assert.equal(notWired.canSelfSignIn, false);
});

test('the Copilot cell carries the precedence rule into the UI', () => {
  const cell = (copilotState, over) => resolveCliAuthCell({
    cli: 'copilot', perUserEnabled: true, userAuthSupported: true, copilotState, ...over,
  });
  assert.equal(cell(COPILOT_AUTH_STATES.viaToken).tone, 'ok');
  assert.equal(cell(COPILOT_AUTH_STATES.viaToken).canSelfSignIn, false, 'nothing to sign in to');
  assert.equal(cell(COPILOT_AUTH_STATES.tokenRejected).tone, 'bad');
  assert.equal(cell(COPILOT_AUTH_STATES.tokenRejected).canSelfSignIn, false, 'a login here cannot take effect');
  assert.match(cell(COPILOT_AUTH_STATES.tokenRejected).detail, /Copilot Requests/, 'the remedy, not just the problem');
  assert.equal(cell(COPILOT_AUTH_STATES.none).canSelfSignIn, true);
  assert.equal(cell(COPILOT_AUTH_STATES.signedIn).canSelfSignIn, true, 're-signing in is allowed');
  // An ignored login is stated, because "sign in" would otherwise look like the fix.
  assert.match(cell(COPILOT_AUTH_STATES.tokenRejected, { copilotOverridesLogin: true }).detail, /being ignored/);
  // An unrecognised state degrades visibly rather than silently reading as fine.
  assert.equal(cell('something-new').tone, 'warn');
});

// ---------------------------------------------------------------------------
// 2. Reading one person's own copilot login off disk
// ---------------------------------------------------------------------------

function copilotHome(base, user) {
  const dir = userCopilotConfigDir(base, user);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// Copilot writes a JSONC-style header into its own config file; the reader has to cope
// with that rather than treating a comment as corruption.
const CONFIG_HEADER = '// User settings belong in settings.json.\n// This file is managed automatically.\n';

test('a completed copilot login is detected — including through Copilot\'s JSONC header', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-copilot-signin-'));
  try {
    const base = path.join(dir, 'pw-users');
    const home = copilotHome(base, 'kevin.charlebois');
    fs.writeFileSync(path.join(home, 'config.json'),
      `${CONFIG_HEADER}${JSON.stringify({ copilotTokens: { 'https://github.com:kev': 'gho_SECRET' } })}`);
    assert.equal(await userCopilotSignedIn({ fsp, base, username: 'kevin.charlebois' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the account record alone counts too, for a box whose token went to a keyring', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-copilot-signin-'));
  try {
    const base = path.join(dir, 'pw-users');
    const home = copilotHome(base, 'kevin.charlebois');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      loggedInUsers: [{ host: 'https://github.com', login: 'kev' }],
    }));
    assert.equal(await userCopilotSignedIn({ fsp, base, username: 'kevin.charlebois' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anything that is not a real login reads as NOT signed in, never as an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-copilot-signin-'));
  try {
    const base = path.join(dir, 'pw-users');
    // Nothing there at all.
    assert.equal(await userCopilotSignedIn({ fsp, base, username: 'nobody' }), false);
    const home = copilotHome(base, 'kevin.charlebois');
    const file = path.join(home, 'config.json');
    for (const body of [
      '',                                                    // empty
      'not json at all',                                     // garbage
      '[]',                                                  // wrong shape
      JSON.stringify({ trustedFolders: ['/tmp'] }),           // real config, no login
      JSON.stringify({ copilotTokens: {} }),                  // logged out
      JSON.stringify({ copilotTokens: { 'h:u': '' } }),       // emptied token
      JSON.stringify({ loggedInUsers: [] }),
      JSON.stringify({ lastLoggedInUser: { login: '' } }),
    ]) {
      fs.writeFileSync(file, body);
      assert.equal(await userCopilotSignedIn({ fsp, base, username: 'kevin.charlebois' }), false, `"${body.slice(0, 30)}" must not read as signed in`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: a symlink planted where the config goes is never followed', async () => {
  // The credential tree is owned by the shared unprivileged pane account, so anyone
  // with a terminal can plant one. Following it would turn this boolean into a 1-bit
  // oracle for the existence and parseability of an arbitrary file readable by whoever
  // runs the check — the same defect already closed for Claude's .credentials.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-copilot-signin-'));
  try {
    const base = path.join(dir, 'pw-users');
    const home = copilotHome(base, 'victim');
    const bait = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(bait, JSON.stringify({ copilotTokens: { 'h:u': 'gho_NOT_THEIRS' } }));
    fs.symlinkSync(bait, path.join(home, 'config.json'));
    assert.equal(await userCopilotSignedIn({ fsp, base, username: 'victim' }), false,
      'a symlinked config must read as not-signed-in, never be followed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the privilege-dropped helper answers for BOTH CLIs in one status job', async () => {
  // One job, because this runs per user per request and each job is a process spawn.
  // credential-writer.mjs enumerates its result fields by hand, so a new one is easy
  // to forget — and would read as "nobody is signed in" rather than as a bug.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-copilot-signin-'));
  try {
    const base = path.join(dir, 'pw-users');
    const home = copilotHome(base, 'over.stdin');
    fs.writeFileSync(path.join(home, 'config.json'), `${CONFIG_HEADER}${JSON.stringify({ copilotTokens: { 'h:u': 'gho_X' } })}`);
    const result = await spawnCredentialJob({
      spawn,
      argv: [process.execPath, path.join(APP_DIR, 'credential-writer.mjs')],
      job: { action: 'status', base, username: 'over.stdin' },
    });
    assert.equal(result.copilotSignedIn, true, 'the helper must report the copilot answer too');
    assert.equal(result.signedIn, false, 'and still report Claude separately');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The self-service sign-in route, end to end
// ---------------------------------------------------------------------------

const scryptAsync = promisify(crypto.scrypt);
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}
const PASSWORD = 'S1gnMe!In';

async function seedUsers(dir, { ghToken = '' } = {}) {
  const passwordHash = await hashPassword(PASSWORD);
  const kevin = { id: 'u-kev', username: 'kevin.charlebois', role: 'developer', projects: '*', passwordHash };
  if (ghToken) kevin.ghToken = ghToken;
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [
    { id: 'u-jl', username: 'james.levac', role: 'admin', projects: '*', passwordHash, ghToken: 'gho_OWNER' },
    kevin,
  ] }, null, 2));
}
// The fixture starts with the shipped default (claude only), so a test that wants a
// Copilot column has to say so — the table only shows CLIs the operator has enabled.
function setEnabledClis(dir, keys) {
  const file = path.join(dir, 'workbench.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fixture starts with none */ }
  fs.writeFileSync(file, JSON.stringify({ ...current, enabledClis: keys, updateClis: [] }, null, 2));
}
function setPrimaryUser(dir, name, owner) {
  const file = path.join(dir, 'projects.json');
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const p of projects) if (p.name === name) p.primaryUser = owner;
  fs.writeFileSync(file, JSON.stringify(projects, null, 2));
}
async function login(base, username) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal((await r.json()).ok, true, `sanity: ${username} must be able to sign in`);
  return r.headers.get('set-cookie').split(';')[0];
}
const signIn = (base, cookie, cli) => fetch(`${base}/api/me/cli-login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ cli }),
}).then((r) => r.json().then((j) => ({ status: r.status, ...j })));

test('a person signs THEMSELVES in: the login runs in a tab carrying their own config dir', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, 'james.levac');
    const cookie = await login(base, 'kevin.charlebois');

    const out = await signIn(base, cookie, 'claude');
    assert.equal(out.ok, true, `sign-in must start: ${JSON.stringify(out)}`);
    assert.equal(out.command, 'claude /login');
    assert.equal(out.project, name, 'it runs in a project they can actually reach');

    // The tab it opened must be attributed to THEM, not to the project's owner —
    // that attribution is what makes the login land in their own directory.
    const list = await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, { headers: { cookie } })).json();
    const tab = list.windows.find((w) => w.index === Number(out.windowIndex));
    assert.ok(tab, 'the sign-in tab must exist');
    assert.equal(tab.credUser, 'kevin.charlebois');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('Copilot refuses a sign-in that its own token precedence would swallow', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    // A classic ghp_ token: Copilot rejects the type AND it overrides any login, so
    // opening a terminal would send someone round a loop that cannot succeed. The
    // refusal has to name the remedy instead.
    await seedUsers(dir, { ghToken: 'ghp_CLASSIC_NOT_SUPPORTED' });
    setPrimaryUser(dir, name, 'james.levac');
    const cookie = await login(base, 'kevin.charlebois');

    const out = await signIn(base, cookie, 'copilot');
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.match(out.error, /Copilot Requests|clear it/, 'the refusal must be actionable');
    assert.doesNotMatch(out.error, /ghp_CLASSIC/, 'and must never echo the token');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('with no stored token, Copilot sign-in is offered and runs `copilot login` (not gh)', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, 'james.levac');
    const cookie = await login(base, 'kevin.charlebois');
    const out = await signIn(base, cookie, 'copilot');
    assert.equal(out.ok, true, `${JSON.stringify(out)}`);
    // `gh auth login` would write the SHARED ~/.config/gh; `copilot login` writes the
    // per-user COPILOT_HOME, which is the entire point of the per-person path.
    assert.equal(out.command, 'copilot login');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('the route refuses the cases where there is no person, or no per-user identity at all', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, 'james.levac');
    const cookie = await login(base, 'kevin.charlebois');

    // Codex has no per-user config dir wired, so a "login" would write the shared one.
    const codex = await signIn(base, cookie, 'codex');
    assert.equal(codex.ok, false);
    assert.match(codex.error, /no per-user config directory|no per-user sign-in/);

    const bogus = await signIn(base, cookie, 'nope');
    assert.equal(bogus.ok, false);
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('with per-user credentials OFF, the route says so instead of opening a pointless tab', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, dir }) => {
    await seedUsers(dir);
    const cookie = await login(base, 'kevin.charlebois');
    const out = await signIn(base, cookie, 'claude');
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.match(out.error, /PW_PER_USER_CLAUDE|shares one login/);
  });
});

test('SECURITY: the Copilot column decrypts a token to classify it and still never publishes it', { timeout: 120000 }, async () => {
  // GET /api/users now decrypts each user's stored token in order to read its TYPE.
  // That is the only reason it is decrypted, and the classification is the only thing
  // allowed out — so the response is checked as RAW TEXT, not as a parsed object with
  // known keys, which is what would miss a token riding along in an unexpected field.
  await withCockpit(async ({ base, dir }) => {
    await seedUsers(dir, { ghToken: 'ghp_CLASSIC_NOT_SUPPORTED' });
    setEnabledClis(dir, ['claude', 'copilot']);
    const admin = await login(base, 'james.levac');
    const raw = await (await fetch(`${base}/api/users`, { headers: { cookie: admin } })).text();
    for (const secret of ['ghp_CLASSIC_NOT_SUPPORTED', 'gho_OWNER']) {
      assert.equal(raw.includes(secret), false, `the users response must not carry ${secret.slice(0, 4)}… material`);
    }
    const body = JSON.parse(raw);
    // A column per offered CLI, and a resolved cell per user per CLI.
    assert.deepEqual(body.clis.map((c) => c.key).sort(), ['claude', 'copilot']);
    const kevin = body.users.find((u) => u.username === 'kevin.charlebois');
    assert.equal(kevin.cliAuth.copilot.label, 'token type refused', 'the diagnosis itself must still be reported');
    assert.equal(kevin.cliAuth.copilot.canSelfSignIn, false, 'and a sign-in that the token would override is not offered');
    assert.match(kevin.cliAuth.copilot.detail, /Copilot Requests|cleared/, 'the cell must carry the remedy');
    assert.equal(kevin.tokenKind, 'classic', 'the TYPE is what an admin needs in order to act');
    assert.equal(kevin.hasToken, true, 'and the existing has-a-token boolean is unchanged');
    assert.equal(body.me, 'james.levac', 'the viewer is named so the table can offer self-service sign-in');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('a developer has a page of their own, reachable without Settings', { timeout: 120000 }, async () => {
  // Everything else about identity lives behind Settings, which a developer cannot
  // open. Without this page they could see Copilot fail and not why, and could not act.
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir, { ghToken: 'ghp_CLASSIC_NOT_SUPPORTED' });
    setEnabledClis(dir, ['claude', 'copilot']);
    setPrimaryUser(dir, name, 'james.levac');
    const cookie = await login(base, 'kevin.charlebois');

    const page = await fetch(`${base}/me`, { headers: { cookie } });
    assert.equal(page.status, 200, 'a developer must be able to open it');
    assert.match(await page.text(), /My CLI sign-ins/);

    const st = await (await fetch(`${base}/api/me/cli-status`, { headers: { cookie } })).json();
    assert.equal(st.ok, true);
    assert.equal(st.username, 'kevin.charlebois');
    const copilot = st.clis.find((c) => c.key === 'copilot');
    assert.equal(copilot.auth.label, 'token type refused', 'the diagnosis an admin sees, shown to the person who has the problem');
    assert.equal(st.github.kind, 'classic', 'and the token TYPE, which is the actionable part');
    // Never the token itself, on the page or in the API.
    const raw = JSON.stringify(st);
    assert.equal(raw.includes('ghp_CLASSIC_NOT_SUPPORTED'), false);
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('REGRESSION: every inline script on the rendered /me page compiles', { timeout: 120000 }, async () => {
  // These pages are assembled as template literals, where \n and \' are escapes the
  // TEMPLATE consumes — so a client-side string written with them arrives holding a real
  // newline or a bare quote and the whole script dies at parse time, with the server
  // perfectly healthy. That is not hypothetical: it happened to this page and to the
  // Settings page in the same change, which is why both are now compiled in CI.
  await withCockpit(async ({ base, dir }) => {
    await seedUsers(dir, { ghToken: 'ghp_CLASSIC_NOT_SUPPORTED' });
    setEnabledClis(dir, ['claude', 'copilot']);
    const cookie = await login(base, 'kevin.charlebois');
    const html = await (await fetch(`${base}/me`, { headers: { cookie } })).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, 'the page must actually carry its client script');
    scripts.forEach((src, i) => {
      assert.doesNotThrow(() => new vm.Script(src), `inline script #${i} on /me does not compile`);
    });
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('REGRESSION: user management survives workbench settings it cannot read', { timeout: 120000 }, async () => {
  // The CLI columns need to know which CLIs are enabled, which means reading
  // workbench.json — and that file ships root-only. Reading it straight through made
  // GET /api/users 500, taking account management down with an informational column.
  // The columns are what degrade now, not the route.
  await withCockpit(async ({ base, dir }) => {
    await seedUsers(dir);
    fs.writeFileSync(path.join(dir, 'workbench.json'), '{ this is not json');
    const admin = await login(base, 'james.levac');
    const r = await fetch(`${base}/api/users`, { headers: { cookie: admin } });
    assert.equal(r.status, 200, 'the user list must still load');
    const body = await r.json();
    assert.deepEqual(body.clis, [], 'with no readable settings there are no CLI columns');
    assert.equal(body.users.length, 2, 'and every user is still listed');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('a person can escape the Copilot dead end themselves: clear, then sign in', { timeout: 120000 }, async () => {
  // This is the whole point of the self-service token controls. A token Copilot refuses
  // overrides any login, so before this existed the ONLY way out was to ask an admin.
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir, { ghToken: 'ghp_CLASSIC_NOT_SUPPORTED' });
    setEnabledClis(dir, ['claude', 'copilot']);
    setPrimaryUser(dir, name, 'james.levac');
    const cookie = await login(base, 'kevin.charlebois');

    const blocked = await signIn(base, cookie, 'copilot');
    assert.equal(blocked.ok, false, 'sanity: the stored token blocks a sign-in');

    const cleared = await (await fetch(`${base}/api/me/github-token`, { method: 'DELETE', headers: { cookie } })).json();
    assert.equal(cleared.ok, true, `clearing must be possible: ${JSON.stringify(cleared)}`);
    assert.equal(cleared.github.hasToken, false);

    const after = await (await fetch(`${base}/api/me/cli-status`, { headers: { cookie } })).json();
    assert.equal(after.clis.find((c) => c.key === 'copilot').auth.canSelfSignIn, true,
      'with the blocking token gone, signing in is now possible');
    const now = await signIn(base, cookie, 'copilot');
    assert.equal(now.ok, true, `and actually works: ${JSON.stringify(now)}`);

    // And they can store a working one themselves rather than losing git auth for good.
    const set = await (await fetch(`${base}/api/me/github-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ token: 'github_pat_11FINEGRAINED' }),
    })).json();
    assert.equal(set.ok, true);
    assert.equal(set.github.kind, 'fine-grained');
    const final = await (await fetch(`${base}/api/me/cli-status`, { headers: { cookie } })).json();
    assert.equal(final.clis.find((c) => c.key === 'copilot').auth.tone, 'ok');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('the self token routes are self-scoped and reject junk', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, dir }) => {
    await seedUsers(dir);
    const cookie = await login(base, 'kevin.charlebois');
    const post = (body) => fetch(`${base}/api/me/github-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
    }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));

    assert.equal((await post({ token: '' })).ok, false, 'an empty token is a clear, not a store');
    assert.equal((await post({ token: 'gho_has space' })).ok, false, 'a pasted newline or partial paste is caught');
    assert.equal((await post({ token: 'x'.repeat(600) })).ok, false, 'and an absurd length');
    // There is no username parameter to abuse: the identity is the session's.
    const src = SRC.slice(SRC.indexOf("app.post(BASE + '/api/me/github-token'"), SRC.indexOf("app.delete(BASE + '/api/me/github-token'"));
    assert.doesNotMatch(src, /req\.body\?\.username|req\.params/);
    assert.match(src, /req\.user\.username/);
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

// ---------------------------------------------------------------------------
// The UI must stop describing the shared identity as a person's login
// ---------------------------------------------------------------------------

test('the CLIs page carries NO sign-in once identity is per person', () => {
  // Installing is the machine's business; signing in is a person's. With per-user
  // credentials on, the shared login runs nobody's terminals, so a sign-in control here
  // would authenticate an identity the presser does not use. Both surfaces remove the
  // control, the status badge and the terminal section, rather than caption them.
  assert.match(SRC, /perUserClaude: PER_USER_CLAUDE \}\);/, 'setup state must tell the UI which identity model is in force');
  assert.equal((SRC.match(/state\.perUserClaude\?'':'<button/g) || []).length, 2,
    'both CLI renderers must drop the sign-in button when identity is per person');
  assert.equal((SRC.match(/c\.authenticated&&!state\.perUserClaude/g) || []).length, 2,
    'and drop the shared-identity badge, which is not about the viewer');
  assert.match(SRC, /if\(shSec&&state\.perUserClaude\)shSec\.remove\(\)/, "the wizard's shared-identity section is removed");
  assert.match(SRC, /if\(shCard\)shCard\.remove\(\)/, "as is the Settings page's shared sign-in terminal");
  // The route behind it refuses in that mode too, so the capability is gone rather than
  // merely hidden — and it still works where the shared login IS everybody's.
  assert.match(SRC, /Per-user credentials are on, so this shared login runs nobody/);
});

test('a stored token can be CLEARED from the Users table', () => {
  // It was write-only: an empty field meant "keep it", so there was no way to remove a
  // token — which is the only fix when Copilot refuses its type, because a stored token
  // overrides any sign-in. The server already accepted ghToken:''; the control did not
  // exist.
  assert.match(SRC, /data-cleartok=/, 'the table needs a clear control');
  assert.match(SRC, /JSON\.stringify\(\{ghToken:''\}\)/, 'clearing sends the empty token the server already understands');
  assert.match(SRC, /git pushes from projects they own will have no credential/,
    'and the confirmation must state the consequence');
});

test("the sign-in means sits in each CLI's cell, on your own row, where it would work", () => {
  // Rendering it on someone else's row would invite an admin to sign the wrong person
  // in (the tab would carry the admin's credentials), and rendering it where a stored
  // token overrides a login would invite a loop that cannot succeed — canSelfSignIn is
  // what encodes the second rule, resolved server-side.
  const start = SRC.indexOf('function cliCellHtml(u,cli){');
  assert.notEqual(start, -1, 'the per-CLI cell renderer must exist');
  const body = SRC.slice(start, SRC.indexOf('function renderUsers(', start));
  assert.match(body, /const mine=u\.username===PW_ME/, 'the button is gated on the row being yours');
  assert.match(body, /mine&&cell\.canSelfSignIn/, 'and on the sign-in being able to take effect');
  // One column per offered CLI, rather than two hardcoded ones.
  assert.match(SRC, /PW_CLIS\.map\(c=>cliCellHtml\(u,c\)\)/, 'every offered CLI gets a cell per user');
});

test('the per-user sign-in route is self-service by construction', () => {
  // It takes no username. An admin pressing it for someone else would create the tab
  // on the ADMIN's credentials and sign the wrong person in, so the identity comes
  // from the session and nowhere else.
  const start = SRC.indexOf("app.post(BASE + '/api/me/cli-login'");
  assert.notEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf("app.post(BASE + '/api/setup/cli/auth'", start));
  assert.doesNotMatch(body, /req\.body\?\.username|req\.params\.username/, 'the route must not accept a target user');
  assert.match(body, /req\.user\.username/);
  assert.match(body, /req\.user\.implicit/, 'an anonymous session has no identity to sign in');
});
