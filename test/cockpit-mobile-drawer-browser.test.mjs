// The cockpit on a phone (James, 2026-10-16): the toolbar keeps only the project, the tabs and a
// Files icon, and the project list comes out of a drawer by a tab on the left edge, which is
// tapped or pulled. There is no ☰ in the toolbar any more and no Preview button on a phone.
//
// The touch half needs a real browser, which is not part of the canonical CI image, so it runs
// only when both are provided (see test/cockpit-tabs-browser.test.mjs):
//   PW_PLAYWRIGHT_CORE  directory of a playwright-core package
//   PW_CHROMIUM         a Chromium executable that package can drive
// Without them it is reported as SKIPPED with that reason, never as passed.
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

test('the cockpit has the drawer tab on the rail and no ☰ in the toolbar', { timeout: 60000 }, async () => {
  await withCockpit(async ({ base, name }) => {
    const html = await fetch(`${base}/term/${encodeURIComponent(name)}/`).then((r) => r.text());
    assert.doesNotMatch(html, /id="railBtn"/, 'the ☰ rail button is gone from the toolbar');
    const rail = html.slice(html.indexOf('<aside id="rail"'), html.indexOf('</aside>'));
    assert.match(rail, /<button id="railHandle" type="button" aria-controls="rail" aria-expanded="false" aria-label="Show projects">/,
      'the tab is a real button inside the rail, so it travels with the drawer');
    assert.match(html, /<button id="fileBtn"[^>]*aria-label="Files"><svg class="fbIcon"/, 'Files keeps its name when only its icon shows');
  });
});

test('BROWSER: on a phone the drawer opens from the edge tab, by a tap or a pull, and is pushed back', { skip, timeout: 120000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    await withCockpit(async ({ base, name, dir }) => {
      // Enough projects that the list inside the drawer scrolls.
      const reg = path.join(dir, 'projects.json');
      const projects = JSON.parse(fs.readFileSync(reg, 'utf8'));
      const list = Array.isArray(projects) ? projects : projects.projects;
      for (let i = 0; i < 25; i++) list.push({ name: `filler${String(i).padStart(2, '0')}`, path: path.join(dir, 'workspaces', `filler${i}`), port: 21000 + i });
      fs.writeFileSync(reg, JSON.stringify(projects, null, 2));

      const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/term/${encodeURIComponent(name)}/`);
      await page.waitForSelector('#railKeys .pkey');

      const shown = (sel) => page.$eval(sel, (el) => getComputedStyle(el).display !== 'none');
      assert.equal(await shown('.previewBtn'), false, 'no Preview button on a phone');
      assert.equal(await shown('.fileInfo'), false, 'Files is only its icon on a phone');
      assert.equal(await shown('.fbIcon'), true);

      // Real touch input, so the browser's own touch handling (touch-action) is part of the test.
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
      const settle = () => page.waitForTimeout(450);
      const swipe = async (x0, y0, x1, y1, { steps = 10, hold = 0 } = {}) => {
        await touch('touchStart', [[x0, y0]]);
        for (let i = 1; i <= steps; i++) {
          await page.waitForTimeout(16);
          await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]);
        }
        if (hold) await page.waitForTimeout(hold);
        await touch('touchEnd', []);
        await settle();
      };
      const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); await settle(); };
      const state = () => page.evaluate(() => ({
        open: document.body.classList.contains('rail-mobile-open'),
        left: Math.round(document.getElementById('rail').getBoundingClientRect().left),
        expanded: document.getElementById('railHandle').getAttribute('aria-expanded'),
      }));
      const closed = { open: false, left: -246, expanded: 'false' };
      const open = { open: true, left: 0, expanded: 'true' };

      const tab = await page.$eval('#railHandle', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left }; });
      assert.equal(Math.round(tab.left), 0, 'the tab sits on the left edge of the screen');
      assert.deepEqual(await state(), closed);

      await tap(tab.x, tab.y);
      assert.deepEqual(await state(), open, 'a tap on the tab opens the drawer');
      await tap(370, 300);
      assert.deepEqual(await state(), closed, 'a tap beside the drawer closes it');

      await swipe(tab.x, tab.y, tab.x + 220, tab.y);
      assert.deepEqual(await state(), open, 'pulling the tab out opens the drawer');
      // REGRESSION: the list is a scroller of its own, and a browser applies touch-action only
      // up to the nearest scroller, so a sideways swipe over it was taken by the browser and the
      // drawer never saw it.
      await swipe(200, 560, 30, 560);
      assert.deepEqual(await state(), closed, 'swiping the drawer left over its list closes it');

      await swipe(tab.x, tab.y, tab.x + 50, tab.y, { steps: 5, hold: 250 });
      assert.deepEqual(await state(), closed, 'a short pull that stops springs back');

      await tap(tab.x, tab.y);
      const before = await page.$eval('#railKeys', (el) => el.scrollTop);
      await swipe(150, 560, 152, 260);
      assert.deepEqual(await state(), open, 'an up-and-down swipe in the drawer leaves it open');
      assert.ok(await page.$eval('#railKeys', (el) => el.scrollTop) > before, 'and scrolls the list');
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
});
