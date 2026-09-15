import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  PAYLOAD, activationCommands, allocatedAccountIds, defaultConfiguration, hostPath, installFiles, lookupAccount, parseAccount,
  parseOptions, parseRange, parseSubordinateIds, planSubordinateIds, prepareStateDirectories, renderUnit, stageRelease,
  validateCodeDirectoryMode, validateSystemdRunHelp,
} from '../deploy/service/install.mjs';
import { atomicFile, checkMetadata, readSnapshot } from '../deploy/service/safe-files.mjs';
import { validateHostConfig, validateSettings, validateTargetSettings } from '../app/deployment/policy.js';
import { validateRecipe } from '../app/deployment/protocol.js';
import { resolveDeployManifest } from '../app/deploy-manifest.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = path.join(REPO, 'deploy', 'service');
const template = fs.readFileSync(path.join(SERVICE, 'pw-deploy.service.in'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(SERVICE, '.install-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 0;
  return { root, policy: { anchor: root, owner: uid, parentsOwner: uid } };
}

function sourceFixture(root) {
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  for (const name of PAYLOAD) {
    const file = path.join(source, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(REPO, ...name.split('/')), file);
  }
  for (const name of ['.git/private-object', '.env', 'app/server.js', 'app/data/private.json', 'systemd/application.service']) {
    const file = path.join(source, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'NON_PACKAGE_FIXTURE_DATA\n');
  }
  return source;
}

function installation(root) {
  return {
    repo: sourceFixture(root), prefix: path.join(root, 'package'), configFile: path.join(root, 'configuration', 'config.json'),
    tokenFile: path.join(root, 'configuration', 'service.token'), stateDir: path.join(root, 'state'),
    unitFile: path.join(root, 'units', 'pw-deploy.service'), configuration: defaultConfiguration(parseOptions([])),
    configSnapshot: null, tokenSnapshot: null, unitSnapshot: null,
    renderUnit: release => renderUnit(template, `/opt/pw-deploy/releases/${path.basename(release)}`, '/etc/pw-deploy/config.json'),
  };
}

test('new configuration matches the service contract and does not enroll targets or change PW', () => {
  const defaults = defaultConfiguration(parseOptions([]));
  assert.deepEqual(defaults, JSON.parse(fs.readFileSync(path.join(SERVICE, 'config.example.json'), 'utf8')));
  const accepted = validateHostConfig(defaults);
  assert.deepEqual(accepted.listen, { host: '127.0.0.1', port: 3800 });
  assert.equal(accepted.runtimeUser, 'pw-deploy-build');
  assert.equal(accepted.buildUser, 'pw-deploy-build');
  assert.equal(accepted.unitName, 'pw-deploy.service');
  const withoutUnitName = { ...defaults };
  delete withoutUnitName.unitName;
  assert.equal(validateHostConfig(withoutUnitName).unitName, 'pw-deploy.service');
  assert.equal(accepted.defaults.maxConcurrent, 1);
  assert.equal(accepted.defaults.defaultTimeoutSeconds, 600);
  assert.equal(accepted.defaults.retentionDays, 7);
  assert.ok(!Object.hasOwn(defaults, 'targets'));
  assert.ok(!Object.hasOwn(defaults, 'backend'));
  assert.deepEqual(validateHostConfig(defaultConfiguration(parseOptions(['--socket']))).listen,
    { socketPath: '/run/pw-deploy/control.sock' });
});

test('existing runtime identity does not replace the dedicated builder or become a mutable UI setting', () => {
  const host = validateHostConfig(defaultConfiguration(parseOptions(['--runtime-user', 'existing-runtime'])));
  assert.equal(host.buildUser, 'pw-deploy-build');
  assert.equal(host.runtimeUser, 'existing-runtime');
  for (const field of ['buildUser', 'runtimeUser', 'unitName']) {
    assert.throws(() => validateSettings({ [field]: 'replacement' }), /Unknown/);
    assert.throws(() => validateTargetSettings({ [field]: 'replacement' }), /Unknown/);
  }
  const settings = validateSettings({ maxConcurrent: 2, defaultTimeoutSeconds: 900, retentionDays: 14 });
  assert.equal(settings.maxConcurrent, 2);
  assert.equal(settings.defaultTimeoutSeconds, 900);
  assert.equal(settings.retentionDays, 14);
  assert.equal(host.buildUser, 'pw-deploy-build');
  assert.equal(host.runtimeUser, 'existing-runtime');
  assert.equal(host.unitName, 'pw-deploy.service');
});

test('systemd-run preflight supports named-user supervision without requiring --gid', () => {
  const flags = ['--wait', '--pipe', '--collect', '--uid', '--property',
    '--working-directory', '--service-type'];
  assert.doesNotThrow(() => validateSystemdRunHelp(flags.map(flag => `${flag}=VALUE`).join('\n')));
  for (const missing of flags) {
    assert.throws(() => validateSystemdRunHelp(flags.filter(flag => flag !== missing).join('\n')),
      error => error.message.includes(`required supervision option ${missing}`));
  }
  assert.throws(() => validateSystemdRunHelp(null), /invalid help text/);
});

test('documented synthetic manifest and Podman wire recipe match the actual validators', async t => {
  const { root } = fixture(t);
  const document = fs.readFileSync(path.join(REPO, 'docs', 'deployment-service.md'), 'utf8');
  const examples = [...document.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match => JSON.parse(match[1]));
  assert.equal(examples.length, 2);
  const manifest = examples.find(example => example.slots?.dev?.script);
  const containerManifest = examples.find(example => example.slots?.dev?.execution);
  const recipe = containerManifest?.slots.dev.execution;
  assert.ok(manifest);
  assert.ok(recipe);
  fs.mkdirSync(path.join(root, '.pw'));
  fs.writeFileSync(path.join(root, '.pw', 'deploy.json'), JSON.stringify(manifest));
  const resolved = await resolveDeployManifest(root, 'dev');
  assert.equal(resolved.script, manifest.slots.dev.script);
  assert.deepEqual(validateRecipe(recipe), recipe);
  fs.writeFileSync(path.join(root, '.pw', 'deploy.json'), JSON.stringify(containerManifest));
  const container = await resolveDeployManifest(root, 'dev');
  assert.equal(container.script, '');
  assert.deepEqual(container.execution, recipe);
});

test('installation arguments refuse unsafe paths, public HTTP, root accounts, and ambiguous activation', () => {
  for (const value of ['/', '/opt', '../runner', '/opt/../etc/runner', '/opt//runner', '/opt/.git/runner',
    '/opt/runner/', '/opt/runner\nExecStart=bad', '/opt/space here', '/opt/%n']) {
    assert.throws(() => hostPath(value), /normalized absolute/);
  }
  for (const args of [
    ['--runtime-user', 'root'], ['--build-user', 'root'], ['--host', '0.0.0.0'], ['--port', '80'],
    ['--port', '3800.5'], ['--socket', '--host', '127.0.0.1'], ['--activate', '--restart'],
    ['--activate', '--activate'], ['--unknown'], ['--prefix'], ['--runtime-user', 'name;id'],
  ]) assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['--runtime-user', 'existing-runtime']).runtimeUser, 'existing-runtime');
});

