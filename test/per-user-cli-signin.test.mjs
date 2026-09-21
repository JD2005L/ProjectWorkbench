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
  classifyGithubToken, resolveCopilotAuthState, copilotLoginWouldTakeEffect,
} from '../app/cli-auth-status.js';
import { userCopilotSignedIn, userCopilotConfigDir, spawnCredentialJob } from '../app/user-credentials.js';
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
    const admin = await login(base, 'james.levac');
    const raw = await (await fetch(`${base}/api/users`, { headers: { cookie: admin } })).text();
    for (const secret of ['ghp_CLASSIC_NOT_SUPPORTED', 'gho_OWNER']) {
      assert.equal(raw.includes(secret), false, `the users response must not carry ${secret.slice(0, 4)}… material`);
    }
    const body = JSON.parse(raw);
    const kevin = body.users.find((u) => u.username === 'kevin.charlebois');
    assert.equal(kevin.copilotAuth, 'token-rejected', 'the classification itself must still be reported');
    assert.equal(kevin.hasToken, true, 'and the existing has-a-token boolean is unchanged');
    assert.equal(body.me, 'james.levac', 'the viewer is named so the table can offer self-service sign-in');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

// ---------------------------------------------------------------------------
// The UI must stop describing the shared identity as a person's login
// ---------------------------------------------------------------------------

test('the shared-identity sign-in is labelled as the SEED identity, not as yours', () => {
  assert.match(SRC, /shared seed identity/, 'the wizard must say what that login now is');
  assert.match(SRC, /perUserClaude: PER_USER_CLAUDE \}\);/, '/api/setup/state must tell the UI which identity model is in force');
  // Both CLI renderers (wizard modal and the Settings page) relabel the badge, so the
  // green "Signed in" pill cannot be read as "you are signed in".
  assert.equal((SRC.match(/'Shared login':'Signed in'/g) || []).length, 2,
    'both renderers must distinguish the shared login from a personal one');
});

test('a sign-in button is offered only on your own row, and only where it would work', () => {
  // Rendering it on someone else's row would invite an admin to sign the wrong person
  // in, and rendering Copilot's where a stored token overrides a login would invite a
  // loop that cannot succeed — the cell says what to fix instead.
  const start = SRC.indexOf('function signInButtonsHtml(');
  assert.notEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf('function renderUsers(', start));
  assert.match(body, /u\.username!==PW_ME\)return ''/, 'other people\'s rows get no button');
  assert.match(body, /u\.copilotAuth==='none'\|\|u\.copilotAuth==='signed-in'/,
    'Copilot sign-in must only appear in the states where a login takes effect');
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
