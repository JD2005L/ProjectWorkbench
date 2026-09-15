import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePwBase, patchDashboard, updateDashboard, validateDashboardPath,
} from '../deploy/service/dashboard-card.mjs';

const SERVICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'service');
const existingCard = "{name:'Existing service',desc:'Existing description',url:'/existing',healthUrl:'/existing/health',tags:['Existing']}";
const page = `<!doctype html>
<html><head><title>Existing dashboard</title></head><body>
<div id="cards"></div><script>
const services=[
  ${existingCard}
];
const renderer = services.map(service => service.name).join(', ');
globalThis.dashboardFixtureMustNotRun = true;
</script></body></html>
`;

function fixture(t, contents = page) {
  const root = fs.mkdtempSync(path.join(SERVICE, '.dashboard-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'index.html');
  fs.writeFileSync(file, contents, { mode: 0o640 });
  const uid = process.getuid?.() ?? 0;
  return { root, file, policy: { anchor: root, owner: uid, parentsOwner: uid } };
}

test('card patch is narrow, uses existing PW UI/health URLs, and never evaluates existing JavaScript', () => {
  const result = patchDashboard(page);
  assert.equal(result.changed, true);
  assert.deepEqual(result.card, {
    name: 'Deployment Service', desc: 'Shared deployment jobs, logs, and administration',
    url: '/workbench/deploy-service', healthUrl: '/workbench/api/deploy-service/health',
    tags: ['Deployments', 'Logs', 'Administration'],
  });
  assert.ok(result.page.includes(existingCard));
  assert.equal(result.page.slice(0, result.page.indexOf('const services=[')), page.slice(0, page.indexOf('const services=[')));
  assert.equal(result.page.slice(result.page.indexOf('];')), page.slice(page.indexOf('];')));
  assert.equal(globalThis.dashboardFixtureMustNotRun, undefined);
  const second = patchDashboard(result.page);
  assert.equal(second.changed, false);
  assert.equal(second.page, result.page);
});

test('literal comments, escaped strings, trailing commas, empty arrays, and CRLF are supported', () => {
  for (const body of [
    '', `${existingCard},`, `${existingCard} // trailing comment\n`,
    `${existingCard}, /* keep this [ ] comment */`,
  ]) {
    const input = `<script>\r\nconst services=[${body.replace(/\n/g, '\r\n')}];\r\n</script>`;
    const result = patchDashboard(input, '/pw/');
    assert.equal(result.card.url, '/pw/deploy-service');
    if (body) assert.ok(result.page.includes(existingCard));
    if (body.includes('trailing comment')) assert.ok(result.page.includes('// trailing comment\r\n'));
    if (body.includes('keep this')) assert.ok(result.page.includes('/* keep this [ ] comment */'));
    assert.equal(patchDashboard(result.page, '/pw').changed, false);
    assert.ok(result.page.includes('\r\n'));
  }
  const escaped = String.raw`<script>const services=[{name:"Quoted \" card",desc:'Unicode \u0057',url:'\/workbench\/deploy-service',tags:[]}];</script>`;
  assert.equal(patchDashboard(escaped).changed, false);
  assert.equal(patchDashboard('<script>const services=[];</script>', '/').card.url, '/deploy-service');
});

test('existing cards are preserved and an already-present link is not rewritten', () => {
  const linked = page.replace("url:'/existing'", "url:'/workbench/deploy-service'");
  assert.deepEqual(patchDashboard(linked).changed, false);
  assert.equal(patchDashboard(linked).page, linked);
  const wrongDestination = page.replace("name:'Existing service'", "name:'Deployment Service'");
  assert.throws(() => patchDashboard(wrongDestination), /different URL/);
});

test('unexpected, dynamic, nested, ambiguous, or non-script declarations are refused', () => {
  for (const input of [
    '<html>No service list</html>',
    page.replace('const services=', 'let services='),
    page + '<script>const services=[];</script>',
    page.replace("url:'/existing'", 'url:location.href'),
    page.replace(existingCard, '{...existing}'),
    page.replace(existingCard, "{name:'one',name:'two',desc:'x',url:'/x',tags:[]}"),
    page.replace("tags:['Existing']", "tags:'Existing'"),
    page.replace("tags:['Existing']", "tags:[],extra:'unsupported'"),
    '<p>const services=[];</p>',
    '<!-- <script>const services=[];</script> -->',
    '<div data-example="<script>const services=[];</script>"></div>',
    '<template><script>const services=[];</script></template>',
    '<textarea><script>const services=[];</script></textarea>',
    '<script>// const services=[];\n</script>',
    '<script>/* const services=[]; */</script>',
    '<script><!-- const services=[];\n</script>',
    '<plaintext><script>const services=[];</script>',
    '<script>const example="const services=[];";</script>',
    '<script>function ignored(){const services=[];}</script>',
    '<script src="/other.js">const services=[];</script>',
    '<script type="application/json">const services=[];</script>',
    '<script>const services=loadServices();</script>',
  ]) assert.throws(() => patchDashboard(input), /Unexpected dashboard format/, input);
});

test('quoted tag attributes and unrelated inert HTML content cannot confuse the selected script', () => {
  const input = '<!-- <script>ignored marker</script> -->'
    + '<textarea><script>inert text</script></textarea>'
    + '<script nonce="literal > attribute">const services=[];</script>';
  const result = patchDashboard(input);
  assert.equal(result.changed, true);
  assert.equal(result.page.slice(0, input.indexOf('const services=')), input.slice(0, input.indexOf('const services=')));
  assert.equal(patchDashboard(result.page).changed, false);
});
test('PW bases reject origins, traversal, encodings, controls, and URL injection', () => {
  for (const base of ['https://example.invalid/workbench', '//example.invalid/workbench', 'workbench',
    '/pw/../admin', '/pw/./admin', '/pw//admin', '/pw?token=hidden', '/pw#x', '/pw%2fadmin',
    '/pw\\admin', '/pw\nadmin', '/pw<script>', '/pw";alert(1)', '', '//']) {
    assert.throws(() => normalizePwBase(base), /PW base/);
  }
  assert.equal(normalizePwBase('/workbench/'), '/workbench');
  assert.equal(normalizePwBase('/'), '');
});

test('dashboard filesystem paths must be absolute, normalized, and static HTML', () => {
  for (const file of ['index.html', 'index.js', path.join(SERVICE, 'index.js'),
    `${SERVICE}${path.sep}..${path.sep}index.html`, `${SERVICE}${path.sep}index\n.html`,
    path.join(SERVICE, '.git', 'index.html')]) {
    assert.throws(() => validateDashboardPath(file), /normalized absolute/);
  }
  assert.equal(validateDashboardPath(path.join(SERVICE, 'index.html')), path.join(SERVICE, 'index.html'));
});

test('file update is atomic/idempotent, preserves owner/mode, and creates only a named page backup', async t => {
  const { root, file, policy } = fixture(t);
  const before = fs.statSync(file);
  const first = await updateDashboard(file, { policy });
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(first.backupFile, 'utf8'), page);
  assert.deepEqual(fs.readdirSync(root).sort(), ['index.html', 'index.html.pw-deploy-service.bak']);
  const edited = fs.readFileSync(file, 'utf8');
  const after = fs.statSync(file), backupTime = fs.statSync(first.backupFile).mtimeMs;
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.backupFile).mode & 0o777, 0o600);
  assert.equal((await updateDashboard(file, { policy })).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  assert.equal(fs.statSync(file).mtimeMs, after.mtimeMs);
  assert.equal(fs.statSync(first.backupFile).mtimeMs, backupTime);
});

