// Verify pinning: manual pin/unpin + lean, persistence, auto-pin on done, toggle.
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASS = fs.readFileSync(path.join(here, '..', 'smoke.pw'), 'utf8').trim();
const out = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1/login', { waitUntil: 'domcontentloaded' });
await page.fill('#u', '_smoke_admin'); await page.fill('#p', PASS);
await Promise.all([page.waitForURL(u => !String(u).includes('/login')), page.click('#loginForm button[type=submit]')]);


// Dedicated throwaway project: signal tests must never touch real projects.
const TP = '_PWTest';
async function ensureTestProject(pg){
  await pg.evaluate(async () => { try { await fetch('/manage/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ name: '_PWTest' }) }); } catch {} });
  execSync('sudo -u admin tmux has-session -t pw__PWTest 2>/dev/null || sudo -u admin tmux new-session -d -s pw__PWTest -c /opt/project-workbench/workspaces/_PWTest');
}
async function removeTestProject(pg){
  await pg.evaluate(async () => { try { await fetch('/manage/delete/_PWTest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ confirm: 'yes' }) }); } catch {} });
}
await page.goto('http://127.0.0.1/term/ProjectWorkbench/', { waitUntil: 'networkidle' });
await ensureTestProject(page);
await page.evaluate(() => { localStorage.setItem('pwPinned', '[]'); localStorage.setItem('pwAutoPin', '1'); });
await page.reload({ waitUntil: 'networkidle' });

// 1. Manual pin via the key's pin control (rail expanded).
await page.click('#railToggle');
await page.waitForTimeout(600);
await page.click('.pkey[data-project="ui3"] .pk-pin');
await page.click('.pkey[data-project="TRYGGBUILTPortal"] .pk-pin');
const pins = await page.evaluate(() => ({
  ui3: document.querySelector('.pkey[data-project="ui3"]').classList.contains('pinned'),
  tr: document.querySelector('.pkey[data-project="TRYGGBUILTPortal"]').classList.contains('pinned'),
  ls: localStorage.getItem('pwPinned'),
  lean: getComputedStyle(document.querySelector('.pkey[data-project="ui3"]')).transform,
}));
out.push('manual pin: ' + JSON.stringify(pins));
await page.screenshot({ path: path.join(here, 'pin-open.png') });

// 2. Collapsed: pinned keys lean out.
await page.click('#railToggle');
await page.mouse.move(700, 450);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(here, 'pin-collapsed.png') });

// 3. Persistence across reload.
await page.reload({ waitUntil: 'networkidle' });
const persisted = await page.evaluate(() => document.querySelector('.pkey[data-project="ui3"]').classList.contains('pinned'));
out.push('persists after reload: ' + persisted);

// 4. Auto-pin on done: marker lights _PWTest → auto-pinned.
fs.writeFileSync('/var/lib/project-workbench/pending/_PWTest', new Date().toISOString() + '\n');
await page.waitForFunction(() => document.querySelector('.pkey[data-project="_PWTest"]')?.classList.contains('pinned'), { timeout: 10000 });
await page.waitForTimeout(500); // let the 180ms border-color transition settle before sampling computed style
const auto = await page.evaluate(() => { const k = document.querySelector('.pkey[data-project="_PWTest"]'); return { lit: k.classList.contains('lit'), ls: localStorage.getItem('pwPinned'), border: getComputedStyle(k).borderTopColor }; });
out.push('auto-pin on done: ' + JSON.stringify(auto));
out.push('pinned+lit shows AMBER border (not hue): ' + (auto.border === 'rgb(161, 98, 7)' ? 'PASS' : 'FAIL ' + auto.border));
await page.screenshot({ path: path.join(here, 'pin-auto.png') });

// 5. Toggle off persists; unpin works.
await page.evaluate(() => document.body.classList.add('rail-open'));
await page.click('#autoPinBtn');
const toggled = await page.evaluate(() => ({ ls: localStorage.getItem('pwAutoPin'), label: document.getElementById('autoPinState')?.textContent }));
out.push('auto-pin toggled: ' + JSON.stringify(toggled));
await page.click('.pkey[data-project="ui3"] .pk-pin');
const unpinned = await page.evaluate(() => !document.querySelector('.pkey[data-project="ui3"]').classList.contains('pinned'));
out.push('unpin works: ' + unpinned);

// Cleanup: markers + pins.
fs.unlinkSync('/var/lib/project-workbench/pending/_PWTest');
await page.evaluate(() => { localStorage.setItem('pwPinned', '[]'); localStorage.setItem('pwAutoPin', '1'); });
await removeTestProject(page);
await browser.close();
console.log(out.join('\n'));
