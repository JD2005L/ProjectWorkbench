import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { builderRequest } from '../app/deployment/builder-client.js';
import { relayStartupFailure, validateRelayStartupFailure } from '../app/deployment/builder-diagnostics.js';

// These are portable Python command/kernel/filesystem models, not evidence
// that a real Linux user manager, Podman API, cgroup or namespace is confined.
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relayPath = path.join(root, 'deploy', 'container', 'builder-relay.py');
const policyPath = path.join(root, 'deploy', 'container', 'builder-policy.example.json');
let python;
for (const candidate of ['python3', 'python']) {
  try {
    await execFileAsync(candidate, ['--version']);
    python = candidate;
    break;
  } catch {
    // Follow the repository's existing Python discovery convention.
  }
}

const HARNESS = String.raw`
import contextlib, copy, importlib.util, io, json, os, stat, subprocess, sys, types
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("builder", sys.argv[1])
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
REAL_RUN_COMMAND = r.run_command
P = {
  "apiVersion": 1, "instanceId": "64b475cf-eaf9-4783-8b0b-5c2418434c21", "user": "builder",
  "controllerUnit": "deployment-engine.service", "stateDir": "/var/lib/deployment-builder",
  "runtimeDir": "/run/user/1001/pw-builder", "imageStore": "/var/lib/deployment-sdk-cache/graph",
  "maxLifetimeSeconds": 3600, "maxMemoryMiB": 8192, "maxPids": 1024,
}
JOB = "123e4567-e89b-42d3-a456-426614174000"
A = types.SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_name="builder", pw_dir="/home/builder")
NOW = 1800000000000
REQUEST = {"requestId": "request_1", "action": "job_start", "jobId": JOB,
           "deadlineAt": NOW + 60000, "memoryMiB": 512, "pids": 128}
calls = []
def forbidden(*args, **kwargs):
    raise AssertionError("A portable fixture attempted a real resource operation")
r.run_command = forbidden
r.systemctl = forbidden
r.prerequisites = forbidden
def error(fn, code=None):
    try: fn()
    except r.RelayError as exc:
        if code is not None: assert exc.code == code, (exc.code, str(exc))
        return {"code": exc.code, "message": str(exc)}
    raise AssertionError("Expected an explicit failure")
def record():
    value = r.new_record(P, A, JOB)
    value.update(deadlineAt=REQUEST["deadlineAt"], memoryMiB=512, pids=128)
    return value
class Store:
    def __init__(self):
        self.job_id = JOB
        self.value = None
        self.cancelled_value = False
        self.saves = []
        self.diagnostics = []
        self.prepared = False
        self.locked_value = False
    @contextlib.contextmanager
    def locked(self):
        assert not self.locked_value
        self.locked_value = True
        try: yield self
        finally: self.locked_value = False
    def load(self, missing=False):
        if self.value is None and not missing: r.fail("Missing metadata", "resource_conflict")
        return copy.deepcopy(self.value)
    def save(self, value):
        r.validate_record(value, P, JOB)
        self.value = copy.deepcopy(value)
        self.saves.append(copy.deepcopy(value))
    def save_startup_failure(self, value, initial=False):
        r.validate_startup_failure(value, P, JOB)
        self.diagnostics.append(copy.deepcopy(value))
    def cancelled(self): return self.cancelled_value
    def cancel(self):
        calls.append(["cancel"])
        self.cancelled_value = True
    def prepare_paths(self, value):
        self.prepared = True
        value["workIdentity"], value["runtimeIdentity"] = [1, 10], [1, 11]
        self.save(value)
    def reserve(self): calls.append(["reserve"])
def unloaded(value):
    result = dict.fromkeys(r.UNIT_PROPERTIES, "")
    result.update(Id=value["unit"], LoadState="not-found", ActiveState="inactive", MainPID="0")
    return result
def loaded(value, active=True):
    result = unloaded(value)
    result.update(LoadState="loaded", ActiveState="active" if active else "inactive",
        SubState="running" if active else "dead", Description=r.description(value),
        ControlGroup=r.expected_cgroup(value), MainPID="4321" if active else "0",
        Transient="yes", Type="notify", NotifyAccess="all", KillMode="control-group", Delegate="yes",
        MemoryMax=str(value["memoryMiB"] * 1048576), TasksMax=str(value["pids"]),
        BindsTo=P["controllerUnit"], After=P["controllerUnit"],
        TimeoutStopUSec="3s", RuntimeMaxUSec="1min", StandardOutput="null", StandardError="null",
        ExecStart="{ path=/usr/bin/python3 ; argv[]=" + " ".join([r.PYTHON_BIN, "-I", r.RELAY_BIN,
            "--unit-entry", r.metadata_path(value), value["nonce"]]) + " ; ignore_errors=no ; }")
    return result
def absent_properties(value):
    result = unloaded(value)
    result.update(SubState="dead", Description=value["unit"], Transient="no", Type="simple",
        KillMode="control-group", Delegate="no", MemoryMax="infinity", TasksMax="infinity",
        TimeoutStopUSec="1min 30s", RuntimeMaxUSec="infinity",
        StandardOutput="journal", StandardError="inherit")
    del result["ExecStart"]
    return result
def raw_unit_query(unit, response, returncode=0, properties=r.UNIT_PROPERTIES):
    if isinstance(response, dict):
        response = "".join(key + "=" + value + "\n" for key, value in response.items()).encode()
    def control(env, *args, **kwargs):
        assert env == {}
        assert args == ("show", unit, "--property=" + ",".join(properties))
        assert kwargs == {"ignore_cancel": True}
        calls.append(list(args))
        return subprocess.CompletedProcess(args, returncode, response)
    r.systemctl = control
def lifecycle():
    store = Store()
    kernel = {"unit": None, "populated": False, "timer": False}
    r.time.time = lambda: NOW / 1000
    r.proc_identity = lambda pid: [pid, 999]
    r.process_cgroup = lambda pid: r.expected_cgroup(store.value) + "/supervisor"
    r.cgroup_populated = lambda value, **kw: kernel["populated"]
    r.api_ready = lambda value, props: [4321, 999]
    r.check_deadline_timer = lambda value, env: r.require(kernel["timer"], "No deadline")
    def command(argv, env, **kw):
        calls.append(argv)
        if any(arg.startswith("--on-calendar=") for arg in argv):
            kernel["timer"] = True
        elif "--unit-entry" in argv:
            assert kernel["timer"]
            assert store.value["phase"] == "launching"
            kernel["unit"] = loaded(store.value)
            kernel["populated"] = True
        return subprocess.CompletedProcess(argv, 0, b"")
    def show(env, unit, properties=r.UNIT_PROPERTIES):
        return copy.deepcopy(kernel["unit"] or unloaded(store.value))
    def control(env, *args, **kw):
        calls.append(list(args))
        assert args[:2] == ("stop", "--no-block")
        kernel["unit"] = loaded(store.value, False)
        kernel["populated"] = False
        return subprocess.CompletedProcess(args, 0, b"")
    r.run_command, r.show_unit, r.systemctl = command, show, control
    return store, kernel
payload = json.loads(sys.argv[2])
`;

async function fixture(body, payload = {}) {
  assert.ok(python, 'An existing Python 3.9+ interpreter is required for builder relay tests');
  const { stdout } = await execFileAsync(python, ['-B', '-c', HARNESS + '\n' + body, relayPath, JSON.stringify(payload)], {
    maxBuffer: 1024 * 1024,
    timeout: 20000,
  });
  return JSON.parse(stdout);
}

test('builder policy example matches strict generic schema and immutable entrypoint', async () => {
  const example = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  const value = await fixture(`
assert r.validate_policy(payload) == payload
print(json.dumps({"policy": r.DEFAULT_POLICY_FILE, "relay": r.RELAY_BIN, "actions": sorted(r.ACTIONS)}))
`, example);
  assert.equal(value.policy, '/etc/pw-deploy-builder-policy.json');
  assert.equal(value.relay, '/usr/local/libexec/pw-deploy-builder.py');
  assert.deepEqual(value.actions, ['builder_probe', 'job_remove', 'job_start', 'job_status', 'job_stop']);
});

test('framing uses ten ASCII digits, bounded JSON, and one complete-frame deadline', async () => {
  const result = await fixture(String.raw`
request = {"requestId": "r", "action": "builder_probe"}
body = json.dumps(request).encode()
assert r.read_request(io.BytesIO(str(len(body)).zfill(10).encode() + body)) == request
invalid = [b"0000000000", b"0000008193", b"abcdefghij", b"+0000000010", b"0000000005{}",
           b"0000000002[]", b"0000000013" + b'{"a":1,"a":2}', b"0000000009" + b'{"a":NaN}']
for value in invalid: error(lambda value=value: r.read_request(io.BytesIO(value)), "invalid_request")
deadlines = []
original = r.read_exact
def observed(stream, size, deadline, fd):
    deadlines.append(deadline)
    return original(stream, size, deadline, fd)
r.read_exact = observed
r.read_request(io.BytesIO(str(len(body)).zfill(10).encode() + body))
assert len(deadlines) == 2 and deadlines[0] == deadlines[1]
output = io.BytesIO()
r.write_response(output, {"ok": True, "result": {"ready": True}})
frame = output.getvalue()
assert int(frame[:10]) == len(frame[10:])
assert json.loads(frame[10:])["ok"]
r.write_response(io.BytesIO(), {"error": "x" * 20000})
print(json.dumps({"invalid": len(invalid), "deadlineSeconds": r.REQUEST_READ_TIMEOUT_SECONDS}))
`);
  assert.equal(result.invalid, 8);
  assert.equal(result.deadlineSeconds, 10);
});

test('policy rejects unknown fields, root, unsafe roots, overlaps and oversized sockets/limits', async () => {
  const result = await fixture(`
changes = [
 {"extra": 1}, {"apiVersion": True}, {"instanceId": JOB.upper()}, {"user": "root"},
 {"controllerUnit": "../arbitrary.service"}, {"controllerUnit": "x@instance.service"},
 {"controllerUnit": "pw-deploy-build-controller.service"}, {"controllerUnit": "pw-builder-controller.service"},
 {"stateDir": "/"}, {"stateDir": "/var/lib/../other"}, {"runtimeDir": P["stateDir"] + "/socket"},
 {"imageStore": P["stateDir"]}, {"imageStore": P["stateDir"] + "/graph"},
 {"runtimeDir": "/run/" + "a" * 80}, {"maxLifetimeSeconds": 3601},
 {"maxMemoryMiB": 16385}, {"maxPids": 2049}, {"maxPids": True},
]
for change in changes:
    error(lambda change=change: r.validate_policy({**P, **change}), "runtime_policy_invalid")
for key in P:
    invalid = dict(P); del invalid[key]
    error(lambda: r.validate_policy(invalid), "runtime_policy_invalid")
print(json.dumps({"invalid": len(changes) + len(P)}))
`);
  assert.equal(result.invalid, 28);
});

