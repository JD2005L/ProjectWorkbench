// End-to-end Manage-modal CRUD exercise with a throwaway local project.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1';
const PASS = fs.readFileSync(path.join(here, '..', 'smoke.pw'), 'utf8').trim();
const NAME = '_SmokeTest';
const out = [];
const shot = (p, n) => p.screenshot({ path: path.join(here, `crud-${n}.png`) });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('dialog', d => d.accept());
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('#u', '_smoke_admin');
await page.fill('#p', PASS);
await Promise.all([page.waitForURL(u => !String(u).includes('/login')), page.click('#loginForm button[type=submit]')]);

await page.goto(BASE + '/manage', { waitUntil: 'networkidle' });
await page.waitForSelector('#pmBackdrop:not(.hidden)', { timeout: 8000 });
out.push('modal auto-opened via /manage');

const status = () => page.locator('#pmStatus').textContent();
const waitStatus = async (re, ms = 60000) => {
  await page.waitForFunction(r => new RegExp(r).test(document.getElementById('pmStatus').textContent), String(re).slice(1, -1), { timeout: ms });
  return status();
};

// 1. Create a local-only project.
await page.click('#pmAddBtn');
await page.fill('#pmName', NAME);
await page.click('#pmSave');
out.push('create: ' + await waitStatus(/Created|failed|exists|Error|invalid/i));
await shot(page, '1-created');

// 2. Duplicate-name error surfaces inline.
await page.click('#pmAddBtn');
await page.fill('#pmName', NAME);
await page.click('#pmSave');
out.push('duplicate: ' + await waitStatus(/exists|Created/i));
const dupErr = await page.locator('#pmStatus').evaluate(el => el.classList.contains('err'));
out.push('duplicate shown as error: ' + dupErr);
await shot(page, '2-dup');

// 3. Update: set a preview command + tab template on the throwaway.
await page.click(`.pmItem[data-name="${NAME}"]`);
await page.click('#pmTabs [data-t="preview"]');
await page.fill('#pmPrevCmd', 'python3 -m http.server ${PORT} --bind 127.0.0.1');
await page.click('#pmTabs [data-t="tabs"]');
await page.click('#pmAddTabBtn');
await page.fill('.pmTabRow:last-child .tt-name', 'Claude Code');
await page.fill('.pmTabRow:last-child .tt-cmd', 'claude');
await page.click('#pmSave');
out.push('update: ' + await waitStatus(/Saved|Error|failed/i));
await shot(page, '3-updated');

// 4. Config API reflects the update.
const cfg = await page.evaluate(async () => (await (await fetch('/api/projects/config', { cache: 'no-store' })).json()));
const saved = cfg.projects.find(p => p.name === '_SmokeTest');
out.push('config check: preview.cmd=' + JSON.stringify(saved?.preview?.cmd) + ' tabs=' + JSON.stringify(saved?.tabs));

// 5. Delete via Danger tab (typed-name arming).
await page.click('#pmTabs [data-t="danger"]');
const armedBefore = await page.locator('#pmDelBtn').isDisabled();
await page.fill('#pmDelName', NAME);
const armedAfter = await page.locator('#pmDelBtn').isDisabled();
out.push(`delete arming: disabled before typing=${armedBefore}, after=${armedAfter}`);
await page.click('#pmDelBtn');
out.push('delete: ' + await waitStatus(/Deleted|Error|failed/i));
await shot(page, '4-deleted');

const gone = await page.evaluate(async () => {
  const j = await (await fetch('/api/projects/config', { cache: 'no-store' })).json();
  return !j.projects.some(p => p.name === '_SmokeTest');
});
out.push('project gone from registry: ' + gone);

await browser.close();
console.log(JSON.stringify({ steps: out, consoleErrors: errors }, null, 1));
