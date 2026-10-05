// The project rail keeps its scroll position when another project is opened.
//
// Opening a project is a full page load, so without this the list always came back
// at the top and a long project list had to be scrolled again after every switch
// (James, 2026-10-05). Driven in a real browser where one is available; see
// test/cockpit-tabs-browser.test.mjs for the PW_PLAYWRIGHT_CORE / PW_CHROMIUM contract.
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

test('BROWSER: the rail is where it was after the next page load', { skip, timeout: 120000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(PLAYWRIGHT, 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    await withCockpit(async ({ base, name, dir }) => {
      // Enough projects that the rail scrolls. They are registry entries only: the rail
      // lists them, and nothing here opens their terminals.
      const reg = path.join(dir, 'projects.json');
      const projects = JSON.parse(fs.readFileSync(reg, 'utf8'));
      const list = Array.isArray(projects) ? projects : projects.projects;
      for (let i = 0; i < 30; i++) list.push({ name: `filler${String(i).padStart(2, '0')}`, path: path.join(dir, 'workspaces', `filler${i}`), port: 21000 + i });
      fs.writeFileSync(reg, JSON.stringify(projects, null, 2));

      const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const url = `${base}/term/${encodeURIComponent(name)}/`;
      await page.goto(url);
      await page.waitForSelector('#railKeys .pkey');
      const max = await page.$eval('#railKeys', (el) => el.scrollHeight - el.clientHeight);
      assert.ok(max > 200, `the rail must actually scroll for this test to mean anything (max ${max})`);
      const target = Math.floor(max * 0.6);
      await page.$eval('#railKeys', (el, y) => { el.scrollTop = y; el.dispatchEvent(new Event('scroll')); }, target);

      await page.goto(url); // what opening a project does: a full page load
      await page.waitForSelector('#railKeys .pkey');
      await page.waitForTimeout(100);
      const after = await page.$eval('#railKeys', (el) => el.scrollTop);
      assert.ok(Math.abs(after - target) <= 2, `rail scroll restored: expected ~${target}, got ${after}`);
      assert.deepEqual(errors, []);

      // A fresh browser tab starts at the top: the position is per tab, not global.
      const other = await browser.newPage({ viewport: { width: 1280, height: 600 } });
      await other.goto(url);
      await other.waitForSelector('#railKeys .pkey');
      assert.equal(await other.$eval('#railKeys', (el) => el.scrollTop), 0);
    });
  } finally {
    await browser.close();
  }
});
