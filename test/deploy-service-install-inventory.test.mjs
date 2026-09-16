import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inventorySlots } from '../deploy/service/inventory.mjs';

const SERVICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'service');
const secret = 'FIXTURE_CREDENTIAL_MUST_NOT_APPEAR';
const configuration = {
  ExampleApp: {
    dev: {
      script: `cd /opt/example; git pull; nsenter -t 1 -m -- sudo podman build .; echo "${secret}"`,
      versionCmd: 'systemctl --user status example-app-dev', runAsRoot: true,
      environment: { DEPLOY_PASSWORD: secret }, password: secret, token: secret,
    },
    prod: { script: 'bash deploy/publish.sh', versionCmd: '', deployPassword: secret },
  },
  ExampleIis: { prod: { script: 'dotnet publish; smbclient "$DEPLOY_SHARE"', versionCmd: 'winrm read-version' } },
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(SERVICE, '.inventory-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'deploy-config.json');
  fs.writeFileSync(file, JSON.stringify(configuration), { mode: 0o600 });
  return { root, file };
}

test('migration inventory emits only slot identities, presence bits, and heuristic labels', () => {
  const report = inventorySlots(configuration);
  assert.equal(report.kind, 'heuristic-migration-inventory');
  assert.equal(report.slots.length, 3);
  assert.deepEqual(report.slots[0], {
    project: 'ExampleApp', target: 'dev', scriptPresent: true, versionCommandPresent: true,
    flags: ['namespace-entry', 'privilege-switching', 'container-assumptions', 'service-control',
      'absolute-host-paths', 'mutable-checkout', 'legacy-root-grant'],
  });
  assert.deepEqual(report.slots[1].flags, []);
  assert.deepEqual(report.slots[2].flags, ['remote-or-optional-toolchain']);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes('nsenter -t'));
  assert.ok(!JSON.stringify(report).includes('DEPLOY_PASSWORD'));
  assert.equal(configuration.ExampleApp.dev.runAsRoot, true);
});

test('invalid saved-slot data fails explicitly instead of returning a success-shaped empty report', () => {
  for (const value of [null, [], { ExampleApp: null }, { ExampleApp: { dev: { script: 123 } } },
    { 'invalid\nproject': { dev: {} } }, { ExampleApp: { prod: { versionCmd: {} } } }]) {
    assert.throws(() => inventorySlots(value), /configuration|slot/);
  }
});

test('inventory CLI is read-only and does not leak script bodies or credentials, including JSON errors', t => {
  const { root, file } = fixture(t);
  const before = fs.readFileSync(file);
  const invoke = () => spawnSync(process.execPath, [path.join(SERVICE, 'inventory.mjs'), '--config', file], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), inventorySlots(configuration));
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(root), ['deploy-config.json']);
  fs.writeFileSync(file, `{"password": "${secret}", BROKEN`);
  const invalid = invoke();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not valid JSON/);
  assert.equal(`${invalid.stdout}${invalid.stderr}`.includes(secret), false);
});

test('inventory CLI rejects symlinked input directories instead of following them', t => {
  const { root, file } = fixture(t);
  const link = path.join(root, 'linked');
  const target = path.join(root, 'source');
  fs.mkdirSync(target);
  fs.copyFileSync(file, path.join(target, 'deploy-config.json'));
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath,
    [path.join(SERVICE, 'inventory.mjs'), '--config', path.join(link, 'deploy-config.json')], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /link/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});
