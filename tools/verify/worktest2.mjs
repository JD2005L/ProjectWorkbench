// Working-detection v2: viewing an idle TUI must NOT flag working; steady
// output must. Uses `less` (repaints on attach/resize, silent otherwise) as
// the idle-TUI stand-in and a 1s tick loop as real work.
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
page.on('dialog', d => d.accept());
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
await ensureTestProject(page);

const api = (u, opts) => page.evaluate(async ({ u, opts }) => (await (await fetch(u, { headers: { 'Content-Type': 'application/json' }, ...opts })).json()), { u, opts });
const amrik = async () => (await api('/api/projects/status')).projects.find(p => p.name === '_PWTest');
// Judge the test window itself — the project-level flag ORs real windows
// (PVIKPBot etc.) that the user or test side-effects can legitimately light.
const idleWin = async () => (await api('/api/term/_PWTest/windows')).windows.find(w => w.name === '_idlepane')?.working;

// Setup: an idle full-screen TUI as _PWTest's ACTIVE window, detached.
const before = await api('/api/term/_PWTest/windows');
const prevActive = before.windows.find(w => w.active)?.index;
const created = await api('/api/term/_PWTest/windows', { method: 'POST', body: JSON.stringify({ name: '_idlepane' }) });
const ip = created.windows.find(w => w.name === '_idlepane');
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${ip.index} "less /opt/project-workbench/projects.json" C-m`);
await page.waitForTimeout(1500);

// 1. FALSE-POSITIVE test: open the cockpit (attach → resize → less repaints).
//    Sample working for 14s while viewing: must stay false throughout.
await page.goto('http://127.0.0.1/term/_PWTest/', { waitUntil: 'networkidle' });
const samples = [];
for (let i = 0; i < 7; i++) {
  const stamp = execSync(`sudo -u admin tmux display -p -t pw__PWTest:${ip.index} '#{window_activity}'`).toString().trim();
  samples.push({ on: await idleWin(), stamp });
  await page.waitForTimeout(2000);
}
const falsePos = samples.some(x => x.on);
const stampsMoved = new Set(samples.map(x => x.stamp)).size - 1;
out.push(`view-idle-TUI over 14s: [${samples.map(x => (x.on ? 1 : 0) + '@' + x.stamp.slice(-3)).join(' ')}] stampsMoved=${stampsMoved} → ${falsePos ? 'FALSE POSITIVE (FAIL)' : 'never working (PASS)'}`);

// 2. TRUE-POSITIVE: steady output in a background window flags within ~8-14s…
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${ip.index} "q" C-m`);
await page.waitForTimeout(500);
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${ip.index} "while true; do echo tick; sleep 1; done" C-m`);
const t0 = Date.now();
await page.goto('http://127.0.0.1/term/ProjectWorkbench/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('.pkey[data-project="_PWTest"]')?.classList.contains('working'), { timeout: 30000 });
out.push(`steady output → rail key working after ${((Date.now() - t0) / 1000).toFixed(1)}s: PASS`);

// 3. …and clears after the loop stops.
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${ip.index} C-c`);
await page.waitForFunction(() => !document.querySelector('.pkey[data-project="_PWTest"]')?.classList.contains('working'), { timeout: 25000 });
out.push('cleared after stop: PASS');

// Cleanup.
await api(`/api/term/_PWTest/windows/${ip.index}`, { method: 'DELETE' });
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });
const after = await api('/api/term/_PWTest/windows');
out.push('cleanup: ' + JSON.stringify(after.windows.map(w => w.index + ':' + w.name + (w.active ? '*' : ''))));
await removeTestProject(page);
await browser.close();
console.log(out.join('\n'));
