// What is waiting to reach PROD, per project — the amber marker on the project rail.
//
// Three kinds of project, told apart by name (see classifyProjects):
//
//   app    deployed straight to PROD from its own Deploy Centre prod slot. Waiting = commits on
//          the branch (local, pushed, or on the remote) that the last successful PROD deploy did
//          not ship.
//   hub    a package hub (STPDataHub, STPProjects): an app whose PROD deploy also ships every
//          tool version pinned in src/<Hub>.Web/<Hub>.Web.csproj. Waiting as an app, and it names
//          the tools it would carry.
//   tool   <Hub>-Tool-<Name>. Its "prod" slot only PUBLISHES to the hub (scripts/publish-to-hub.sh
//          tags the tool v<version> and pins <Hub>.Tool.<Name> [<version>] in the hub). Reaching
//          PROD takes two hops, and either can be the one outstanding:
//            1. commits since the newest v<version> tag: not yet published to the hub;
//            2. a published version the hub's PROD deploy does not pin yet: waiting for the hub.
//
// Which commit PROD runs comes from the deploy log: entries written since this file record the
// workspace HEAD a deploy finished on (`commit`); older ones are matched by time (the branch's
// newest commit before the deploy), and the result says it is approximate.
//
// Every Git read runs as the pane account in a child process (the same rule as source.js: root
// performs no filesystem operation below a path the terminal account controls). Remote tips come
// from `ls-remote`, and apps and tools are never fetched. HUBS are: a tool's publish pushes its pin
// to the hub from a temporary clone, so the hub's workspace never sees it otherwise, and without
// the pin at the hub's tip a published tool cannot be told from an unpublished one. That fetch
// (`git fetch --no-tags`, as the pane account) only moves the hub's remote-tracking refs; its
// branch and working tree are untouched. Anything that cannot be judged answers null, which the
// rail shows as no marker at all.
//
// A tool is in one of two stages, shown differently on the rail because they need different
// people to act: stage 'publish' (something in the tool is not in the hub: publish it) and stage
// 'hub' (everything is in the hub; it reaches PROD with the hub's next PROD deploy). The hub's
// tooltip lists both sides: what its next deploy carries, and which tools it will NOT carry yet.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { credentialDropArgv, credentialExecutionPlan } from '../user-credentials.js';
import { boundedCommand, gitEnvironment, gitRunner, checkUpstream } from './source.js';

const HELPER = fileURLToPath(import.meta.url);
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const VERSION = /^\d+(?:\.\d+){1,3}$/;
const MAX_SUBJECTS = 8;
const MAX_REPOS = 200;

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function hubCsproj(hub) { return `src/${hub}.Web/${hub}.Web.csproj`; }

// <PackageReference Include="<Hub>.Tool.<Name>" Version="[x]" /> → { <Name>: 'x' }
export function parsePins(text, hub) {
  const pins = {};
  if (typeof text !== 'string') return pins;
  const prefix = `${hub}.Tool.`;
  for (const m of text.matchAll(/<PackageReference\b[^>]*>/g)) {
    const include = /\bInclude="([^"]+)"/.exec(m[0])?.[1] || '';
    const version = /\bVersion="\[?([^\]"]+)\]?"/.exec(m[0])?.[1] || '';
    if (include.startsWith(prefix) && VERSION.test(version)) pins[include.slice(prefix.length)] = version;
  }
  return pins;
}

// names → { kinds: {name: 'app'|'hub'|'tool'}, tools: {name: {hub, tool}} }
export function classifyProjects(names) {
  const set = new Set(names);
  const kinds = {}, tools = {};
  for (const name of names) {
    const m = /^(.+?)-Tool-(.+)$/.exec(name);
    if (m && set.has(m[1])) { tools[name] = { hub: m[1], tool: m[2] }; kinds[name] = 'tool'; }
  }
  for (const name of names) {
    if (kinds[name]) continue;
    kinds[name] = Object.values(tools).some(t => t.hub === name) ? 'hub' : 'app';
  }
  return { kinds, tools };
}

