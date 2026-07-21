import { chromium } from 'playwright-core';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const PASS = fs.readFileSync(path.join(here, '..', 'smoke.pw'), 'utf8').trim();
const out = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1/login', { waitUntil: 'domcontentloaded' });
await page.fill('#u', '_smoke_admin'); await page.fill('#p', PASS);
await Promise.all([page.waitForURL(u => !String(u).includes('/login')), page.click('#loginForm button[type=submit]')]);
await page.goto('http://127.0.0.1/term/ProjectWorkbench/', { waitUntil: 'networkidle' });
const tabsBefore = await page.evaluate(() => document.querySelectorAll('.tabStrip .tab').length);
out.push('tabs before: ' + tabsBefore);

// Simulate session expiry: revoke the session server-side without navigating.
await page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); });
const t0 = Date.now();
await page.waitForURL(u => String(u).includes('/login'), { timeout: 10000 });
out.push(`auto-redirected to login in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${page.url()}`);
out.push('next param preserved: ' + (page.url().includes(encodeURIComponent('/term/ProjectWorkbench/')) ? 'PASS' : 'FAIL'));

// Re-login → should land straight back in the same cockpit, fully operational.
await page.fill('#u', '_smoke_admin'); await page.fill('#p', PASS);
await Promise.all([page.waitForURL(u => String(u).includes('/term/ProjectWorkbench/'), { timeout: 10000 }), page.click('#loginForm button[type=submit]')]);
await page.waitForTimeout(3000);
const tabsAfter = await page.evaluate(() => document.querySelectorAll('.tabStrip .tab').length);
out.push(`back on cockpit with ${tabsAfter} tabs: ${tabsAfter >= 1 && page.url().includes('/term/ProjectWorkbench/') ? 'PASS' : 'FAIL'}`);
await browser.close();
console.log(out.join('\n'));
