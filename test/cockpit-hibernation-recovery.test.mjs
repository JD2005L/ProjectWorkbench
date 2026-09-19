// A hibernated conversation must be VISIBLE to the browser, and recoverable from it.
//
// Hibernation stops an idle Claude and leaves a placeholder in its tmux window. Everything it does
// is deliberately silent — no bell, no output — so every signal the dashboard reads (bell, working,
// pending, window activity) is identical to an idle live window. A project holding a hibernated
// conversation therefore rendered as perfectly healthy, and the only way back was to reopen the
// project and press Enter at the placeholder's banner. Worse, once pw-claude-wait spends its
// automatic retries it stops advertising @pw_claude_waiting and no tmux hook can resume it at all.
//
// So the windows API now reports the hibernation markers, and a window can be woken through the
// same script the hooks use. These run against a real dashboard process and a real tmux server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmux, withCockpit } from './cockpit-instance-fixture.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAKE = path.join(REPO, 'scripts', 'pw-claude-wake');
const SID = '11111111-2222-3333-4444-555555555555';

const windowsOf = async (base, name) => {
  const res = await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`);
  assert.equal(res.status, 200, 'the windows API must answer');
  const body = await res.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.windows;
};

test('a hibernated window is reported as hibernated, and a stray marker cannot fake one', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock, dir }) => {
    const session = `pw_${name}`;
    await tmux(sock, ['new-window', '-d', '-t', session]);
    const ids = (await tmux(sock, ['list-windows', '-t', session, '-F', '#{window_index} #{window_id}']))
      .split('\n').filter(Boolean).map((l) => l.split(' '));
    assert.ok(ids.length >= 2, 'the fixture needs two windows to tell scoped markers apart');
    const [firstIndex, firstId] = ids[0];

    const before = await windowsOf(base, name);
    assert.equal(before.length, ids.length);
    assert.ok(before.every((w) => w.hibernated === false),
      'a window with no markers is never reported hibernated');

    // Exactly what scripts/pw-claude-hibernate stamps on a window it hibernates.
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_sid', SID]);
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_hib_win', firstId]);
    const marked = await windowsOf(base, name);
    const first = marked.find((w) => String(w.index) === firstIndex);
    assert.equal(first.hibernationMarkers, true, 'the marked window carries the markers');
    assert.equal(first.windowId, firstId);
    assert.equal(first.autoResume, false,
      'nothing is advertising a placeholder, so no tmux hook can resume this one');
    // REGRESSION: markers alone are not hibernation. pw-claude-wait keeps them across a resume, so
    // reporting on markers would badge a window whose conversation is already back and running —
    // the same false-healthy error in the opposite direction. Only the placeholder actually
    // sitting in the pane means "waiting to resume".
    assert.equal(first.hibernated, false,
      'a marked window whose pane is not the waiting placeholder is not hibernated');
    assert.equal(marked.filter((w) => w.hibernated).length, 0);

    // @pw_claude_sid resolves up the pane→window→session→global chain, so a marker set at SESSION
    // scope is visible on every window. Only @pw_claude_hib_win naming the window itself makes it
    // hibernated — the same rule scripts/pw-tmux-save applies before it records a resume id.
    await tmux(sock, ['set-option', '-t', session, '@pw_claude_sid', SID]);
    const stray = await windowsOf(base, name);
    assert.equal(stray.filter((w) => w.hibernationMarkers).length, 1,
      'a session-scope marker must not make every window look hibernated');

    // The placeholder advertising itself is what the hooks look for.
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_waiting', `${process.pid}:1`]);
    const armed = await windowsOf(base, name);
    assert.equal(armed.find((w) => String(w.index) === firstIndex).autoResume, true);

    // And a window that really is waiting: pw-claude-wait re-execs itself under this name, which is
    // what tmux reports as the pane's foreground job.
    const standIn = path.join(dir, 'claude-resume');
    // `exec -a claude-resume`, exactly as scripts/pw-claude-wait renames itself: tmux reports the
    // pane's foreground job from its argv[0], which is the whole reason that rename exists.
    fs.writeFileSync(standIn, '#!/bin/bash\nexec -a claude-resume /bin/bash -c \'read -r _\'\n');
    fs.chmodSync(standIn, 0o755);
    const waitingId = (await tmux(sock, ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', session, standIn])).trim();
    await tmux(sock, ['set-option', '-w', '-t', waitingId, '@pw_claude_sid', SID]);
    await tmux(sock, ['set-option', '-w', '-t', waitingId, '@pw_claude_hib_win', waitingId]);
    let waiting = null;
    for (let i = 0; i < 40 && !waiting?.hibernated; i++) {
      waiting = (await windowsOf(base, name)).find((w) => w.windowId === waitingId);
      if (!waiting?.hibernated) await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(waiting.hibernated, true, 'a window whose pane holds the waiting placeholder IS hibernated');

    // REGRESSION: and a placeholder that has RESUMED its conversation is not. It keeps the
    // `claude-resume` name and the markers while that Claude runs, so the only thing that separates
    // the two states is the process tree — a waiting placeholder has no child, a resumed one has
    // the Claude as its child. Reading it the other way badges a live conversation and then sends
    // it an Enter, submitting whatever the person had half-typed.
    const busy = path.join(dir, 'claude-resume-busy');
    fs.writeFileSync(busy, '#!/bin/bash\nexec -a claude-resume /bin/bash -c \'sleep 300 & read -r _\'\n');
    fs.chmodSync(busy, 0o755);
    const busyId = (await tmux(sock, ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', session, busy])).trim();
    await tmux(sock, ['set-option', '-w', '-t', busyId, '@pw_claude_sid', SID]);
    await tmux(sock, ['set-option', '-w', '-t', busyId, '@pw_claude_hib_win', busyId]);
    let busyRow = null;
    for (let i = 0; i < 40; i++) {
      busyRow = (await windowsOf(base, name)).find((w) => w.windowId === busyId);
      if (busyRow?.hibernationMarkers) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(busyRow.hibernationMarkers, true, 'it carries the same markers');
    assert.equal(busyRow.hibernated, false,
      'but a placeholder holding a conversation OPEN is not waiting to reopen one');
  }, { prefix: 'pw-hib-' });
});

test('the wake route answers honestly instead of reporting a resume it never performed', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock }) => {
    const session = `pw_${name}`;
    const wake = (index) => fetch(`${base}/api/term/${encodeURIComponent(name)}/windows/${index}/wake`, { method: 'POST' })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

    // A window nobody hibernated is not an error — it is already where the caller wants it.
    const live = await wake(0);
    assert.equal(live.status, 200);
    assert.deepEqual([live.body.ok, live.body.woke], [true, false]);
    assert.match(live.body.reason, /not hibernated/);

    const firstId = (await tmux(sock, ['list-windows', '-t', session, '-F', '#{window_id}'])).split('\n')[0].trim();
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_sid', SID]);
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_hib_win', firstId]);

    // Marked, but the pane holds a shell rather than a waiting placeholder: pressing Enter would
    // run whatever is typed at that prompt, so the wake must decline — and the route must pass that
    // refusal through as woke:false with the reason, not swallow it into a cheerful ok:true.
    const asked = await wake(0);
    assert.equal(asked.status, 200);
    assert.equal(asked.body.ok, true);
    assert.equal(asked.body.woke, false, 'no resume happened, so none may be claimed');
    assert.ok(asked.body.reason && asked.body.reason.length > 0, 'and the reason reaches the caller');
    assert.ok(Array.isArray(asked.body.windows), 'the caller gets fresh window state to re-render from');

    const unknown = await wake(99);
    assert.equal(unknown.status, 404);
  }, { prefix: 'pw-hibwake-', env: { PW_CLAUDE_WAKE_BIN: WAKE } });
});

test('the wake route is the terminal\'s own authorization, and the cockpit asks at most once per window', () => {
  const server = fs.readFileSync(path.join(REPO, 'app', 'server.js'), 'utf8');
  // Sending a keystroke into someone's terminal may never sit behind a weaker gate than reading it.
  assert.match(server, /app\.post\(BASE \+ '\/api\/term\/:project\/windows\/:index\/wake', requireTerminalAccess,/,
    'the wake route must use requireTerminalAccess, exactly like every other window route');
  // One request per window per page load. The automatic retry cap in pw-claude-wait exists to stop
  // a broken resume looping; the cockpit must not become a new loop around it.
  assert.match(server, /if\(!w\|\|wakeAttempted\.has\(w\.index\)\)return;wakeAttempted\.add\(w\.index\)/,
    'the cockpit must guard its automatic wake with a per-window attempt set');
  assert.match(server, /const w=\(windows\|\|\[\]\)\.find\(x=>x\.active&&x\.hibernated\)/,
    'and only ever ask for the window the user is actually looking at');
});

test('a wake helper that cannot be run is reported, not raised as a 500', { timeout: 120000 }, async () => {
  // The helper used to be named by an absolute install path, which exists on a host install and
  // never in a container image — so on a container deployment every wake spawned a path that was
  // not there. ENOENT's code is the string 'ENOENT', not 1, so it escaped the refusal guard and
  // surfaced as a 500 carrying a raw spawn error: nothing the cockpit could say to anyone, and the
  // cause buried in the server log. Resolution now covers both layouts (shipped-helpers.test.mjs);
  // this pins the other half — that a helper which genuinely cannot be run still ANSWERS.
  await withCockpit(async ({ base, name, sock }) => {
    const session = `pw_${name}`;
    const firstId = (await tmux(sock, ['list-windows', '-t', session, '-F', '#{window_id}'])).split('\n')[0].trim();
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_sid', SID]);
    await tmux(sock, ['set-option', '-w', '-t', firstId, '@pw_claude_hib_win', firstId]);

    const res = await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows/0/wake`, { method: 'POST' });
    assert.equal(res.status, 200, 'a missing helper is an answer, not a server fault');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.woke, false, 'and it may never claim a resume it did not perform');
    assert.match(body.reason, /could not be run/, 'the reason has to say what went wrong');
    assert.match(body.reason, /no-such-wake-helper/, 'and name the path it tried');
  }, { prefix: 'pw-hibmissing-', env: { PW_CLAUDE_WAKE_BIN: '/usr/local/bin/no-such-wake-helper' } });
});

test('the wake helper is run as the account that owns the sessions, never as root', () => {
  // The dashboard is root in host mode. tmuxOwned is what drops to the terminal account for a
  // tmux-adjacent tool; routing the wake anywhere else would hand a root shell a keystroke path
  // into someone's pane.
  const server = fs.readFileSync(path.join(REPO, 'app', 'server.js'), 'utf8');
  assert.match(server, /await tmuxOwned\(CLAUDE_WAKE_HELPER,/, 'the wake must go through tmuxOwned');
  const fn = server.slice(server.indexOf('function tmuxOwned('), server.indexOf('function parseTmuxWindows('));
  assert.match(fn, /DEPLOY_MODE === 'container'/, 'container runs it directly, in the one account that exists there');
  assert.match(fn, /execFileAsync\('sudo',\['-u',hostTerminalUser\(process\.env\),file,\.\.\.args\]/,
    'host mode must drop privilege to the resolved terminal user, by argv, with no shell');
});