// The newest successful PROD deploy per project: { name: { commit?, ts } }.
export function lastProdDeploys(entries) {
  const out = {};
  for (const e of entries || []) {
    if (!e || e.target !== 'prod' || e.status !== 'success' || typeof e.project !== 'string') continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (!out[e.project] || ts >= Date.parse(out[e.project].ts)) {
      out[e.project] = { ts: e.ts, ...(REVISION.test(e.commit || '') ? { commit: e.commit } : {}) };
    }
  }
  return out;
}

// ── Facts, read as the pane account ───────────────────────────────────────────────────────────

const text = async (runGit, args, options = {}) => (await runGit(args, { maxBytes: 65536, ...options })).toString('utf8').trim();
const quiet = async (fn) => { try { return await fn(); } catch { return null; } };

// One repository: where its branch is, what PROD runs, and what lies between.
//   deployed  { commit?, ts? } | null   the last PROD deploy (from lastProdDeploys)
//   csproj    path                       hubs: read the tool pins at both ends
//   tags      true                       tools: the newest v<version> tag and what came after it
//   remote    false                      skip ls-remote (tests; the deploy route's HEAD probe)
//   fetch     true                       hubs: fetch the branch's remote first (see the top)
export async function inspectRepo(runGit, { deployed = null, csproj = null, tags = false, remote = true, fetch = false } = {}) {
  const head = await quiet(() => text(runGit, ['rev-parse', '--verify', 'HEAD^{commit}']));
  if (!REVISION.test(head || '')) return { ok: false };
  const facts = { ok: true, head };
  if (fetch) facts.fetched = !!(await quiet(() => runGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head'], { timeoutMs: 30000, maxBytes: 65536 })));
  const refs = [head];
  const local = await quiet(() => text(runGit, ['rev-parse', '--verify', '--quiet', '@{upstream}^{commit}']));
  if (REVISION.test(local || '') && local !== head) refs.push(local);
  if (remote) {
    const up = await quiet(() => checkUpstream(runGit, { timeoutMs: 15000 }));
    if (up?.remoteTip && REVISION.test(up.remoteTip)) {
      facts.remoteTip = up.remoteTip;
      if (up.unfetched) facts.unfetched = true;
      else if (!refs.includes(up.remoteTip)) refs.push(up.remoteTip);
    }
  }
  // The newest commit any of the refs reaches (for the time match and the "would ship" end).
  const newest = await quiet(() => text(runGit, ['rev-list', '-1', '--date-order', ...refs])) || head;
  facts.newest = newest;
  const between = async (base) => {
    const count = Number(await text(runGit, ['rev-list', '--count', ...refs, `^${base}`]));
    const subjects = count ? (await text(runGit, ['log', `-${MAX_SUBJECTS}`, '--format=%h %s', ...refs, `^${base}`])).split('\n').filter(Boolean) : [];
    return { count: Number.isSafeInteger(count) ? count : null, subjects: subjects.map(s => s.slice(0, 120)) };
  };

  if (deployed) {
    let commit = null, approximate = false;
    if (deployed.commit && await quiet(() => runGit(['cat-file', '-e', `${deployed.commit}^{commit}`], { maxBytes: 256 }))) commit = deployed.commit;
    else if (deployed.ts) {
      const at = Math.floor(Date.parse(deployed.ts) / 1000);
      if (Number.isFinite(at)) {
        commit = await quiet(() => text(runGit, ['rev-list', '-1', '--first-parent', `--before=${at}`, newest]));
        approximate = true;
      }
    }
    if (REVISION.test(commit || '')) {
      facts.deployed = { commit, approximate, ts: deployed.ts || null, ...(await quiet(() => between(commit)) || { count: null, subjects: [] }) };
    }
  }
  if (csproj) {
    const at = async (rev) => (await quiet(() => text(runGit, ['show', `${rev}:${csproj}`], { maxBytes: 1024 * 1024 }))) ?? null;
    facts.csprojNewest = await at(newest);
    if (facts.deployed) facts.csprojDeployed = await at(facts.deployed.commit);
  }
  if (tags) {
    const list = (await quiet(() => text(runGit, ['tag', '--list', 'v*'])) || '').split('\n')
      .map(t => t.trim().slice(1)).filter(v => VERSION.test(v)).sort(compareVersions);
    const latest = list.at(-1) || null;
    facts.published = latest;
    if (latest) facts.sincePublished = await quiet(() => between(`v${latest}`));
  }
  return facts;
}

async function inspectAll(repos, { concurrency = 4 } = {}) {
  const out = {};
  const queue = repos.slice(0, MAX_REPOS);
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const r = queue.shift();
      out[r.id] = await quiet(() => inspectRepo(gitRunner(r.workspace), r)) || { ok: false };
    }
  }));
  return out;
}

