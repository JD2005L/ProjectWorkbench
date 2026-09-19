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
max_image_bytes = int(sys.argv[4]) if len(sys.argv) > 4 else 8 * 1024 * 1024
policy = {"resourceNames": {}, "healthHosts": ["127.0.0.1"], "maxImageBytes": max_image_bytes, "healthTargets": {}}
try:
  relay.handle_image_import(policy, request, io.BytesIO(payload))
  result = {"ok": True}
except relay.RelayError as error:
  result = {"ok": False, "code": error.code, "message": str(error)}
print(json.dumps({"result": result, "podmanCalls": calls}))
`;

async function importAttempt(archive, overrides = {}, maxImageBytes = null) {
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
  const args = ['-c', HARNESS, RELAY_PATH, JSON.stringify(request), archive.data.toString('base64')];
  if (maxImageBytes !== null) args.push(String(maxImageBytes));
  const { stdout } = await execFileAsync(PYTHON, args, { maxBuffer: 1024 * 1024 });
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
state = {"untagged": False}
class Result:
  def __init__(self, returncode=0, stdout=b""): self.returncode, self.stdout = returncode, stdout
def podman(args, **kwargs):
  calls.append(args)
  head = args[:2]
  if head == ["image", "exists"]:
    if scenario == "absent":
      return Result(1)
    if state["untagged"]:
      return Result(1)
    return Result(0)
  if head == ["image", "inspect"]:
    actual = expected if scenario in ("matching", "interleaved") else "sha256:" + "f" * 64
    return Result(0, actual.encode())
  if head == ["image", "untag"]:
    if scenario == "interleaved":
      return Result(125)
    state["untagged"] = True
    return Result(0)
  if head == ["image", "rm"]:
    raise AssertionError("candidate removal must never delete by image id")
  raise AssertionError("unexpected podman action: " + json.dumps(args))
relay.podman = podman
request = {"project": "myproj", "target": "prod", "image": "myproj",
  "jobId": "123e4567-e89b-42d3-a456-426614174000", "expectedImageId": expected}
policy = {"resourceNames": {}, "healthHosts": ["127.0.0.1"], "maxImageBytes": 1024, "healthTargets": {}}
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

test('image_remove_candidate untags only a candidate whose ID matches the checkpoint', { skip: !PYTHON }, async () => {
  const value = await removeCandidateAttempt('matching');
  assert.deepEqual(value.value, { ok: true, result: { removed: true } });
  assert.deepEqual(value.calls.map(args => args.slice(0, 2)), [
    ['image', 'exists'], ['image', 'inspect'], ['image', 'untag'], ['image', 'exists'],
  ]);
  const untag = value.calls.find(args => args[1] === 'untag');
  assert.deepEqual(untag, ['image', 'untag', `sha256:${'c'.repeat(64)}`, `localhost/myproj:candidate-${JOB_ID}`]);
  assert.ok(!value.calls.some(args => args[1] === 'rm'), 'must not remove by image id');
});

test('image_remove_candidate refuses a tag reassigned between inspect and untag', { skip: !PYTHON }, async () => {
  const value = await removeCandidateAttempt('interleaved');
  assert.deepEqual(value.value, { ok: false, code: 'resource_conflict' });
  assert.deepEqual(value.calls.map(args => args.slice(0, 2)), [
    ['image', 'exists'], ['image', 'inspect'], ['image', 'untag'],
  ]);
  assert.ok(!value.calls.some(args => args[1] === 'rm'), 'a reassigned tag must never be deleted by id');
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

test('image_import caps the canonical archive before staging it into a memfd', { skip: !PYTHON }, async () => {
  const value = await importAttempt(ociArchive(), {}, 3000);
  assert.equal(value.result.ok, false);
  assert.equal(value.result.code, 'invalid_image', value.result.message);
  assert.match(value.result.message, /Canonical/);
  assert.deepEqual(value.podmanCalls, []);
});

test('image_import accounts for tar record padding when capping the canonical archive', { skip: !PYTHON }, async () => {
  // The canonical archive's logical content is 6144 bytes but tarfile pads the
  // whole file up to RECORDSIZE (10240) on close. A limit that sits between the
  // two (8192) must still be rejected up front, before any memfd is created.
  const value = await importAttempt(ociArchive(), {}, 8192);
  assert.equal(value.result.ok, false);
  assert.equal(value.result.code, 'invalid_image', value.result.message);
  assert.match(value.result.message, /Canonical/);
  assert.deepEqual(value.podmanCalls, []);
});

const HEALTH_HARNESS = String.raw`
import importlib.util, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("relay", sys.argv[2])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
scenario = sys.argv[1]
class Handler(BaseHTTPRequestHandler):
  def do_GET(self):
    if scenario == "dribble":
      # Emit the status line and headers immediately, then trickle the body one
      # byte at a time for far longer than the probe budget so the relay must
      # bound the whole transaction rather than block on response.read().
      self.send_response(200)
      self.send_header("Content-Type", "application/json")
      self.send_header("Content-Length", "200")
      self.end_headers()
      for _ in range(200):
        try:
          self.wfile.write(b"a"); self.wfile.flush()
        except Exception:
          return
        time.sleep(0.1)
      return
    body = json.dumps({"ok": True, "version": "1.2.3"}).encode()
    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)
  def log_message(self, *args): pass
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
other_port = port + 1 if port < 65535 else port - 1
expected = "sha256:" + "a" * 64
class Result:
  def __init__(self, returncode=0, stdout=b""): self.returncode, self.stdout = returncode, stdout
