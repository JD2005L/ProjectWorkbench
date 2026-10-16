// A thumb swipe scrolls a terminal's history on a phone (James, 2026-10-16: "I can't thumb scroll
// the tmux window's history"). The history is tmux's; app/terminal-preload.js replays a vertical
// swipe as the wheel notches a mouse would send, which tmux (mouse on) turns into copy-mode scrolling.
//
// Real everything: a private tmux server with a long history, the shipped ttyd started with the
// flags scripts/project-terminal-start uses, the preload injected before ttyd's own script (as
// nginx's sub_filter does), and touch input through Chromium's DevTools protocol. It needs a
// browser, which is not part of the canonical CI image (see test/cockpit-tabs-browser.test.mjs):
//   PW_PLAYWRIGHT_CORE  directory of a playwright-core package
//   PW_CHROMIUM         a Chromium executable that package can drive
// and /usr/bin/ttyd. Without them it is reported as SKIPPED with that reason, never as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixtureTmuxServer } from './tmux-owner-fixture.mjs';
import { scrubbedEnv } from './pane-env-fixture.mjs';

const PLAYWRIGHT = process.env.PW_PLAYWRIGHT_CORE || '';
const CHROMIUM = process.env.PW_CHROMIUM || '';
const TTYD = '/usr/bin/ttyd';
const skip = PLAYWRIGHT && CHROMIUM && fs.existsSync(PLAYWRIGHT) && fs.existsSync(CHROMIUM) && fs.existsSync(TTYD)
  ? false
  : 'needs PW_PLAYWRIGHT_CORE, PW_CHROMIUM and /usr/bin/ttyd; a browser is not part of the canonical CI image';
const PRELOAD = fileURLToPath(new URL('../app/terminal-preload.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('BROWSER: a thumb swipe scrolls tmux history, and a tap or a sideways swipe does not', { skip, timeout: 120000 }, async () => {
  const env = scrubbedEnv();
  const sock = `pwtouch-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const server = createFixtureTmuxServer({ socket: sock, session: 'demo', command: "bash --noprofile --norc -c 'seq 1 400; exec sleep 3600'", env });
  const tmux = (...args) => execFileSync('tmux', ['-L', sock, ...args], { env, encoding: 'utf8' }).trim();
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let ttyd = null;
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    tmux('set', '-g', 'mouse', 'on'); // as /etc/tmux.conf has it
    ttyd = spawn(TTYD, ['--interface', '127.0.0.1', '--port', String(port), '--base-path', '/pty/demo', '--writable',
      '--terminal-type', 'xterm-256color', '--client-option', 'fontFamily=monospace', '--client-option', 'fontSize=14',
      '--client-option', 'lineHeight=1', '--client-option', 'letterSpacing=0', '--client-option', 'disableLeaveAlert=true',
      '--check-origin', 'tmux', '-L', sock, 'attach', '-t', 'demo'], { env, stdio: 'ignore' });

    const ctx = await browser.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true });
    await ctx.addInitScript({ content: fs.readFileSync(PRELOAD, 'utf8') });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    for (let i = 0; ; i++) {
      try { await page.goto(`http://127.0.0.1:${port}/pty/demo/`); break; } catch (e) { if (i > 20) throw e; await sleep(150); }
    }
    await page.waitForSelector('.xterm-screen');
    for (let i = 0; i < 40 && !tmux('list-clients', '-t', 'demo'); i++) await sleep(150);
    await sleep(500);

    const state = () => {
      const [mode, pos] = tmux('display', '-p', '-t', 'demo', '#{pane_in_mode} #{scroll_position}').split(' ');
      return { mode: Number(mode), pos: Number(pos || 0) };
    };
    // Touch events carry their own timestamps, a phone's 12ms apart, so the flick below is a flick
    // however slowly a loaded host delivers them.
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts, timestamp) => cdp.send('Input.dispatchTouchEvent', { type, timestamp, touchPoints: pts.map(([x, y]) => ({ x, y })) });
    const swipe = async (x0, y0, x1, y1, { steps = 12, hold = 0.15 } = {}) => {
      const t0 = Date.now() / 1000;
      await touch('touchStart', [[x0, y0]], t0);
      for (let i = 1; i <= steps; i++) await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]], t0 + 0.012 * i);
      await touch('touchEnd', [], t0 + 0.012 * steps + hold);
      await sleep(400);
    };

    assert.deepEqual(state(), { mode: 0, pos: 0 }, 'starts live');
    const t0 = Date.now() / 1000;
    await touch('touchStart', [[200, 300]], t0);
    await touch('touchEnd', [], t0 + 0.05);
    await sleep(300);
    assert.deepEqual(state(), { mode: 0, pos: 0 }, 'a tap does not scroll');

    // From live output, even a short swipe shows something: tmux spends the first notch on
    // entering copy mode, and the preload pays for it up front.
    const rowPx = await page.evaluate(() => document.querySelector('.xterm-screen').clientHeight / window.term.rows);
    await swipe(200, 300, 200, 300 + 4 * rowPx, { steps: 4 });
    const short = state();
    assert.ok(short.mode === 1 && short.pos > 0, `a 4-row swipe already scrolls: ${JSON.stringify(short)}`);
    for (let i = 0; i < 6 && state().mode === 1; i++) await swipe(200, 600, 200, 100);
    assert.equal(state().mode, 0);

    await swipe(200, 150, 200, 600);
    const first = state();
    // "Can it thumb scroll a bit quicker?" (James, 2026-10-16): two lines of history per row of
    // finger travel, where it used to be one.
    const rows = 450 / rowPx;
    assert.ok(first.mode === 1 && first.pos >= 1.5 * rows, `a swipe down goes back about 2 lines per row travelled (${rows.toFixed(1)} rows): ${JSON.stringify(first)}`);
    await swipe(200, 600, 200, 300);
    assert.ok(state().pos < first.pos, 'a swipe up comes forward again');
    for (let i = 0; i < 6 && state().mode === 1; i++) await swipe(200, 600, 200, 100);
    assert.equal(state().mode, 0, 'at the bottom tmux leaves the history by itself');

    await swipe(200, 200, 200, 340, { steps: 4, hold: 0.012 });
    await sleep(1500);
    const flick = state();
    assert.ok(flick.mode === 1 && flick.pos >= 20, `a flick keeps going after the finger lifts: ${JSON.stringify(flick)}`);
    await swipe(60, 400, 330, 410);
    assert.equal(state().pos, flick.pos, 'a sideways swipe does not scroll');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    if (ttyd) ttyd.kill('SIGTERM');
    server?.release();
  }
});
