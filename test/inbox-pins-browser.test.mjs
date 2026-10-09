// The cockpit's Files tray: each inbox file says when it will expire, and its pin
// toggles "kept past the expiry" (James, 2026-10-07). Real browser where one is
// available; see test/cockpit-tabs-browser.test.mjs for PW_PLAYWRIGHT_CORE / PW_CHROMIUM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCockpit } from './cockpit-instance-fixture.mjs';

const PLAYWRIGHT = process.env.PW_PLAYWRIGHT_CORE || '';
const CHROMIUM = process.env.PW_CHROMIUM || '';
const skip = PLAYWRIGHT && CHROMIUM && fs.existsSync(PLAYWRIGHT) && fs.existsSync(CHROMIUM)
  ? false
  : 'needs PW_PLAYWRIGHT_CORE and PW_CHROMIUM; a browser is not part of the canonical CI image';

test('BROWSER: an inbox file shows its expiry, and the pin keeps it', { skip, timeout: 120000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    await withCockpit(async ({ base, name, dir }) => {
      const reg = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'));
      const proj = (Array.isArray(reg) ? reg : reg.projects).find((p) => p.name === name);
      const inbox = path.join(proj.path, '_inbox');
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, 'contract.pdf'), 'pdf');

      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/term/${encodeURIComponent(name)}/`);
      await page.click('#fileBtn');
      const row = page.locator('.inboxList .row', { hasText: 'contract.pdf' });
      await row.waitFor();
      assert.match(await row.locator('.meta').innerText(), /expires in 30 days/);
      assert.equal(await row.locator('.pin').getAttribute('aria-pressed'), 'false');

      await row.locator('.pin').click();
      await page.waitForFunction(() => document.querySelector('.inboxList .row .pin')?.getAttribute('aria-pressed') === 'true');
      assert.match(await page.locator('.inboxList .row .meta').innerText(), /pinned — kept/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'inbox-pins.json'), 'utf8')), { [name]: ['contract.pdf'] });

      await page.locator('.inboxList .row .pin').click(); // unpin
      await page.waitForFunction(() => document.querySelector('.inboxList .row .pin')?.getAttribute('aria-pressed') === 'false');
      assert.match(await page.locator('.inboxList .row .meta').innerText(), /expires in 30 days/);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
});
