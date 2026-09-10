import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anticipateVersion, DeployManifestError, resolveDeployManifest, validateDeployInputs } from '../app/deploy-manifest.js';
import { addIdentity, manifestWorkspace, writeJson } from './deploy-manifest-fixtures.mjs';

test('manifest: absent file and undeclared slots retain legacy behavior', async t => {
 const { root } = manifestWorkspace(t);
 assert.equal(await resolveDeployManifest(root, 'prod'), null);
 fs.unlinkSync(path.join(root, '.pw', 'deploy.json'));
 assert.equal(await resolveDeployManifest(root, 'dev'), null);
 fs.rmdirSync(path.join(root, '.pw'));
 assert.equal(await resolveDeployManifest(root, 'dev'), null);
});

test('manifest: documented publishing and MCP-server example resolves without host configuration', async t => {
 const { root } = manifestWorkspace(t);
 const docs = fs.readFileSync(new URL('../DEPLOY.md', import.meta.url), 'utf8');
 const section = docs.split('## Repository-managed deployment inputs')[1]?.split('## Release version')[0];
 const example = /```json\r?\n([\s\S]*?)\r?\n```/.exec(section || '');
 assert.ok(example, 'deployment manifest example must remain available');
 writeJson(root, ['.pw', 'deploy.json'], JSON.parse(example[1]));
 const publishing = await resolveDeployManifest(root, 'dev');
 const server = await resolveDeployManifest(root, 'prod');
 assert.deepEqual(publishing.inputs.map(input => input.name), ['identity', 'bump']);
 assert.equal(publishing.script, 'bash deploy/publish.sh "$DEPLOY_IDENTITY" "$DEPLOY_BUMP"');
 assert.equal(server.label, 'Deploy MCP server');
 assert.equal(server.script, 'bash deploy/deploy-mcp.sh');
 assert.deepEqual(server.inputs, []);
 assert.equal(server.version, null);
});

test('manifest: script-only slots normalize omitted or empty inputs without inventing versions', async t => {
 for (const explicit of [false, true]) {
  await t.test(explicit ? 'empty inputs' : 'omitted inputs', async sub => {
   const { root, document, save } = manifestWorkspace(sub);
   document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
   if (explicit) document.slots.prod.inputs = [];
   save();
   const slot = await resolveDeployManifest(root, 'prod');
   assert.deepEqual(slot.inputs, []);
   assert.equal(slot.version, null);
   assert.equal(slot.script, 'bash deploy/deploy-mcp.sh');
   assert.deepEqual(validateDeployInputs(slot, {}, slot.revision), {
    inputs: {}, env: {}, currentVersion: null, targetVersion: null,
   });
   assert.throws(() => validateDeployInputs(slot, { identity: 'alpha' }, slot.revision), /unknown field inputs.identity/);
   assert.throws(() => validateDeployInputs(slot, undefined, slot.revision), /inputs must be an object/);
   assert.throws(() => validateDeployInputs(slot, {}, 'stale'), error => error.statusCode === 409);
  });
 }
});

test('manifest: script-only slots still reject invalid inputs, dangling versions and privilege fields', async t => {
 const { root, document, save } = manifestWorkspace(t);
 for (const extra of [
  { inputs: null }, { inputs: {} }, { inputs: 'none' }, { inputs: false },
  { version: { input: 'identity', bumpInput: 'bump' } },
  { inputs: [], version: { input: 'identity', bumpInput: 'bump' } },
  { runAsRoot: true }, { reauth: false },
 ]) {
  document.slots.prod = { label: 'Deploy server', script: 'bash deploy/deploy-mcp.sh', ...extra };
  save();
  await assert.rejects(resolveDeployManifest(root, 'prod'), DeployManifestError);
 }
});

test('manifest: resolves separate required selects, selected versions, and literal environment values', async t => {
 const { root } = manifestWorkspace(t);
 const slot = await resolveDeployManifest(root, 'dev');
 assert.equal(slot.script, 'bash deploy/publish.sh "$DEPLOY_IDENTITY" "$DEPLOY_BUMP"');
 assert.match(slot.revision, /^[a-f0-9]{64}$/);
 assert.deepEqual(slot.inputs.map(input => [input.name, input.required]), [['identity', true], ['bump', true]]);
 assert.deepEqual(slot.inputs[0].choices.map(choice => [choice.value, choice.label, choice.version, choice.initialVersion]), [
  ['alpha', 'Alpha', '2.3.4', '1.0.0'], ['bravo', 'Bravo', null, '1.2.0'],
 ]);
 assert.deepEqual(validateDeployInputs(slot, { identity: 'alpha', bump: 'minor' }, slot.revision), {
  inputs: { identity: 'alpha', bump: 'minor' },
  env: { DEPLOY_IDENTITY: 'alpha', DEPLOY_BUMP: 'minor' },
  currentVersion: '2.3.4', targetVersion: '2.4.0',
 });
 for (const bump of ['patch', 'minor', 'major']) {
  assert.equal(validateDeployInputs(slot, { identity: 'bravo', bump }, slot.revision).targetVersion, '1.2.0', 'first release freezes the metadata version rather than bumping it');
 }
});

