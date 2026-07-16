// Full acceptance sweep for the cockpit redesign. Prints JSON {checks:[{id,pass,info}]}.
// Bell test only ever types into a window this script creates (_belltest).
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1';
const PASS = fs.readFileSync(path.join(here, '..', 'smoke.pw'), 'utf8').trim();
const DEVPASS = fs.readFileSync(path.join(here, '..', 'dev.pw'), 'utf8').trim();
const checks = [];
const ok = (id, pass, info = '') => { checks.push({ id, pass: !!pass, info: String(info).slice(0, 300) }); };

const browser = await chromium.launch();

async function login(ctx, user, pass) {
  const page = await ctx.newPage();
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('#u', user); await page.fill('#p', pass);
  await Promise.all([page.waitForURL(u => !String(u).includes('/login'), { timeout: 10000 }), page.click('#loginForm button[type=submit]')]);
  return page;
}

// ---------- admin context (force reduced motion to prove the override) -------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await login(ctx, '_smoke_admin', PASS);
page.on('dialog', d => d.accept());
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
// Record a failing check instead of aborting the whole sweep on a timeout.
async function waitOk(id, fn, info = '') {
  try { await fn(); ok(id, true, info); } catch (e) { ok(id, false, (info ? info + ' — ' : '') + (e.message || e).slice(0, 200)); }
}


