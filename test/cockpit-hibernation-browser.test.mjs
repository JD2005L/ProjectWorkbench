// The whole point of the change, in a real browser: a person sitting on the project cockpit gets a
// hibernated conversation back without doing anything, and can see that it happened.
//
// The defect was browser-shaped, so this is the test that actually describes it. A window whose
// placeholder has spent its automatic retries is unreachable by every tmux wake hook; nothing in
// the cockpit showed it, and nothing in the cockpit could end it. Here the page is opened and left
// alone — no click, no keystroke — and the window must come back on its own.
//
// A browser is not part of the canonical CI image, so this runs only when both are provided:
//   PW_PLAYWRIGHT_CORE  directory of a playwright-core package
//   PW_CHROMIUM         a Chromium executable that package can drive
// Without them the test is reported as SKIPPED with that reason, never as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmux, withCockpit } from './cockpit-instance-fixture.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAKE = path.join(REPO, 'scripts', 'pw-claude-wake');
const SID = '99999999-8888-7777-6666-555555555555';
const PLAYWRIGHT = process.env.PW_PLAYWRIGHT_CORE || '';
const CHROMIUM = process.env.PW_CHROMIUM || '';
const skip = PLAYWRIGHT && CHROMIUM && fs.existsSync(PLAYWRIGHT) && fs.existsSync(CHROMIUM)
  ? false
  : 'needs PW_PLAYWRIGHT_CORE and PW_CHROMIUM; a browser is not part of the canonical CI image';

/** A real tmux client, as the cockpit's own terminal is: the wake only ever fires where someone looks. */
function attachClient(sock, session) {
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.TMUX;
  return spawn('script', ['-qfec', `tmux -L ${sock} attach -t ${session}`, '/dev/null'],
    { env, stdio: ['pipe', 'ignore', 'ignore'] });
}

test('BROWSER: opening the cockpit brings back a conversation no hook could reach', { skip, timeout: 180000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  let client;
  try {
    await withCockpit(async ({ base, name, sock, dir }) => {
      const session = `pw_${name}`;
      // A stand-in placeholder: pw-claude-wait renames itself `claude-resume` so tmux reports that
      // as the pane's foreground job, and it blocks on a read that Enter satisfies — which is
      // exactly the surface a wake acts on. It writes a file when woken, so "did the browser
      // actually resume it" is answered by the filesystem rather than by the UI under test.
      const woke = path.join(dir, 'woke');
      const standIn = path.join(dir, 'claude-resume');
      fs.writeFileSync(standIn, `#!/bin/bash\nexec -a claude-resume /bin/bash -c 'read -r _; printf ok > ${woke}; sleep 30'\n`);
      fs.chmodSync(standIn, 0o755);

      const windowId = (await tmux(sock, ['new-window', '-P', '-F', '#{window_id}', '-t', session, standIn])).trim();
      const index = (await tmux(sock, ['display-message', '-p', '-t', windowId, '#{window_index}'])).trim();
      await tmux(sock, ['set-option', '-w', '-t', windowId, '@pw_claude_sid', SID]);
      await tmux(sock, ['set-option', '-w', '-t', windowId, '@pw_claude_hib_win', windowId]);
      // Deliberately NOT advertising @pw_claude_waiting: this is the stranded state, the one every
      // hook declines. If the page recovers this window, it did it through the requested wake.
      await tmux(sock, ['select-window', '-t', `${session}:${index}`]);
      client = attachClient(sock, session);
      for (let i = 0; i < 60; i++) {
        if ((await tmux(sock, ['list-clients', '-t', session])).trim()) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok((await tmux(sock, ['list-clients', '-t', session])).trim(), 'a client must be attached, as the cockpit terminal is');

      const page = await browser.newPage();
      const pageErrors = [];
      const wakeCalls = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('request', (r) => { if (/\/windows\/\d+\/wake$/.test(r.url())) wakeCalls.push(r.url()); });

      await page.goto(`${base}/term/${encodeURIComponent(name)}/`, { waitUntil: 'domcontentloaded' });
      // The hibernated window is marked in the tab strip: the state was invisible before.
      await page.waitForSelector('#tabStrip .tab.hibernated', { timeout: 30000 });

      // Nothing is clicked. The page asks on its own.
      await page.waitForFunction(() => document.querySelectorAll('#tabStrip .tab.hibernated').length === 0, null, { timeout: 30000 });
      assert.equal(fs.existsSync(woke), true, 'the conversation must actually have been resumed, not just un-badged');
      assert.equal(wakeCalls.length, 1, 'exactly one wake request per window per visit — never a loop');

      // And it stays one: the poll runs every 2s, so several more rounds pass here.
      await new Promise((r) => setTimeout(r, 6000));
      assert.equal(wakeCalls.length, 1, 'the cockpit must not keep asking');
      assert.deepEqual(pageErrors, [], 'the cockpit page must raise no uncaught script error');
    }, { prefix: 'pw-hibbrowser-', env: { PW_CLAUDE_WAKE_BIN: WAKE } });
  } finally {
    client?.kill('SIGKILL');
    await browser.close();
  }
});
