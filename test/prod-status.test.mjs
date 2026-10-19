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
  fastForwardWorkspace, fastForwardAsOwner, describeFastForward,
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

test('a hub and its tools: each stage on its own, and what the hub will and will not carry', async t => {
  const root = fixture(t);
  const hub = repo(t, root, 'Hub');
  const pinFile = 'src/Hub.Web/Hub.Web.csproj';
  const deployed = commit(hub, pinFile, csproj({ A: '1.26.1001.1000', B: '1.26.1001.1000', C: '1.26.1001.1000' }), 'base');
  git(hub, 'push', '-q', '-u', 'origin', 'main');
  // The way publish-to-hub.sh pins a tool: from its own clone of the hub, pushed straight to the
  // remote. The hub's workspace on this server does not see it until something fetches.
  const clone = path.join(root, 'publish-clone');
  git(root, 'clone', '-q', path.join(root, 'Hub.git'), clone);
  commit(clone, pinFile, csproj({ A: '1.26.1002.1000', B: '1.26.1001.1000', C: '1.26.1001.1000' }), 'Publish A 1.26.1002.1000');
  git(clone, 'push', '-q');

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
  assert.equal(plan.repos.find(r => r.id === 'Hub').fetch, true, 'only the hub is fetched');
  assert.ok(plan.repos.filter(r => r.id !== 'Hub').every(r => !r.fetch));
  const facts = {};
  for (const r of plan.repos) facts[r.id] = await inspectRepo(gitRunner(r.workspace), r);
  assert.equal(facts.Hub.fetched, true);
  assert.equal(git(hub, 'rev-parse', 'HEAD'), deployed, "the fetch leaves the hub's branch where it was");
  const s = summarize(plan, facts);

  assert.equal(s['Hub-Tool-A'].stage, 'hub', 'A is fully published: it only waits for the hub');
  assert.equal(s['Hub-Tool-A'].summary, "v1.26.1002.1000 is in Hub, waiting for Hub's PROD deploy (PROD has v1.26.1001.1000)");
  assert.equal(s['Hub-Tool-B'].stage, 'publish');
  assert.equal(s['Hub-Tool-B'].summary, '2 commits since v1.26.1001.1000, not published to Hub');
  assert.match(s['Hub-Tool-B'].lines.join('\n'), /work 1[\s\S]*work 0/);
  assert.equal(s['Hub-Tool-C'].stage, 'publish');
  assert.equal(s['Hub-Tool-C'].summary, 'v1.26.1003.1000 tagged but not pinned in Hub: the publish did not finish, publish again');
  assert.equal(s['Hub-Tool-D'].summary, 'never published to Hub');
  assert.equal(s.Hub.summary, '1 commit not in PROD');
  assert.ok(s.Hub.lines.includes('its next PROD deploy carries: A 1.26.1002.1000'), s.Hub.lines.join('\n'));
  const not = s.Hub.lines.find(l => l.startsWith('it will NOT carry yet'));
  assert.match(not, /B \(2 commits since v1\.26\.1001\.1000, not published\)/);
  assert.match(not, /C \(tagged but not pinned/);
  assert.match(not, /D \(never published\)/);

  // Once the hub deploys its tip, A is in PROD; the rest are unchanged.
  git(hub, 'merge', '-q', '--ff-only', 'origin/main');
  const after = planRepos(projects, { Hub: { commit: git(hub, 'rev-parse', 'HEAD') } });
  const f2 = { ...facts, Hub: await inspectRepo(gitRunner(hub), after.repos.find(r => r.id === 'Hub')) };
  const s2 = summarize(after, f2);
  assert.equal(s2.Hub.waiting, false, 'nothing to deploy in the hub itself');
  assert.match(s2.Hub.lines.join('\n'), /will NOT carry yet/, 'but it still says which tools are not in it');
  assert.deepEqual(s2['Hub-Tool-A'], { waiting: false, kind: 'tool' });
  assert.equal(s2['Hub-Tool-B'].stage, 'publish');
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

test('after a publish, the hub workspace is fast-forwarded only when that is plainly safe', async t => {
  const root = fixture(t);
  const hub = repo(t, root, 'Hub');
  commit(hub, 'pins.txt', '1', 'base');
  git(hub, 'push', '-q', '-u', 'origin', 'main');
  const clone = path.join(root, 'publish-clone');
  git(root, 'clone', '-q', path.join(root, 'Hub.git'), clone);
  const publish = (v) => { commit(clone, 'pins.txt', v, `Publish ${v}`); git(clone, 'push', '-q'); return git(clone, 'rev-parse', 'HEAD'); };

  // Clean and behind: fast-forwarded to exactly what the publish pushed.
  let tip = publish('2');
  const before = git(hub, 'rev-parse', 'HEAD');
  let r = await fastForwardWorkspace(gitRunner(hub));
  assert.equal(r.state, 'fast_forwarded');
  assert.deepEqual([r.from, r.to, r.count, r.upstream], [before, tip, 1, 'origin/main']);
  assert.equal(git(hub, 'rev-parse', 'HEAD'), tip);
  assert.equal(fs.readFileSync(path.join(hub, 'pins.txt'), 'utf8'), '2');
  assert.match(describeFastForward('Hub', r), /fast-forwarded to origin\/main \(1 commit, .{7}\.\..{7}\), so deploying Hub needs no git pull/);
  assert.equal((await fastForwardWorkspace(gitRunner(hub))).state, 'up_to_date');

  // An agent's uncommitted edit to a tracked file: left alone.
  tip = publish('3');
  fs.writeFileSync(path.join(hub, 'pins.txt'), 'agent was here');
  r = await fastForwardWorkspace(gitRunner(hub));
  assert.equal(r.state, 'skipped');
  assert.match(r.reason, /uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(hub, 'pins.txt'), 'utf8'), 'agent was here');
  assert.match(describeFastForward('Hub', r), /NOT updated — uncommitted changes.*git pull --ff-only` in Hub/);
  git(hub, 'checkout', '-q', '--', 'pins.txt');

  // An untracked file does not block it.
  fs.writeFileSync(path.join(hub, 'notes.md'), 'scratch');
  assert.equal((await fastForwardWorkspace(gitRunner(hub))).state, 'fast_forwarded');
  assert.equal(git(hub, 'rev-parse', 'HEAD'), tip);

  // Local commits the remote lacks: never merged or rebased for anyone.
  publish('4');
  commit(hub, 'other.txt', 'x', 'local work');
  const local = git(hub, 'rev-parse', 'HEAD');
  r = await fastForwardWorkspace(gitRunner(hub));
  assert.equal(r.state, 'skipped');
  assert.match(r.reason, /commits origin\/main does not/);
  assert.equal(git(hub, 'rev-parse', 'HEAD'), local);

  // A detached HEAD (how a rollback looks): left alone.
  git(hub, 'checkout', '-q', '--detach', 'HEAD~1');
  assert.equal((await fastForwardWorkspace(gitRunner(hub))).reason, 'detached HEAD');
});

test('the fast-forward runs in the helper process too', async t => {
  if (process.getuid?.() === 0) { t.skip('the helper refuses to run as root'); return; }
  const root = fixture(t);
  const hub = repo(t, root, 'Hub');
  commit(hub, 'a.txt', '1', 'base');
  git(hub, 'push', '-q', '-u', 'origin', 'main');
  const clone = path.join(root, 'c');
  git(root, 'clone', '-q', path.join(root, 'Hub.git'), clone);
  commit(clone, 'a.txt', '2', 'publish'); git(clone, 'push', '-q');
  const r = await fastForwardAsOwner(hub, { owner: null, currentUid: process.getuid() });
  assert.equal(r.state, 'fast_forwarded');
  assert.equal(git(hub, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'HEAD'));
  assert.equal((await fastForwardAsOwner(path.join(root, 'missing'), { owner: null, currentUid: process.getuid() })).state, 'skipped');
});