ports_map = {
  "direct_ok": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
  "image_mismatch": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
  "direct_wrong_port": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(other_port)}]},
  "dribble": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
  "direct_udp_only": {"3000/udp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
  "direct_v6_url_v4_published": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
  "direct_v4_url_v6_published": {"3000/tcp": [{"HostIp": "::1", "HostPort": str(port)}]},
  "direct_wildcard_v4": {"3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": str(port)}]},
}.get(scenario, {})
def podman(args, **kwargs):
  head = args[:2]
  if head == ["container", "exists"]:
    return Result(0)
  if head == ["container", "inspect"]:
    fmt = args[3]
    if "State.Running" in fmt:
      img = expected if scenario != "image_mismatch" else "sha256:" + "f" * 64
      return Result(0, ("true " + img).encode())
    if "NetworkSettings.Ports" in fmt:
      return Result(0, json.dumps(ports_map).encode())
  raise AssertionError("unexpected podman action: " + json.dumps(args))
relay.podman = podman
health_hosts = ["127.0.0.1", "::1", "health.internal"]
health_targets = {}
if scenario == "direct_ok":
  os.environ["http_proxy"] = "http://127.0.0.1:1"
  os.environ["https_proxy"] = "http://127.0.0.1:1"
  health_url = "http://127.0.0.1:%d/healthz" % port
elif scenario == "direct_wrong_port":
  health_url = "http://127.0.0.1:%d/healthz" % port
elif scenario == "proxy_ok":
  health_url = "http://127.0.0.1:%d/legacy/health" % port
  health_targets = {"myproj/prod": health_url}
elif scenario == "proxy_unapproved":
  health_url = "https://health.internal/health"
elif scenario == "dribble":
  relay.HEALTH_PROBE_TIMEOUT_SECONDS = 2
  health_url = "http://127.0.0.1:%d/healthz" % port
elif scenario == "direct_udp_only":
  health_url = "http://127.0.0.1:%d/healthz" % port
elif scenario == "direct_v6_url_v4_published":
  health_url = "http://[::1]:%d/healthz" % port
elif scenario == "direct_v4_url_v6_published":
  health_url = "http://127.0.0.1:%d/healthz" % port
elif scenario == "direct_wildcard_v4":
  health_url = "http://127.0.0.1:%d/healthz" % port
elif scenario == "bad_port_request":
  health_url = "http://127.0.0.1:99999/healthz"
else:
  health_url = "http://127.0.0.1:%d/healthz" % port