test('execution identity cannot resolve to UID/GID zero or multiple NSS records', () => {
  assert.deepEqual(parseAccount('builder:x:200:200::/var/lib/builder:/usr/sbin/nologin', 'builder'),
    { name: 'builder', uid: 200, gid: 200, home: '/var/lib/builder', shell: '/usr/sbin/nologin' });
  for (const text of ['builder:x:0:200::/root:/bin/bash', 'builder:x:200:0::/home/builder:/bin/bash',
    'builder:x:200:200::relative:/bin/bash', 'other:x:200:200::/home/other:/bin/bash',
    'builder:x:200:200::/home/builder:/bin/bash\nother:x:201:201::/home/other:/bin/bash']) {
    assert.throws(() => parseAccount(text, 'builder'), /non-root UID and GID/);
  }
});

test('runtime account lookup accepts a passwd primary GID without querying a group record', async () => {
  const calls = [];
  const identity = await lookupAccount('runtime.worker', {
    runCommand(command, args) {
      calls.push([command, args]);
      assert.deepEqual(args, ['passwd', 'runtime.worker'], 'No runtime group record may be required');
      return { status: 0, output: 'runtime.worker:x:2100:470000::/srv/runtime-home:/usr/sbin/nologin' };
    },
  });
  assert.equal(identity.name, 'runtime.worker');
  assert.equal(identity.uid, 2100);
  assert.equal(identity.gid, 470000);
  assert.deepEqual(calls, [['/usr/bin/getent', ['passwd', 'runtime.worker']]]);
});

