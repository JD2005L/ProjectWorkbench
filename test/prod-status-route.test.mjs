// The PROD marker end to end: a real instance, a real workspace with a remote and a deploy log.
// /api/projects/status (the rail's 4-second poll) carries `prod`, and it follows a new deploy on
// its own: no page has to be reloaded for the marker to appear or clear.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withCockpit } from './cockpit-instance-fixture.mjs';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last.done) return last.value; await sleep(250); }
  assert.fail(`timed out; last: ${JSON.stringify(last?.value)}`);
}

test('the rail status poll reports what is waiting for PROD and follows a new deploy', { timeout: 90000 }, async (t) => {
  if (process.getuid?.() === 0) { t.skip('Git is never read as root'); return; }
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pw-prod-route-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const log = path.join(scratch, 'deploy-log.jsonl');
  fs.writeFileSync(log, '');
  await withCockpit(async ({ base, name, dir }) => {
    const ws = path.join(dir, 'workspaces', name);
    const bare = path.join(scratch, 'remote.git');
    git(scratch, 'init', '-q', '--bare', '-b', 'main', bare);
    if (!fs.existsSync(path.join(ws, '.git'))) git(ws, 'init', '-q');
    git(ws, 'checkout', '-q', '-B', 'main');
    git(ws, 'remote', 'add', 'origin', bare);
    fs.writeFileSync(path.join(ws, 'a.txt'), '1'); git(ws, 'add', 'a.txt'); git(ws, 'commit', '-q', '-m', 'shipped');
    const shipped = git(ws, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(ws, 'a.txt'), '2'); git(ws, 'commit', '-q', '-am', 'not shipped yet');
    git(ws, 'push', '-q', '-u', 'origin', 'main');
    fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), project: name, target: 'prod', status: 'success', commit: shipped }) + '\n');

    const prodOf = async () => {
      const j = await fetch(`${base}/api/projects/status`).then((r) => r.json());
      return j.projects.find((p) => p.name === name)?.prod ?? null;
    };
    const waiting = await until(async () => { const v = await prodOf(); return { done: !!v?.waiting, value: v }; });
    assert.equal(waiting.summary, '1 commit not in PROD');
    assert.match(waiting.lines.join('\n'), /not shipped yet/);

    fs.appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), project: name, target: 'prod', status: 'success', commit: git(ws, 'rev-parse', 'HEAD') }) + '\n');
    const clear = await until(async () => { const v = await prodOf(); return { done: v && v.waiting === false, value: v }; });
    assert.deepEqual(clear, { waiting: false, kind: 'app' });

    const html = await fetch(`${base}/term/${name}/`).then((r) => r.text());
    assert.match(html, /class="pk-prod"/, 'every rail tile carries the marker element');
    assert.match(html, /'\|prod'/, 'and the filter offers "Waiting for PROD"');
  }, { env: { PW_PROD_STATUS: 'on', PW_PROD_STATUS_FIRST_MS: '300', PW_PROD_STATUS_SECONDS: '5', PW_DEPLOY_LOG: log, PW_PROMOTE_SPOOL: path.join(scratch, 'promote') } });
});