test('request actions, UUIDs, field sets, deadlines and caps are exact', async () => {
  const result = await fixture(`
assert r.validate_request(REQUEST, P, NOW) == "job_start"
changes = [
 {"action": "exec"}, {"action": "--unit-entry"}, {"action": []}, {"jobId": "../other"},
 {"jobId": JOB.upper()}, {"requestId": "with space"}, {"policy": "/tmp/policy"},
 {"source": "secret"}, {"deadlineAt": NOW}, {"deadlineAt": NOW + 3600001},
 {"deadlineAt": True}, {"memoryMiB": 0}, {"memoryMiB": 8193}, {"pids": 1025},
]
for change in changes:
    error(lambda change=change: r.validate_request({**REQUEST, **change}, P, NOW),
          "action_not_allowed" if "action" in change else "invalid_request")
assert r.validate_request({**REQUEST, "deadlineAt": NOW + 3600000}, P, NOW) == "job_start"
error(lambda: r.validate_request({"requestId": "r", "action": "builder_probe", "jobId": JOB}, P), "invalid_request")
print(json.dumps({"invalid": len(changes) + 1}))
`);
  assert.equal(result.invalid, 15);
});

test('caller overrides, SSH internal modes and policy path overrides are refused', async () => {
  const result = await fixture(`
for key in ("PODMAN_HOST", "CONTAINER_HOST", "CONTAINERS_STORAGE_CONF", "STORAGE_DRIVER",
            "BUILDAH_ISOLATION", "LD_PRELOAD", "PYTHONPATH", "SYSTEMD_BUS_ADDRESS",
            "DBUS_SYSTEM_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "XDG_CONFIG_HOME"):
    error(lambda key=key: r.check_environment({key: "untrusted"}), "privilege_refused")
r.check_environment({"SSH_ORIGINAL_COMMAND": "pw-deploy-builder", "XDG_RUNTIME_DIR": "/run/user/1001"})
error(lambda: r.check_environment({"SSH_ORIGINAL_COMMAND": "pw-deploy-builder --unit-entry"}), "action_not_allowed")
error(lambda: r.internal_main(["--policy", "/tmp/policy"]), "action_not_allowed")
with patch.dict(r.os.environ, {"SSH_CONNECTION": "fixture"}, clear=True):
    error(lambda: r.internal_main(["--unit-entry", "/var/lib/jobs", "a" * 64]), "action_not_allowed")
env = r.runtime_environment(A)
assert env["XDG_RUNTIME_DIR"] == "/run/user/1001"
assert env["DBUS_SESSION_BUS_ADDRESS"] == "unix:path=/run/user/1001/bus"
assert "CONTAINER_HOST" not in env
print(json.dumps({"env": env}))
`);
  assert.equal(result.env.HOME, '/home/builder');
});

test('non-root approved identity is required before any command', async () => {
  const result = await fixture(`
r.sys.platform = "linux"
r.fcntl = object()
r.pwd = types.SimpleNamespace(getpwnam=lambda user: A)
for actual, effective, gid, expected in [(0,0,1001,"privilege_refused"),
    (1002,1002,1001,"privilege_refused"), (1001,0,1001,"privilege_refused"), (1001,1001,1002,"privilege_refused")]:
    with patch.object(r.os, "getuid", return_value=actual, create=True), \
         patch.object(r.os, "geteuid", return_value=effective, create=True), \
         patch.object(r.os, "getgid", return_value=gid, create=True), \
         patch.object(r.os, "getegid", return_value=gid, create=True):
        error(lambda: r.identity(P), expected)
with patch.object(r.os, "getuid", return_value=1001, create=True), \
     patch.object(r.os, "geteuid", return_value=1001, create=True), \
     patch.object(r.os, "getgid", return_value=1001, create=True), \
     patch.object(r.os, "getegid", return_value=1001, create=True):
    assert r.identity(P) == A
print(json.dumps({"calls": calls}))
`);
  assert.deepEqual(result.calls, []);
});

test('unit command contains exact delegation, limits, controller binding, bootstrap and null logs', async () => {
  const result = await fixture(`
value = record()
argv = r.service_argv(value, NOW)
deadline = r.deadline_argv(value)
api = r.api_argv(value)
assert value["unit"] == "pw-deploy-build-64b475cfeaf947838b0b5c2418434c21-123e4567-e89b-42d3-a456-426614174000.service"
assert "--unit=" + value["unit"] in argv
assert "--unit=" + value["unit"][:-8] + "-deadline.service" in deadline
assert "--property=Type=notify" in argv
assert "--property=NotifyAccess=all" in argv
assert "--property=Slice=app.slice" in argv
assert "--property=Delegate=yes" in argv
assert "--property=KillMode=control-group" in argv
assert "--property=RuntimeMaxSec=60.000s" in argv
assert "--property=MemoryMax=536870912" in argv
assert "--property=TasksMax=128" in argv
assert "--property=TimeoutStopSec=3s" in argv
assert "--property=TimeoutStartSec=10s" in argv
assert "--property=BindsTo=" + P["controllerUnit"] in argv
assert "--property=After=" + P["controllerUnit"] in argv
assert "--property=NoNewPrivileges=no" in argv
environment = next(arg for arg in argv if arg.startswith("--property=Environment="))
assert environment.startswith("--property=Environment=HOME=" + r.job_home(value) + " XDG_CONFIG_HOME=" + r.job_home(value) + "/.config ")
assert " TMPDIR=" + r.transfer_path(value) + " " in environment
assert A.pw_dir not in environment
assert all("--property=" + key + "=null" in argv for key in ("StandardOutput", "StandardError"))
assert argv[-6:] == [r.PYTHON_BIN, "-I", r.RELAY_BIN, "--unit-entry", r.metadata_path(value), value["nonce"]]
assert "--on-calendar=2027-01-15 08:01:00.000 UTC" in deadline
assert "--timer-property=AccuracySec=1us" in deadline
assert "--deadline-entry" in deadline
assert api == ["/usr/bin/podman", "--remote=false", "--root", r.work_path(value) + "/graph",
 "--runroot", r.runtime_path(value) + "/r", "--tmpdir", r.runtime_path(value) + "/t",
 "--storage-opt=additionalimagestore=" + P["imageStore"], "--cgroup-manager=cgroupfs",
 "system", "service", "--time=0", "unix://" + r.runtime_path(value) + "/api.sock"]
assert P["imageStore"] != r.work_path(value) + "/graph"
error(lambda: r.service_argv(value, NOW + 60000), "cancelled")
print(json.dumps({"api": api, "cgroup": r.expected_cgroup(value)}))
`);
  assert.equal(result.cgroup, '/user.slice/user-1001.slice/user@1001.service/app.slice/'
    + 'pw-deploy-build-64b475cfeaf947838b0b5c2418434c21-123e4567-e89b-42d3-a456-426614174000.service');
});

test('unit and cgroup binding reject legacy names, compact job IDs and mismatched user slices', async () => {
  const result = await fixture(`
value = record()
expected = "pw-deploy-build-64b475cfeaf947838b0b5c2418434c21-" + JOB + ".service"
assert value["unit"] == expected
invalid_units = [
 "pw-builder-" + P["instanceId"].replace("-","") + "-" + JOB.replace("-","") + ".service",
 "pw-deploy-build-" + P["instanceId"].replace("-","") + "-" + JOB.replace("-","") + ".service",
 expected.replace(P["instanceId"].replace("-",""), P["instanceId"]),
 expected.replace(JOB, "223e4567-e89b-42d3-a456-426614174000"),
]
for unit in invalid_units:
    error(lambda unit=unit:r.validate_record({**value,"unit":unit},P,JOB), "resource_not_allowed")
for cgroup in [
 "/user.slice/user-1002.slice/user@1001.service/app.slice/" + expected,
 "/user.slice/user-1001.slice/user@1002.service/app.slice/" + expected,
 "/user.slice/user-0.slice/user@0.service/app.slice/" + expected,
 "/user.slice/user-1001.slice/user@1001.service/app.slice/other.service",
 "/user.slice/user-1001.slice/user@1001.service/app.slice/" + expected + "/nested",
]:
    error(lambda cgroup=cgroup:r.owned_unit(value,{**loaded(value),"ControlGroup":cgroup}), "resource_not_allowed")
for uid in (0,-1):
    error(lambda uid=uid:r.validate_record({**value,"uid":uid}), "resource_not_allowed")
print(json.dumps({"refused":len(invalid_units)+7}))
`);
  assert.equal(result.refused, 11);
});

test('raw systemd absent-unit output preserves omitted ExecStart and still proves the whole cgroup stopped', async () => {
  const result = await fixture(`
value = record(); value["phase"] = "launching"
kernel_reads = []
def empty(candidate):
    assert candidate is value
    kernel_reads.append(r.expected_cgroup(candidate))
    return False
r.cgroup_populated = empty
for returncode in (0, 1, 4):
    for settled, observed in ((True, False), (False, True)):
        value.update(launchSettled=settled, observedUnit=observed)
        for explicit_empty in (False, True):
            props = absent_properties(value)
            if explicit_empty:
                props.update(ExecStart="", Job="0")
            before = copy.deepcopy(props)
            raw_unit_query(value["unit"], props, returncode)
            decoded = r.show_unit({}, value["unit"])
            assert decoded == before and props == before
            assert ("ExecStart" in decoded) == explicit_empty
            assert r.prove_stopped(value, {}) is True
assert len(kernel_reads) == 12
assert all(path == r.expected_cgroup(value) for path in kernel_reads)
assert all(call[0] == "show" for call in calls)
print(json.dumps({"proofs": len(kernel_reads)}))
`);
  assert.equal(result.proofs, 12);
});

test('raw systemd property parsing refuses every other omission and malformed response', async () => {
  const result = await fixture(String.raw`
value = record()
props = absent_properties(value)
failures = []
for key in props:
    missing = {name: text for name, text in props.items() if name != key}
    raw_unit_query(value["unit"], missing)
    failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
    assert failure["message"] == "User manager did not return complete unit properties"
    failures.append(failure)
for state in ("loaded", "masked", "error", "", "not_found", "not-found "):
    raw_unit_query(value["unit"], {**props, "LoadState": state})
    failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
    assert failure["message"] == "User manager did not return complete unit properties"
    failures.append(failure)
body = "".join(key + "=" + text + "\n" for key,text in props.items()).encode()
for suffix in (b"LoadState=not-found\n", b"ExecStart=\nExecStart=\n", b"ExecStartEx=\n",
               b"MainPID\n", b"\n", b"=0\n"):
    raw_unit_query(value["unit"], body + suffix)
    failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
    assert failure["message"] == "User manager returned unexpected properties"
    failures.append(failure)
raw_unit_query(value["unit"], b"\xff")
failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
assert failure["message"] == "User manager returned invalid property data"
failures.append(failure)
raw_unit_query(value["unit"], b"")
failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
assert failure["message"] == "User manager did not return complete unit properties"
failures.append(failure)
print(json.dumps({"refused": len(failures), "required": len(props)}))
`);
  assert.equal(result.refused, result.required + 14);
});