policy = {"resourceNames": {}, "healthHosts": health_hosts, "maxImageBytes": 1024, "healthTargets": health_targets}
request = {"requestId": "request_1", "action": "health_check", "project": "myproj", "target": "prod",
  "service": "myproj", "expectedImageId": expected, "healthUrl": health_url, "versionField": "version"}
started = time.monotonic()
try:
  result = relay.handle_health_check(policy, request, None)
  value = {"ok": True, "result": result}
except relay.RelayError as error:
  value = {"ok": False, "code": error.code}
value["elapsed"] = time.monotonic() - started
server.shutdown()
print(json.dumps(value))
`;

async function healthAttempt(scenario) {
  const { stdout } = await execFileAsync(PYTHON, ['-c', HEALTH_HARNESS, scenario, RELAY_PATH]);
  return JSON.parse(stdout);
}

const POSIX_HEALTH_SKIP = process.platform === 'win32'
  ? 'health probing runs a supervised subprocess with POSIX pipe readiness polling'
  : !PYTHON;

test('health_check accepts a direct loopback probe bound to the container port with a matching image', { skip: POSIX_HEALTH_SKIP }, async () => {
  const value = await healthAttempt('direct_ok');
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.result, { version: '1.2.3' });
});

test('health_check rejects a direct probe against a port this container does not publish', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('direct_wrong_port');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'health_target_not_allowed');
});

test('health_check accepts an operator-approved proxy target without a published port', { skip: POSIX_HEALTH_SKIP }, async () => {
  const value = await healthAttempt('proxy_ok');
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.result, { version: '1.2.3' });
});

test('health_check rejects a proxied URL that has no operator binding', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('proxy_unapproved');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'health_target_not_allowed');
});

test('health_check refuses to probe when the container is not running the expected image', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('image_mismatch');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'health_failed');
});

test('health_check rejects a UDP publication for a TCP HTTP health probe', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('direct_udp_only');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'health_target_not_allowed');
});

test('health_check rejects an IPv6 loopback URL when only the IPv4 loopback port is published', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('direct_v6_url_v4_published');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'health_target_not_allowed');
});

test('health_check rejects an IPv4 loopback URL when only the IPv6 loopback port is published', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('direct_v4_url_v6_published');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'health_target_not_allowed');
});

test('health_check rejects a request-time health URL with an out-of-range port', { skip: !PYTHON }, async () => {
  const value = await healthAttempt('bad_port_request');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'invalid_request');
});

test('health_check accepts an IPv4 loopback URL covered by a same-family wildcard publication', { skip: POSIX_HEALTH_SKIP }, async () => {
  const value = await healthAttempt('direct_wildcard_v4');
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.result, { version: '1.2.3' });
});

test('health_check bounds a dribbling response with an absolute deadline instead of blocking', {
  skip: process.platform === 'win32' ? 'health probing runs a supervised subprocess with POSIX pipe readiness polling' : !PYTHON,
}, async () => {
  const value = await healthAttempt('dribble');
  assert.equal(value.ok, false, JSON.stringify(value));
  assert.equal(value.code, 'health_failed');
  assert.ok(value.elapsed < 8, `probe should be bounded, took ${value.elapsed}s`);
});

const READ_REQUEST_HARNESS = String.raw`
import importlib.util, io, json, os, sys, time
spec = importlib.util.spec_from_file_location("relay", sys.argv[2])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
mode = sys.argv[1]
def frame(obj):
  body = json.dumps(obj).encode()
  return str(len(body)).zfill(10).encode() + body
if mode == "full":
  req = relay.read_request(io.BytesIO(frame({"action": "container_status", "requestId": "r1"})))
  print(json.dumps({"ok": True, "request": req}))
elif mode == "truncated":
  try:
    relay.read_request(io.BytesIO(b"0000000050" + b"{}"))
    print(json.dumps({"ok": True}))
  except relay.RelayError as error:
    print(json.dumps({"ok": False, "code": error.code}))
