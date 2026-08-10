// The evidence PVI2 owns: a real privilege drop, with the expected owner and the running process
// genuinely different accounts.
//
// Round 8 recorded why this file exists. The previous ownership regression asserted
// `st.uid === os.userInfo().uid` — the account running the test. Run as root that passes by
// asserting *root wrote it as root*, which is the defect. An assertion that passes identically for
// the correct and the defective outcome is not evidence, and under the Final Implementation Notes
// Disposition this is exactly the evidence the PVI2 lane owns rather than GOA or GitHub.
//
// So here the expected owner is resolved INDEPENDENTLY of the process running the test, and the
// interesting case is deliberately the one where they differ: the dashboard side runs as root and
// the artifact must end up owned by the unprivileged workspace account. Where that cannot be
// arranged — no root, no non-interactive sudo — every affected assertion reports **not run** by
// name. It is never quietly downgraded to a same-account comparison that cannot fail.
//
//   PW_TEST_DROP_USER   names the workspace account to drop to (same convention as
//                       test/orch-privilege-real.test.mjs). Defaults to `admin` when running as
//                       root, otherwise the account running the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { credentialDropArgv } from '../app/user-credentials.js';
import { CREDENTIAL_FILENAME } from '../app/git-credential-store.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(REPO, 'app', 'credential-writer.mjs');
const TOKEN = 'ghp_CANARY_real_boundary_0123456789';

const me = os.userInfo();
const DROP_USER = process.env.PW_TEST_DROP_USER || (me.uid === 0 ? 'admin' : me.username);

/** The expected owner, resolved from passwd — never from the process running this test. */
async function resolveExpectedOwner(name) {
  try {
    const { stdout } = await execFileAsync('getent', ['passwd', name], { timeout: 5000 });
    const fields = stdout.split('\n')[0].split(':');
    if (fields.length === 7 && /^\d+$/.test(fields[2])) {
      return { user: fields[0], uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] };
    }
  } catch { /* fall through */ }
  return null;
}

/** Can this process actually become that account non-interactively? */
async function canBecome(user) {
  if (me.uid === 0) return true;
  try { await execFileAsync('sudo', ['-n', '-u', user, 'true'], { timeout: 5000 }); return true; }
  catch { return false; }
}

function runHelper(argv, job) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.stdin.end(JSON.stringify(job));
  });
}

/** A workspace owned by `owner`, created by whoever is running — chowned only if we are root. */
async function ownedWorkspace(owner) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-realbound-'));
  await execFileAsync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  if (me.uid === 0 && owner.uid !== 0) {
    await execFileAsync('chown', ['-R', `${owner.uid}:${owner.gid}`, dir]);
  }
  // The temp dir itself must be traversable by the account we drop to.
  await fsp.chmod(dir, 0o755);
  return dir;
}

const store = (ws) => path.join(ws, '.git', CREDENTIAL_FILENAME);

test('the privilege drop really happens, and the artifact belongs to the workspace account', { timeout: 60000 }, async (t) => {
  const owner = await resolveExpectedOwner(DROP_USER);
  if (!owner) {
    t.skip(`not run: the expected workspace account '${DROP_USER}' does not resolve in passwd here`);
    return;
  }
  if (!(await canBecome(owner.user))) {
    t.skip(`not run: cannot become '${owner.user}' non-interactively here (no root, and sudo will not run non-interactively)`);
    return;
  }

  const ws = await ownedWorkspace(owner);
  t.after(() => fsp.rm(ws, { recursive: true, force: true }).catch(() => {}));

  const argv = credentialDropArgv({ owner: { user: owner.user, source: 'passwd' }, execPath: process.execPath, helperPath: HELPER });
  assert.deepEqual(argv.slice(0, 4), ['/usr/bin/sudo', '-n', '-u', owner.user],
    'the work must be handed to the workspace account, not done by the dashboard process');

  const res = await runHelper(argv, {
    action: 'git-credentials', projectPath: ws, ghToken: TOKEN, expectUid: owner.uid,
  });
  assert.equal(res.code, 0, `helper failed: ${res.err || res.out}`);
  const parsed = JSON.parse(res.out);
  assert.equal(parsed.ok, true, res.out);

  // THE ASSERTION ROUND 8 REQUIRED. `owner.uid` came from passwd, not from this process.
  assert.equal(parsed.result.runningUid, owner.uid,
    'the helper must report having run as the workspace account — proof of the drop, not an assumption');
  for (const file of [store(ws), path.join(ws, '.git', 'config')]) {
    const st = await fsp.lstat(file);
    assert.equal(st.uid, owner.uid, `${path.basename(file)} must belong to the account whose git has to read and lock it`);
  }
  assert.equal((await fsp.lstat(store(ws))).mode & 0o777, 0o600);

  // And the discriminating half: when the test process is root, expected != running, so this
  // assertion could not have been satisfied by root-wrote-it-as-root.
  if (me.uid === 0) {
    assert.notEqual(owner.uid, me.uid,
      'running as root, the expected owner must differ from the running account or this proves nothing');
    assert.equal((await fsp.lstat(store(ws))).uid !== 0, true, 'the artifact must not be root-owned');
  } else {
    t.diagnostic(`partial: suite is running as ${me.username} (uid ${me.uid}), so expected-owner and running account coincide; `
      + 'the differing-account half of this assertion is NOT RUN. Re-run as root to exercise it.');
  }

  assert.ok(!res.out.includes(TOKEN) && !res.err.includes(TOKEN), 'the helper must not echo the credential');
  assert.ok(!argv.some((a) => a.includes(TOKEN)), 'and it must never appear in argv');
});