test('primary GIDs remain reserved when group records or account enumeration are absent', () => {
  const local = 'root:x:0:0::/root:/bin/bash\nbuilder:x:200:200::/srv/builder:/usr/sbin/nologin\n';
  const runtime = parseAccount('runtime.worker:x:2100:470000::/srv/runtime-home:/usr/sbin/nologin', 'runtime.worker');
  const groups = 'root:x:0:\nbuilder:x:200:\nsupplementary:x:300:\n';
  const fromPasswd = allocatedAccountIds(`${local}runtime.worker:x:2100:470000::/srv/runtime-home:/usr/sbin/nologin\n`, groups);
  const fromNamedLookup = allocatedAccountIds(local, groups, [runtime]);
  assert.deepEqual(new Set(fromPasswd.allocatedUids), new Set([0, 200, 2100]));
  assert.deepEqual(new Set(fromPasswd.allocatedGids), new Set([0, 200, 300, 470000]));
  assert.deepEqual(new Set(fromNamedLookup.allocatedGids), new Set(fromPasswd.allocatedGids));
  assert.throws(() => planSubordinateIds([], { name: 'builder', uid: 200 }, '450000:65536',
    fromNamedLookup.allocatedGids), /enumerated/);
  assert.throws(() => allocatedAccountIds('broken:x:not-an-id:200::/srv/fixture:/bin/false', groups), /enumerate/);
  assert.throws(() => allocatedAccountIds(local, groups, [{ uid: 2100, gid: 0 }]), /non-root/);
});

test('subordinate ranges are explicit, nonconflicting, and idempotent', () => {
  const builder = { name: 'builder', uid: 200 };
  const ranges = parseSubordinateIds('other:100000:65536\nbuilder:200000:65536\n');
  assert.equal(planSubordinateIds(ranges, builder, null, [0, 200, 1000]), null);
  assert.equal(planSubordinateIds(ranges, builder, '200000:65536', [200]), null);
  assert.deepEqual(planSubordinateIds(ranges, builder, '300000:65536', [200]),
    { start: 300000, count: 65536, end: 365535 });
  assert.equal(planSubordinateIds(parseSubordinateIds('200:200000:65536'), builder, null), null);
  assert.throws(() => planSubordinateIds([], builder, null), /explicitly reviewed/);
  assert.throws(() => planSubordinateIds(parseSubordinateIds('undefined:200000:65536'), { name: 'builder' }, null), /explicitly reviewed/);
  assert.throws(() => planSubordinateIds(ranges, builder, '120000:65536'), /conflict/);
  assert.throws(() => planSubordinateIds(ranges, builder, '220000:65536'), /conflict/);
  assert.throws(() => planSubordinateIds([], builder, '300000:65536', [320000]), /enumerated/);
  assert.throws(() => planSubordinateIds(ranges, builder, null, [210000]), /enumerated/);
  assert.throws(() => parseSubordinateIds('one:100000:65536\ntwo:120000:65536'), /Overlapping/);
  assert.throws(() => parseSubordinateIds('broken:abc:65536'), /Malformed/);
  for (const value of ['auto', '0:65536', '65536:1', '65536:-1', '4294967294:65536', '1e6:65536']) {
    assert.throws(() => parseRange(value));
  }
});

test('unit definitions reload by default; activation/restart require their own explicit option', () => {
  assert.deepEqual(activationCommands({}), [['daemon-reload']]);
  assert.deepEqual(activationCommands({ enableLinger: true }), [['daemon-reload']]);
  assert.deepEqual(activationCommands({ activate: true }), [['daemon-reload'], ['enable', '--now', 'pw-deploy.service']]);
  assert.deepEqual(activationCommands({ restart: true }), [['daemon-reload'], ['restart', 'pw-deploy.service']]);
  const unit = renderUnit(template, '/opt/pw-deploy/releases/fixture', '/etc/pw-deploy/config.json');
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/pw-deploy\/releases\/fixture\/app\/deployment\/service.js --config \/etc\/pw-deploy\/config.json$/m);
  for (const line of ['User=root', 'KillMode=control-group', 'SendSIGKILL=yes', 'RuntimeDirectory=pw-deploy',
    'RuntimeDirectoryMode=0700', 'UMask=0077', 'TimeoutStopSec=45s']) assert.ok(unit.split('\n').includes(line), line);
  assert.doesNotMatch(unit, /^(?:ProtectSystem|NoNewPrivileges|ExecStartPost|ExecStopPost)=/m);
  assert.doesNotMatch(unit, /project-workbench\.service|pw-tmux|@RELEASE@|@CONFIG@/);
});