test('manifest: numeric version bumps and invalid versions are explicit', () => {
 assert.equal(anticipateVersion('2.3.4', '1.0.0', 'patch'), '2.3.5');
 assert.equal(anticipateVersion('2.3.4', '1.0.0', 'minor'), '2.4.0');
 assert.equal(anticipateVersion('2.3.4', '1.0.0', 'major'), '3.0.0');
 for (const bad of ['', 'v1.0.0', '1.02.0', '1.0', '1.0.0-beta', '9007199254740992.0.0', 123]) {
  assert.throws(() => anticipateVersion(bad, '1.0.0', 'patch'), DeployManifestError);
 }
 assert.throws(() => anticipateVersion('1.0.0', '1.0.0', 'draft'), /patch, minor, or major/);
 assert.throws(() => anticipateVersion('9007199254740991.0.0', '1.0.0', 'major'), /out of range/);
});

test('manifest: new identities appear, deleted identities vanish, and old snapshots are rejected', async t => {
 const { root } = manifestWorkspace(t);
 const first = await resolveDeployManifest(root, 'dev');
 addIdentity(root, 'future-style', { label: 'Future style', initial: '3.0.0' });
 const added = await resolveDeployManifest(root, 'dev');
 assert.deepEqual(added.inputs[0].choices.map(choice => choice.value), ['alpha', 'bravo', 'future-style']);
 assert.notEqual(added.revision, first.revision);
 assert.throws(() => validateDeployInputs(added, { identity: 'alpha', bump: 'patch' }, first.revision), error => error.statusCode === 409);
 fs.rmSync(path.join(root, 'identities', 'alpha'), { recursive: true });
 const removed = await resolveDeployManifest(root, 'dev');
 assert.deepEqual(removed.inputs[0].choices.map(choice => choice.value), ['bravo', 'future-style']);
 assert.throws(() => validateDeployInputs(removed, { identity: 'alpha', bump: 'patch' }, removed.revision), /valid Visual identity/);
});

test('manifest: stale release and token metadata invalidate the panel revision', async t => {
 const { root } = manifestWorkspace(t);
 let slot = await resolveDeployManifest(root, 'dev');
 const old = slot.revision;
 writeJson(root, ['releases', 'alpha', 'index.json'], { latest: '2.3.5' });
 slot = await resolveDeployManifest(root, 'dev');
 assert.notEqual(slot.revision, old);
 assert.throws(() => validateDeployInputs(slot, { identity: 'alpha', bump: 'patch' }, old), error => error.staleManifest);
 writeJson(root, ['identities', 'alpha', 'tokens.json'], { $meta: { name: 'Alpha', version: '1.0.0' }, color: 'changed' });
 assert.notEqual((await resolveDeployManifest(root, 'dev')).revision, slot.revision);
});

test('manifest: missing, extra, empty, unknown, and non-string selections never default', async t => {
 const { root } = manifestWorkspace(t);
 const slot = await resolveDeployManifest(root, 'dev');
 for (const inputs of [
  undefined, null, [], {}, { bump: 'patch' }, { identity: 'alpha' },
  { identity: '', bump: 'patch' }, { identity: 'missing', bump: 'patch' },
  { identity: 'alpha', bump: 'draft' }, { identity: 'alpha', bump: '' },
  { identity: 'alpha', bump: 'patch', extra: 'x' }, { identity: ['alpha'], bump: 'patch' },
  { identity: 'alpha', bump: { value: 'patch' } }, { identity: 'alpha ', bump: 'patch' },
 ]) assert.throws(() => validateDeployInputs(slot, inputs, slot.revision), DeployManifestError);
 for (const revision of [undefined, null, '', 'old']) {
  assert.throws(() => validateDeployInputs(slot, { identity: 'alpha', bump: 'patch' }, revision), error => error.statusCode === 409);
 }
});

