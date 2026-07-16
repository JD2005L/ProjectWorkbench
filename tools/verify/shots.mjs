// PW screenshot + console-error harness.
// Usage: node shots.mjs <outPrefix> <path> [path...]
//   env: PW_BASE (default http://127.0.0.1), PW_USER (_smoke_admin),
//        PW_PASS_FILE (../smoke.pw), PW_VIEW (1440x900 | 390x844), PW_ACTIONS
//        (optional JS snippet evaluated in page context after load),
//        PW_CLICK (optional selector to click after load), PW_WAIT (extra ms)
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PW_BASE || 'http://127.0.0.1';
const USER = process.env.PW_USER || '_smoke_admin';
const PASS = fs.readFileSync(process.env.PW_PASS_FILE || path.join(here, '..', 'smoke.pw'), 'utf8').trim();
const [outPrefix, ...paths] = process.argv.slice(2);
if (!outPrefix || paths.length === 0) { console.error('usage: node shots.mjs <outPrefix> <path>...'); process.exit(2); }
const [W, H] = (process.env.PW_VIEW || '1440x900').split('x').map(Number);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

// Login once via the real login form (end-to-end through nginx).
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
if (await page.locator('#loginForm').count()) {
  await page.fill('#u', USER);
  await page.fill('#p', PASS);
  await Promise.all([
    page.waitForURL(u => !String(u).includes('/login'), { timeout: 10000 }).catch(() => {}),
    page.click('#loginForm button[type=submit]'),
  ]);
}

const results = [];
for (const p of paths) {
  const errsBefore = consoleErrors.length;
  const resp = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => ({ _err: e.message }));
  await page.waitForTimeout(Number(process.env.PW_WAIT || 1200));
  if (process.env.PW_CLICK) { await page.click(process.env.PW_CLICK, { timeout: 5000 }).catch(e => consoleErrors.push('click failed: ' + e.message)); await page.waitForTimeout(800); }
  if (process.env.PW_HOVER) { await page.hover(process.env.PW_HOVER, { timeout: 5000 }).catch(e => consoleErrors.push('hover failed: ' + e.message)); await page.waitForTimeout(900); }
  if (process.env.PW_ACTIONS) { try { await page.evaluate(process.env.PW_ACTIONS); await page.waitForTimeout(800); } catch (e) { consoleErrors.push('actions failed: ' + e.message); } }
  const slug = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
  const file = path.join(here, `${outPrefix}-${slug}.png`);
  await page.screenshot({ path: file, fullPage: false });
  results.push({ path: p, finalUrl: page.url(), status: resp?.status ? resp.status() : (resp?._err || 'n/a'), shot: file, newConsoleErrors: consoleErrors.slice(errsBefore) });
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