test('raw systemd exit codes and loaded-unit ownership remain strict', async () => {
  const result = await fixture(`
value = record(); value.update(phase="launching", launchSettled=True)
props = loaded(value, False)
r.cgroup_populated = lambda candidate: False
raw_unit_query(value["unit"], props)
assert r.prove_stopped(value, {}) is True
for returncode in (1, 4):
    for state in ("loaded", "error", ""):
        raw_unit_query(value["unit"], {**props, "LoadState": state}, returncode)
        failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
        assert failure["message"] == "User manager query failed"
for returncode in (-9, 2, 3, 5):
    raw_unit_query(value["unit"], absent_properties(value), returncode)
    failure = error(lambda:r.show_unit({},value["unit"]), "process_failed")
    assert failure["message"] == "User manager could not be queried"
for returncode in (0, 1, 4):
    raw_unit_query(value["unit"], {key:text for key,text in props.items() if key != "ExecStart"}, returncode)
    failure = error(lambda:r.prove_stopped(value,{}), "process_failed")
    assert failure["message"] == "User manager did not return complete unit properties"
changes = [
 {"Id":"foreign.service"}, {"Description":"foreign"}, {"Transient":"no"},
 {"ControlGroup":"/foreign"}, {"Type":"simple"}, {"KillMode":"process"}, {"Delegate":"no"},
 {"MemoryMax":"infinity"}, {"TasksMax":"infinity"}, {"BindsTo":""}, {"After":""},
 {"StandardOutput":"journal"}, {"StandardError":"journal"}, {"TimeoutStopUSec":"90s"},
 {"RuntimeMaxUSec":"infinity"}, {"ExecStart":""}, {"ExecStart":"/bin/true"},
]
for change in changes:
    raw_unit_query(value["unit"], {**props, **change})
    error(lambda:r.prove_stopped(value,{}), "resource_not_allowed")
assert all(call[0] == "show" for call in calls)
print(json.dumps({"loadedGuards":len(changes), "exitAndPresenceGuards":13}))
`);
  assert.deepEqual(result, { loadedGuards: 17, exitAndPresenceGuards: 13 });
});

test('raw systemd absent-unit omission cannot bypass launch, identity, state or population guards', async () => {
  const result = await fixture(`
value = record(); value.update(phase="launching", launchSettled=True)
props = absent_properties(value)
kernel_reads = []
def empty(candidate):
    kernel_reads.append(candidate["unit"])
    return False
r.cgroup_populated = empty
raw_unit_query(value["unit"], {**props, "Id":"foreign.service"})
failure = error(lambda:r.prove_stopped(value,{}), "resource_not_allowed")
assert failure["message"] == "Unit identity does not match"
changes = [
 {"ActiveState":"active"}, {"ActiveState":"activating"}, {"ActiveState":"failed"},
 {"MainPID":"4321"}, {"MainPID":"-1"}, {"MainPID":""}, {"MainPID":"null"}, {"MainPID":"00"},
 {"ControlGroup":r.expected_cgroup(value)}, {"ControlGroup":"/foreign"},
 {"Job":"17"}, {"Job":"17 /org/freedesktop/systemd1/job/17"},
]
for change in changes:
    raw_unit_query(value["unit"], {**props, **change})
    failure = error(lambda:r.prove_stopped(value,{}), "process_failed")
    assert failure["message"] == "Unloaded unit state is uncertain"
value.update(launchSettled=False, observedUnit=False)
raw_unit_query(value["unit"], props)
failure = error(lambda:r.prove_stopped(value,{}), "process_failed")
assert failure["message"] == "Start transaction is unresolved; an unloaded unit is not stop proof"
assert not kernel_reads
value["launchSettled"] = True
r.cgroup_populated = lambda candidate: True
failure = error(lambda:r.prove_stopped(value,{}), "process_failed")
assert failure["message"] == "Owned cgroup still contains processes"
print(json.dumps({"refused":len(changes)+3}))
`);
  assert.equal(result.refused, 15);
});

test('raw systemd deadline and custom property queries never inherit the ExecStart omission exception', async () => {
  const result = await fixture(`
value = record()
timer = r.deadline_unit(value)[:-8] + ".timer"
properties = ("Id","LoadState","ActiveState","Description","Transient","Unit")
props = {"Id":timer, "LoadState":"loaded", "ActiveState":"active",
         "Description":r.description(value,True), "Transient":"yes", "Unit":r.deadline_unit(value)}
raw_unit_query(timer, props, properties=properties)
r.check_deadline_timer(value,{})
failures = []
for state in ("loaded", "not-found"):
    for key in props:
        missing = {name:text for name,text in {**props,"LoadState":state}.items() if name != key}
        raw_unit_query(timer, missing, properties=properties)
        failure = error(lambda:r.check_deadline_timer(value,{}), "process_failed")
        assert failure["message"] == "User manager did not return complete unit properties"
        failures.append(failure)
raw_unit_query(timer, {**props,"ExecStart":""}, properties=properties)
failure = error(lambda:r.check_deadline_timer(value,{}), "process_failed")
assert failure["message"] == "User manager returned unexpected properties"
custom = ("Id","LoadState","ExecStart")
raw_unit_query(value["unit"], {"Id":value["unit"],"LoadState":"not-found"}, properties=custom)
failure = error(lambda:r.show_unit({},value["unit"],custom), "process_failed")
assert failure["message"] == "User manager did not return complete unit properties"
print(json.dumps({"requiredFieldRefusals":len(failures), "customRefused":True}))
`);
  assert.deepEqual(result, { requiredFieldRefusals: 12, customRefused: true });
});

test('portable bootstrap model moves to supervisor before exec and creates the payload subgroup', async () => {
  const result = await fixture(`
store = Store(); value = record(); value["phase"] = "launching"
r.time.time = lambda: NOW / 1000
current = {"path": r.expected_cgroup(value)}
r.process_cgroup = lambda pid: current["path"]
@contextlib.contextmanager
def directory(*args, **kw): yield 10
r.directory = directory
events = []
r.validate_job_home = lambda value: events.append(["private-mounts-validated"])
def write(fd, data):
    events.append(["write", data.decode()])
    if data.isdigit(): current["path"] += "/supervisor"
    return len(data)
with patch.object(r.os, "O_NOFOLLOW", 0, create=True), patch.object(r.os, "O_CLOEXEC", 0, create=True), \
     patch.object(r.os, "O_DIRECTORY", 0, create=True), \
     patch.object(r.os, "mkdir", side_effect=lambda name, *a, **k: events.append(["mkdir", name])), \
     patch.object(r.os, "open", return_value=11), patch.object(r.os, "close"), \
     patch.object(r.os, "write", side_effect=write), patch.object(r.os, "umask"), \
     patch.dict(r.os.environ, {"NOTIFY_SOCKET":"/run/user/1001/systemd/notify"}, clear=True), \
     patch.object(r.os, "stat", return_value=types.SimpleNamespace(st_mode=stat.S_IFSOCK|0o700,st_uid=1001)), \
     patch.object(r.os, "execve", side_effect=lambda binary, argv, env: events.append(["exec", binary, argv, env])):
    r.bootstrap(value, A, store)
assert events[0] == ["private-mounts-validated"]
assert events[1] == ["mkdir", "supervisor"]
assert events[3] == ["write", "+memory +pids"]
assert events[4] == ["mkdir", "payload"]
assert events[5][0] == "exec"
assert events[5][3]["XDG_RUNTIME_DIR"] == r.runtime_path(value)
assert events[5][3]["HOME"] == r.job_home(value) != A.pw_dir
assert events[5][3]["XDG_CONFIG_HOME"] == r.job_home(value) + "/.config"
assert events[5][3]["TMPDIR"] == r.transfer_path(value)
assert events[5][3]["NOTIFY_SOCKET"] == "/run/user/1001/systemd/notify"
current["path"] = "/wrong-unit"
error(lambda: r.bootstrap(value, A, store), "privilege_refused")
store.cancelled_value = True
error(lambda: r.bootstrap(value, A, store), "cancelled")
store.cancelled_value = False
r.time.time = lambda: (NOW + 60000) / 1000
error(lambda: r.bootstrap(value, A, store), "cancelled")
print(json.dumps({"events": events[:5]}))
`);
  assert.equal(result.events.length, 5);
});

test('API environment forwards only the approved user manager notification socket', async () => {
  const result = await fixture(`
value = record()
state = {"mode":stat.S_IFSOCK|0o700,"uid":1001}
@contextlib.contextmanager
def directory(path, uid, **kwargs):
    assert path == "/run/user/1001/systemd" and uid == 1001
    yield 10
r.directory = directory
def socket_info(path, **kwargs):
    assert path == "notify" and kwargs == {"dir_fd":10,"follow_symlinks":False}
    return types.SimpleNamespace(st_mode=state["mode"],st_uid=state["uid"])
with patch.object(r.os,"stat",side_effect=socket_info), \
     patch.dict(r.os.environ,{"NOTIFY_SOCKET":"/run/user/1001/systemd/notify","UNTRUSTED":"not-forwarded"},clear=True):
    env = r.api_environment(value,A)
    assert env["NOTIFY_SOCKET"] == "/run/user/1001/systemd/notify" and "UNTRUSTED" not in env
    assert env["HOME"] == r.job_home(value) and env["TMPDIR"] == r.transfer_path(value)
    for invalid in ("", "/run/systemd/notify", "/run/user/1002/systemd/notify",
                    "@/foreign/notify", "/run/user/1001/systemd/../notify"):
        r.os.environ["NOTIFY_SOCKET"] = invalid
        error(lambda:r.api_environment(value,A),"resource_not_allowed")
    del r.os.environ["NOTIFY_SOCKET"]
    error(lambda:r.api_environment(value,A),"resource_not_allowed")
    r.os.environ["NOTIFY_SOCKET"] = "/run/user/1001/systemd/notify"
    for field,invalid in (("mode",stat.S_IFREG|0o700),("mode",stat.S_IFLNK|0o777),("uid",1002)):
        old = state[field]; state[field] = invalid
        error(lambda:r.api_environment(value,A),"resource_not_allowed")
        state[field] = old
print(json.dumps({"refused":9,"notificationBound":True}))
`);
  assert.deepEqual(result, { refused: 9, notificationBound: true });
});

test('unit ownership requires the notify profile while preserving legacy exec cleanup', async () => {
  const result = await fixture(`
value = record()
props = loaded(value)
assert r.owned_unit(value,props)
assert r.owned_unit(value,{**props,"Type":"exec","NotifyAccess":"none"})
for kind,access in (("notify","none"),("notify","main"),("notify","exec"),
                    ("exec","all"),("exec","main"),("simple","all")):
    error(lambda:r.owned_unit(value,{**props,"Type":kind,"NotifyAccess":access}),"resource_not_allowed")
print(json.dumps({"refused":6,"legacyCleanup":True}))
`);
  assert.deepEqual(result, { refused: 6, legacyCleanup: true });
});

test('portable start model arms the deadline before launching and returns only the fixed protocol', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
reply = r.start_job(P, A, {}, REQUEST, store)
assert kernel["timer"] and kernel["populated"]
assert store.value["phase"] == "running" and store.value["apiIdentity"] == [4321,999]
assert reply == {"instanceId": P["instanceId"], "jobId": JOB, "unit": store.value["unit"],
 "socketDirectory": JOB, "cgroupParent": r.expected_cgroup(store.value) + "/payload",
 "deadlineAt": REQUEST["deadlineAt"], "running": True}
status = r.status_job(P, {}, store)
assert status["running"] and not status["stopped"]
error(lambda: r.start_job(P, A, {}, REQUEST, store), "resource_conflict")
print(json.dumps(reply))
`);
  assert.equal(result.running, true);
  assert.equal(Object.keys(result).length, 7);
});

test('startup diagnostics preserve the primary rule and distinct cleanup error without private data', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
primary = r.RelayError("API socket peer does not match the owned unit", "resource_not_allowed")
cleanup = OSError(13, "PRIVATE_EXCEPTION /private/config argv=PRIVATE_ARGV")
def ready(*args): raise primary
def stop(*args): raise cleanup
r.api_ready, r.stop_owned = ready, stop
try: r.start_job(P,A,{},REQUEST,store)
except OSError as exc:
    assert exc is cleanup and exc.__cause__ is primary
    diagnostic = exc.startup_failure
else: raise AssertionError("Expected startup and cleanup failure")
assert store.cancelled_value and store.value["phase"] == "launching"
assert store.value["observedUnit"] and store.value["apiIdentity"] is None
assert diagnostic["primary"] == {"stage":"api_readiness","code":"resource_not_allowed","rule":"api_peer","errno":None}
assert diagnostic["cleanup"] == {"stage":"stop","outcome":"failed",
    "failure":{"stage":"stop","code":"os_error","rule":"os_error","errno":13}}
assert diagnostic["recordingErrors"] == []
assert store.diagnostics[0]["cleanup"]["outcome"] == "pending"
assert store.diagnostics[-1] == diagnostic
text = json.dumps(diagnostic)
for private in ("PRIVATE_EXCEPTION","PRIVATE_ARGV","/private/config",store.value["nonce"]):
    assert private not in text
assert set(store.value) == r.RECORD_FIELDS
print(json.dumps({"primary":diagnostic["primary"],"cleanup":diagnostic["cleanup"]["outcome"]}))
`);
  assert.equal(result.primary.rule, 'api_peer');
  assert.equal(result.cleanup, 'failed');
});

