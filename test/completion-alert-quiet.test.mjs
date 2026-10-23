// A session the agent API made for automation (window option @pw_quiet=1, agent-sessions.js
// MARKER_QUIET) never lights the amber completion alert for people: not its tab, not the
// project's key. Real tmux, real server; the bell is a real BEL in a real background window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCockpit, tmux } from './cockpit-instance-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last.ok) return last.value; await sleep(200); }
  assert.fail(`timed out; last: ${JSON.stringify(last?.value)}`);
}

test('a quiet window rings, but neither its tab nor the project lights; a normal one does', { timeout: 90000 }, async () => {
  await withCockpit(async ({ base, name, sock }) => {
    const session = `pw_${name}`;
    await until(async () => {
      try { await tmux(sock, ['has-session', '-t', session]); return { ok: true }; }
      catch { await fetch(`${base}/term/${name}/`).catch(() => {}); return { ok: false, value: 'no session yet' }; }
    });
    const ring = async (win) => tmux(sock, ['send-keys', '-t', `${session}:${win}`, "printf '\\a'", 'Enter']);
    await tmux(sock, ['new-window', '-d', '-t', session, '-n', 'dependabot', 'bash --noprofile --norc']);
    await tmux(sock, ['set-option', '-w', '-t', `${session}:dependabot`, '@pw_quiet', '1']);
    await ring('dependabot');

    const windows = async () => (await fetch(`${base}/api/term/${name}/windows`).then((r) => r.json())).windows;
    const bot = await until(async () => { const w = (await windows()).find((x) => x.name === 'dependabot'); return { ok: !!w?.bell, value: w }; });
    assert.equal(bot.quiet, true, 'the window reports quiet, with its raw bell intact for the agent API');
    const status = async () => (await fetch(`${base}/api/projects/status`).then((r) => r.json())).projects.find((p) => p.name === name);
    let s = await status();
    assert.equal(s.bell, false, 'the project key does not light for a quiet window');
    assert.equal(s.pending, false);

    // Made by the API before the marker existed: token marker, no @pw_quiet. Excluded too.
    await tmux(sock, ['new-window', '-d', '-t', session, '-n', 'eod-commit', 'bash --noprofile --norc']);
    await tmux(sock, ['set-option', '-w', '-t', `${session}:eod-commit`, '@pw_agent_token', 'tok-old']);
    await ring('eod-commit');
    const eod = await until(async () => { const w = (await windows()).find((x) => x.name === 'eod-commit'); return { ok: !!w?.bell, value: w }; });
    assert.equal(eod.quiet, true, 'an API window from before the marker is excluded');
    assert.equal((await status()).bell, false);
    // notify: true on an API window is an explicit '0': included.
    await tmux(sock, ['new-window', '-d', '-t', session, '-n', 'asked', 'bash --noprofile --norc']);
    await tmux(sock, ['set-option', '-w', '-t', `${session}:asked`, '@pw_agent_token', 'tok-new']);
    await tmux(sock, ['set-option', '-w', '-t', `${session}:asked`, '@pw_quiet', '0']);
    assert.equal((await windows()).find((x) => x.name === 'asked').quiet, false);
    await tmux(sock, ['new-window', '-d', '-t', session, '-n', 'kevin', 'bash --noprofile --norc']);
    await ring('kevin');
    s = await until(async () => { const v = await status(); return { ok: !!v?.bell, value: v }; });
    assert.equal(s.pending, true, 'a normal window still lights it');
    const kev = (await windows()).find((x) => x.name === 'kevin');
    assert.equal(kev.quiet, false);
  });
});

test('the cockpit tab ignores a quiet window\'s bell, and says why', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  assert.match(src, /const outc=\(w\.bell&&!w\.active&&!w\.quiet\)\?\(w\.outcome\|\|''\):'';const needsAttention=w\.bell&&!w\.active&&!w\.quiet&&/);
  assert.match(src, /if\(w\.quiet\)tab\.title\+=' \\u2014 completion alerts off \(started through the agent API\)';/);
  const hook = fs.readFileSync(new URL('../scripts/pw-stop-hook.sh', import.meta.url), 'utf8');
  assert.match(hook, /\[ "\$\{PW_COMPLETION_ALERT:-\}" = off \] && exit 0/, 'the host-mode Stop hook writes no pending marker for one');
});
