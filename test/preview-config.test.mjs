// The per-project preview block (app/preview-config.js) and the two routes that write it.
//
// The edit route (/manage/update/:oldName) used to validate a preview inline, and the add
// handler (/manage/add and POST /api/projects) ignored the fields entirely, so a
// projects:register token could not create a project with a working Preview pane. Both now
// call one helper; these tests pin its rules and that both routes route through it. The
// end-to-end registration over a token is in test/api-tokens-register.test.mjs (needs tmux).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  allUsedPorts, nextPort, nextPreviewPort, validPort, parsePreviewEnv, buildPreviewBlock, previewPortInUseMessage,
} from '../app/preview-config.js';

const SRC = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

const registry = [
  { name: 'a', port: 7681, preview: { cmd: 'npm run dev', port: 7790 } },
  { name: 'b', port: 7682 },
];

// --- port helpers ---------------------------------------------------------------

test('ports: terminal and preview ports are both "used", and allocation skips them', () => {
  assert.deepEqual([...allUsedPorts(registry)].sort(), [7681, 7682, 7790]);
  assert.equal(nextPort(registry), 7683);
  assert.equal(nextPreviewPort(registry), 7791);
  assert.equal(nextPreviewPort([]), 7790);
  assert.ok(validPort(1024) && validPort(65535));
  for (const bad of [1023, 65536, 7790.5, NaN, '7790']) assert.ok(!validPort(bad), `must refuse ${bad}`);
});

// --- buildPreviewBlock ------------------------------------------------------------

test('no command means no preview, whatever else was sent', () => {
  assert.equal(buildPreviewBlock({ cmd: '', port: '7800', env: 'A=1', terminalPort: 7683, others: registry }), null);
  assert.equal(buildPreviewBlock({ cmd: '   ', terminalPort: 7683, others: registry }), null);
  assert.equal(buildPreviewBlock({ terminalPort: 7683, others: registry }), null);
});

test('a command alone gets the next free preview port and no env key', () => {
  const block = buildPreviewBlock({ cmd: '  npm run dev -- --port ${PORT}  ', terminalPort: 7683, others: registry });
  assert.deepEqual(block, { cmd: 'npm run dev -- --port ${PORT}', port: 7791 });
  assert.ok(!('env' in block), 'an empty env must not be stored');
});

test('an explicit port wins over defaultPort and auto-allocation; numbers and strings both work', () => {
  assert.equal(buildPreviewBlock({ cmd: 'x', port: '8100', terminalPort: 7683, others: registry, defaultPort: 8200 }).port, 8100);
  assert.equal(buildPreviewBlock({ cmd: 'x', port: 8101, terminalPort: 7683, others: registry }).port, 8101);
  assert.equal(buildPreviewBlock({ cmd: 'x', port: ' 8102 ', terminalPort: 7683, others: registry }).port, 8102);
});

test('a blank port falls back to defaultPort (the edit route\'s stored port) before auto-allocating', () => {
  assert.equal(buildPreviewBlock({ cmd: 'x', port: '', terminalPort: 7683, others: registry, defaultPort: 8200 }).port, 8200);
  assert.equal(buildPreviewBlock({ cmd: 'x', port: '', terminalPort: 7683, others: registry, defaultPort: undefined }).port, 7791);
});

test('port refusals keep their exact messages', () => {
  const base = { cmd: 'x', terminalPort: 7683, others: registry };
  assert.throws(() => buildPreviewBlock({ ...base, port: '80' }), { message: 'Preview port must be between 1024 and 65535' });
  assert.throws(() => buildPreviewBlock({ ...base, port: '70000' }), { message: 'Preview port must be between 1024 and 65535' });
  assert.throws(() => buildPreviewBlock({ ...base, port: '7683' }), { message: 'Preview port cannot match this project\'s terminal port' });
  // Another project's terminal port, and another project's preview port.
  assert.throws(() => buildPreviewBlock({ ...base, port: '7681' }), { message: 'Preview port 7681 is already in use by another project' });
  assert.throws(() => buildPreviewBlock({ ...base, port: '7790' }), { message: 'Preview port 7790 is already in use by another project' });
  assert.equal(previewPortInUseMessage(7790), 'Preview port 7790 is already in use by another project');
});

test('the project\'s own stored preview port is not a collision when it is excluded from `others`', () => {
  // The edit route passes every project except the one being edited.
  const others = registry.filter((p) => p.name !== 'a');
  assert.equal(buildPreviewBlock({ cmd: 'x', port: '', terminalPort: 7681, others, defaultPort: 7790 }).port, 7790);
});

test('env: KEY=VALUE lines, comments and blanks skipped, values kept verbatim', () => {
  const block = buildPreviewBlock({
    cmd: 'x', terminalPort: 7683, others: registry,
    env: '# a comment\r\n\r\n  NODE_ENV = development\nURL=http://h/?a=b=c\n_X1=\n',
  });
  assert.deepEqual(block.env, { NODE_ENV: ' development', URL: 'http://h/?a=b=c', _X1: '' });
});