elif mode == "pipe_timeout":
  relay.REQUEST_READ_TIMEOUT_SECONDS = 1
  r, w = os.pipe()
  os.write(w, b"000")
  class Stream:
    def fileno(self): return r
    def read(self, n): return os.read(r, n)
  start = time.monotonic()
  try:
    relay.read_request(Stream())
    print(json.dumps({"ok": True}))
  except relay.RelayError as error:
    print(json.dumps({"ok": False, "code": error.code, "elapsed": time.monotonic() - start}))
`;

async function readRequestAttempt(mode) {
  const { stdout } = await execFileAsync(PYTHON, ['-c', READ_REQUEST_HARNESS, mode, RELAY_PATH]);
  return JSON.parse(stdout);
}

test('read_request decodes a complete bounded in-memory frame', { skip: !PYTHON }, async () => {
  const value = await readRequestAttempt('full');
  assert.equal(value.ok, true);
  assert.equal(value.request.action, 'container_status');
});

test('read_request rejects a truncated frame without blocking', { skip: !PYTHON }, async () => {
  const value = await readRequestAttempt('truncated');
  assert.deepEqual(value, { ok: false, code: 'invalid_request' });
});

test('read_request enforces an absolute deadline on idle partial input (POSIX pipe)', {
  skip: process.platform === 'win32' ? 'requires POSIX pipe readiness polling' : !PYTHON,
}, async () => {
  const value = await readRequestAttempt('pipe_timeout');
  assert.equal(value.ok, false);
  assert.equal(value.code, 'invalid_request');
  assert.ok(value.elapsed >= 0.9, `deadline should be honored, got ${value.elapsed}`);
});

const RUN_COMMAND_HARNESS = String.raw`
import importlib.util, json, os, subprocess, sys, time
spec = importlib.util.spec_from_file_location("relay", sys.argv[2])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
mode = sys.argv[1]
if mode == "output_cap":
  try:
    relay.run_command(["/bin/sh", "-c", "yes | head -c 5000000"], max_output_bytes=1024)
    print(json.dumps({"ok": True}))
  except relay.RelayError as error:
    print(json.dumps({"ok": False, "code": error.code}))
elif mode == "home":
  import pwd
  os.environ["HOME"] = "/tmp/tampered-home-should-be-ignored"
  env = relay.runtime_environment()
  print(json.dumps({"home": env["HOME"], "expected": pwd.getpwuid(os.getuid()).pw_dir}))
elif mode == "reap_escalates":
  import select, signal
  relay.REAP_WAIT_SECONDS = 1
  child = subprocess.Popen(
    [sys.executable, "-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(60)"],
    stdout=subprocess.PIPE, start_new_session=True)
  relay.ACTIVE_PROCESSES.add(child)
  try:
    # Sending TERM before the child installs its handler only proves default termination.
    if not select.select([child.stdout], [], [], 3)[0]:
      raise RuntimeError("Signal-ignoring helper did not become ready")
    assert os.read(child.stdout.fileno(), 6) == b"ready\n"
    start = time.monotonic()
    relay._terminate_and_reap(child)
    elapsed = time.monotonic() - start
    result = {"returncode": child.returncode, "alive": child.poll() is None,
              "elapsed": elapsed, "sigkill": child.returncode == -signal.SIGKILL}
  finally:
    if child.poll() is None:
      child.kill()
    child.wait(timeout=5)
    child.stdout.close()
    relay.ACTIVE_PROCESSES.discard(child)
  print(json.dumps(result))
elif mode == "reap_unconfirmed":
  # If even a post-SIGKILL wait cannot confirm the process is gone, the cleanup
  # must surface an error rather than silently returning success-shaped.
  relay.REAP_WAIT_SECONDS = 1
  relay._stop_process = lambda p: None
  relay._kill_process = lambda p: None
  class FakeProc:
    returncode = None
    def poll(self): return None
    def wait(self, timeout=None): raise subprocess.TimeoutExpired("fake", timeout)
  try:
    relay._terminate_and_reap(FakeProc())
    print(json.dumps({"raised": False}))
  except relay.RelayError as error:
    print(json.dumps({"raised": True, "code": error.code}))