test('root-owned filesystem policy refuses links, wrong owners, writable state, and exposed secrets', () => {
  const regular = {
    uid: 0, mode: 0o100644, nlink: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
  };
  assert.doesNotThrow(() => checkMetadata(regular, { platform: 'linux' }));
  assert.throws(() => checkMetadata({ ...regular, uid: 1000 }, { platform: 'linux' }), /owner/);
  assert.throws(() => checkMetadata({ ...regular, nlink: 2 }, { platform: 'linux' }), /Hard-linked/);
  assert.throws(() => checkMetadata({ ...regular, mode: 0o100664 }, { platform: 'linux' }), /permissions/);
  assert.throws(() => checkMetadata(regular, { privateFile: true, platform: 'linux' }), /permissions/);
  assert.throws(() => checkMetadata({ ...regular, isSymbolicLink: () => true }, { platform: 'linux' }), /link/);
  assert.doesNotThrow(() => checkMetadata({ ...regular, mode: 0o100600 }, { privateFile: true, platform: 'linux' }));
  const directory = { ...regular, mode: 0o40711, isFile: () => false, isDirectory: () => true };
  assert.doesNotThrow(() => checkMetadata(directory, { kind: 'directory', platform: 'linux' }));
  for (const unsafe of [{ ...directory, uid: 1000 }, { ...directory, mode: 0o40731 }, { ...directory, mode: 0o40713 }]) {
    assert.throws(() => checkMetadata(unsafe, { kind: 'directory', platform: 'linux' }), /owner|permissions/);
  }
});

test('code directory access checks distinguish worker code from traversal-only or private state', () => {
  assert.doesNotThrow(() => validateCodeDirectoryMode(0o40755, { platform: 'linux' }));
  for (const mode of [0o40700, 0o40710, 0o40711, 0o40750]) {
    assert.throws(() => validateCodeDirectoryMode(mode, { platform: 'linux' }), /readable\/traversable/);
  }
});

test('state preparation changes only its two dedicated directories and preserves private descendants', async t => {
  const { root, policy } = fixture(t);
  const ancestor = path.join(root, 'shared');
  const state = path.join(ancestor, 'pw-deploy'), jobs = path.join(state, 'jobs');
  const job = path.join(jobs, '12345678-1234-4234-8234-123456789abc');
  const stage = path.join(job, 'stage'), artifacts = path.join(job, 'artifacts');
  fs.mkdirSync(ancestor, { mode: 0o755 });
  for (const directory of [state, jobs]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(job, { mode: 0o711 });
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.mkdirSync(artifacts, { mode: 0o711 });
  const files = [path.join(root, 'config.json'), path.join(root, 'service.token'),
    path.join(state, 'settings.json'), path.join(state, 'targets.json'), path.join(job, 'job.json'),
    path.join(stage, 'source.txt'), path.join(artifacts, 'candidate.oci')];
  for (const file of files) fs.writeFileSync(file, 'PRIVATE_FIXTURE_DATA\n', { mode: 0o600 });
  const untouched = new Map([root, ancestor, job, stage, artifacts, ...files].map(file => {
    const stat = fs.statSync(file);
    return [file, { mode: stat.mode, uid: stat.uid, gid: stat.gid }];
  }));
  const calls = [], chmod = fsp.chmod;
  t.mock.method(fsp, 'chmod', async (file, mode) => {
    calls.push([file, mode]);
    return chmod(file, mode);
  });
  await prepareStateDirectories(state, policy);
  await prepareStateDirectories(state, policy);
  assert.deepEqual(new Set(calls.map(([file]) => file)), new Set([state, jobs]));
  assert.ok(calls.every(([, mode]) => mode === 0o711));
  for (const [file, before] of untouched) {
    const after = fs.statSync(file);
    assert.deepEqual({ mode: after.mode, uid: after.uid, gid: after.gid }, before, file);
  }
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'PRIVATE_FIXTURE_DATA\n');
  if (process.platform !== 'win32') {
    for (const directory of [state, jobs]) assert.equal(fs.statSync(directory).mode & 0o7777, 0o711);
    assert.equal(fs.statSync(stage).mode & 0o7777, 0o700);
  }
});