test('env refusals keep their exact messages', () => {
  const base = { cmd: 'x', terminalPort: 7683, others: registry };
  assert.throws(() => buildPreviewBlock({ ...base, env: 'PORT=1' }), { message: 'PORT is reserved and cannot be set via preview env' });
  assert.throws(() => buildPreviewBlock({ ...base, env: 'BASEPATH=/x' }), { message: 'BASEPATH is reserved and cannot be set via preview env' });
  assert.throws(() => buildPreviewBlock({ ...base, env: 'NOEQUALS' }), { message: 'Bad env line (need KEY=VALUE): NOEQUALS' });
  assert.throws(() => buildPreviewBlock({ ...base, env: '=v' }), { message: 'Bad env line (need KEY=VALUE): =v' });
  assert.throws(() => buildPreviewBlock({ ...base, env: '1BAD=v' }), { message: 'Invalid env var name: 1BAD' });
  assert.throws(() => buildPreviewBlock({ ...base, env: 'BAD-NAME=v' }), { message: 'Invalid env var name: BAD-NAME' });
  assert.deepEqual(parsePreviewEnv(''), {});
});

test('port is checked before env, as the edit route always did', () => {
  assert.throws(() => buildPreviewBlock({ cmd: 'x', port: '7683', env: 'PORT=1', terminalPort: 7683, others: registry }),
    /cannot match this project's terminal port/);
});

// --- wiring in app/server.js ------------------------------------------------------

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = SRC.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return SRC.slice(start, end);
}

test('server.js has exactly one implementation: the helper, imported', () => {
  assert.match(SRC, /import \{[^}]*\bbuildPreviewBlock\b[^}]*\} from '\.\/preview-config\.js'/);
  assert.doesNotMatch(SRC, /function (allUsedPorts|nextPort|nextPreviewPort|validPort)\(/, 'no second copy of the port helpers');
  assert.doesNotMatch(SRC, /is reserved and cannot be set via preview env/, 'no second copy of the env rules');
  assert.equal((SRC.match(/buildPreviewBlock\(/g) || []).length, 2, 'the edit route and the add handler, nothing else');
});

test('the edit route keeps the stored preview port when the field is blank', () => {
  const update = slice("app.post(BASE + '/manage/update/:oldName'", "audit('project_update'");
  assert.match(update, /buildPreviewBlock\(\{ cmd: req\.body\.previewCmd, port: req\.body\.previewPort, env: req\.body\.previewEnv,\s+terminalPort: port, others, defaultPort: p\.preview\?\.port \}\)/);
  assert.match(update, /if\(previewBlock\) p\.preview = previewBlock; else delete p\.preview;/);
});

test('the add handler validates the preview before the clone and re-checks its port in the lock', () => {
  const add = slice('const addProjectHandler = async (req,res,next)=>{', "app.post(BASE + '/manage/add'");
  const build = add.indexOf('buildPreviewBlock(');
  const clone = add.indexOf('await cloneWorkspace(');
  const lock = add.indexOf('await withProjectsLock(');
  assert.ok(build !== -1 && build < clone, 'the preview must be validated before the clone');
  assert.match(add, /terminalPort: port, others: projects, defaultPort: nextPreviewPort\(\[\.\.\.projects, \{ port \}\]\)/);
  assert.match(add, /if\(preview\) p\.preview = preview;/);
  const txn = add.slice(lock, add.indexOf('fresh.push(p)', lock));
  assert.match(txn, /if\(p\.preview && allUsedPorts\(fresh\)\.has\(p\.preview\.port\)\) throw new Error\(previewPortInUseMessage\(p\.preview\.port\)\)/,
    'another project may have taken the preview port during the clone');
  assert.doesNotMatch(add, /startPreview|preview\/[^']*start/, 'a new preview is never auto-started');
});

test('the add handler answers with a preview key and audits only whether one exists', () => {
  const add = slice('const addProjectHandler = async (req,res,next)=>{', "app.post(BASE + '/manage/add'");
  assert.match(add, /res\.json\(\{ok:true,name,preview: added\?\.preview \? \{ port: added\.preview\.port \} : null\}\)/);
  assert.match(add, /res\.redirect\(BASE \+ '\/manage'\)/, 'a form post still redirects');
  const auditCall = add.slice(add.indexOf("audit('project_add'"), add.indexOf('\n', add.indexOf("audit('project_add'")));
  assert.match(auditCall, /hasPreview: !!added\?\.preview/);
  assert.doesNotMatch(auditCall, /preview\.(cmd|env)|previewCmd|previewEnv/, 'never the command or env values');
});

test('nginx routes every project that has a preview, so a new one gets /preview/<name>/', () => {
  assert.match(SRC, /const previewProjects = projects\.filter\(hasPreview\);/);
  const str = slice('async function startThenRoute(p, projects){', '\n}\n');
  assert.match(str, /await applyRouting\(projects\);/);
});
