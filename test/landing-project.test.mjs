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

test('both landing routes resolve the target through one rule', () => {
  const root = between("app.get(BASE + '/', requireAuth", 'const claudeVersion');
  assert.match(root, /const target = await landingProject\(req, projects\)/,
    'the cockpit-first redirect must use landingProject');
  const manage = between("app.get(BASE + '/manage', requireAdmin", "res.redirect(BASE + '/term/'");
  assert.match(manage, /const target = await landingProject\(req, projects\)/,
    'the /manage deep link must use the same rule as /');
  assert.doesNotMatch(root + manage, /projects\.find\(p => p\.name === lastName\)/,
    'no route may still select on the cookie alone');
});

test('landing precedence is per-user, then cookie, then configured default, then rail order', () => {
  const fn = between('async function landingProject(req, projects){', '\n}\n');
  const order = ['remembered', 'cookieLast', 'settings.defaultProject', 'projects[0]'];
  let at = -1;
  for (const step of order) {
    const i = fn.indexOf(step);
    assert.ok(i > at, `precedence out of order at ${step}`);
    at = i;
  }
  // Every candidate has to be looked up inside the caller's visible list, so a
  // remembered or configured project the user cannot open is never redirected to.
  for (const step of ['remembered', 'cookieLast', 'settings.defaultProject']) {
    assert.match(fn, new RegExp(`projects\\.find\\(p => p\\.name === ${step.replace('.', '\\.')}\\)`),
      `${step} must be filtered through the visible projects`);
  }
});

test('per-user memory is written on cockpit open and never blocks the render', () => {
  const cockpit = between("app.get(BASE + '/term/:project/'", 'const adminManage');
  assert.match(cockpit, /void rememberLastProject\(req\.user\?\.username, p\.name\)/,
    'opening a cockpit must record the visit for this user, unawaited');
  assert.match(cockpit, /pw_last=\$\{encodeURIComponent\(p\.name\)\}/,
    'the cookie stays, since implicit-admin mode has no username to key on');
  const store = between('async function rememberLastProject(username, project){', '\n}\n');
  assert.match(store, /catch \{/, 'a landing pointer must never fail a page render');
  assert.match(store, /withLifecycleLock\(USER_STATE_LOCK_PATH/,
    'read-modify-write must not clobber other users');
});

test('the single default is claimed, released, and carried across a rename', () => {
  const fn = between('async function applyDefaultProjectFlag(prevName, projectName, raw){', '\n}\n');
  assert.match(fn, /const claimed = cur === projectName \|\| \(!!prevName && cur === prevName\)/,
    'a rename must not strand the claim');
  assert.match(fn, /const next = want \? projectName : \(claimed \? '' : cur\)/,
    'unticking a project that does not hold the default must leave it alone');
  assert.match(fn, /if\(next === cur\) return;/, 'no write when nothing changed');

  assert.match(between("app.post(BASE + '/manage/update/:oldName'", "audit('project_update'"),
    /applyDefaultProjectFlag\(oldName, newName, req\.body\.defaultProject\)/);
  assert.match(between("app.post(BASE + '/manage/add'", "audit('project_add'"),
    /applyDefaultProjectFlag\(null, name, req\.body\.defaultProject\)/);
  assert.match(between("app.post(BASE + '/manage/delete/:name'", "audit('project_delete'"),
    /applyDefaultProjectFlag\(name, name, ''\)/,
    'deleting the default project must release it, or first logins strand');
});

test('the manage modal can read and write the flag', () => {
  const cfg = between("app.get(BASE + '/api/projects/config'", '} catch(e){');
  assert.match(cfg, /defaultProject: settings\.defaultProject \|\| ''/,
    'the modal cannot render the checkbox without knowing the current claim');
  assert.match(server, /<input type="checkbox" id="pmDefaultProject">/,
    'the General pane needs the control');
  assert.match(server, /fDefaultProject\.checked=!!\(p&&cfg&&cfg\.defaultProject===p\.name\)/,
    'the checkbox reflects whether THIS project holds the claim');
  assert.equal((server.match(/defaultProject:fDefaultProject\.checked\?'yes':''/g) || []).length, 2,
    'both the add and update payloads must carry the flag');
  assert.match(server, /fDefaultProject\.addEventListener\('change',markDirty\)/,
    'toggling it has to mark the form dirty or the save is silently dropped');
});