test('startup diagnostics retain an OS errno while confirmed cleanup still propagates the original failure', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
primary = OSError(28, "PRIVATE_EXCEPTION", "/private/source")
def prepare(*args): raise primary
store.prepare_paths = prepare
try: r.start_job(P,A,{},REQUEST,store)
except OSError as exc:
    assert exc is primary
    diagnostic = exc.startup_failure
else: raise AssertionError("Expected original failure")
assert store.cancelled_value and store.value["phase"] == "stopped"
assert diagnostic["primary"] == {"stage":"prepare_paths","code":"os_error","rule":"os_error","errno":28}
assert diagnostic["cleanup"] == {"stage":"persist_stopped","outcome":"stopped","failure":None}
assert "PRIVATE_EXCEPTION" not in json.dumps(diagnostic) and "/private/source" not in json.dumps(diagnostic)
assert store.diagnostics[-1] == diagnostic
print(json.dumps({"originalPreserved":True,"cleanup":diagnostic["cleanup"]["outcome"]}))
`);
  assert.deepEqual(result, { originalPreserved: true, cleanup: 'stopped' });
});

test('startup diagnostic I/O failures never skip cancellation or stop and remain explicitly reported', async () => {
  const result = await fixture(`
original_stop = r.stop_owned
cases = []
for failed_writes in ({"diagnostic_initial"},{"diagnostic_final"},{"diagnostic_initial","diagnostic_final"}):
    for stop_fails in (False, True):
        store, kernel = lifecycle()
        order = []
        primary = r.RelayError("PRIVATE_PRIMARY raw argv/env/config", "resource_not_allowed")
        cleanup = r.RelayError("User manager refused the owned unit stop")
        def ready(*args): raise primary
        r.api_ready = ready
        saved = store.save_startup_failure
        def diagnostic_write(value, initial=False):
            stage = "diagnostic_initial" if initial else "diagnostic_final"
            order.append(stage)
            if stage in failed_writes: raise OSError(28, "PRIVATE_IO", "/private/diagnostic")
            saved(value, initial)
        store.save_startup_failure = diagnostic_write
        cancel = store.cancel
        def cancelled():
            order.append("cancel")
            cancel()
        store.cancel = cancelled
        def stop(*args):
            order.append("stop")
            if stop_fails: raise cleanup
            return original_stop(*args)
        r.stop_owned = stop
        try: r.start_job(P,A,{},REQUEST,store)
        except r.RelayError as exc:
            assert exc is (cleanup if stop_fails else primary)
            diagnostic = exc.startup_failure
        else: raise AssertionError("Diagnostics cannot turn a failure into success")
        assert order == ["diagnostic_initial","cancel","stop","diagnostic_final"]
        assert {item["stage"] for item in diagnostic["recordingErrors"]} == failed_writes
        assert all(item["code"] == "os_error" and item["errno"] == 28 for item in diagnostic["recordingErrors"])
        assert diagnostic["primary"]["rule"] == "relay_refusal"
        assert diagnostic["cleanup"]["outcome"] == ("failed" if stop_fails else "stopped")
        assert store.value["phase"] == ("launching" if stop_fails else "stopped")
        assert store.cancelled_value and "PRIVATE_" not in json.dumps(diagnostic)
        if "diagnostic_final" in failed_writes and store.diagnostics:
            assert store.diagnostics[-1]["cleanup"]["outcome"] == "pending"
        if "diagnostic_final" not in failed_writes:
            assert store.diagnostics[-1] == diagnostic
        cases.append(True)
print(json.dumps({"cases":len(cases)}))
`);
  assert.equal(result.cases, 6);
});

test('startup diagnostic schemas reject arbitrary data and never change the authority of old job records', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
def ready(*args): r.fail("API socket peer does not match the owned unit","resource_not_allowed")
r.api_ready = ready
error(lambda:r.start_job(P,A,{},REQUEST,store),"resource_not_allowed")
diagnostic = store.diagnostics[-1]
changes = [
 {"message":"PRIVATE_SECRET"}, {"version":True}, {"jobId":P["instanceId"]}, {"instanceId":JOB},
 {"primary":{**diagnostic["primary"],"stage":"PRIVATE_STAGE"}},
 {"primary":{**diagnostic["primary"],"code":"PRIVATE_CODE"}},
 {"primary":{**diagnostic["primary"],"rule":"PRIVATE_RULE"}},
 {"primary":{**diagnostic["primary"],"errno":True}},
 {"primary":{**diagnostic["primary"],"errno":4096}},
 {"primary":{**diagnostic["primary"],"path":"/private"}},
 {"cleanup":{"stage":"stop","outcome":"stopped","failure":None}},
 {"cleanup":{"stage":"stop","outcome":"failed","failure":None}},
 {"recordingErrors":[diagnostic["primary"]]*3},
]
for change in changes:
    error(lambda change=change:r.validate_startup_failure({**diagnostic,**change},P,JOB),"resource_not_allowed")
assert r.validate_record(store.value,P,JOB) == store.value
assert set(store.value) == r.RECORD_FIELDS
r.cgroup_populated = lambda *args,**kwargs:True
error(lambda:r.prove_stopped(store.value,{}),"process_failed")
print(json.dumps({"refused":len(changes),"oldSchemaUnchanged":True}))
`);
  assert.deepEqual(result, { refused: 13, oldSchemaUnchanged: true });
});

test('startup diagnostic persistence uses the protected job directory and refuses replacing another primary', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
def ready(*args): r.fail("API socket peer does not match the owned unit","resource_not_allowed")
r.api_ready = ready
error(lambda:r.start_job(P,A,{},REQUEST,store),"resource_not_allowed")
diagnostic = store.diagnostics[-1]
real = r.JobStore(P,A,JOB)
seen = []
@contextlib.contextmanager
def directory(path,uid,private=False,**kwargs):
    assert path == real.path and uid == A.pw_uid and private
    yield 17
r.directory = directory
def absent(*args): raise FileNotFoundError()
r.read_json_at = absent
r.write_json_at = lambda fd,name,value:seen.append((fd,name,copy.deepcopy(value)))
real.save_startup_failure(diagnostic, initial=True)
assert seen == [(17,r.STARTUP_DIAGNOSTIC_FILE,diagnostic)]
r.read_json_at = lambda fd,name,uid:copy.deepcopy(diagnostic)
error(lambda:real.save_startup_failure(diagnostic,initial=True),"resource_conflict")
foreign = copy.deepcopy(diagnostic)
foreign["primary"]["rule"] = "api_store"
r.read_json_at = lambda fd,name,uid:foreign
error(lambda:real.save_startup_failure(diagnostic),"resource_conflict")
assert len(seen) == 1
print(json.dumps({"protected":True,"oldPrimaryRetained":True}))
`);
  assert.deepEqual(result, { protected: true, oldPrimaryRetained: true });
});

test('cancel-before-start retains a tombstone and blocks replay, including after removal', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
reply = r.stop_job(P, A, {}, store)
assert reply["stopped"] and store.cancelled_value
assert store.value["phase"] == "stopped"
assert not store.prepared
error(lambda: r.start_job(P, A, {}, REQUEST, store), "resource_conflict")
r.cleanup_job = lambda value, env, store: calls.append(["cleanup"])
removed = r.stop_job(P, A, {}, store, remove=True)
assert removed["removed"] and store.value["phase"] == "removed"
again = r.stop_job(P, A, {}, store, remove=True)
assert again == removed
assert calls.count(["cleanup"]) == 1
assert store.cancelled_value
error(lambda: r.start_job(P, A, {}, REQUEST, store), "resource_conflict")
print(json.dumps({"phase": store.value["phase"], "tombstone": store.cancelled_value}))
`);
  assert.deepEqual(result, { phase: 'removed', tombstone: true });
});

test('cancel-during-start is checked after launch, stops the whole owned unit, and never reports running', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
command = r.run_command
def racing(argv, env, **kw):
    result = command(argv, env, **kw)
    if "--unit-entry" in argv: store.cancel()
    return result
r.run_command = racing
failure = error(lambda: r.start_job(P, A, {}, REQUEST, store), "cancelled")
assert not kernel["populated"] and store.value["phase"] == "stopped"
assert any(call[:2] == ["stop", "--no-block"] for call in calls)
assert store.cancelled_value
print(json.dumps(failure))
`);
  assert.equal(result.code, 'cancelled');
});

test('unsettled launcher exit with unloaded unit is uncertain, not stop proof', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
value = record(); value["phase"] = "launching"
store.save(value)
failure = error(lambda: r.stop_job(P, A, {}, store, remove=True), "process_failed")
assert "unresolved" in failure["message"]
assert store.value["phase"] == "launching" and store.cancelled_value
error(lambda: r.status_job(P, {}, store), "process_failed")
print(json.dumps(failure))
`);
  assert.match(result.message, /unresolved/);
});

test('a timed-out launcher is reconciled against the actual unit rather than presumed stopped', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
command = r.run_command
def timeout(argv, env, **kw):
    result = command(argv, env, **kw)
    if "--unit-entry" in argv: raise r.CommandUncertain("synthetic CLI timeout")
    return result
r.run_command = timeout
error(lambda: r.start_job(P, A, {}, REQUEST, store), "process_failed")
assert store.cancelled_value and store.value["phase"] == "stopped"
assert store.value["observedUnit"] and not kernel["populated"]
print(json.dumps({"stopped": True}))
`);
  assert.equal(result.stopped, true);
});

test('empty launcher PID and stop acknowledgment do not prove an empty backend cgroup', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
r.STOP_TIMEOUT_SECONDS = 0
value = record(); value["phase"] = "running"; value["launchSettled"] = True
store.save(value)
kernel["unit"] = loaded(value, False)
kernel["populated"] = True
error(lambda: r.prove_stopped(value, {}), "process_failed")
def ack(env, *args, **kw): return subprocess.CompletedProcess(args, 0, b"")
r.systemctl = ack
failure = error(lambda: r.stop_job(P, A, {}, store, remove=True), "process_failed")
assert "not be confirmed" in failure["message"]
assert store.value["phase"] == "running" and store.cancelled_value
assert not any(call == ["cleanup"] for call in calls)
print(json.dumps(failure))
`);
  assert.match(result.message, /not be confirmed/);
});