// Dedicated throwaway project: signal tests must never touch real projects.
const TP = '_PWTest';
async function ensureTestProject(pg){
  await pg.evaluate(async () => { try { await fetch('/manage/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ name: '_PWTest' }) }); } catch {} });
  execSync('sudo -u admin tmux has-session -t pw__PWTest 2>/dev/null || sudo -u admin tmux new-session -d -s pw__PWTest -c /opt/project-workbench/workspaces/_PWTest');
}
async function removeTestProject(pg){
  await pg.evaluate(async () => { try { await fetch('/manage/delete/_PWTest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ confirm: 'yes' }) }); } catch {} });
}
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await ensureTestProject(page);

// C7: / lands in a cockpit.
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
ok('C7-root-redirect', /\/term\/[^/]+\/$/.test(page.url()), page.url());

// C8: force-motion beats emulated reduce-motion.
const fm = await page.evaluate(() => ({
  mm: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  anim: getComputedStyle(document.querySelector('.pkey')).animationName,
}));
ok('C8-force-motion', fm.mm === false && /pkIn/.test(fm.anim), JSON.stringify(fm));

// C2/C9: rail toggle + persistence across reload.
await page.goto(BASE + '/term/ProjectWorkbench/', { waitUntil: 'networkidle' });
const openedBefore = await page.evaluate(() => document.body.classList.contains('rail-open'));
await page.click('#railToggle');
const openedAfter = await page.evaluate(() => document.body.classList.contains('rail-open'));
await page.reload({ waitUntil: 'networkidle' });
const openedReload = await page.evaluate(() => document.body.classList.contains('rail-open'));
const ariaNow = await page.getAttribute('#railToggle', 'aria-expanded');
ok('C2-toggle', openedBefore === false && openedAfter === true, `before=${openedBefore} after=${openedAfter}`);
ok('C9-persist', openedReload === true && ariaNow === 'true', `reload=${openedReload} aria=${ariaNow}`);
await page.click('#railToggle'); // restore collapsed default

// C1: rail lists projects, current highlighted; clicking a key navigates.
const railInfo = await page.evaluate(() => ({
  count: document.querySelectorAll('#railKeys .pkey').length,
  current: document.querySelector('.pkey.current .pk-name')?.textContent,
}));
ok('C1-rail', railInfo.count >= 10 && railInfo.current === 'ProjectWorkbench', JSON.stringify(railInfo));
await page.click('.pkey[data-project="_PWTest"]');
await page.waitForURL(/\/term\/_PWTest\//, { timeout: 10000 });
ok('C1-switch', page.url().includes('/term/_PWTest/'), page.url());
await page.goto(BASE + '/term/ProjectWorkbench/', { waitUntil: 'networkidle' });

// C3 + C4: REAL bell in a window we create in _PWTest.
const api = (u, opts) => page.evaluate(async ({ u, opts }) => {
  const r = await fetch(u, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return await r.json();
}, { u, opts });
const before = await api('/api/term/_PWTest/windows');
const prevActive = before.windows.find(w => w.active)?.index;
const created = await api('/api/term/_PWTest/windows', { method: 'POST', body: JSON.stringify({ name: '_belltest' }) });
const bt = created.windows.find(w => w.name === '_belltest');
ok('bell-setup', !!bt && Number.isFinite(prevActive), `belltest idx=${bt?.index} prevActive=${prevActive}`);
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${bt.index} "printf '\\\\a'" C-m`);
await waitOk('C3-key-lights', () => page.waitForFunction(() => document.querySelector('.pkey[data-project="_PWTest"]')?.classList.contains('lit'), { timeout: 8000 }), 'lit within poll');
const titleLit = await page.title();
await page.screenshot({ path: path.join(here, 'verify-lit.png') });
ok('C3-title-dot', titleLit.startsWith('● '), titleLit);

// Visit the project: its background tab shows attention (C4), click clears.
await page.goto(BASE + '/term/_PWTest/', { waitUntil: 'networkidle' });
await waitOk('C4-tab-attention', () => page.waitForFunction(() => [...document.querySelectorAll('.tabStrip .tab')].some(t => t.classList.contains('attention')), { timeout: 8000 }), 'attention tab visible');
await page.screenshot({ path: path.join(here, 'verify-tab-attention.png') });
await page.evaluate(() => [...document.querySelectorAll('.tabStrip .tab')].find(t => t.classList.contains('attention'))?.click());
await waitOk('C4-click-clears', () => page.waitForFunction(() => ![...document.querySelectorAll('.tabStrip .tab')].some(t => t.classList.contains('attention')), { timeout: 8000 }), 'attention cleared after selecting tab');
const statusAfter = await api('/api/projects/status');
ok('C3-clears-on-view', statusAfter.projects.find(p => p.name === '_PWTest')?.pending === false, JSON.stringify(statusAfter.projects.find(p => p.name === '_PWTest')));
// Cleanup: remove _belltest, restore previous active window.
await api(`/api/term/_PWTest/windows/${bt.index}`, { method: 'DELETE' });
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });
const after = await api('/api/term/_PWTest/windows');
ok('bell-cleanup', !after.windows.some(w => w.name === '_belltest') && after.windows.find(w => w.active)?.index === prevActive, JSON.stringify(after.windows.map(w => w.index + ':' + w.name + (w.active ? '*' : ''))));

// Back on PW cockpit: _PWTest key unlit.
await page.goto(BASE + '/term/ProjectWorkbench/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500);
const unlit = await page.evaluate(() => !document.querySelector('.pkey[data-project="_PWTest"]')?.classList.contains('lit'));
ok('C3-unlit-after-view', unlit);

// C3b: a bell on the ACTIVE window of a DETACHED session lights too — the
// single-window case that used to be missed (fixed via #{session_attached}).
// We navigated away above, so _PWTest's ttyd client is detached again.
const created2 = await api('/api/term/_PWTest/windows', { method: 'POST', body: JSON.stringify({ name: '_belltest2' }) });
const bt2 = created2.windows.find(w => w.name === '_belltest2');
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${bt2.index} "printf '\\\\a'" C-m`);
await waitOk('C3b-active-detached', () => page.waitForFunction(() => document.querySelector('.pkey[data-project="_PWTest"]')?.classList.contains('lit'), { timeout: 8000 }), 'active-window bell, detached session');
await api(`/api/term/_PWTest/windows/${bt2.index}`, { method: 'DELETE' });
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });

// C3c: done-state latch — once a poll observes the bell, the state must
// survive the raw tmux flag being cleared (stray attach / automation select).
const created3 = await api('/api/term/_PWTest/windows', { method: 'POST', body: JSON.stringify({ name: '_latchtest' }) });
const lt = created3.windows.find(w => w.name === '_latchtest');
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });
execSync(`sudo -u admin tmux send-keys -t pw__PWTest:${lt.index} "printf '\\a'" C-m`);
await page.waitForTimeout(800);
const latch1 = (await api('/api/projects/status')).projects.find(p => p.name === '_PWTest');
const markerOnDisk = fs.existsSync('/var/lib/project-workbench/pending/_PWTest');
await api(`/api/term/_PWTest/windows/${lt.index}/select`, { method: 'POST' }); // clears the raw flag
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });
await page.waitForTimeout(500);
const latch2 = (await api('/api/projects/status')).projects.find(p => p.name === '_PWTest');
ok('C3c-latch', latch1?.pending === true && markerOnDisk && latch2?.pending === true && latch2?.bell === false,
   `observed=${latch1?.pending} marker=${markerOnDisk} afterFlagClear pending=${latch2?.pending} bell=${latch2?.bell}`);
await page.goto(BASE + '/term/_PWTest/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const latch3 = (await api('/api/projects/status')).projects.find(p => p.name === '_PWTest');
ok('C3c-clears-on-view', latch3?.pending === false && !fs.existsSync('/var/lib/project-workbench/pending/_PWTest'), JSON.stringify(latch3));
await api(`/api/term/_PWTest/windows/${lt.index}`, { method: 'DELETE' });
await api(`/api/term/_PWTest/windows/${prevActive}/select`, { method: 'POST' });
await page.goto(BASE + '/term/ProjectWorkbench/', { waitUntil: 'networkidle' });

// C11: a project with NO tmux session renders unlit + clickable, status stays ok.
const mkC11 = await page.evaluate(async () => (await (await fetch('/manage/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ name: '_C11Test' }) })).json()));
ok('C11-setup', mkC11.ok === true, JSON.stringify(mkC11));
try { execSync('sudo -u admin tmux kill-session -t pw__C11Test 2>/dev/null'); } catch {} // ensure no session
await page.goto(BASE + '/term/ProjectWorkbench/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500);
const c11 = await page.evaluate(async () => {
  const key = document.querySelector('.pkey[data-project="_C11Test"]');
  const st = await (await fetch('/api/projects/status', { cache: 'no-store' })).json();
  const row = st.projects.find(p => p.name === '_C11Test');
  return { keyExists: !!key, isLink: key?.tagName === 'A' && !!key?.href, lit: key?.classList.contains('lit'), statusOk: st.ok, row };
});
ok('C11-sessionless', c11.keyExists && c11.isLink && c11.lit === false && c11.statusOk && c11.row && c11.row.pending === false, JSON.stringify(c11));
const rmC11 = await page.evaluate(async () => (await (await fetch('/manage/delete/_C11Test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ confirm: 'yes' }) })).json()));
ok('C11-cleanup', rmC11.ok === true, JSON.stringify(rmC11));

// C16: preview modal opens and closes.
await page.click('.previewBtn');
await page.waitForSelector('#previewBackdrop:not(.hidden)', { timeout: 5000 });
await page.keyboard.press('Escape');
const prevHidden = await page.evaluate(() => document.getElementById('previewBackdrop').classList.contains('hidden'));
ok('C16-preview-modal', prevHidden, 'opened + Esc closed');

// C16: file tray opens; upload lands in inbox list; delete cleans up.
await page.click('#fileBtn');
const shadeOpen = await page.evaluate(() => document.body.classList.contains('shade-open'));
const up = await page.evaluate(async () => (await (await fetch('/api/upload/ProjectWorkbench', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'verify-note.txt', mime: 'text/plain', data: btoa('cockpit verify') }) })).json()));
await page.click('#fileBtn'); await page.click('#fileBtn'); // cycle to refresh inbox
await page.waitForFunction(() => [...document.querySelectorAll('.inboxList .row .name')].some(n => n.textContent.includes('verify-note')), { timeout: 6000 });
const fname = up.path.split('/').pop();
const delGone = await page.evaluate(async n => {
  const d = await (await fetch('/api/inbox/ProjectWorkbench/' + encodeURIComponent(n), { method: 'DELETE' })).json();
  const list = await (await fetch('/api/inbox/ProjectWorkbench', { cache: 'no-store' })).json();
  return d.ok && !list.files.some(f => f.name === n);
}, fname);
await page.keyboard.press('Escape');
ok('C16-tray-upload', shadeOpen && up.ok && delGone, `upload=${up.ok} deleted+absent=${delGone} file=${fname}`);

// C15: manage modal ARIA + Esc.
await page.evaluate(() => document.body.classList.add('rail-open'));
await page.click('#manageEntry');
await page.waitForSelector('#pmBackdrop:not(.hidden)', { timeout: 6000 });
const aria = await page.evaluate(() => { const b = document.getElementById('pmBackdrop'); return { role: b.getAttribute('role'), modal: b.getAttribute('aria-modal') }; });
await page.keyboard.press('Escape');
const pmHidden = await page.evaluate(() => document.getElementById('pmBackdrop').classList.contains('hidden'));
ok('C15-modal-aria-esc', aria.role === 'dialog' && aria.modal === 'true' && pmHidden, JSON.stringify(aria));

// C15: keys are anchors (keyboard reachable), nav labelled.
const a11y = await page.evaluate(() => ({
  keysAreLinks: [...document.querySelectorAll('.pkey')].every(k => k.tagName === 'A' && k.href),
  navLabel: document.getElementById('rail').getAttribute('aria-label'),
  currentMarked: !!document.querySelector('.pkey[aria-current="page"]'),
}));
ok('C15-keys', a11y.keysAreLinks && a11y.navLabel === 'Projects' && a11y.currentMarked, JSON.stringify(a11y));

// C10: handoff endpoint still present and gated (401/403 without token).
const handoff = execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: x' http://127.0.0.1:3000/api/internal/pvikpbot/handoff -H 'Content-Type: application/json' -d '{}'`).toString();
ok('C10-handoff-gated', handoff === '401' || handoff === '403', 'status=' + handoff);

// C14: no page errors through the whole admin flow.
ok('C14-no-page-errors', consoleErrors.length === 0, JSON.stringify(consoleErrors));

// Sign out via rail (C16 logout path).
await page.evaluate(() => document.body.classList.add('rail-open'));
await page.click('#railLogout');
await page.waitForURL(/\/login/, { timeout: 8000 });
const me = await page.evaluate(async () => (await fetch('/api/auth/me')).status);
ok('C16-logout', me === 401, '/api/auth/me=' + me);
await ctx.close();

// ---------- developer context: granted-only rail, no manage entry ------------
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dpage = await login(dctx, '_smoke_dev', DEVPASS);
await dpage.goto(BASE + '/', { waitUntil: 'networkidle' });
ok('C7-dev-redirect', dpage.url().includes('/term/_PWTest/'), dpage.url());
const dev = await dpage.evaluate(() => ({
  keys: [...document.querySelectorAll('#railKeys .pkey')].map(k => k.dataset.project),
  manage: !!document.getElementById('manageEntry'),
}));
ok('C12-dev-rail', dev.keys.length === 1 && dev.keys[0] === '_PWTest' && dev.manage === false, JSON.stringify(dev));
const forbidden = await dpage.goto(BASE + '/term/HarmaniPublic/', { waitUntil: 'domcontentloaded' }); // real project: 403 is decided before ttyd, no attach happens
ok('C12-dev-403', forbidden.status() === 403, 'status=' + forbidden.status());
await dctx.close();

// ---------- editor context: no terminal access --------------------------------
const ectx = await browser.newContext();
const epage = await login(ectx, '_smoke_editor', fs.readFileSync(path.join(here, '..', 'editor.pw'), 'utf8').trim());
const eterm = await epage.goto(BASE + '/term/_PWTest/', { waitUntil: 'domcontentloaded' });
ok('C12-editor-403', eterm.status() === 403, 'status=' + eterm.status());
await ectx.close();

const cctx = await browser.newContext();
const cpage = await login(cctx, '_smoke_admin', PASS);
await removeTestProject(cpage);
await cctx.close();
await browser.close();
const fails = checks.filter(c => !c.pass);
console.log(JSON.stringify({ checks, failCount: fails.length }, null, 1));