test('fresh state and jobs directories get 0711 without assigning it to newly created ancestors', async t => {
  const { root, policy } = fixture(t);
  const ancestor = path.join(root, 'operator-parent');
  fs.mkdirSync(ancestor, { mode: 0o755 });
  const before = fs.statSync(ancestor).mode;
  const intermediate = path.join(ancestor, 'dedicated'), state = path.join(intermediate, 'state');
  const calls = [], chmod = fsp.chmod;
  t.mock.method(fsp, 'chmod', async (file, mode) => {
    calls.push([file, mode]);
    return chmod(file, mode);
  });
  await prepareStateDirectories(state, policy);
  assert.deepEqual(new Set(calls.filter(([, mode]) => mode === 0o711).map(([file]) => file)),
    new Set([state, path.join(state, 'jobs')]));
  assert.equal(calls.some(([file]) => file === ancestor || file === root), false);
  assert.equal(fs.statSync(ancestor).mode, before);
  assert.equal(fs.statSync(path.join(state, 'jobs')).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(intermediate).mode & 0o7777, 0o755);
});

test('unsafe jobs paths and unexpected state ownership are rejected before chmod', async t => {
  const { root, policy } = fixture(t);
  const state = path.join(root, 'state'), unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(unrelated, { mode: 0o755 });
  fs.writeFileSync(path.join(unrelated, 'keep'), 'untouched\n');
  fs.symlinkSync(unrelated, path.join(state, 'jobs'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.statSync(state).mode;
  const calls = [], chmod = fsp.chmod;
  t.mock.method(fsp, 'chmod', async (file, mode) => {
    calls.push([file, mode]);
    return chmod(file, mode);
  });
  await assert.rejects(prepareStateDirectories(state, policy), /link/);
  await assert.rejects(prepareStateDirectories(state, { ...policy, owner: policy.owner + 1 }), /owner/);
  assert.deepEqual(calls, []);
  assert.equal(fs.statSync(state).mode, before);
  assert.deepEqual(fs.readdirSync(unrelated), ['keep']);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'untouched\n');
});

test('staged allowlisted release is dependency-free, self-contained, and excludes live data', async t => {
  const { root, policy } = fixture(t);
  const source = sourceFixture(root);
  const release = await stageRelease(source, path.join(root, 'package'), policy);
  const manifest = JSON.parse(fs.readFileSync(path.join(release.directory, 'release.json'), 'utf8'));
  assert.equal(manifest.sha256, release.digest);
  assert.deepEqual(manifest.files, [...PAYLOAD, 'app/package.json'].sort());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(release.directory, 'app', 'package.json'), 'utf8')),
    { private: true, type: 'module' });
  for (const name of ['.git', '.env', 'app/server.js', 'app/data', 'systemd']) {
    assert.equal(fs.existsSync(path.join(release.directory, ...name.split('/'))), false, name);
  }
  const stagedService = await import(pathToFileURL(path.join(release.directory, 'app', 'deployment', 'service.js')).href);
  assert.equal(typeof stagedService.createDeploymentServer, 'function');
  const stagedInstaller = await import(pathToFileURL(path.join(release.directory, 'deploy', 'service', 'install.mjs')).href);
  assert.deepEqual(stagedInstaller.PAYLOAD, PAYLOAD);
  assert.equal(fs.readFileSync(path.join(release.directory, 'deploy', 'service', 'install.sh'), 'utf8').includes('\r'), false);
});

