import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PATH = path.resolve(TEST_DIR, '..', 'deploy', 'container', 'runtime-relay.py');
const REAL_FIXTURE_PATH = path.resolve(TEST_DIR, '..', '..', 'contained-oci-fixture', 'fixture.oci.tar');
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const REVISION = 'a'.repeat(40);

async function detectPython() {
  for (const candidate of ['python3', 'python']) {
    try {
      await execFileAsync(candidate, ['--version']);
      return candidate;
    } catch {
      // Try the next conventional Python executable.
    }
  }
  return null;
}
const PYTHON = await detectPython();

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function tar(entries) {
  const parts = [];
  for (const { name, data = Buffer.alloc(0), type } of entries) {
    parts.push(tarHeader(name, data.length, type));
    parts.push(data);
    const padding = (512 - data.length % 512) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ociArchive({ foreignTag = false, extraEntry = false, corruptManifest = false } = {}) {
  const config = Buffer.from(JSON.stringify({
    architecture: 'amd64',
    os: 'linux',
    config: { Labels: { 'org.opencontainers.image.revision': REVISION } },
  }));
  const configDigest = sha256(config);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: `sha256:${configDigest}`,
      size: config.length,
    },
    layers: [],
  }));
  const manifestDigest = sha256(manifest);
  const index = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${manifestDigest}`,
      size: manifest.length,
      annotations: {
        'org.opencontainers.image.ref.name': foreignTag ? 'localhost/unrelated:latest' : `localhost/myproj:candidate-${JOB_ID}`,
      },
    }],
  }));
  const manifestData = corruptManifest ? Buffer.from(`${manifest.toString('utf8')} `) : manifest;
  return {
    expectedImageId: `sha256:${configDigest}`,
    data: tar([
      { name: 'blobs', type: '5' },
      { name: 'blobs/sha256', type: '5' },
      { name: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
      { name: 'index.json', data: index },
      { name: `blobs/sha256/${manifestDigest}`, data: manifestData },
      { name: `blobs/sha256/${configDigest}`, data: config },
      ...(extraEntry ? [{ name: 'unexpected.txt', data: Buffer.from('not OCI') }] : []),
    ]),
  };
}

const HARNESS = String.raw`
import base64, importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("relay", sys.argv[1])
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
relay.sys.platform = "test"
payload = base64.b64decode(sys.argv[3])
request = json.loads(sys.argv[2])
calls = []
class Result:
  def __init__(self, stdout=b""): self.stdout = stdout
def forbidden_podman(args, **kwargs):
  calls.append(args)
  raise AssertionError("podman must not run for an invalid archive")
relay.stage_oci_stream = lambda stream, limit: io.BytesIO(payload)
relay.podman = forbidden_podman
policy = {"resourceNames": {}, "healthHosts": ["127.0.0.1"], "maxImageBytes": 8 * 1024 * 1024}
try:
  relay.handle_image_import(policy, request, io.BytesIO(payload))
  result = {"ok": True}
except relay.RelayError as error:
  result = {"ok": False, "code": error.code, "message": str(error)}
