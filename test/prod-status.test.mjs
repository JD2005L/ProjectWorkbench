// What is waiting to reach PROD (app/deployment/prod-status.js), against real Git: an app, a
// package hub and one of its tools, each with a bare remote, deployed and published the way the
// Deploy Centre and scripts/publish-to-hub.sh leave them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitRunner } from '../app/deployment/source.js';
import {
  compareVersions, parsePins, classifyProjects, lastProdDeploys, planRepos, inspectRepo, summarize, readRepoFacts,
} from '../app/deployment/prod-status.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function repo(t, root, name) {
  const bare = path.join(root, `${name}.git`), ws = path.join(root, name);
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, ws);
  git(ws, 'checkout', '-q', '-b', 'main');
  return ws;
}
function commit(ws, file, body, message, when) {
  fs.mkdirSync(path.dirname(path.join(ws, file)), { recursive: true });
  fs.writeFileSync(path.join(ws, file), body);
  git(ws, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: ws, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) } });
  return git(ws, 'rev-parse', 'HEAD');
}
const csproj = (pins) => `<Project>\n  <ItemGroup>\n${Object.entries(pins).map(([n, v]) => `    <PackageReference Include="Hub.Tool.${n}" Version="[${v}]" />`).join('\n')}\n    <PackageReference Include="Other.Thing" Version="2.0.0" />\n  </ItemGroup>\n</Project>\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-prod-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('versions, pins, kinds and the newest PROD deploy', () => {
  assert.equal(compareVersions('1.26.1016.1611', '1.26.1016.1149'), 1);
  assert.equal(compareVersions('1.26.109.905', '1.26.1016.1149'), -1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.deepEqual(parsePins(csproj({ A: '1.26.1016.1149', B: '1.26.1019.1033' }), 'Hub'), { A: '1.26.1016.1149', B: '1.26.1019.1033' });
  assert.deepEqual(parsePins('<PackageReference Include="Hubby.Tool.X" Version="[1.0]" />', 'Hub'), {});
  const c = classifyProjects(['Hub', 'Hub-Tool-A', 'Orphan-Tool-B', 'App']);
  assert.deepEqual(c.kinds, { Hub: 'hub', 'Hub-Tool-A': 'tool', 'Orphan-Tool-B': 'app', App: 'app' });
  assert.deepEqual(c.tools, { 'Hub-Tool-A': { hub: 'Hub', tool: 'A' } });
  const sha = 'a'.repeat(40);
  assert.deepEqual(lastProdDeploys([
    { project: 'App', target: 'prod', status: 'success', ts: '2026-10-01T00:00:00Z' },
    { project: 'App', target: 'prod', status: 'success', ts: '2026-10-02T00:00:00Z', commit: sha },
    { project: 'App', target: 'prod', status: 'failed', ts: '2026-10-03T00:00:00Z' },
    { project: 'App', target: 'dev', status: 'success', ts: '2026-10-04T00:00:00Z' },
    { project: 'Other', target: 'prod', status: 'success', ts: '2026-10-01T00:00:00Z', commit: 'not-a-sha' },
  ]), { App: { ts: '2026-10-02T00:00:00Z', commit: sha }, Other: { ts: '2026-10-01T00:00:00Z' } });
});

test('an app: commits since the recorded deploy, pushed or not; nothing waiting once deployed', async t => {
  const root = fixture(t);
  const ws = repo(t, root, 'App');
  const shipped = commit(ws, 'a.txt', '1', 'first');
  git(ws, 'push', '-q', '-u', 'origin', 'main');
  commit(ws, 'a.txt', '2', 'second'); git(ws, 'push', '-q');
  commit(ws, 'a.txt', '3', 'third, not pushed');
  const projects = [{ name: 'App', workspace: ws }, { name: 'Never', workspace: ws }];
  const plan = planRepos(projects, { App: { commit: shipped, ts: new Date().toISOString() } });
  assert.deepEqual(plan.repos.map(r => r.id), ['App'], 'a project never deployed to PROD is not judged');
  const facts = { App: await inspectRepo(gitRunner(ws), plan.repos[0]) };
  const s = summarize(plan, facts);
  assert.equal(s.App.waiting, true);
  assert.equal(s.App.summary, '2 commits not in PROD');
  assert.match(s.App.lines.join('\n'), /third, not pushed[\s\S]*second/);
  assert.equal(s.App.approximate, false);
  assert.equal(s.Never, null);

  const now = summarize(plan, { App: await inspectRepo(gitRunner(ws), { deployed: { commit: git(ws, 'rev-parse', 'HEAD') } }) });
  assert.deepEqual(now.App, { waiting: false, kind: 'app' });
});

test('an old deploy without a commit is matched by time and says it is approximate', async t => {
  const root = fixture(t);
  const ws = repo(t, root, 'App');
  commit(ws, 'a.txt', '1', 'before', '2026-10-01T10:00:00Z');
  commit(ws, 'a.txt', '2', 'after', '2026-10-01T12:00:00Z');
  git(ws, 'push', '-q', '-u', 'origin', 'main');
  const plan = planRepos([{ name: 'App', workspace: ws }], { App: { ts: '2026-10-01T11:00:00Z' } });
  const s = summarize(plan, { App: await inspectRepo(gitRunner(ws), plan.repos[0]) });
  assert.equal(s.App.summary, '1 commit not in PROD');
  assert.equal(s.App.approximate, true);
  assert.match(s.App.lines.at(-1), /approximate/);
});

test('a remote ahead of what this server fetched is still reported as waiting', async t => {
  const root = fixture(t);
  const ws = repo(t, root, 'App');
  const shipped = commit(ws, 'a.txt', '1', 'first');
  git(ws, 'push', '-q', '-u', 'origin', 'main');
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', path.join(root, 'App.git'), other);
  commit(other, 'a.txt', '2', 'pushed from elsewhere'); git(other, 'push', '-q');
  const plan = planRepos([{ name: 'App', workspace: ws }], { App: { commit: shipped } });
  const s = summarize(plan, { App: await inspectRepo(gitRunner(ws), plan.repos[0]) });
  assert.equal(s.App.waiting, true);
  assert.match(s.App.summary, /remote has newer commits/);
  assert.equal(fs.existsSync(path.join(ws, '.git', 'FETCH_HEAD')), false, 'nothing is fetched');
});

test('a hub and its tools: unpublished work, a publish waiting for the hub, a stalled publish, and what the hub carries', async t => {
  const root = fixture(t);
  const hub = repo(t, root, 'Hub');
  const pinFile = 'src/Hub.Web/Hub.Web.csproj';
  const deployed = commit(hub, pinFile, csproj({ A: '1.26.1001.1000', B: '1.26.1001.1000', C: '1.26.1001.1000' }), 'base');
  git(hub, 'push', '-q', '-u', 'origin', 'main');
  commit(hub, pinFile, csproj({ A: '1.26.1002.1000', B: '1.26.1001.1000', C: '1.26.1001.1000' }), 'Publish A 1.26.1002.1000');
  git(hub, 'push', '-q');

  const tools = {};
  for (const [name, tags, extra] of [['A', ['1.26.1001.1000', '1.26.1002.1000'], 0], ['B', ['1.26.1001.1000'], 2], ['C', ['1.26.1001.1000', '1.26.1003.1000'], 0], ['D', [], 1]]) {
    const ws = repo(t, root, `Hub-Tool-${name}`);
    commit(ws, 'x.txt', 'base', 'base');
    for (const v of tags) { commit(ws, 'v.txt', v, `Release ${name} ${v}`); git(ws, 'tag', `v${v}`); }
    for (let i = 0; i < extra; i++) commit(ws, 'x.txt', String(i), `work ${i}`);
    git(ws, 'push', '-q', '-u', 'origin', 'main', '--tags');
    tools[name] = ws;
  }
  const projects = [{ name: 'Hub', workspace: hub }, ...Object.entries(tools).map(([n, ws]) => ({ name: `Hub-Tool-${n}`, workspace: ws }))];
  const plan = planRepos(projects, { Hub: { commit: deployed } });
  const facts = {};
  for (const r of plan.repos) facts[r.id] = await inspectRepo(gitRunner(r.workspace), r);
  const s = summarize(plan, facts);

  assert.equal(s['Hub-Tool-A'].summary, 'v1.26.1002.1000 published, waiting for Hub PROD deploy');
  assert.equal(s['Hub-Tool-B'].summary, '2 commits not published to Hub');
  assert.match(s['Hub-Tool-B'].lines.join('\n'), /work 1[\s\S]*work 0/);
  assert.equal(s['Hub-Tool-C'].summary, 'v1.26.1003.1000 tagged but not pinned in Hub: the publish did not finish, publish again');
  assert.equal(s['Hub-Tool-D'].summary, 'never published to Hub');
  assert.equal(s.Hub.summary, '1 commit not in PROD');
  assert.ok(s.Hub.lines.includes('carries A 1.26.1002.1000'), s.Hub.lines.join('\n'));
  assert.ok(!s.Hub.lines.some(l => /C 1\.26\.1003/.test(l)), 'a tag the hub never pinned is not carried');

  // Once the hub deploys its tip, A is in PROD; the rest are unchanged.
  const after = planRepos(projects, { Hub: { commit: git(hub, 'rev-parse', 'HEAD') } });
  const f2 = { ...facts, Hub: await inspectRepo(gitRunner(hub), after.repos.find(r => r.id === 'Hub')) };
  const s2 = summarize(after, f2);
  assert.deepEqual(s2.Hub, { waiting: false, kind: 'hub' });
  assert.deepEqual(s2['Hub-Tool-A'], { waiting: false, kind: 'tool' });
  assert.equal(s2['Hub-Tool-B'].waiting, true);
});

test('the helper process answers the same facts, and nothing under .git is written', async t => {
  const root = fixture(t);
  const ws = repo(t, root, 'App');
  const shipped = commit(ws, 'a.txt', '1', 'first');
  git(ws, 'push', '-q', '-u', 'origin', 'main');
  commit(ws, 'a.txt', '2', 'second');
  const before = execFileSync('find', [path.join(ws, '.git'), '-newer', path.join(ws, '.git', 'HEAD')], { encoding: 'utf8' });
  const uid = process.getuid();
  if (uid === 0) { t.skip('the helper refuses to run as root'); return; }
  const facts = await readRepoFacts([{ id: 'App', workspace: ws, deployed: { commit: shipped } }, { id: 'Gone', workspace: path.join(root, 'nope') }],
    { owner: null, currentUid: uid });
  assert.equal(facts.App.ok, true);
  assert.equal(facts.App.deployed.count, 1);
  assert.deepEqual(facts.Gone, { ok: false });
  const afterFiles = execFileSync('find', [path.join(ws, '.git'), '-newer', path.join(ws, '.git', 'HEAD')], { encoding: 'utf8' });
  assert.equal(afterFiles, before);
});

test('the helper refuses to be started as root', async () => {
  await assert.rejects(readRepoFacts([], { owner: null, currentUid: 0 }), /non-root pane account/);
  await assert.rejects(readRepoFacts([], { owner: { uid: 0, gid: 0, user: 'root' }, currentUid: 0 }), /non-root pane account/);
});