test('restrictive installer umask cannot hide the installed step or its code parents from workers', async t => {
  const { root, policy } = fixture(t);
  const plan = installation(root);
  const directoryModes = [], fileModes = [];
  const chmod = fsp.chmod, open = fsp.open;
  t.mock.method(fsp, 'chmod', async (file, mode) => {
    directoryModes.push([file, mode]);
    return chmod(file, mode);
  });
  t.mock.method(fsp, 'open', async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
      const handleChmod = handle.chmod.bind(handle);
      t.mock.method(handle, 'chmod', async mode => {
        fileModes.push([file, mode]);
        return handleChmod(mode);
      });
    }
    return handle;
  });
  const previousUmask = process.umask(0o077);
  try {
    const release = await installFiles(plan, policy);
    const releases = path.join(plan.prefix, 'releases');
    const stagedRoot = directoryModes.find(([file, mode]) =>
      path.dirname(file) === releases && path.basename(file).startsWith('.stage-') && mode === 0o755)?.[0];
    assert.ok(stagedRoot);
    const stagedCodeDirectories = [plan.prefix, releases, stagedRoot,
      path.join(stagedRoot, 'app'), path.join(stagedRoot, 'app', 'deployment')];
    for (const directory of stagedCodeDirectories) {
      assert.ok(directoryModes.some(([file, mode]) => file === directory && mode === 0o755), directory);
    }
    for (const name of ['step.js', 'service.js']) {
      assert.ok(fileModes.some(([file, mode]) => path.dirname(file) === path.join(stagedRoot, 'app', 'deployment')
        && path.basename(file).startsWith(`.${name}.pw-deploy-`) && mode === 0o644), name);
      assert.equal(fs.existsSync(path.join(release.directory, 'app', 'deployment', name)), true);
    }
    if (process.platform !== 'win32') {
      for (const directory of [plan.prefix, releases, release.directory,
        path.join(release.directory, 'app'), path.join(release.directory, 'app', 'deployment')]) {
        assert.equal(fs.statSync(directory).mode & 0o7777, 0o755, directory);
      }
      assert.equal(fs.statSync(path.join(release.directory, 'app', 'deployment', 'step.js')).mode & 0o7777, 0o644);
      for (const file of [plan.configFile, plan.tokenFile]) assert.equal(fs.statSync(file).mode & 0o7777, 0o600);
      for (const directory of [plan.stateDir, path.join(plan.stateDir, 'jobs')]) {
        assert.equal(fs.statSync(directory).mode & 0o7777, 0o711);
      }
      fs.chmodSync(releases, 0o700);
      await assert.rejects(stageRelease(plan.repo, plan.prefix, policy), /readable\/traversable/);
      assert.equal(fs.statSync(releases).mode & 0o7777, 0o700, 'An existing code parent is refused, not widened');
    }
  } finally { process.umask(previousUmask); }
});

test('repeated preparation preserves configuration, credential, state, and existing checkout', async t => {
  const { root, policy } = fixture(t);
  const plan = installation(root);
  const first = await installFiles(plan, policy);
  assert.equal(fs.statSync(path.join(plan.stateDir, 'jobs')).isDirectory(), true);
  const initialToken = fs.readFileSync(plan.tokenFile, 'utf8');
  assert.match(initialToken, /^[A-Za-z0-9_-]{64}\n$/);
  const configured = `${JSON.stringify({ ...plan.configuration, runtimeUser: 'existing-runtime', retentionDays: 30 }, null, 2)}\n`;
  fs.writeFileSync(plan.configFile, configured);
  fs.writeFileSync(path.join(plan.stateDir, 'retained-job.json'), '{"state":"interrupted"}\n', { mode: 0o600 });
  const next = {
    ...plan, configSnapshot: await readSnapshot(plan.configFile, policy),
    tokenSnapshot: await readSnapshot(plan.tokenFile, { ...policy, privateFile: true }),
    unitSnapshot: await readSnapshot(plan.unitFile, policy),
  };
  const second = await installFiles(next, policy);
  assert.equal(first.directory, second.directory);
  assert.equal(fs.readFileSync(plan.configFile, 'utf8'), configured);
  assert.equal(fs.readFileSync(plan.tokenFile, 'utf8'), initialToken);
  assert.equal(fs.statSync(plan.configFile).mtimeMs, next.configSnapshot.stat.mtimeMs);
  assert.equal(fs.statSync(plan.tokenFile).mtimeMs, next.tokenSnapshot.stat.mtimeMs);
  assert.equal(fs.statSync(plan.unitFile).mtimeMs, next.unitSnapshot.stat.mtimeMs);
  assert.equal(fs.readFileSync(path.join(plan.stateDir, 'retained-job.json'), 'utf8'), '{"state":"interrupted"}\n');
  assert.equal(fs.readFileSync(path.join(plan.repo, '.git', 'private-object'), 'utf8'), 'NON_PACKAGE_FIXTURE_DATA\n');
  assert.deepEqual(fs.readdirSync(path.join(plan.prefix, 'releases')), [first.digest]);
  assert.ok(!JSON.stringify(second).includes(initialToken.trim()));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(plan.tokenFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(plan.configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(plan.tokenFile).uid, process.getuid());
    assert.equal(fs.statSync(plan.stateDir).mode & 0o777, 0o711);
    assert.equal(fs.statSync(path.join(plan.stateDir, 'jobs')).mode & 0o777, 0o711);
  }
});

