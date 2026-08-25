import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

function between(start, end) {
  const a = server.indexOf(start);
  assert.notEqual(a, -1, `missing start seam: ${start}`);
  const b = server.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `missing end seam: ${end}`);
  return server.slice(a, b);
}

test('completion stays latched while the cockpit is merely visible', () => {
  assert.doesNotMatch(server, /function pwHeartbeat\s*\(/,
    'a visible-page heartbeat must not acknowledge completion');
  assert.doesNotMatch(server, /visibilitychange[^\n]*pwHeartbeat/,
    'visibility changes must not acknowledge completion');
});

test('explicit terminal selection acknowledges completion after tmux selects the window', () => {
  const route = between(
    "app.post(BASE + '/api/term/:project/windows/:index/select'",
    "app.post(BASE + '/api/term/:project/windows/:index/rename'",
  );
  const selected = route.indexOf("await tmux(['select-window'");
  const cleared = route.indexOf('await clearPending(p)');
  assert.ok(selected >= 0, 'selection route must select the tmux window');
  assert.ok(cleared > selected, 'completion must clear only after successful tmux selection');
});

test('clicking even the already-active terminal tab explicitly selects and acknowledges it', () => {
  const render = between('function renderTabs(windows)', 'refreshTabs();setInterval');
  assert.doesNotMatch(render, /tab\.onclick=async\(\)=>\{if\(w\.active\)return;/,
    'active tab clicks must not be ignored');
  assert.match(render, /tab\.onclick=async\(\)=>\{await fetch\(tabsBase\+'\/'\+w\.index\+'\/select'/,
    'every terminal tab click must call the explicit select route');
  assert.match(render, /label\.onclick=ev=>\{if\(!w\.active\)return;ev\.stopPropagation\(\);startEdit\(label,w\)\}/,
    'the active tab label keeps its intentional rename gesture');
});

test('opening a project route remains an explicit acknowledgement', () => {
  const cockpit = between(
    "app.get(BASE + '/term/:project/'",
    "app.get(BASE + '/files/:project/'",
  );
  assert.match(cockpit, /await clearPending\(p\)/,
    'opening the project cockpit must still clear its completion marker');
});

test('legacy visible-page clients cannot clear completion through the obsolete endpoint', () => {
  assert.doesNotMatch(server, /app\.post\(BASE \+ '\/api\/projects\/:name\/clear-pending'/,
    'the obsolete heartbeat endpoint lets already-open old pages erase fresh completion markers');
});
