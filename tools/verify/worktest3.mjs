// Detector v4: continuity through output pauses and page refreshes.
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
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
const api = (u) => page.evaluate(async u => (await (await fetch(u, { cache: 'no-store' }))).json(), u).catch(() => null);
const winWorking = async () => {
  const j = await page.evaluate(async () => (await (await fetch('/api/term/_PWTest/windows', { cache: 'no-store' })).json()));
  return j.windows.find(w => w.name === '_pausetest')?.working;
};

// Window becomes active; we then VIEW the project so it's attached+active (hardest path).
const before = await page.evaluate(async () => (await (await fetch('/api/term/_PWTest/windows')).json()));
const prevActive = before.windows.find(w => w.active)?.index;
const mk = await page.evaluate(async () => (await (await fetch('/api/term/_PWTest/windows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '_pausetest' }) })).json()));
const pt = mk.windows.find(w => w.name === '_pausetest');
await page.goto('http://127.0.0.1/term/_PWTest/', { waitUntil: 'networkidle' });

// ticks 0-13s, PAUSE 14-20s, ticks 21-35s
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${pt.index} "for i in \\$(seq 1 14); do echo t; sleep 1; done; sleep 7; for i in \\$(seq 1 15); do echo t; sleep 1; done" C-m`);
const t0 = Date.now();
const timeline = [];
while (Date.now() - t0 < 26000) {
  timeline.push({ t: +((Date.now() - t0) / 1000).toFixed(1), on: await winWorking() });
  await page.waitForTimeout(1600);
}
const at = (a, b) => timeline.filter(x => x.t >= a && x.t < b);
const enterOk = at(10, 14).some(x => x.on);
const pauseHold = at(15, 20.5).length > 0 && at(15, 20.5).every(x => x.on);
out.push('timeline: ' + timeline.map(x => `${x.t}:${x.on ? 1 : 0}`).join(' '));
out.push(`entered by ~10-14s: ${enterOk ? 'PASS' : 'FAIL'}`);
out.push(`held ON through the 7s pause: ${pauseHold ? 'PASS' : 'FAIL'}`);

// Refresh continuity: reload during the second tick phase — first sample must be ON.
await page.reload({ waitUntil: 'networkidle' });
const afterReload = await winWorking();
out.push(`working immediately after page refresh: ${afterReload ? 'PASS' : 'FAIL'}`);

// End: interrupt, expect OFF within ~20s (grace) and not before bell-free stop.
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${pt.index} C-c`);
const tEnd = Date.now();
let offAt = null;
while (Date.now() - tEnd < 25000) { if (!(await winWorking())) { offAt = (Date.now() - tEnd) / 1000; break; } await page.waitForTimeout(1500); }
// Bell-less stop worst case = grace(15s) + cadence decay + poll; Claude turns end via bell → instant.
out.push(`off after stop in ${offAt?.toFixed(1)}s: ${offAt !== null && offAt <= 25 ? 'PASS' : 'FAIL'}`);

// Cleanup.
await page.evaluate(async i => { await fetch('/api/term/_PWTest/windows/' + i, { method: 'DELETE' }); }, pt.index);
await page.evaluate(async i => { await fetch('/api/term/_PWTest/windows/' + i + '/select', { method: 'POST' }); }, prevActive);
await removeTestProject(page);
await browser.close();
console.log(out.join('\n'));