test('manifest: static select metacharacters remain data, never shell interpolation', async t => {
 const { root, document, save } = manifestWorkspace(t);
 const value = 'literal "$(touch sentinel)" ; \'quoted\' & %PATH%';
 document.slots.dev.inputs[0] = {
  name: 'identity', type: 'select', label: 'Identity', env: 'DEPLOY_IDENTITY', required: true,
  choices: [{ value, label: '<not html>' }],
 };
 delete document.slots.dev.version;
 save();
 const slot = await resolveDeployManifest(root, 'dev');
 const selected = validateDeployInputs(slot, { identity: value, bump: 'patch' }, slot.revision);
 assert.equal(selected.env.DEPLOY_IDENTITY, value);
 assert.equal(slot.script, 'bash deploy/publish.sh "$DEPLOY_IDENTITY" "$DEPLOY_BUMP"');
 assert.equal(selected.targetVersion, null);
});

test('manifest: schema is strict and cannot grant privileges or define defaults', async t => {
 const mutations = [
  ['unknown top-level key', doc => { doc.commands = []; }],
  ['unsupported schema', doc => { doc.schemaVersion = 2; }],
  ['unknown target', doc => { doc.slots.staging = doc.slots.dev; }],
  ['root grant', doc => { doc.slots.dev.runAsRoot = true; }],
  ['reauth override', doc => { doc.slots.dev.reauth = false; }],
  ['version command', doc => { doc.slots.dev.versionCmd = 'curl nowhere'; }],
  ['empty script', doc => { doc.slots.dev.script = ' '; }],
  ['missing inputs', doc => { delete doc.slots.dev.inputs; }],
  ['optional input', doc => { doc.slots.dev.inputs[0].required = false; }],
  ['default identity', doc => { doc.slots.dev.inputs[0].default = 'alpha'; }],
  ['arbitrary input type', doc => { doc.slots.dev.inputs[0].type = 'command'; }],
  ['duplicate names', doc => { doc.slots.dev.inputs[1].name = 'identity'; }],
  ['duplicate envs', doc => { doc.slots.dev.inputs[1].env = 'DEPLOY_IDENTITY'; }],
  ['password env', doc => { doc.slots.dev.inputs[0].env = 'DEPLOY_PASSWORD'; }],
  ['legacy option env', doc => { doc.slots.dev.inputs[0].env = 'DEPLOY_OPTION'; }],
  ['shell env', doc => { doc.slots.dev.inputs[0].env = 'BASH_ENV'; }],
  ['both choice providers', doc => { doc.slots.dev.inputs[0].choices = [{ value: 'a', label: 'A' }]; }],
  ['duplicate choices', doc => { doc.slots.dev.inputs[1].choices[1].value = 'patch'; }],
  ['extra choice field', doc => { doc.slots.dev.inputs[1].choices[0].script = 'true'; }],
  ['scripted choices', doc => { doc.slots.dev.inputs[0].source.command = 'find .'; }],
  ['extra version source field', doc => { doc.slots.dev.inputs[0].source.version.command = 'curl nowhere'; }],
  ['bad label path', doc => { doc.slots.dev.inputs[0].source.labelPath = '$meta.name'; }],
  ['prototype path', doc => { doc.slots.dev.inputs[0].source.labelPath = ['__proto__', 'name']; }],
  ['missing initial path', doc => { delete doc.slots.dev.inputs[0].source.initialVersionPath; }],
  ['unknown version input', doc => { doc.slots.dev.version.input = 'missing'; }],
  ['unknown bump input', doc => { doc.slots.dev.version.bumpInput = 'missing'; }],
  ['missing release type', doc => { doc.slots.dev.inputs[1].choices.pop(); }],
 ];
 for (const [name, mutate] of mutations) {
  await t.test(name, async sub => {
   const { root, document, save } = manifestWorkspace(sub);
   mutate(document); save();
   await assert.rejects(resolveDeployManifest(root, 'dev'), DeployManifestError);
  });
 }
});

test('manifest: malformed requested slot fails closed without disabling an undeclared slot', async t => {
 const { root, document, save } = manifestWorkspace(t);
 document.slots.dev = { script: 'true' };
 save();
 await assert.rejects(resolveDeployManifest(root, 'dev'), DeployManifestError);
 assert.equal(await resolveDeployManifest(root, 'prod'), null);
 fs.writeFileSync(path.join(root, '.pw', 'deploy.json'), '{"schemaVersion":');
 await assert.rejects(resolveDeployManifest(root, 'dev'), /not valid JSON/);
 await assert.rejects(resolveDeployManifest(root, 'prod'), /not valid JSON/);
});