elif mode in ("probe_unconfirmed_stop", "probe_unavailable", "probe_cancelled"):
  waits = []
  class FakeProc:
    def poll(self): return None
    def wait(self, timeout=None):
      waits.append(timeout)
      raise subprocess.TimeoutExpired("controlled-helper", timeout)
  relay._stop_process = lambda process: None
  relay._kill_process = lambda process: None
  def command(*args, **kwargs):
    if mode == "probe_unconfirmed_stop":
      relay._terminate_and_reap(FakeProc())
    elif mode == "probe_cancelled":
      raise relay.RelayError("Runtime connector was cancelled", "cancelled")
    else:
      raise relay.RelayError("Controlled helper failure", "process_failed")
  relay.run_command = command
  try:
    relay._probe_health("http://127.0.0.1:12345/health")
    print(json.dumps({"raised": False}))
  except relay.RelayError as error:
    print(json.dumps({"raised": True, "code": error.code, "waits": len(waits),
      "unconfirmed": isinstance(error, relay.UnconfirmedProcessStop)}))
elif mode == "cancel_retains_tracking":
  # When a cancel/exceptional path cannot confirm the helper stopped, tracking
  # must be retained (not discarded) and the unconfirmed-stop error surfaced.
  captured = {}
  def fake_reap(process):
    captured["process"] = process
    raise relay.RelayError("Runtime helper could not be stopped", "process_failed")
  relay._terminate_and_reap = fake_reap
  out = {"raised": False}
  try:
    relay.run_command([sys.executable, "-c", "import time;time.sleep(30)"], timeout=1)
  except relay.RelayError as error:
    process = captured.get("process")
    out = {"raised": True, "code": error.code, "tracked": process in relay.ACTIVE_PROCESSES}
    if process is not None:
      if process.poll() is None:
        process.kill()
      process.wait(timeout=5)
      process.stdout.close()
      relay.ACTIVE_PROCESSES.discard(process)
  print(json.dumps(out))
`;

async function runCommandAttempt(mode) {
  const { stdout } = await execFileAsync(PYTHON, ['-c', RUN_COMMAND_HARNESS, mode, RELAY_PATH], {
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('run_command bounds and terminates a helper that overruns its output cap (POSIX)', {
  skip: process.platform === 'win32' ? 'requires POSIX pipe readiness polling and /bin/sh' : !PYTHON,
}, async () => {
  const value = await runCommandAttempt('output_cap');
  assert.deepEqual(value, { ok: false, code: 'process_failed' });
});

test('runtime_environment derives HOME from the account record, not the caller (POSIX)', {
  skip: process.platform === 'win32' ? 'requires POSIX account database' : !PYTHON,
}, async () => {
  const value = await runCommandAttempt('home');
  assert.equal(value.home, value.expected);
  assert.notEqual(value.home, '/tmp/tampered-home-should-be-ignored');
});

test('a SIGTERM-ignoring helper is escalated to SIGKILL and confirmed reaped (POSIX)', {
  skip: process.platform === 'win32' ? 'requires POSIX process groups and signals' : !PYTHON,
}, async () => {
  const value = await runCommandAttempt('reap_escalates');
  assert.equal(value.alive, false, 'helper must be reaped');
  assert.notEqual(value.returncode, null, 'reap must be confirmed');
  assert.equal(value.sigkill, true, `helper must be killed by SIGKILL, got ${value.returncode}`);
  assert.ok(value.elapsed >= 0.9, `SIGTERM window should be honored before escalation, got ${value.elapsed}`);
});

test('an unconfirmed reap surfaces an error instead of success-shaped cleanup', { skip: !PYTHON }, async () => {
  const value = await runCommandAttempt('reap_unconfirmed');
  assert.deepEqual(value, { raised: true, code: 'process_failed' });
});

for (const [scenario, code, waits, unconfirmed] of [
  ['probe_unconfirmed_stop', 'process_failed', 2, true],
  ['probe_unavailable', 'health_failed', 0, false],
  ['probe_cancelled', 'cancelled', 0, false],
]) {
  test(`health wrapper preserves the ${scenario} error contract`, { skip: !PYTHON }, async () => {
    assert.deepEqual(await runCommandAttempt(scenario), { raised: true, code, waits, unconfirmed });
  });
}

test('run_command retains helper tracking and surfaces the error on an unconfirmed cancel stop (POSIX)', {
  skip: process.platform === 'win32' ? 'requires POSIX pipe readiness polling' : !PYTHON,
}, async () => {
  const value = await runCommandAttempt('cancel_retains_tracking');
  assert.equal(value.raised, true);
  assert.equal(value.code, 'process_failed');
  assert.equal(value.tracked, true, 'a still-live helper must remain tracked');
});

const POLICY_HARNESS = String.raw`
import importlib.util, io, json, stat as stat_mod, sys
spec = importlib.util.spec_from_file_location("relay", sys.argv[2])
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
policy_json = sys.argv[1]
class FakeStat:
  st_mode = stat_mod.S_IFREG | 0o644
  st_uid = 0