test('non-owned or weakened units are refused before stop or deletion', async () => {
  const result = await fixture(`
value = record()
changes = [
 {"Description": "other"}, {"Id": "unrelated.service"}, {"Transient": "no"},
 {"ControlGroup": "/other"}, {"KillMode": "process"}, {"Delegate": "no"},
 {"BindsTo": ""}, {"After": ""}, {"MemoryMax": "infinity"}, {"TasksMax": "infinity"},
 {"ExecStart": "/bin/sh -c arbitrary"}, {"StandardError": "journal"},
 {"RuntimeMaxUSec": "infinity"}, {"TimeoutStopUSec": "90s"},
]
for change in changes:
    store, kernel = lifecycle()
    store.save(value)
    kernel["unit"] = {**loaded(value), **change}
    before = len(calls)
    error(lambda: r.stop_job(P, A, {}, store, remove=True), "resource_not_allowed")
    assert not any(call[:2] == ["stop", "--no-block"] for call in calls[before:])
print(json.dumps({"refused": len(changes)}))
`);
  assert.equal(result.refused, 14);
});

test('PID reuse, expired and cancelling states cannot be reported as running', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
r.start_job(P, A, {}, REQUEST, store)
r.proc_identity = lambda pid: [pid, 1000]
error(lambda: r.status_job(P, {}, store), "resource_conflict")
r.proc_identity = lambda pid: [pid, 999]
store.cancelled_value = True
error(lambda: r.status_job(P, {}, store), "resource_conflict")
store.cancelled_value = False
r.time.time = lambda: (NOW + 60000) / 1000
error(lambda: r.status_job(P, {}, store), "resource_conflict")
print(json.dumps({"refused": 3}))
`);
  assert.equal(result.refused, 3);
});

test('metadata binds policy, nonce, job, unit, account, phases and limits', async () => {
  const result = await fixture(`
value = record()
assert r.validate_record(value, P, JOB, value["nonce"]) is value
mutations = [{"unit":"other.service"}, {"nonce":"x"}, {"jobId":"../job"},
             {"phase":"unknown"}, {"uid":0}, {"pids":9999}, {"apiIdentity":[1,"2"]},
             {"cleanupAncestors":{"/parent":[1,2,2000]}}, {"untrusted":"extra"}]
for mutation in mutations:
    error(lambda mutation=mutation: r.validate_record({**value, **mutation}), "resource_not_allowed")
error(lambda: r.validate_record(value, {**P,"user":"other"}), "resource_not_allowed")
error(lambda: r.validate_record(value, nonce="f" * 64), "resource_not_allowed")
assert r.metadata_path(value) != r.work_path(value)
assert P["imageStore"] not in (r.metadata_path(value), r.work_path(value), r.runtime_path(value))
print(json.dumps({"refused": len(mutations)+2}))
`);
  assert.equal(result.refused, 11);
});

test('portable openat model refuses symlink traversal, wrong owner, and writable parents', async () => {
  const result = await fixture(`
opened = []
flags = {}
def open_fixture(name, value, **kw):
    opened.append((name, value))
    if name == "link": raise OSError(40, "synthetic symlink")
    return 10
mode = {"uid":1001, "bits":0o700}
def info(fd): return types.SimpleNamespace(st_uid=mode["uid"], st_mode=stat.S_IFDIR|mode["bits"])
with patch.object(r.os, "O_DIRECTORY", 0x10000, create=True), \
     patch.object(r.os, "O_NOFOLLOW", 0x20000, create=True), \
     patch.object(r.os, "O_CLOEXEC", 0x40000, create=True), \
     patch.object(r.os, "open", side_effect=open_fixture), patch.object(r.os, "close"), \
     patch.object(r.os, "fstat", side_effect=info):
    with r.directory("/owned/private",1001,private=True): pass
    assert all(value & 0x20000 for name,value in opened)
    mode["uid"] = 1002
    def attempt():
        with r.directory("/owned/private",1001,private=True): pass
    error(attempt, "resource_not_allowed")
    mode["uid"], mode["bits"] = 1001, 0o777
    error(attempt, "resource_not_allowed")
    mode["bits"] = 0o755
    error(attempt, "resource_not_allowed")
    try:
        with r.directory("/link",1001): pass
    except OSError as exc: assert exc.errno == 40
    else: raise AssertionError("Symlink was accepted")
    error(lambda: r.safe_path("/owned/../other","path","resource_not_allowed"), "resource_not_allowed")
print(json.dumps({"nofollow": True}))
`);
  assert.equal(result.nofollow, true);
});

test('cleanup validates root inode/nonce and refuses unbound paths, mounts, and parent substitution', async () => {
  const result = await fixture(`
value = record(); value["workIdentity"] = [1,10]
@contextlib.contextmanager
def directory(*args, **kw): yield 20
r.directory = directory
current = {"inode":10, "nonce":value["nonce"]}
r.read_json_at = lambda *a, **kw: {"instanceId":P["instanceId"],"jobId":JOB,"nonce":current["nonce"]}
r.remove_tree_at = lambda *a, **kw: calls.append(["remove", a, kw])
def info(fd): return types.SimpleNamespace(st_uid=1001, st_mode=stat.S_IFDIR|0o700, st_dev=1, st_ino=current["inode"])
with patch.object(r.os, "O_DIRECTORY", 0, create=True), patch.object(r.os, "O_NOFOLLOW", 0, create=True), \
     patch.object(r.os, "O_CLOEXEC", 0, create=True), patch.object(r.os, "open", return_value=21), \
     patch.object(r.os, "close"), patch.object(r.os, "fstat", side_effect=info):
    current["inode"] = 11
    error(lambda: r.remove_job_path(value,"work",1001), "resource_not_allowed")
    current["inode"], current["nonce"] = 10, "f" * 64
    error(lambda: r.remove_job_path(value,"work",1001), "resource_not_allowed")
    current["nonce"] = value["nonce"]
    r.remove_job_path(value,"work",1001)
    assert calls[-1][1][1] == JOB
    assert calls[-1][1][2] == [1,10]
with patch.object(r.os.path, "lexists", return_value=True):
    error(lambda: r.remove_job_path(value,"runtime",1001), "resource_not_allowed")
r.mount_paths = lambda: [r.work_path(value)+"/graph/overlay/merged"]
error(lambda: r.refuse_job_mounts(value), "resource_not_allowed")
print(json.dumps({"deletions": len(calls)}))
`);
  assert.equal(result.deletions, 1);
});

test('namespace mapping must bind root to the positive approved host ID and never host root', async () => {
  const result = await fixture(String.raw`
r.validate_mapping("0 1001 1\n1 100000 65536\n",1001,"uid_map")
invalid = ["0 0 4294967295", "0 1002 1\n1 100000 65536", "0 1001 2",
           "0 1001 1\n1 0 1", "0 1001 1\n1 1001 2", "0 1001 1\n0 100000 2", "bad"]
for value in invalid:
    error(lambda value=value: r.validate_mapping(value,1001,"uid_map"), "privilege_refused")
print(json.dumps({"refused":len(invalid)}))
`);
  assert.equal(result.refused, 7);
});

test('permission cleanup uses only the existing normal rootless namespace, never a job/cache store', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
value = record(); value["phase"] = "stopped"; value["launchSettled"] = True
store.save(value)
r.refuse_job_mounts = lambda value: None
r.prove_stopped = lambda value, env: True
def permission(*args): raise PermissionError("mapped graph owner")
r.remove_job_path = permission
r.capture_cleanup_ancestors = lambda value: {"/var": [1,2,0]}
r.existing_namespace = lambda value: [3,4]
commands = []
def command(argv, env, **kwargs):
    commands.append(argv)
    return subprocess.CompletedProcess(argv,0,b"")
r.run_command = command
with patch.object(r.os.path, "lexists", return_value=False):
    r.cleanup_job(value,{},store)
assert commands[0][:3] == ["/usr/bin/podman","--remote=false","unshare"]
assert "--root" not in commands[0] and "--runroot" not in commands[0]
assert not any("additionalimagestore" in arg for arg in commands[0])
assert store.value["cleanupNamespace"] == [3,4]
assert "--cleanup-entry" in commands[0]
r.existing_namespace = lambda value: r.fail("Normal rootless namespace is absent")
error(lambda: r.cleanup_job(value,{},store), "process_failed")
assert len(commands) == 1
print(json.dumps({"commands": commands}))
`);
  assert.equal(result.commands.length, 1);
});