print(json.dumps({"result": result, "podmanCalls": calls}))
`;

async function importAttempt(archive, overrides = {}) {
  const request = {
    requestId: 'request_123',
    action: 'image_import',
    project: 'myproj',
    target: 'prod',
    image: 'myproj',
    jobId: JOB_ID,
    expectedImageId: archive.expectedImageId,
    revision: REVISION,
    ...overrides,
  };
  const { stdout } = await execFileAsync(PYTHON, [
    '-c', HARNESS, RELAY_PATH, JSON.stringify(request), archive.data.toString('base64'),
  ], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

test('relay production entrypoint has immutable command and policy configuration', { skip: !PYTHON }, async () => {
  const { stdout } = await execFileAsync(PYTHON, ['-c', String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("relay", sys.argv[1])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
print(json.dumps({"podman": relay.PODMAN_BIN, "systemctl": relay.SYSTEMCTL_BIN, "policy": relay.DEFAULT_POLICY_FILE,
  "runtime": relay.runtime_environment() if hasattr(relay.os, "getuid") else None}))
`, RELAY_PATH]);
  const value = JSON.parse(stdout);
  assert.equal(value.podman, '/usr/bin/podman');
  assert.equal(value.systemctl, '/usr/bin/systemctl');
  assert.equal(value.policy, '/etc/pw-deploy/runtime-policy.json');
  if (value.runtime) {
    assert.equal(value.runtime.XDG_RUNTIME_DIR, `/run/user/${process.getuid()}`);
    assert.equal(value.runtime.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${process.getuid()}/bus`);
  }
});

for (const [name, options, assertion] of [
  ['foreign candidate tag', { foreignTag: true }, value => assert.equal(value.result.code, 'invalid_image')],
  ['extra archive entry', { extraEntry: true }, value => assert.equal(value.result.code, 'invalid_image')],
  ['digest-inconsistent manifest', { corruptManifest: true }, value => assert.equal(value.result.code, 'invalid_image')],
  ['wrong expected image ID', {}, value => assert.equal(value.result.code, 'invalid_image')],
]) {
  test(`image_import rejects ${name} before invoking podman`, { skip: !PYTHON }, async () => {
    const archive = ociArchive(options);
    const value = await importAttempt(archive, name === 'wrong expected image ID'
      ? { expectedImageId: `sha256:${'f'.repeat(64)}` } : {});
    assert.equal(value.result.ok, false);
    assertion(value);
    assert.deepEqual(value.podmanCalls, []);
  });
}

test('image_import requires expected image ID and revision metadata before staging', { skip: !PYTHON }, async () => {
  const archive = ociArchive();
  for (const field of ['expectedImageId', 'revision']) {
    const request = { [field]: undefined };
    const value = await importAttempt(archive, request);
    assert.equal(value.result.ok, false);
    assert.equal(value.result.code, 'invalid_request');
    assert.deepEqual(value.podmanCalls, []);
  }
});

const CANDIDATE_REMOVE_HARNESS = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("relay", sys.argv[1])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
scenario, expected = sys.argv[2:]
calls = []
class Result:
  def __init__(self, returncode=0, stdout=b""): self.returncode, self.stdout = returncode, stdout
def podman(args, **kwargs):
  calls.append(args)
  if args[:2] == ["image", "exists"]:
    return Result(1 if scenario == "absent" else 0)
  if args[:2] == ["image", "inspect"]:
    actual = expected if scenario == "matching" else "sha256:" + "f" * 64
    return Result(0, actual.encode())
  if args[:2] == ["image", "rm"]:
    return Result()
  raise AssertionError("unexpected podman action")
relay.podman = podman
request = {"project": "myproj", "target": "prod", "image": "myproj",
  "jobId": "123e4567-e89b-42d3-a456-426614174000", "expectedImageId": expected}
policy = {"resourceNames": {}, "healthHosts": ["127.0.0.1"], "maxImageBytes": 1024}
try:
  result = relay.handle_image_remove_candidate(policy, request, None)
  value = {"ok": True, "result": result}
except relay.RelayError as error:
  value = {"ok": False, "code": error.code}
print(json.dumps({"value": value, "calls": calls}))
`;

async function removeCandidateAttempt(scenario) {
  const expected = `sha256:${'c'.repeat(64)}`;
  const { stdout } = await execFileAsync(PYTHON, ['-c', CANDIDATE_REMOVE_HARNESS, RELAY_PATH, scenario, expected]);
  return JSON.parse(stdout);
}

test('image_remove_candidate treats an absent candidate as safe without inspecting or deleting', { skip: !PYTHON }, async () => {
  const value = await removeCandidateAttempt('absent');
  assert.deepEqual(value.value, { ok: true, result: { removed: false } });
  assert.equal(value.calls.length, 1);
  assert.deepEqual(value.calls[0].slice(0, 2), ['image', 'exists']);
});

test('image_remove_candidate refuses a replacement candidate without deleting it', { skip: !PYTHON }, async () => {
  const value = await removeCandidateAttempt('mismatch');
  assert.deepEqual(value.value, { ok: false, code: 'resource_conflict' });
  assert.deepEqual(value.calls.map(args => args.slice(0, 2)), [['image', 'exists'], ['image', 'inspect']]);
});

test('image_remove_candidate removes only a candidate whose ID matches the checkpoint', { skip: !PYTHON }, async () => {
  const value = await removeCandidateAttempt('matching');
  assert.deepEqual(value.value, { ok: true, result: { removed: true } });
  assert.deepEqual(value.calls.map(args => args.slice(0, 2)), [
    ['image', 'exists'], ['image', 'inspect'], ['image', 'rm'],
  ]);
});

test('a well-formed archive reaches the platform gate without invoking podman', { skip: !PYTHON }, async () => {
  const value = await importAttempt(ociArchive());
  assert.equal(value.result.ok, false);
  assert.equal(value.result.code, 'process_failed', value.result.message);
  assert.deepEqual(value.podmanCalls, []);
});

test('Podman-generated zero-layer OCI fixture passes validation before the platform gate', { skip: !PYTHON }, async t => {
  try {
    await fs.access(REAL_FIXTURE_PATH);
  } catch {
    t.skip('read-only OCI fixture is not present');
    return;
  }
  const harness = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("relay", sys.argv[2])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
relay.sys.platform = "test"
try:
  with open(sys.argv[1], "rb") as archive:
    relay.validate_oci_archive(archive,
      "localhost/pw-oci-fixture-524637ea-dev:candidate-c83df704-45b9-4a10-8b83-c1972b12d6f8",
      "sha256:75c584a21c7922419d8904cc3c1d5229422399678939227f18e7594479ca537f",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 8 * 1024 * 1024)
except relay.RelayError as error:
  print(json.dumps({"code": error.code}))
`;
  const { stdout } = await execFileAsync(PYTHON, ['-c', harness, REAL_FIXTURE_PATH, RELAY_PATH]);
  assert.deepEqual(JSON.parse(stdout), { code: 'process_failed' });
});