test('check and unexpected-format refusal never create a backup or change the static page', async t => {
  const { root, file, policy } = fixture(t);
  assert.equal((await updateDashboard(file, { policy, check: true })).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), page);
  assert.deepEqual(fs.readdirSync(root), ['index.html']);
  fs.writeFileSync(file, '<html>Unrecognized dashboard</html>');
  await assert.rejects(updateDashboard(file, { policy }), /Unexpected dashboard format/);
  assert.equal(fs.readFileSync(file, 'utf8'), '<html>Unrecognized dashboard</html>');
  assert.deepEqual(fs.readdirSync(root), ['index.html']);
});

test('conflicting rollback copies are not overwritten and rollback refuses subsequent page edits', async t => {
  const { root, file, policy } = fixture(t);
  const backup = `${file}.pw-deploy-service.bak`;
  fs.writeFileSync(backup, 'a different static page', { mode: 0o600 });
  await assert.rejects(updateDashboard(file, { policy }), /different page/);
  assert.equal(fs.readFileSync(file, 'utf8'), page);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'a different static page');
  fs.unlinkSync(backup);
  await updateDashboard(file, { policy });
  fs.appendFileSync(file, '<!-- later operator edit -->');
  await assert.rejects(updateDashboard(file, { policy, rollback: true }), /later edits/);
  assert.match(fs.readFileSync(file, 'utf8'), /later operator edit/);
  assert.equal(fs.readFileSync(backup, 'utf8'), page);
  assert.equal(fs.existsSync(`${file}.pw-deploy-service.lock`), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['index.html', 'index.html.pw-deploy-service.bak']);
});

test('explicit rollback restores only the original page and safely permits reapplying the same card', async t => {
  const { file, policy } = fixture(t);
  const first = await updateDashboard(file, { policy });
  const changed = fs.readFileSync(file, 'utf8');
  assert.equal((await updateDashboard(file, { policy, rollback: true, check: true })).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  await updateDashboard(file, { policy, rollback: true });
  assert.equal(fs.readFileSync(file, 'utf8'), page);
  assert.equal(fs.readFileSync(first.backupFile, 'utf8'), page);
  await updateDashboard(file, { policy });
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
});

test('hostile parent and backup symlinks/junctions are refused without touching their targets', async t => {
  const { root, file, policy } = fixture(t);
  const outside = path.join(root, 'unrelated');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'index.html'), page);
  const linked = path.join(root, 'linked-directory');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(updateDashboard(path.join(linked, 'index.html'), { policy }), /link/);
  fs.symlinkSync(outside, `${file}.pw-deploy-service.bak`, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(updateDashboard(file, { policy }), /link/);
  assert.equal(fs.readFileSync(file, 'utf8'), page);
  assert.deepEqual(fs.readdirSync(outside), ['index.html']);
  assert.equal(fs.readFileSync(path.join(outside, 'index.html'), 'utf8'), page);
});

test('hard-linked dashboard files are refused before a backup can be created', async t => {
  const { root, file, policy } = fixture(t);
  const alias = path.join(root, 'alias.html');
  fs.linkSync(file, alias);
  await assert.rejects(updateDashboard(file, { policy }), /Hard-linked/);
  assert.equal(fs.readFileSync(file, 'utf8'), page);
  assert.equal(fs.existsSync(`${file}.pw-deploy-service.bak`), false);
});

test('a final-component page symlink is refused when the platform permits creating it', async t => {
  const { root, file, policy } = fixture(t);
  const link = path.join(root, 'linked.html');
  try { fs.symlinkSync(file, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows does not grant file-symlink creation; real directory junction refusal is covered separately');
      return;
    }
    throw error;
  }
  await assert.rejects(updateDashboard(link, { policy }), /link/);
  assert.equal(fs.readFileSync(file, 'utf8'), page);
});