export function helperArgv({ owner, currentUid = process.getuid?.() ?? null, execPath = process.execPath }) {
  if ((owner && (!Number.isSafeInteger(owner.uid) || owner.uid <= 0 || !Number.isSafeInteger(owner.gid) || owner.gid <= 0))
      || (!owner && (currentUid === null || currentUid === 0))) {
    throw new Error('PROD status requires a resolved non-root pane account; Git is not read as root.');
  }
  const plan = credentialExecutionPlan({ owner, currentUid });
  return [...(plan.drop ? credentialDropArgv({ owner, execPath, helperPath: HELPER }) : [execPath, HELPER]), '--prod-status'];
}

// repos: [{ id, workspace, deployed?, csproj?, tags?, remote? }] → { id: facts }
export async function readRepoFacts(repos, { owner, home, currentUid, env = process.env, spawnProcess = spawn, timeoutMs = 180000 }) {
  const raw = await boundedCommand(helperArgv({ owner, currentUid }), {
    input: JSON.stringify({ repos: repos.slice(0, MAX_REPOS) }), maxBytes: 8 * 1024 * 1024, timeoutMs,
    env: gitEnvironment(env, owner, home), spawnProcess,
  });
  const result = JSON.parse(raw.toString('utf8'));
  return result && typeof result === 'object' && result.ok === true ? result.facts : {};
}

// ── Facts → what the rail shows ───────────────────────────────────────────────────────────────

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// projects: [{ name, workspace }]; deploys: lastProdDeploys(); overrides: { name: { commit, ts } }
// (ProjectWorkbench itself reaches PROD by promote, not by a Deploy Centre slot).
export function planRepos(projects, deploys, overrides = {}) {
  const { kinds, tools } = classifyProjects(projects.map(p => p.name));
  const repos = [];
  for (const p of projects) {
    if (!p.workspace) continue;
    const kind = kinds[p.name];
    const deployed = overrides[p.name] || deploys[p.name] || null;
    if (kind === 'tool') repos.push({ id: p.name, workspace: p.workspace, tags: true });
    else if (kind === 'hub') repos.push({ id: p.name, workspace: p.workspace, deployed, csproj: hubCsproj(p.name), fetch: true });
    else if (deployed) repos.push({ id: p.name, workspace: p.workspace, deployed });
  }
  return { repos, kinds, tools };
}