test('THE DEFECT, reproduced: the same work done in-process as root produces a root-owned artifact', { timeout: 60000 }, async (t) => {
  // The negative control. Without it, the test above cannot distinguish "the drop fixed it" from
  // "there was nothing to fix on this host". Only runnable as root, and reported as not run
  // otherwise rather than skipped silently.
  if (me.uid !== 0) {
    t.skip('not run: reproducing the root-write defect requires running as root (PVI2 lane owns this evidence)');
    return;
  }
  const owner = await resolveExpectedOwner(DROP_USER);
  if (!owner || owner.uid === 0) {
    t.skip(`not run: no distinct unprivileged account resolved for '${DROP_USER}'`);
    return;
  }
  const ws = await ownedWorkspace(owner);
  t.after(() => fsp.rm(ws, { recursive: true, force: true }).catch(() => {}));

  // Exactly what the old code did, in this (root) process.
  await fsp.writeFile(store(ws), `https://${TOKEN}:x-oauth-basic@github.com\n`, { mode: 0o600 });
  await execFileAsync('git', ['-C', ws, 'config', '--local', '--add', 'credential.helper', `store --file=${store(ws)}`]);

  assert.equal((await fsp.lstat(store(ws))).uid, 0,
    'this is the defect: root writes the credential, and the pane account cannot read it');

  // Now the repair path, through the drop, must displace it and hand it to the right account.
  const argv = credentialDropArgv({ owner: { user: owner.user, source: 'passwd' }, execPath: process.execPath, helperPath: HELPER });
  const res = await runHelper(argv, {
    action: 'git-credentials-remediate', projectPath: ws, expectUid: owner.uid, ghToken: TOKEN,
  });
  assert.equal(res.code, 0, `remediation failed: ${res.err || res.out}`);
  const parsed = JSON.parse(res.out);
  assert.equal(parsed.result.action, 'replaced');
  assert.equal(parsed.result.previousUid, 0, 'the report must name what it displaced');
  const st = await fsp.lstat(store(ws));
  assert.equal(st.uid, owner.uid, 'after remediation the artifact belongs to the workspace account');
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(!res.out.includes(TOKEN), 'the remediation report must not echo the credential');
});

test('a job that names an unexpected owner is refused rather than written as the wrong account', { timeout: 60000 }, async (t) => {
  const owner = await resolveExpectedOwner(DROP_USER);
  if (!owner || !(await canBecome(owner.user))) {
    t.skip(`not run: cannot become '${DROP_USER}' non-interactively here`);
    return;
  }
  const ws = await ownedWorkspace(owner);
  t.after(() => fsp.rm(ws, { recursive: true, force: true }).catch(() => {}));

  const argv = credentialDropArgv({ owner: { user: owner.user, source: 'passwd' }, execPath: process.execPath, helperPath: HELPER });
  const res = await runHelper(argv, {
    action: 'git-credentials', projectPath: ws, ghToken: TOKEN, expectUid: owner.uid + 4242,
  });
  assert.notEqual(res.code, 0, 'a mismatched expected owner must be a refusal');
  assert.match(res.out || res.err, /owner/i);
  assert.equal(fs.existsSync(store(ws)), false, 'and nothing may have been written on the way out');
  assert.ok(!(res.out + res.err).includes(TOKEN), 'the refusal must not reflect the token');
});
