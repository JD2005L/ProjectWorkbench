// A project's own push credential, separate from the person's GitHub token.
//
// THE DEFECT THIS CLOSES, which happened on this instance on 2026-09-21: PW stored one
// GitHub token per person and used it for both jobs — the credential pinned into every
// project they own, AND what authenticates Copilot in their terminals. Authorising
// somebody through the new `gh auth login` route replaced their token with an
// enterprise OAuth token and silently re-pinned it into all their projects. Pushes to
// JD2005L/ProjectWorkbench then failed with a 403 naming an account nobody had chosen.
//
// It is not fixable by granting permissions: `james-levac_goa` is an Enterprise Managed
// User, so it does not exist outside its enterprise (the public API answers 404 for it
// and 200 for JD2005L) and cannot be a collaborator on a repository outside that
// enterprise. One account genuinely cannot do both jobs, so the two roles are separate
// fields with the project's own credential winning for git.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveProjectGitToken, PUSH_TOKEN_SOURCES } from '../app/project-push-token.js';
import { inlineScripts } from './cockpit-instance-fixture.mjs';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const SRC = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
const TYPOGRAPHIC_QUOTES = /[‘’“”]/;

// A stand-in for the real cipher: reversible, and able to FAIL on demand, which is the
// case that decides whether an unreadable override falls back or refuses.
const plain = (s) => `enc:${s}`;
const decrypt = (c) => {
  const v = String(c || '');
  if (v === 'enc:BROKEN') throw new Error('bad key');
  return v.startsWith('enc:') ? v.slice(4) : '';
};

// ---------------------------------------------------------------------------
// Which token wins
// ---------------------------------------------------------------------------

test("the project's own credential beats the git identity's", () => {
  const users = [{ username: 'james.levac', ghToken: plain('gho_ENTERPRISE') }];
  const got = resolveProjectGitToken({
    project: { primaryUser: 'james.levac', pushToken: plain('github_pat_REPO') }, users, decrypt,
  });
  assert.equal(got.token, 'github_pat_REPO');
  assert.equal(got.source, PUSH_TOKEN_SOURCES.override);
  assert.equal(got.readable, true);
});

test('without an override, the git identity supplies the token, as before', () => {
  const users = [{ username: 'james.levac', ghToken: plain('gho_ENTERPRISE') }];
  const got = resolveProjectGitToken({ project: { primaryUser: 'james.levac' }, users, decrypt });
  assert.equal(got.token, 'gho_ENTERPRISE');
  assert.equal(got.source, PUSH_TOKEN_SOURCES.owner);
});

test('an UNREADABLE override is a fault, never a fallback to the owner', () => {
  // The override exists because the owner's account authenticates as the wrong identity
  // for this remote. Falling back would push as exactly the account that was ruled out,
  // which is the original bug wearing a different hat.
  const users = [{ username: 'james.levac', ghToken: plain('gho_ENTERPRISE') }];
  const got = resolveProjectGitToken({
    project: { primaryUser: 'james.levac', pushToken: 'enc:BROKEN' }, users, decrypt,
  });
  assert.equal(got.token, '', 'no token, rather than the wrong one');
  assert.equal(got.source, PUSH_TOKEN_SOURCES.override, 'and the override is still what was in play');
  assert.equal(got.readable, false);
  assert.match(got.detail, /could not be decrypted/);
});

test('every unusable case explains itself, and none of them leaks the secret', () => {
  const cases = [
    [{}, [], PUSH_TOKEN_SOURCES.none, /no git identity chosen/],
    [{ primaryUser: 'ghost' }, [], PUSH_TOKEN_SOURCES.owner, /does not resolve to a user record/],
    [{ primaryUser: 'kevin' }, [{ username: 'kevin' }], PUSH_TOKEN_SOURCES.owner, /no stored GitHub token/],
    [{ primaryUser: 'kevin' }, [{ username: 'kevin', ghToken: 'enc:BROKEN' }], PUSH_TOKEN_SOURCES.owner, /could not be decrypted/],
  ];
  for (const [project, users, source, detail] of cases) {
    const got = resolveProjectGitToken({ project, users, decrypt });
    assert.equal(got.token, '', JSON.stringify(project));
    assert.equal(got.source, source, JSON.stringify(project));
    assert.match(got.detail, detail);
  }
  // A detail string is shown to operators and written to logs, so it carries names and
  // reasons and never credential material.
  const leak = resolveProjectGitToken({
    project: { primaryUser: 'x', pushToken: plain('github_pat_SECRET') },
    users: [], decrypt,
  });
  assert.doesNotMatch(leak.detail, /github_pat_SECRET/);
});

// ---------------------------------------------------------------------------
// Wiring: the same answer everywhere a repo is transacted with
// ---------------------------------------------------------------------------

test('the pinned git credential is resolved through the shared resolver', () => {
  const start = SRC.indexOf('async function syncProjectCredentials(project){');
  assert.notEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /resolveProjectGitToken\(/);
  // Read from DISK by registered path: a caller holding a stale snapshot must not be
  // able to re-pin a credential that has since been replaced.
  assert.match(body, /projects\.find\(x => x\?\.path && x\.path === project\.path\)/);
  // ... while primaryUser still comes from the caller, because the user-deletion path
  // revokes by passing a synthetic project with it cleared.
  assert.match(body, /primaryUser: project\.primaryUser/);
  // And a broken override refuses rather than silently pinning the owner's token.
  assert.match(body, /PUSH_TOKEN_SOURCES\.override/);
  assert.match(body, /Refusing to fall back/);
});