test('manifest: relative paths reject traversal, drive paths, streams, and empty components', async t => {
 for (const unsafe of ['../outside', '/outside', 'C:\\outside', 'C:outside', '\\\\server\\share', 'identities/../outside', 'identities//alpha', './identities', 'tokens.json:stream']) {
  await t.test(unsafe, async sub => {
   const { root, document, save } = manifestWorkspace(sub);
   document.slots.dev.inputs[0].source.directory = unsafe;
   save();
   await assert.rejects(resolveDeployManifest(root, 'dev'), /path/);
  });
 }
 const { root, document, save } = manifestWorkspace(t);
 document.slots.dev.inputs[0].source.file = '../tokens.json';
 save();
 await assert.rejects(resolveDeployManifest(root, 'dev'), /path/);
 document.slots.dev.inputs[0].source.file = 'tokens.json';
 document.slots.dev.inputs[0].source.version.directory = '../releases';
 save();
 await assert.rejects(resolveDeployManifest(root, 'dev'), /path/);
});

test('manifest: missing and malformed metadata never become inferred identities or first releases', async t => {
 const mutations = [
  ['missing identity metadata', root => fs.unlinkSync(path.join(root, 'identities', 'alpha', 'tokens.json'))],
  ['invalid identity JSON', root => fs.writeFileSync(path.join(root, 'identities', 'alpha', 'tokens.json'), '{')],
  ['missing label', root => writeJson(root, ['identities', 'alpha', 'tokens.json'], { $meta: { version: '1.0.0' } })],
  ['invalid label', root => writeJson(root, ['identities', 'alpha', 'tokens.json'], { $meta: { name: {}, version: '1.0.0' } })],
  ['invalid initial version', root => writeJson(root, ['identities', 'alpha', 'tokens.json'], { $meta: { name: 'Alpha', version: 'latest' } })],
  ['missing release index', root => fs.unlinkSync(path.join(root, 'releases', 'alpha', 'index.json'))],
  ['missing latest', root => writeJson(root, ['releases', 'alpha', 'index.json'], { versions: [] })],
  ['invalid latest', root => writeJson(root, ['releases', 'alpha', 'index.json'], { latest: 'V1.26.0909.1200' })],
  ['null latest', root => writeJson(root, ['releases', 'alpha', 'index.json'], { latest: null })],
  ['oversized JSON', root => fs.writeFileSync(path.join(root, 'identities', 'alpha', 'tokens.json'), ' '.repeat(1024 * 1024 + 1))],
 ];
 for (const [name, mutate] of mutations) {
  await t.test(name, async sub => {
   const { root } = manifestWorkspace(sub);
   mutate(root);
   await assert.rejects(resolveDeployManifest(root, 'dev'), DeployManifestError);
  });
 }
});

test('manifest: only immediate directories are choices; no available identities is an error', async t => {
 const { root } = manifestWorkspace(t);
 writeJson(root, ['identities', 'README.json'], { name: 'not a choice' });
 addIdentity(root, path.join('alpha', 'nested'));
 assert.deepEqual((await resolveDeployManifest(root, 'dev')).inputs[0].choices.map(choice => choice.value), ['alpha', 'bravo']);
 fs.rmSync(path.join(root, 'identities', 'alpha'), { recursive: true });
 fs.rmSync(path.join(root, 'identities', 'bravo'), { recursive: true });
 await assert.rejects(resolveDeployManifest(root, 'dev'), /no choices/);
});

test('manifest: symbolic directory links are rejected at every discovery boundary', async t => {
 for (const parts of [['.pw'], ['identities'], ['identities', 'alpha'], ['releases'], ['releases', 'alpha']]) {
  await t.test(parts.join('/'), async sub => {
   const { root } = manifestWorkspace(sub);
   const original = path.join(root, ...parts);
   const renamed = path.join(root, 'link-target');
   fs.renameSync(original, renamed);
   fs.symlinkSync(renamed, original, process.platform === 'win32' ? 'junction' : 'dir');
   await assert.rejects(resolveDeployManifest(root, 'dev'), /symbolic link/);
  });
 }
});

test('manifest: symlinked JSON is rejected without reading its target', async t => {
 const { root } = manifestWorkspace(t);
 const file = path.join(root, 'identities', 'alpha', 'tokens.json');
 fs.unlinkSync(file);
 try { fs.symlinkSync(path.join(root, 'does-not-exist.json'), file, 'file'); }
 catch (error) {
  if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows account cannot create file symlinks; directory-junction boundary tests still run');
  throw error;
 }
 await assert.rejects(resolveDeployManifest(root, 'dev'), /symbolic link/);
});