// → { name: { waiting, kind, stage?, summary, lines[], approximate } | null }
export function summarize({ kinds, tools }, facts) {
  const out = {};
  const pinsOf = (hub, which) => parsePins(facts[hub]?.[which], hub);
  const carries = {}, missing = {};
  for (const [name, { hub, tool }] of Object.entries(tools)) {
    const f = facts[name];
    if (!f?.ok) { out[name] = null; continue; }
    const hubFacts = facts[hub]?.ok ? facts[hub] : null;
    const pinned = hubFacts ? pinsOf(hub, 'csprojNewest')[tool] : undefined;
    const live = hubFacts?.deployed ? pinsOf(hub, 'csprojDeployed')[tool] : undefined;
    const since = f.published ? (f.sincePublished?.count || 0) : 0;
    const publish = [], hubWait = [];
    if (!f.published) publish.push(`never published to ${hub}`);
    else {
      // A tag the hub never pinned is a publish that stopped part-way (the tag is made before the
      // hub's tests and push): it is not on its way to PROD at all.
      if (hubFacts && (!pinned || compareVersions(f.published, pinned) > 0)) {
        publish.push(hubFacts.unfetched && !hubFacts.fetched
          ? `v${f.published} tagged; not in ${hub} as this server last saw it`
          : `v${f.published} tagged but not pinned in ${hub}: the publish did not finish, publish again`);
      }
      if (since) publish.push(`${plural(since, 'commit')} since v${f.published}, not published to ${hub}`, ...f.sincePublished.subjects.map(s => `  ${s}`));
    }
    if (pinned && hubFacts?.deployed && (!live || compareVersions(pinned, live) > 0)) {
      hubWait.push(`v${pinned} is in ${hub}, waiting for ${hub}'s PROD deploy${live ? ` (PROD has v${live})` : ''}`);
      (carries[hub] ||= []).push(`${tool} ${pinned}`);
    }
    if (publish.length) (missing[hub] ||= []).push(`${tool} (${publish[0].replace(` to ${hub}`, '').replace(/^v[\d.]+ /, '')})`);
    const lines = [...publish, ...hubWait];
    if (!lines.length) { out[name] = { waiting: false, kind: 'tool' }; continue; }
    // Anything to publish is this project's own job, so it wins the stage.
    out[name] = { waiting: true, kind: 'tool', stage: publish.length ? 'publish' : 'hub', summary: lines[0], lines, approximate: false };
  }
  for (const [name, kind] of Object.entries(kinds)) {
    if (kind === 'tool') continue;
    const f = facts[name];
    if (!f?.ok || !f.deployed) { out[name] = null; continue; }
    const lines = [];
    const n = f.deployed.count || 0;
    if (n) lines.push(`${plural(n, 'commit')} not in PROD`, ...f.deployed.subjects.map(s => `  ${s}`));
    if (f.unfetched && !f.fetched) lines.push('the remote has newer commits this server has not fetched');
    if (kind === 'hub' && carries[name]?.length) lines.push(`its next PROD deploy carries: ${carries[name].join(', ')}`);
    if (kind === 'hub' && missing[name]?.length) lines.push(`it will NOT carry yet (publish first): ${missing[name].join('; ')}`);
    const waiting = !!(n || (f.unfetched && !f.fetched) || carries[name]?.length);
    if (!waiting) { out[name] = lines.length ? { waiting: false, kind, lines } : { waiting: false, kind }; continue; }
    const summary = n ? lines[0] : (carries[name]?.length ? `carries ${carries[name].length} tool update${carries[name].length === 1 ? '' : 's'} to PROD` : lines[0]);
    if (f.deployed.approximate) lines.push('(last PROD deploy matched by time; approximate)');
    out[name] = { waiting: true, kind, summary, lines, approximate: !!f.deployed.approximate };
  }
  return out;
}

async function helperMain() {
  let result = { ok: false };
  try {
    if (!process.getuid || process.getuid() === 0) throw new Error('refusing to run as root');
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('request too large');
    }
    const request = JSON.parse(raw);
    const repos = (Array.isArray(request.repos) ? request.repos : []).filter(r => r && typeof r.id === 'string'
      && typeof r.workspace === 'string' && path.isAbsolute(r.workspace)).map(r => ({
      id: r.id, workspace: r.workspace, deployed: r.deployed && typeof r.deployed === 'object' ? r.deployed : null,
      csproj: typeof r.csproj === 'string' && /^[A-Za-z0-9._\/-]{1,200}$/.test(r.csproj) && !r.csproj.split('/').includes('..') ? r.csproj : null,
      tags: r.tags === true, remote: r.remote !== false, fetch: r.fetch === true,
    }));
    result = { ok: true, facts: await inspectAll(repos) };
  } catch { result = { ok: false }; }
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === HELPER && process.argv[2] === '--prod-status') await helperMain();