test('the CLONE uses the same credential the pushes will', () => {
  // Otherwise a project can be created from a remote it then cannot push to, which is
  // the whole failure this field exists to end.
  const start = SRC.indexOf('const addProjectHandler = async (req,res,next)=>{');
  const body = SRC.slice(start, SRC.indexOf("app.post(BASE + '/manage/add'", start));
  assert.match(body, /resolveProjectGitToken\(\{ project:p, users, decrypt \}\)/);
  assert.match(body, /if\(push\.set\) p\.pushToken = encrypt\(push\.token\)/);
});

test('the credential repair treats an override as authoritative too', () => {
  // Before, a project with no primaryUser was reported as having "no authoritative
  // token to rewrite from" — which would now be wrong for a project that carries its
  // own credential.
  const start = SRC.indexOf('const wrongOwner = rows.filter');
  const body = SRC.slice(start, start + 2600);
  assert.match(body, /resolveProjectGitToken\(\{ project, users, decrypt \}\)/);
  assert.match(body, /left untouched rather than revoked/, 'an unresolved project is still never revoked');
  assert.doesNotMatch(body, /no primaryUser, so no authoritative token/, 'the owner-only gate must be gone');
});

test('a blank field means KEEP; only an explicit request clears', () => {
  const start = SRC.indexOf('function parsePushToken(body){');
  assert.notEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /pushTokenClear/);
  assert.match(body, /if\(!token\) return \{ set:false, clear:false/, 'blank must not clear');
  // Whitespace would corrupt the git credential file it is written into.
  assert.match(body, /must not contain spaces/);
  assert.match(body, /512/);
  const update = SRC.slice(SRC.indexOf("app.post(BASE + '/manage/update/:oldName'"));
  assert.match(update.slice(0, 6000), /else if\(push\.clear\) delete p\.pushToken/);
});

// ---------------------------------------------------------------------------
// The secret never travels outward
// ---------------------------------------------------------------------------

test('the config API reports the STATE of the credential, never the credential', () => {
  const start = SRC.indexOf('projects: projects.map(p => ({ name:p.name,');
  assert.notEqual(start, -1);
  const body = SRC.slice(start, start + 1200);
  assert.match(body, /hasPushToken: !!p\.pushToken/);
  assert.match(body, /pushTokenKind/, 'the type is useful; the value is not');
  assert.doesNotMatch(body, /pushToken: p\.pushToken/, 'the stored secret must never be serialised to a client');
});

test('the audit trail records that a credential exists, not what it is', () => {
  assert.match(SRC, /project_add', \{[^}]*hasPushToken: !!added\?\.pushToken/);
  assert.match(SRC, /project_update', \{[^}]*hasPushToken: !!updated\?\.pushToken/);
});

test('git only: the push credential never reaches a terminal or Copilot', () => {
  // The separation is the entire point. A pane's GH_TOKEN is what Copilot authenticates
  // with, and it must keep coming from the PERSON, never from a project override.
  const start = SRC.indexOf('function credentialContext(');
  assert.notEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /pushToken/, 'the pane environment must not see the project push credential');
});

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Boot a dashboard with isolated state and no tmux dependency. */
async function withDashboard(fn) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-push-srv-'));
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    PW_API_TOKENS_PATH: path.join(dir, 'api-tokens.json'),
    // Isolated so the host's real workbench.json cannot decide which CLIs this test
    // sees, which is what made an earlier suite pass here and fail elsewhere.
    PW_WORKBENCH_SETTINGS: path.join(dir, 'workbench.json'),
    PW_AUDIT_LOG: path.join(dir, 'audit.log'),
  };
  const logs = [];
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn({ base, dir });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
}

test('REGRESSION: the manage page still compiles with the new field on it', { timeout: 60000 }, async () => {
  // The cockpit tab strip vanished on 2026-09-14 because a typographic quote reached an
  // inline script, and this field adds client code to the same page. An apostrophe in a
  // server template literal is the specific trap: it arrives unescaped and ends a
  // string.
  await withDashboard(async ({ base }) => {
    const res = await fetch(`${base}/manage`);
    assert.equal(res.status, 200, 'manage must render');
    const html = await res.text();

    const scripts = inlineScripts(html);
    const form = scripts.find((s) => s.includes('function fillForm(') && s.includes('pmPushToken'));
    assert.ok(form, 'the project form script must be inline on the manage page');
    scripts.forEach((code, i) => {
      try { new vm.Script(code, { filename: `manage-inline-${i}.js` }); }
      catch (err) { assert.fail(`inline script #${i} on manage does not compile: ${err.message}`); }
    });
    assert.doesNotMatch(form, TYPOGRAPHIC_QUOTES, 'the form script must use ASCII string delimiters');

    // The field, and the explanation of when it is needed — the EMU case is not
    // guessable, so leaving it out would make the field look like a duplicate of the
    // git identity.
    assert.match(html, /id="pmPushToken"/);
    assert.match(html, /id="pmPushClear"/);
    assert.match(html, /enterprise-managed account/);
    assert.match(html, /never authenticates Copilot/);
    // type=password so it is not shoulder-read or stored by a password manager as a
    // visible field, and blank-means-keep is stated where it is acted on.
    assert.match(html, /id="pmPushToken" type="password"/);
    assert.match(html, /Leave blank to keep whatever is stored/);
  });
});