test('a new code release is additive and tampered prior releases are not overwritten', async t => {
  const { root, policy } = fixture(t);
  const source = sourceFixture(root), prefix = path.join(root, 'package');
  const first = await stageRelease(source, prefix, policy);
  fs.appendFileSync(path.join(source, 'app', 'deployment', 'service.js'), '\n// fixture release change\n');
  const second = await stageRelease(source, prefix, policy);
  assert.notEqual(second.digest, first.digest);
  assert.equal(fs.existsSync(first.directory), true);
  const changed = path.join(second.directory, 'app', 'deployment', 'service.js');
  fs.appendFileSync(changed, '\n// local tamper fixture\n');
  await assert.rejects(stageRelease(source, prefix, policy), /differs from its package/);
  assert.match(fs.readFileSync(changed, 'utf8'), /local tamper fixture/);
});

test('an unmanaged unit and a Git-checkout prefix are refused before overwriting anything', async t => {
  const { root, policy } = fixture(t);
  const plan = installation(root);
  fs.mkdirSync(path.dirname(plan.unitFile));
  fs.writeFileSync(plan.unitFile, '[Service]\nExecStart=/operator/managed\n', { mode: 0o644 });
  plan.unitSnapshot = await readSnapshot(plan.unitFile, policy);
  await assert.rejects(installFiles(plan, policy), /not managed/);
  assert.equal(fs.existsSync(plan.tokenFile), false);
  fs.mkdirSync(plan.prefix);
  fs.chmodSync(plan.prefix, 0o755);
  fs.mkdirSync(path.join(plan.prefix, '.git'));
  await assert.rejects(stageRelease(plan.repo, plan.prefix, policy), /Git checkout/);
  assert.equal(fs.readFileSync(plan.unitFile, 'utf8'), '[Service]\nExecStart=/operator/managed\n');
});

test('package installation refuses a hostile directory symlink or junction', async t => {
  const { root, policy } = fixture(t);
  const source = sourceFixture(root), outside = path.join(root, 'unrelated');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
  const linked = path.join(root, 'linked-prefix');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageRelease(source, linked, policy), /link/);
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
});

test('atomic publication refuses changed input and cleans only its own temporary file', async t => {
  const { root, policy } = fixture(t);
  const file = path.join(root, 'policy.json');
  fs.writeFileSync(file, 'original\n', { mode: 0o600 });
  const expected = await readSnapshot(file, policy);
  fs.writeFileSync(file, 'operator change\n');
  await assert.rejects(atomicFile(file, 'replacement\n', {
    expected, policy, uid: policy.owner, gid: process.getgid?.() ?? 0,
  }), /changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'operator change\n');
  assert.deepEqual(fs.readdirSync(root), ['policy.json']);
});

test('atomic publication also refuses metadata changes when file content is unchanged', async t => {
  const { root, policy } = fixture(t);
  const file = path.join(root, 'policy.json');
  fs.writeFileSync(file, 'unchanged content\n', { mode: 0o600 });
  const expected = await readSnapshot(file, policy);
  fs.chmodSync(file, 0o400);
  try {
    await assert.rejects(atomicFile(file, 'replacement\n', {
      expected, policy, uid: policy.owner, gid: process.getgid?.() ?? 0,
    }), /changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged content\n');
  } finally { fs.chmodSync(file, 0o600); }
});

test('installer help executes without host modification and documents explicit activation', () => {
  const result = spawnSync(process.execPath, [path.join(SERVICE, 'install.mjs'), '--help'], {
    cwd: REPO, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /never start\/restart a service/);
  assert.match(result.stdout, /--activate \| --restart/);
});