test('failed cleanup retains stopped metadata and cancellation rather than claiming removal', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
r.start_job(P,A,{},REQUEST,store)
r.cleanup_job = lambda *args: r.fail("Unsafe storage remains", "resource_not_allowed")
error(lambda: r.stop_job(P,A,{},store,remove=True), "resource_not_allowed")
assert store.value["phase"] == "stopped" and store.cancelled_value and not kernel["populated"]
print(json.dumps({"phase": store.value["phase"]}))
`);
  assert.equal(result.phase, 'stopped');
});

test('probe is read-only and missing prerequisites do not create job state', async () => {
  const result = await fixture(`
r.prerequisites = lambda *args: calls.append(["prerequisites"])
r.JobStore = forbidden
reply = r.dispatch(P,A,{},{"requestId":"r","action":"builder_probe"})
assert reply == {"instanceId":P["instanceId"],"ready":True}
assert calls == [["prerequisites"]]
r.prerequisites = lambda *args: r.fail("User manager requires memory and pids", "runtime_policy_invalid")
error(lambda: r.dispatch(P,A,{},{"requestId":"r","action":"builder_probe"}), "runtime_policy_invalid")
print(json.dumps(reply))
`);
  assert.equal(result.ready, true);
});

test('independent deadline handler cancels before stopping without waiting on a start lock or reloading policy', async () => {
  const result = await fixture(`
value = record(); value["phase"] = "launching"
store = Store(); store.save(value)
r.load_internal = lambda *args, **kw: (value,A)
r.JobStore = lambda *args: store
def stopped(value,env):
    assert not store.locked_value
    value["observedUnit"] = True
    calls.append(["stop-owned"])
r.stop_owned = stopped
r.prove_stopped = lambda *args: True
r.load_policy = forbidden
with patch.dict(r.os.environ, {}, clear=True):
    r.internal_main(["--deadline-entry",r.metadata_path(value),value["nonce"]])
assert calls == [["cancel"],["stop-owned"]]
assert not store.locked_value
assert store.value["phase"] == "stopped" and store.value["observedUnit"]
print(json.dumps({"calls":calls}))
`);
  assert.deepEqual(result.calls, [['cancel'], ['stop-owned']]);
});

test('complete-frame timeout cannot be extended by trickled bytes', async () => {
  const result = await fixture(`
ticks = iter([0.0, 0.1, 0.2, 10.1])
r.time.monotonic = lambda: next(ticks)
chunks = iter([b"00000000", b"02"])
stream = types.SimpleNamespace(fileno=lambda: 9)
r.select.select = lambda *args: ([9],[],[])
r.os.read = lambda *args: next(chunks)
failure = error(lambda: r.read_request(stream), "invalid_request")
assert "timed out" in failure["message"]
print(json.dumps(failure))
`);
  assert.match(result.message, /timed out/);
});

test('root-protected policy reads refuse writable, linked, oversized and non-root files', async () => {
  const result = await fixture(`
state = {"uid":0,"mode":stat.S_IFREG|0o644,"links":1,"size":200}
data = json.dumps(P).encode()
def info(fd):
    return types.SimpleNamespace(st_uid=state["uid"],st_mode=state["mode"],
        st_nlink=state["links"],st_size=state["size"])
def attempt(): return r.read_json_at(10,"policy.json",0,private=False)
with patch.object(r.os,"O_NOFOLLOW",0,create=True), patch.object(r.os,"O_CLOEXEC",0,create=True), \
     patch.object(r.os,"open",return_value=11), patch.object(r.os,"close"), \
     patch.object(r.os,"fstat",side_effect=info), patch.object(r.os,"read",side_effect=[data,b""]):
    assert attempt() == P
    for field,value in [("uid",1001),("mode",stat.S_IFREG|0o666),("mode",stat.S_IFLNK|0o777),
                        ("links",2),("size",r.MAX_METADATA_BYTES+1)]:
        original = state[field]; state[field] = value
        error(attempt,"resource_not_allowed")
        state[field] = original
print(json.dumps({"refused":5}))
`);
  assert.equal(result.refused, 5);
});

test('actual readiness handler binds Unix peer PID, kernel starttime, command and private store identity', async () => {
  const result = await fixture(String.raw`
value = record()
props = loaded(value)
state = {"peer":4321,"uid":1001,"graph":r.work_path(value)+"/graph",
    "transfer":r.transfer_path(value),"cgroup":r.expected_cgroup(value)+"/supervisor"}
r.proc_identity = lambda pid: [pid,999]
r.process_cgroup = lambda pid: state["cgroup"]
@contextlib.contextmanager
def directory(*args,**kwargs): yield 10
r.directory = directory
command = b"\0".join(item.encode() for item in r.api_argv(value))+b"\0"
def opened(path,*args,**kwargs):
    assert path == "/proc/4321/cmdline"
    return io.BytesIO(command)
class Connection:
    def settimeout(self,*args): pass
    def connect(self,path): assert path == r.runtime_path(value)+"/api.sock"
    def getsockopt(self,*args): return r.struct.pack("3i",state["peer"],state["uid"],1001)
    def sendall(self,request):
        assert request.startswith(b"GET /v1.0.0/libpod/info HTTP/1.0")
        body = json.dumps({"store":{"graphRoot":state["graph"],"runRoot":r.runtime_path(value)+"/r",
            "imageCopyTmpDir":state["transfer"]},
            "host":{"cgroupManager":"cgroupfs","cgroupVersion":"v2","security":{"rootless":True}}}).encode()
        self.parts = iter([b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n"+body,b""])
    def recv(self,*args): return next(self.parts)
    def close(self): pass
with patch("builtins.open",side_effect=opened), \
     patch.object(r.socket,"AF_UNIX",1,create=True), patch.object(r.socket,"SO_PEERCRED",17,create=True), \
     patch.object(r.socket,"socket",side_effect=lambda *args:Connection()), \
     patch.object(r.os,"stat",return_value=types.SimpleNamespace(st_mode=stat.S_IFSOCK|0o600,st_uid=1001)):
    assert r.api_ready(value,props) == [4321,999]
    for key,bad in [("peer",999),("uid",1002),("graph",P["imageStore"]),
                    ("transfer","/var/tmp"),("transfer",None),("transfer",P["imageStore"]),("cgroup","/other")]:
        original = state[key]; state[key] = bad
        error(lambda:r.api_ready(value,props),"resource_not_allowed")
        state[key] = original
    entry = [r.PYTHON_BIN,"-I",r.RELAY_BIN,"--unit-entry",r.metadata_path(value),value["nonce"]]
    command = b"\0".join(item.encode() for item in entry)+b"\0"
    state["cgroup"] = r.expected_cgroup(value)
    try: r.api_ready(value,props)
    except r.NotReady: pass
    else: raise AssertionError("Bootstrap was incorrectly called ready")
print(json.dumps({"bound":True}))
`);
  assert.equal(result.bound, true);
});

test('readiness retries the exact bootstrap without interpreting it as escaped API work', async () => {
  const result = await fixture(`
store,kernel = lifecycle()
attempts = []
def ready(value,props):
    attempts.append(1)
    if len(attempts) == 1: raise r.NotReady("bootstrapping")
    return [4321,999]
r.api_ready = ready
r.time.sleep = lambda seconds:None
reply = r.start_job(P,A,{},REQUEST,store)
assert reply["running"] and len(attempts) == 2
print(json.dumps({"attempts":len(attempts)}))
`);
  assert.equal(result.attempts, 2);
});

test('stop polls through inactive-but-populated kernel state before reporting success', async () => {
  const result = await fixture(`
store,kernel = lifecycle()
r.start_job(P,A,{},REQUEST,store)
control = r.systemctl
count = []
def populated(value,**kwargs):
    count.append(1)
    return len(count) == 1
r.cgroup_populated = populated
r.time.sleep = lambda seconds:None
reply = r.stop_job(P,A,{},store)
assert reply["stopped"] and len(count) >= 3
print(json.dumps({"polls":len(count)}))
`);
  assert.ok(result.polls >= 3);
});

test('probe accepts systemd template cgroups for an activating controller without starting it', async () => {
  const result = await fixture(`
real = importlib.util.module_from_spec(spec); spec.loader.exec_module(real)
real.trusted_executable = lambda path: calls.append(["trusted",path])
manager = real.CGROUP_ROOT + real.user_cgroup(A.pw_uid)
assert manager.endswith("/user@1001.service")
opened = {}
private = {P["stateDir"],P["runtimeDir"],"/run/user/1001"}
owned = private | {P["imageStore"],manager}
unsafe = {"path":None,"uid":1002,"mode":0o755}
def open_fixture(name, flags, dir_fd=None):
    assert flags & real.os.O_NOFOLLOW
    path = name if dir_fd is None else opened[dir_fd].rstrip("/")+"/"+name
    fd = len(opened)+10
    opened[fd] = path
    return fd
def info(fd):
    path = opened[fd]
    uid = A.pw_uid if path in owned else 0
    mode = 0o700 if path in private else 0o755
    if path == unsafe["path"]: uid,mode = unsafe["uid"],unsafe["mode"]
    return types.SimpleNamespace(st_uid=uid,st_mode=stat.S_IFDIR|mode)
real.process_cgroup = lambda pid:real.user_cgroup(A.pw_uid)+"/app.slice/"+P["controllerUnit"]
controller = {"Id":P["controllerUnit"],"LoadState":"loaded","ActiveState":"activating","MainPID":"10",
              "ControlGroup":real.user_cgroup(A.pw_uid)+"/app.slice/"+P["controllerUnit"]}
real.show_unit = lambda *args:controller
real.systemctl = forbidden
real.run_command = forbidden
real.JobStore = forbidden
request = {"requestId":"probe_1","action":"builder_probe"}
def probe(): return real.dispatch(P,A,{},request)
def refused(code):
    try: probe()
    except real.RelayError as exc: assert exc.code == code, (exc.code,str(exc))
    else: raise AssertionError("Unsafe prerequisite accepted")
with patch.object(real.os,"O_DIRECTORY",0x10000,create=True), \
     patch.object(real.os,"O_NOFOLLOW",0x20000,create=True), \
     patch.object(real.os,"O_CLOEXEC",0x40000,create=True), \
     patch.object(real.os,"stat",return_value=types.SimpleNamespace(st_mode=stat.S_IFSOCK|0o600,st_uid=1001)), \
     patch.object(real.os,"open",side_effect=open_fixture),patch.object(real.os,"close"), \
     patch.object(real.os,"fstat",side_effect=info), \
     patch.object(real.os,"read",return_value=b"memory pids cpu"):
    assert probe() == {"instanceId":P["instanceId"],"ready":True}
    assert manager+"/cgroup.controllers" in opened.values()
    unsafe["path"] = manager
    refused("resource_not_allowed")
    unsafe["uid"],unsafe["mode"] = A.pw_uid,0o775
    refused("resource_not_allowed")
    unsafe["path"] = None
    controller["MainPID"]="0"
    refused("runtime_policy_invalid")
assert all(call[0]=="trusted" for call in calls)
for path in (manager+"/../other", manager+"//child", manager+"/./child", manager+"\\n"):
    error(lambda path=path:r.safe_path(path,"cgroup","resource_not_allowed"),"resource_not_allowed")
print(json.dumps({"readOnly":True,"realDirectoryWalk":True,"unsafeCases":7}))
`);
  assert.equal(result.readOnly, true);
  assert.equal(result.realDirectoryWalk, true);
  assert.equal(result.unsafeCases, 7);
});

test('directory deletion unlinks internal image symlinks without following them and preserves marker until last', async () => {
  const result = await fixture(`
events=[]
@contextlib.contextmanager
def entries(fd):
    yield iter([types.SimpleNamespace(name=".pw-builder-owner"),types.SimpleNamespace(name="inside-link")])
def info(name,*args,**kw):
    if name=="inside-link": return types.SimpleNamespace(st_mode=stat.S_IFLNK|0o777,st_dev=1,st_ino=12)
    return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_dev=1,st_ino=10)
with patch.object(r.os,"O_DIRECTORY",0,create=True),patch.object(r.os,"O_NOFOLLOW",0,create=True), \
     patch.object(r.os,"O_CLOEXEC",0,create=True),patch.object(r.os,"open",return_value=11), \
     patch.object(r.os,"close"),patch.object(r.os,"fstat",side_effect=info), \
     patch.object(r.os,"stat",side_effect=info),patch.object(r.os,"scandir",side_effect=entries), \
     patch.object(r.os,"unlink",side_effect=lambda name,**kw:events.append(["unlink",name])), \
     patch.object(r.os,"rmdir",side_effect=lambda name,**kw:events.append(["rmdir",name])),patch.object(r.os,"fsync"):
    r.remove_tree_at(10,JOB,[1,10],owner_marker=True)
assert events==[["unlink","inside-link"],["unlink",".pw-builder-owner"],["rmdir",JOB]]
print(json.dumps({"events":events}))
`);
  assert.equal(result.events[0][1], 'inside-link');
  assert.equal(result.events[1][1], '.pw-builder-owner');
});

test('bounded command helper kills and reaps its own process group on timeout, cancellation and excess output', async () => {
  const result = await fixture(`
class Process:
    def __init__(self):
        self.pid=555
        self.returncode=None
        self.stdout=types.SimpleNamespace(fileno=lambda:11,close=lambda:calls.append(["close"]))
    def poll(self): return self.returncode
    def wait(self,timeout):
        calls.append(["wait",timeout])
        self.returncode=-9
        return self.returncode
def spawned(argv,**kwargs):
    assert kwargs["start_new_session"] is True
    assert kwargs["stderr"] == subprocess.DEVNULL and kwargs["stdin"] == subprocess.DEVNULL
    return Process()
with patch.object(r.subprocess,"Popen",side_effect=spawned), \
     patch.object(r.os,"killpg",side_effect=lambda pid,sig:calls.append(["kill",pid]),create=True), \
     patch.object(r.signal,"SIGKILL",9,create=True), \
     patch.object(r.select,"select",side_effect=lambda readable,*args:(readable,[],[])), \
     patch.object(r.os,"read",return_value=b"x"*9):
    ticks=iter([0,11]); r.time.monotonic=lambda:next(ticks)
    try: REAL_RUN_COMMAND(["fixed"],{})
    except r.CommandUncertain: pass
    else: raise AssertionError("Timed-out command succeeded")
    r.time.monotonic=lambda:0
    r.MAX_HELPER_OUTPUT_BYTES=8
    try: REAL_RUN_COMMAND(["fixed"],{})
    except r.CommandUncertain: pass
    else: raise AssertionError("Excess command output succeeded")
    r.TERMINATED=True
    error(lambda:REAL_RUN_COMMAND(["fixed"],{}),"cancelled")
assert [item for item in calls if item[0]=="kill"] == [["kill",555]]*3
assert len([item for item in calls if item[0]=="wait"])==3
assert len([item for item in calls if item[0]=="close"])==3
print(json.dumps({"reaped":3}))
`);
  assert.equal(result.reaped, 3);
});

test('unreaped helper is explicitly uncertain, never a successful manager outcome', async () => {
  const result = await fixture(`
class Process:
    pid=555
    stdout=types.SimpleNamespace(fileno=lambda:11,close=lambda:None)
    def poll(self):return None
    def wait(self,timeout):raise subprocess.TimeoutExpired("fixture",timeout)
ticks=iter([0,11]);r.time.monotonic=lambda:next(ticks)
with patch.object(r.subprocess,"Popen",return_value=Process()), \
     patch.object(r.os,"killpg",return_value=None,create=True),patch.object(r.signal,"SIGKILL",9,create=True):
    failure=error(lambda:REAL_RUN_COMMAND(["fixed"],{}),"process_failed")
assert "reaped" in failure["message"]
print(json.dumps(failure))
`);
  assert.match(result.message, /reaped/);
});

test('public SSH rejects internal arguments with a bounded error frame and root before loading policy', async () => {
  const result = await fixture(`
def invoke(args,environment):
    output=io.BytesIO()
    with patch.object(r.sys,"argv",args), \
         patch.object(r.sys,"stdout",types.SimpleNamespace(buffer=output)), \
         patch.object(r.signal,"signal"),patch.dict(r.os.environ,environment,clear=True):
        status=r.main()
    frame=output.getvalue()
    assert int(frame[:10])==len(frame[10:])
    assert status==0
    return json.loads(frame[10:])
r.load_policy=forbidden
reply=invoke(["builder","--unit-entry","/untrusted","a"*64],{"SSH_CONNECTION":"fixture"})
assert reply["code"]=="action_not_allowed"
reply=invoke(["builder","--policy","/untrusted"],{})
assert reply["code"]=="action_not_allowed"
r.sys.platform="linux";r.pwd=object();r.fcntl=object()
with patch.object(r.os,"getuid",return_value=0,create=True),patch.object(r.os,"geteuid",return_value=0,create=True):
    reply=invoke(["builder"],{})
assert reply["code"]=="privilege_refused"
print(json.dumps({"framed":True}))
`);
  assert.equal(result.framed, true);
});

test('public SSH accepts only the approved PAM session bus address', async () => {
  const result = await fixture(`
r.sys.platform = "linux"
r.fcntl = object()
r.pwd = types.SimpleNamespace(getpwnam=lambda user: A)
r.load_policy = lambda: P
request = {"requestId": "pam-fixture", "action": "builder_probe"}
body = json.dumps(request).encode()
frame = str(len(body)).zfill(10).encode() + body
base = {"HOME": A.pw_dir, "USER": A.pw_name, "LOGNAME": A.pw_name,
        "SSH_ORIGINAL_COMMAND": "pw-deploy-builder", "SSH_CONNECTION": "fixture",
        "XDG_RUNTIME_DIR": "/run/user/1001", "XDG_SESSION_ID": "fixture",
        "XDG_SESSION_TYPE": "tty", "XDG_SESSION_CLASS": "user"}
def dispatched(policy, account, environment, value):
    assert policy == P and account == A and value == request
    assert environment["DBUS_SESSION_BUS_ADDRESS"] == "unix:path=/run/user/1001/bus"
    calls.append("dispatch")
    return {"instanceId": P["instanceId"], "ready": True}
r.dispatch = dispatched
def invoke(address):
    environment = dict(base)
    if address is not None:
        environment["DBUS_SESSION_BUS_ADDRESS"] = address
    output = io.BytesIO()
    incoming = io.BytesIO(frame)
    with patch.object(r.sys, "argv", ["builder"]), \\
         patch.object(r.sys, "stdout", types.SimpleNamespace(buffer=output)), \\
         patch.object(r.sys, "stdin", types.SimpleNamespace(buffer=incoming)), \\
         patch.object(r.signal, "signal"), patch.dict(r.os.environ, environment, clear=True), \\
         patch.object(r.os, "getuid", return_value=1001, create=True), \\
         patch.object(r.os, "geteuid", return_value=1001, create=True), \\
         patch.object(r.os, "getgid", return_value=1001, create=True), \\
         patch.object(r.os, "getegid", return_value=1001, create=True):
        assert r.main() == 0
    data = output.getvalue()
    assert int(data[:10]) == len(data[10:])
    return json.loads(data[10:]), incoming.tell()
for address in (None, "unix:path=/run/user/1001/bus"):
    reply, consumed = invoke(address)
    assert reply == {"ok": True, "result": {"instanceId": P["instanceId"], "ready": True}}, reply
    assert consumed == len(frame)
bad = ["", "unix:path=/run/user/0/bus", "unix:path=/run/user/1002/bus",
       "unix:path=/tmp/bus", "tcp:host=127.0.0.1,port=1234",
       "unix:abstract=/run/user/1001/bus",
       "unix:path=/run/user/1001/bus;unix:path=/tmp/bus",
       "unix:path=/run/user/1001/bus,guid=untrusted"]
for address in bad:
    reply, consumed = invoke(address)
    assert reply["ok"] is False and reply["code"] == "privilege_refused", reply
    assert consumed == 0
assert calls == ["dispatch", "dispatch"], calls
print(json.dumps({"accepted": 2, "refusedBeforeDispatch": len(bad)}))
`);
  assert.equal(result.accepted, 2);
  assert.equal(result.refusedBeforeDispatch, 8);
});

test('deeply nested JSON cannot crash the public frame parser', async () => {
  const result = await fixture(`
body=b'{"a":'+b"["*1500+b"0"+b"]"*1500+b"}"
failure=error(lambda:r.read_request(io.BytesIO(str(len(body)).zfill(10).encode()+body)),"invalid_request")
print(json.dumps(failure))
`);
  assert.equal(result.code, 'invalid_request');
});

test('cleanup namespace ancestry is inode-bound rather than trusting unmapped ownership', async () => {
  const result = await fixture(`
ancestors={"/parent":[1,10,0],"/parent/private":[1,11,1001]}
state={"current":"","inode":11}
def opened(name,flags,**kwargs):
    state["current"]=name
    return 10
def info(fd):
    parent=state["current"]=="parent"
    return types.SimpleNamespace(st_uid=65534 if parent else 0,st_mode=stat.S_IFDIR|0o700,
        st_dev=1,st_ino=10 if parent else state["inode"])
def attempt():
    with r.directory("/parent/private",0,private=True,ancestors=ancestors):pass
with patch.object(r.os,"O_DIRECTORY",0,create=True),patch.object(r.os,"O_NOFOLLOW",0,create=True), \
     patch.object(r.os,"O_CLOEXEC",0,create=True),patch.object(r.os,"open",side_effect=opened), \
     patch.object(r.os,"close"),patch.object(r.os,"fstat",side_effect=info), \
     patch.object(r.os,"stat",return_value=types.SimpleNamespace(st_uid=65534)):
    attempt()
    state["inode"]=12
    error(attempt,"resource_not_allowed")
print(json.dumps({"refusedSubstitution":True}))
`);
  assert.equal(result.refusedSubstitution, true);
});

test('expired and substituted deadline timers cannot be treated as armed', async () => {
  const result = await fixture(`
value=record()
timer=r.deadline_unit(value)[:-8]+".timer"
props={"Id":timer,"LoadState":"loaded","ActiveState":"active","Description":r.description(value,True),
       "Transient":"yes","Unit":r.deadline_unit(value)}
r.show_unit=lambda *args:props
r.check_deadline_timer(value,{})
for key,bad in [("ActiveState","inactive"),("Description","other"),("Unit","foreign.service"),("Transient","no")]:
    old=props[key];props[key]=bad
    error(lambda:r.check_deadline_timer(value,{}),"process_failed")
    props[key]=old
print(json.dumps({"refused":4}))
`);
  assert.equal(result.refused, 4);
});

test('stop CLI timeout is reconciled by manager and kernel proof, not its exit status', async () => {
  const result = await fixture(`
store,kernel=lifecycle()
r.start_job(P,A,{},REQUEST,store)
control=r.systemctl
def timed_out(env,*args,**kwargs):
    control(env,*args,**kwargs)
    raise r.CommandUncertain("synthetic stop CLI deadline")
r.systemctl=timed_out
reply=r.stop_job(P,A,{},store)
assert reply["stopped"] and not kernel["populated"] and store.value["phase"]=="stopped"
print(json.dumps(reply))
`);
  assert.equal(result.stopped, true);
});

test('private HOME generation creates an exclusive empty mounts.conf and validates it without reading host files', async () => {
  const result = await fixture(`
value=record()
directories={100:r.work_path(value)}
files={}
opened=[]
synced=[]
@contextlib.contextmanager
def directory(name,uid,private=False,**kwargs):
    assert uid==1001 and private is True
    assert name in (r.work_path(value),r.job_home(value)+"/.config/containers")
    yield next(fd for fd,path in directories.items() if path==name)
r.directory=directory
def child(parent,name,uid):
    assert uid==1001
    target=directories[parent]+"/"+name
    for fd,path in directories.items():
        if path==target:return fd
    fd=max(directories)+1
    directories[fd]=target
    return fd
r.ensure_child=child
state={"uid":1001,"mode":stat.S_IFREG|0o600,"links":1,"data":b""}
def opened_file(name,flags,mode=None,dir_fd=None):
    target=directories[dir_fd]+"/"+name
    assert target==r.job_home(value)+"/.config/containers/mounts.conf"
    assert flags & r.os.O_NOFOLLOW
    opened.append((target,flags,mode))
    if flags & r.os.O_CREAT:
        assert flags & r.os.O_EXCL and mode==0o600
        if target in files:raise FileExistsError(target)
        files[target]=b""
    else:
        assert flags & r.os.O_NONBLOCK
    return 200
def info(fd):
    assert fd==200
    return types.SimpleNamespace(st_uid=state["uid"],st_mode=state["mode"],
        st_nlink=state["links"],st_size=len(state["data"]))
with patch.object(r.os,"O_NOFOLLOW",0x100000,create=True), \
     patch.object(r.os,"O_CLOEXEC",0x200000,create=True),patch.object(r.os,"O_NONBLOCK",0x400000,create=True), \
     patch.object(r.os,"open",side_effect=opened_file),patch.object(r.os,"close"), \
     patch.object(r.os,"fstat",side_effect=info),patch.object(r.os,"fsync",side_effect=lambda fd:synced.append(fd)), \
     patch.object(r.os,"read",side_effect=forbidden),patch.object(r.os,"write",side_effect=forbidden):
    r.prepare_job_home(value)
    target=r.job_home(value)+"/.config/containers/mounts.conf"
    assert files=={target:b""}
    assert 200 in synced and 103 in synced
    r.validate_job_home(value)
    for field,bad in [("uid",1002),("mode",stat.S_IFREG|0o660),("mode",stat.S_IFLNK|0o600),
                      ("mode",stat.S_IFIFO|0o600),("links",2),("data",b"/forbidden/source:/target")]:
        previous=state[field];state[field]=bad
        error(lambda:r.validate_job_home(value),"resource_not_allowed")
        state[field]=previous
    try:r.prepare_job_home(value)
    except FileExistsError:pass
    else:raise AssertionError("Existing mounts.conf was silently overwritten")
assert all(path.startswith(r.work_path(value)+"/home/") for path,flags,mode in opened)
assert value["home"]==A.pw_dir and r.runtime_environment(A)["HOME"]==A.pw_dir
print(json.dumps({"generated":files[target].decode(),"path":target,"unchangedAccountHome":value["home"]}))
`);
  assert.equal(result.generated, '');
  assert.match(result.path, /\/work\/123e4567-e89b-42d3-a456-426614174000\/home\/\.config\/containers\/mounts\.conf$/);
  assert.equal(result.unchangedAccountHome, '/home/builder');
});

test('job preparation wires private mounts override before the unit can be launched', async () => {
  const result = await fixture(`
value=record()
store=r.JobStore(P,A,JOB)
events=[]
@contextlib.contextmanager
def directory(name,uid,private=False,**kwargs):
    assert name in (P["stateDir"],P["runtimeDir"]) and private is True
    yield 10
r.directory=directory
r.ensure_child=lambda *args:11
r.write_json_at=lambda fd,name,data:events.append(["marker",name])
store.save=lambda saved:events.append(["saved",copy.deepcopy(saved)])
def prepare(saved):
    assert saved["workIdentity"]==[1,20] and saved["runtimeIdentity"]==[1,20]
    events.append(["home",r.job_home(saved)])
r.prepare_job_home=prepare
r.prepare_job_transfer=lambda saved:events.append(["transfer",r.transfer_path(saved)])
with patch.object(r.os,"O_DIRECTORY",0,create=True),patch.object(r.os,"O_NOFOLLOW",0,create=True), \
     patch.object(r.os,"O_CLOEXEC",0,create=True),patch.object(r.os,"dup",return_value=11), \
     patch.object(r.os,"mkdir"),patch.object(r.os,"open",return_value=12),patch.object(r.os,"close"), \
     patch.object(r.os,"fsync"),patch.object(r.os,"fstat",return_value=types.SimpleNamespace(st_dev=1,st_ino=20)):
    store.prepare_paths(value)
assert [event[0] for event in events]==["marker","saved","marker","saved","home","transfer"]
assert value["phase"]=="reserved"
print(json.dumps({"preparedBeforeLaunch":True}))
`);
  assert.equal(result.preparedBeforeLaunch, true);
});

test('missing or substituted private mounts override blocks bootstrap before Podman execution', async () => {
  const result = await fixture(`
value=record();value["phase"]="launching"
store=Store()
r.time.time=lambda:NOW/1000
r.process_cgroup=lambda pid:r.expected_cgroup(value)
r.validate_job_home=lambda value:r.fail("Private mounts override unavailable","resource_not_allowed")
with patch.object(r.os,"execve",side_effect=forbidden),patch.object(r.os,"mkdir",side_effect=forbidden):
    error(lambda:r.bootstrap(value,A,store),"resource_not_allowed")
assert not any(arg.startswith("--hooks-dir") for arg in r.api_argv(value))
print(json.dumps({"blockedBeforeExec":True,"hooksUnchanged":True}))
`);
  assert.equal(result.blockedBeforeExec, true);
  assert.equal(result.hooksUnchanged, true);
});

test('job transfer storage is exclusively created inside its owned private work directory', async () => {
  const result = await fixture(`
value=record()
events=[]
@contextlib.contextmanager
def directory(name,uid,private=False):
    assert name==r.work_path(value) and uid==1001 and private is True
    yield 20
r.directory=directory
def mkdir(name,mode,dir_fd):
    assert (name,mode,dir_fd)==("transfer",0o700,20)
    if events:raise FileExistsError(name)
    events.append(["created",r.transfer_path(value)])
with patch.object(r.os,"mkdir",side_effect=mkdir),patch.object(r.os,"fsync",return_value=None):
    r.prepare_job_transfer(value)
    try:r.prepare_job_transfer(value)
    except FileExistsError:pass
    else:raise AssertionError("Pre-existing transfer storage was adopted")
assert events==[["created",r.work_path(value)+"/transfer"]]
print(json.dumps({"exclusive":True}))
`);
  assert.equal(result.exclusive, true);
});

test('missing or unsafe transfer storage prevents API execution rather than falling back to host temp', async () => {
  const result = await fixture(`
value=record();value["phase"]="launching"
store=Store()
r.time.time=lambda:NOW/1000
r.process_cgroup=lambda pid:r.expected_cgroup(value)
r.validate_job_home=lambda value:None
@contextlib.contextmanager
def directory(name,uid,private=False):
    assert name==r.transfer_path(value) and uid==1001 and private is True
    r.fail("Private transfer storage unavailable","resource_not_allowed")
    yield
r.directory=directory
with patch.object(r.os,"execve",side_effect=forbidden),patch.object(r.os,"mkdir",side_effect=forbidden):
    error(lambda:r.bootstrap(value,A,store),"resource_not_allowed")
print(json.dumps({"blockedBeforeExec":True}))
`);
  assert.equal(result.blockedBeforeExec, true);
});

test('public framed refusal is decoded by the real Node builder transport', async () => {
  const result = await fixture(`
output=io.BytesIO()
r.sys.platform="linux"
r.pwd=object();r.fcntl=object()
r.load_policy=lambda:P
r.identity=lambda policy:A
r.read_request=lambda stream:REQUEST
r.dispatch=lambda *args:r.fail("Synthetic owned job conflict","resource_conflict")
with patch.object(r.sys,"argv",["builder"]), \
     patch.object(r.sys,"stdout",types.SimpleNamespace(buffer=output)), \
     patch.object(r.sys,"stdin",types.SimpleNamespace(buffer=io.BytesIO())), \
     patch.object(r.signal,"signal"),patch.dict(r.os.environ,{},clear=True), \
     patch.object(r.os,"getuid",return_value=1001,create=True), \
     patch.object(r.os,"geteuid",return_value=1001,create=True):
    status=r.main()
print(json.dumps({"status":status,"frame":output.getvalue().decode()}))
`);
  assert.equal(result.status, 0);
  const connection = {
    host: 'fixture.invalid', port: 22, user: 'builder',
    keyFile: '/fixture/key', knownHostsFile: '/fixture/known-hosts',
  };
  await assert.rejects(builderRequest(connection, { action: 'job_start', requestId: 'fixture' }, {
    timeoutMs: 5000,
    spawnProcess(command, args, options) {
      assert.equal(command, '/usr/bin/ssh');
      assert.equal(args.at(-1), 'pw-deploy-builder');
      return spawn(process.execPath, ['-e',
        'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(process.argv[1]);process.exitCode=Number(process.argv[2]);});',
        result.frame, String(result.status)], options);
    },
  }), error => error.code === 'resource_conflict' && error.message === 'Synthetic owned job conflict');
});

test('internal unit failures remain nonzero and do not emit a public success-shaped frame', async () => {
  const result = await fixture(`
output=io.BytesIO();errors=io.StringIO()
r.internal_main=lambda args:r.fail("Synthetic internal failure","resource_conflict")
with patch.object(r.sys,"argv",["builder","--unit-entry","/fixture","a"*64]), \
     patch.object(r.sys,"stdout",types.SimpleNamespace(buffer=output)), \
     patch.object(r.sys,"stderr",errors),patch.object(r.signal,"signal"), \
     patch.dict(r.os.environ,{},clear=True):
    status=r.main()
assert status==1 and output.getvalue()==b""
assert errors.getvalue()=="resource_conflict: Synthetic internal failure\\n"
print(json.dumps({"internalFailure":True}))
`);
  assert.equal(result.internalFailure, true);
});

test('actual Python startup diagnostics survive real Node framing with fixed enums and explicit recording failure', async () => {
  const result = await fixture(`
store, kernel = lifecycle()
primary = r.RelayError("API socket peer does not match the owned unit","resource_not_allowed")
cleanup = r.RelayError("User manager did not return complete unit properties")
def ready(*args): raise primary
def stop(*args): raise cleanup
r.api_ready, r.stop_owned = ready, stop
save = store.save_startup_failure
def write(value, initial=False):
    if not initial: raise OSError(28,"PRIVATE_IO","/private/path")
    save(value,initial)
store.save_startup_failure = write
try: r.start_job(P,A,{},REQUEST,store)
except r.RelayError as exc: failure = exc
else: raise AssertionError("Expected failure")
output = io.BytesIO()
def dispatch(*args): raise failure
r.load_policy=lambda:P
r.identity=lambda policy:A
r.read_request=lambda stream:REQUEST
r.dispatch=dispatch
with patch.object(r.sys,"platform","linux"), \
     patch.dict(r.__dict__,{"pwd":object(),"fcntl":object()}), \
     patch.object(r.sys,"argv",["builder"]), \
     patch.object(r.sys,"stdout",types.SimpleNamespace(buffer=output)), \
     patch.object(r.sys,"stdin",types.SimpleNamespace(buffer=io.BytesIO())), \
     patch.object(r.signal,"signal"),patch.dict(r.os.environ,{},clear=True), \
     patch.object(r.os,"getuid",return_value=1001,create=True), \
     patch.object(r.os,"geteuid",return_value=1001,create=True):
    status=r.main()
text=output.getvalue().decode()
assert "PRIVATE_IO" not in text and "/private/path" not in text and store.value["nonce"] not in text
print(json.dumps({"status":status,"frame":text,"jobId":JOB,"instanceId":P["instanceId"],
    "stages":sorted(r.STARTUP_STAGES),"codes":sorted(r.DIAGNOSTIC_CODES),"rules":sorted(r.DIAGNOSTIC_RULE_NAMES)}))
`);
  const connection = {
    host: 'fixture.invalid', port: 22, user: 'builder',
    keyFile: '/fixture/key', knownHostsFile: '/fixture/known-hosts',
  };
  let diagnostic;
  await assert.rejects(builderRequest(connection, { action: 'job_start', requestId: 'fixture', jobId: result.jobId }, {
    timeoutMs: 5000,
    spawnProcess(command, args, options) {
      assert.equal(command, '/usr/bin/ssh');
      assert.equal(args.at(-1), 'pw-deploy-builder');
      return spawn(process.execPath, ['-e',
        'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(process.argv[1]);process.exitCode=Number(process.argv[2]);});',
        result.frame, String(result.status)], options);
    },
  }), error => {
    diagnostic = relayStartupFailure(error);
    return error.code === 'process_failed' && error.message === 'Private builder startup failed';
  });
  assert.equal(diagnostic.primary.rule, 'api_peer');
  assert.equal(diagnostic.cleanup.failure.rule, 'manager_incomplete');
  assert.deepEqual(diagnostic.recordingErrors,
    [{ stage: 'diagnostic_final', code: 'os_error', rule: 'os_error', errno: 28 }]);
  for (const [key, values] of [['stage', result.stages], ['code', result.codes], ['rule', result.rules]]) {
    for (const value of values) {
      validateRelayStartupFailure({ ...diagnostic, primary: { ...diagnostic.primary, [key]: value } },
        result.jobId, result.instanceId);
    }
  }
});