relay.os.getuid = lambda: 0
relay.os.lstat = lambda path: FakeStat()
relay.open = lambda path, *a, **k: io.StringIO(policy_json)
try:
  parsed = relay.load_policy("/etc/pw-deploy/runtime-policy.json")
  print(json.dumps({"ok": True, "healthTargets": parsed["healthTargets"]}))
except relay.RelayError as error:
  print(json.dumps({"ok": False, "code": error.code}))
`;

async function policyAttempt(policy) {
  const { stdout } = await execFileAsync(PYTHON, ['-c', POLICY_HARNESS, JSON.stringify(policy), RELAY_PATH]);
  return JSON.parse(stdout);
}

test('load_policy accepts an approved healthTargets binding', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({
    resourceNames: { 'myproj/prod': 'myproj' },
    healthHosts: ['127.0.0.1'],
    healthTargets: { 'myproj/prod': 'http://127.0.0.1/health' },
  });
  assert.deepEqual(value, { ok: true, healthTargets: { 'myproj/prod': 'http://127.0.0.1/health' } });
});

test('load_policy rejects an unknown top-level field', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({ resourceNames: {}, healthHosts: ['127.0.0.1'], bogusField: 1 });
  assert.deepEqual(value, { ok: false, code: 'runtime_policy_invalid' });
});

test('load_policy rejects a malformed healthTargets key', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({
    resourceNames: {},
    healthHosts: ['127.0.0.1'],
    healthTargets: { 'myprojprod': 'http://127.0.0.1/health' },
  });
  assert.deepEqual(value, { ok: false, code: 'runtime_policy_invalid' });
});

test('load_policy rejects a healthTargets URL whose host is not allowlisted', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({
    resourceNames: {},
    healthHosts: ['127.0.0.1'],
    healthTargets: { 'myproj/prod': 'http://evil.example/health' },
  });
  assert.deepEqual(value, { ok: false, code: 'runtime_policy_invalid' });
});

test('load_policy rejects a healthTargets URL with an out-of-range port', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({
    resourceNames: {},
    healthHosts: ['127.0.0.1'],
    healthTargets: { 'myproj/prod': 'http://127.0.0.1:99999/health' },
  });
  assert.deepEqual(value, { ok: false, code: 'runtime_policy_invalid' });
});

test('load_policy rejects a healthTargets URL with a non-numeric port', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({
    resourceNames: {},
    healthHosts: ['127.0.0.1'],
    healthTargets: { 'myproj/prod': 'http://127.0.0.1:not-a-port/health' },
  });
  assert.deepEqual(value, { ok: false, code: 'runtime_policy_invalid' });
});

test('load_policy rejects a healthTargets URL with a malformed IPv6 bracket', { skip: !PYTHON }, async () => {
  const value = await policyAttempt({
    resourceNames: {},
    healthHosts: ['::1'],
    healthTargets: { 'myproj/prod': 'http://[::1/health' },
  });
  assert.deepEqual(value, { ok: false, code: 'runtime_policy_invalid' });
});
