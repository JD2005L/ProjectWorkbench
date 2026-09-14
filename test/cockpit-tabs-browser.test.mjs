// The cockpit tab strip end to end, in a real browser: tab badges and the "+" control render, and "+"
// creates a tab that really exists in tmux. This is the user-visible half of
// test/cockpit-client-script.test.mjs (2026-09-14: typographic quotes in spawnTab broke the whole tab
// script in the browser while the server stayed healthy).
//
// A browser is not part of the canonical CI image, so this runs only when both are provided:
//   PW_PLAYWRIGHT_CORE  directory of a playwright-core package
//   PW_CHROMIUM         a Chromium executable that package can drive
// Without them the test is reported as SKIPPED with that reason, never as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmux, withCockpit } from './cockpit-instance-fixture.mjs';

const PLAYWRIGHT = process.env.PW_PLAYWRIGHT_CORE || '';
const CHROMIUM = process.env.PW_CHROMIUM || '';
const skip = PLAYWRIGHT && CHROMIUM && fs.existsSync(PLAYWRIGHT) && fs.existsSync(CHROMIUM)
  ? false
  : 'needs PW_PLAYWRIGHT_CORE and PW_CHROMIUM; a browser is not part of the canonical CI image';

test('BROWSER: the cockpit shows tab badges and "+", and "+" creates a real tab', { skip, timeout: 120000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    await withCockpit(async ({ base, name, sock }) => {
      const page = await browser.newPage();
      const pageErrors = [];
      const dialogs = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });

      await page.goto(`${base}/term/${encodeURIComponent(name)}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tabStrip .tab', { timeout: 20000 });
      await page.waitForSelector('#tabStrip .newTab', { timeout: 20000 });
      const badges = await page.locator('#tabStrip .tab').count();
      assert.ok(badges >= 1, 'at least the session\'s first window is shown as a tab badge');
      const listWindows = async () => (await tmux(sock, ['list-windows', '-t', `pw_${name}`, '-F', '#{window_name}'])).split('\n').filter(Boolean);
      const before = await listWindows();
      assert.equal(badges, before.length, 'one badge per tmux window');

      await page.click('#tabStrip .newTab');
      const blank = page.locator('.tabMenu .tabMenuItem.blank', { hasText: 'Blank tab' });
      await blank.waitFor({ timeout: 10000 });
      await blank.click();
      await page.waitForFunction((n) => document.querySelectorAll('#tabStrip .tab').length === n + 1, badges, { timeout: 20000 });

      const after = await listWindows();
      assert.equal(after.length, before.length + 1, 'the "+" control must create a real tmux window');
      assert.deepEqual(dialogs, [], 'no "Tab error" alert');
      assert.deepEqual(pageErrors, [], 'the cockpit page must raise no uncaught script error');
    });
  } finally {
    await browser.close();
  }
});
