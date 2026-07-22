// Isolation must be safe by default: ANY registry path other than the
// configured canonical one runs isolated (no host tmux/nginx/systemd writes).
// Host mode for a non-default location (e.g. GOA's /etc registry) requires the
// explicit PW_CANONICAL_REGISTRY override — never inference from "not /tmp".
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIsolation, DEFAULT_CANONICAL_REGISTRY } from '../app/isolation.js';

test('default env: canonical registry, host mode', () => {
  const r = resolveIsolation({});
  assert.equal(r.registryPath, DEFAULT_CANONICAL_REGISTRY);
  assert.equal(r.canonicalRegistry, DEFAULT_CANONICAL_REGISTRY);
  assert.equal(r.isolated, false);
});

test('explicit PW_ISOLATED=1 forces isolation even on the canonical registry', () => {
  assert.equal(resolveIsolation({ PW_ISOLATED: '1' }).isolated, true);
});

for (const p of [
  '/tmp/pw-test/projects.json',
  '/root/projects.json',
  '/var/tmp/pw/projects.json',
  '/var/lib/pw/projects.json',
]) {
  test(`non-canonical registry ${p} -> isolated`, () => {
    assert.equal(resolveIsolation({ PW_REGISTRY_PATH: p }).isolated, true);
  });
}

test('registry explicitly set to the canonical path stays host mode', () => {
  assert.equal(resolveIsolation({ PW_REGISTRY_PATH: DEFAULT_CANONICAL_REGISTRY }).isolated, false);
});

test('GOA production override: canonical registry moved under /etc -> host mode', () => {
  const env = { PW_CANONICAL_REGISTRY: '/etc/project-workbench/projects.json' };
  const r = resolveIsolation(env);
  assert.equal(r.isolated, false);
  assert.equal(r.registryPath, '/etc/project-workbench/projects.json');
  assert.equal(
    resolveIsolation({ ...env, PW_REGISTRY_PATH: '/etc/project-workbench/projects.json' }).isolated,
    false,
  );
});

test('GOA override still isolates when pointed at a different registry', () => {
  const r = resolveIsolation({
    PW_CANONICAL_REGISTRY: '/etc/project-workbench/projects.json',
    PW_REGISTRY_PATH: '/tmp/throwaway/projects.json',
  });
  assert.equal(r.isolated, true);
});

test('PW_ISOLATED=1 wins over a matching canonical override', () => {
  const r = resolveIsolation({
    PW_ISOLATED: '1',
    PW_CANONICAL_REGISTRY: '/etc/project-workbench/projects.json',
    PW_REGISTRY_PATH: '/etc/project-workbench/projects.json',
  });
  assert.equal(r.isolated, true);
});
