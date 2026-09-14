// The rail's category filter end to end, in a real browser: the dropdown opens, checking a
// category hides the projects that don't carry it, the current project never disappears, and the
// selection survives a reload. This is the user-visible half of test/project-categories.test.mjs.
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
import { withCockpit } from './cockpit-instance-fixture.mjs';

const PLAYWRIGHT = process.env.PW_PLAYWRIGHT_CORE || '';
const CHROMIUM = process.env.PW_CHROMIUM || '';
const skip = PLAYWRIGHT && CHROMIUM && fs.existsSync(PLAYWRIGHT) && fs.existsSync(CHROMIUM)
  ? false
  : 'needs PW_PLAYWRIGHT_CORE and PW_CHROMIUM; a browser is not part of the canonical CI image';

const form = (base, urlPath, fields) => fetch(`${base}${urlPath}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(fields),
}).then((r) => r.json());

test('BROWSER: the category dropdown filters the rail and the selection persists', { skip, timeout: 120000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    await withCockpit(async ({ base, name }) => {
      // Tag the fixture project 'Client Sites'; add a second, untagged project beside it.
      const cfg = await fetch(`${base}/api/projects/config`).then((r) => r.json());
      const port = cfg.projects.find((p) => p.name === name).port;
      assert.equal((await form(base, `/manage/update/${encodeURIComponent(name)}`,
        { name, repo: '', port: String(port), categories: 'Client Sites' })).ok, true);
      const twin = `${name}b`;
      assert.equal((await form(base, '/manage/add', { name: twin, port: String(port + 1) })).ok, true);

      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(`${base}/term/${encodeURIComponent(name)}/`, { waitUntil: 'domcontentloaded' });

      const row = (proj) => page.locator(`.pkeyRow:has(.pkey[data-project="${proj}"])`);
      await row(twin).waitFor({ timeout: 20000 });
      await assert.doesNotReject(page.waitForSelector('#railFilterBtn', { timeout: 20000 }),
        'the dropdown button must be in the rail');

      // Filter to 'Client Sites': the untagged twin hides, the tagged current project stays.
      await page.click('#railFilterBtn');
      await page.check('#railFilterMenu input[data-cat="Client Sites"]');
      await page.waitForFunction((t) => {
        const r = document.querySelector(`.pkey[data-project="${t}"]`)?.closest('.pkeyRow');
        return r && r.classList.contains('catHidden');
      }, twin, { timeout: 10000 });
      assert.ok(await row(name).isVisible(), 'the tagged project stays visible');
      assert.equal(await page.textContent('#railFilterLabel'), 'Client Sites', 'the button names the filter');

      // Uncategorized instead: the twin returns; the current project stays visible even though it
      // no longer matches — the rail must never hide the cockpit being looked at.
      await page.uncheck('#railFilterMenu input[data-cat="Client Sites"]');
      await page.check('#railFilterMenu input[data-cat="|none"]');
      await page.waitForFunction((t) => {
        const r = document.querySelector(`.pkey[data-project="${t}"]`)?.closest('.pkeyRow');
        return r && !r.classList.contains('catHidden');
      }, twin, { timeout: 10000 });
      assert.ok(await row(name).isVisible(), 'the current project is exempt from the filter');

      // The selection survives a reload (localStorage), and pruning does not resurrect it wrongly.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#railFilterBtn', { timeout: 20000 });
      assert.equal(await page.textContent('#railFilterLabel'), 'Uncategorized', 'the filter persists across reloads');

      // Pinned only: pin the twin, reset the filter, enable Pinned only — the pinned twin and the
      // current project show. Unpinning the twin then hides it LIVE, because applyPins re-applies
      // the filter.
      const pinSel = `.pkeyRow:has(.pkey[data-project="${twin}"]) .pk-pin`;
      await page.click('#railToggle');
      await page.click(pinSel);
      await page.click('#railFilterBtn');
      await page.click('#railFilterAll');
      await page.click('#railFilterBtn');
      await page.check('#railFilterMenu input[data-cat="|pinned"]');
      assert.equal(await page.textContent('#railFilterLabel'), 'Pinned only', 'the button names the mode');
      // Close the menu before touching the rows beneath it — the open popover covers them.
      await page.keyboard.press('Escape');
      assert.ok(await row(twin).isVisible(), 'a pinned project shows under Pinned only');
      await page.click(pinSel);
      await page.waitForFunction((t) => {
        const r = document.querySelector(`.pkey[data-project="${t}"]`)?.closest('.pkeyRow');
        return r && r.classList.contains('catHidden');
      }, twin, { timeout: 10000 });
      assert.ok(await row(name).isVisible(), 'the current project stays visible under Pinned only');
      assert.deepEqual(pageErrors, [], 'the cockpit page must raise no uncaught script error');
    });
  } finally {
    await browser.close();
  }
});
