#!/usr/bin/env python3
"""Fixed-action connector for private, cgroup-owned rootless Podman job APIs.

Install this file, root-owned and not writable by the builder account, at
/usr/local/libexec/pw-deploy-builder.py. The fixed SSH command must invoke it
with /usr/bin/python3 -I, without forwarding SSH arguments or environment.
Internal entrypoints use protected metadata, not a second global policy read.
"""
import contextlib
import datetime
import io
import json
import os
import posixpath
import re
import secrets
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

try:
    import fcntl
    import pwd
except ImportError:
    fcntl = None
    pwd = None

DEFAULT_POLICY_FILE = '/etc/pw-deploy-builder-policy.json'
RELAY_BIN = '/usr/local/libexec/pw-deploy-builder.py'
PYTHON_BIN = '/usr/bin/python3'
PODMAN_BIN = '/usr/bin/podman'
SYSTEMCTL_BIN = '/usr/bin/systemctl'
SYSTEMD_RUN_BIN = '/usr/bin/systemd-run'
HEADER_BYTES = 10
MAX_REQUEST_BYTES = 8192
MAX_RESPONSE_BYTES = 8192
MAX_METADATA_BYTES = 16384
MAX_HELPER_OUTPUT_BYTES = 65536
REQUEST_READ_TIMEOUT_SECONDS = 10
COMMAND_TIMEOUT_SECONDS = 10
START_TIMEOUT_SECONDS = 15
STOP_TIMEOUT_SECONDS = 10
LOCK_TIMEOUT_SECONDS = 30
CGROUP_ROOT = '/sys/fs/cgroup'
UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
NONCE_RE = re.compile(r'[0-9a-f]{64}\Z')
REQUEST_ID_RE = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
UNIT_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.service\Z')
USER_RE = re.compile(r'[a-z_][a-z0-9_-]{0,31}\Z')
PATH_RE = re.compile(r'/[A-Za-z0-9_./@-]+\Z')
POLICY_FIELDS = {
    'apiVersion', 'instanceId', 'user', 'controllerUnit', 'stateDir',
    'runtimeDir', 'imageStore', 'maxLifetimeSeconds', 'maxMemoryMiB', 'maxPids',
}
ACTIONS = {'builder_probe', 'job_start', 'job_status', 'job_stop', 'job_remove'}
UNIT_PROPERTIES = (
    'Id', 'LoadState', 'ActiveState', 'SubState', 'Description', 'ControlGroup',
    'MainPID', 'Transient', 'Type', 'KillMode', 'Delegate', 'MemoryMax',
    'TasksMax', 'BindsTo', 'After', 'TimeoutStopUSec', 'RuntimeMaxUSec',
    'StandardOutput', 'StandardError', 'ExecStart', 'Job',
)
TERMINATED = False
STARTUP_DIAGNOSTIC_FILE = 'startup-failure.json'
STARTUP_STAGES = {
    'prepare_paths', 'persist_prepared', 'deadline_create', 'deadline_verify',
    'launch_parameters', 'persist_launch', 'launch', 'persist_launch_result',
    'launch_result', 'startup_deadline', 'unit_query', 'unit_ownership',
    'persist_observation', 'unit_state', 'api_readiness', 'persist_ready',
}
STARTUP_CLEANUP_STAGES = {'pending', 'cancel', 'stop', 'persist_stopped'}
DIAGNOSTIC_CODES = {
    'invalid_request', 'action_not_allowed', 'resource_not_allowed', 'resource_conflict',
    'runtime_policy_invalid', 'process_failed', 'privilege_refused', 'cancelled', 'os_error',
}
DIAGNOSTIC_RULES = {
    'Builder connector was cancelled': 'cancelled',
    'Helper deadline exceeded; manager outcome must be reconciled': 'helper_deadline',
    'Helper output exceeded its limit; manager outcome must be reconciled': 'helper_output',
    'Helper did not exit; manager outcome must be reconciled': 'helper_exit',
    'Helper could not be reaped; resources are retained': 'helper_unreaped',
    'User manager could not be queried': 'manager_query',
    'User manager returned invalid property data': 'manager_encoding',
    'User manager returned unexpected properties': 'manager_properties',
    'User manager did not return complete unit properties': 'manager_incomplete',
    'User manager query failed': 'manager_exit',
    'Unit identity does not match': 'unit_identity',
    'Unloaded unit state is uncertain': 'unit_absence',
    'Refusing a non-owned unit': 'unit_owner',
    'Reserved job unexpectedly has a unit': 'unit_reserved',
    'Owned unit process state is incomplete': 'unit_process',
    'Owned unit confinement properties do not match': 'unit_confinement',
    'Owned unit entrypoint does not match': 'unit_entrypoint',
    'Unrecognized manager duration': 'unit_duration',
    'Start transaction is unresolved; an unloaded unit is not stop proof': 'launch_unresolved',
    'Owned unit has not finished stopping': 'unit_stopping',
    'Owned cgroup still contains processes': 'cgroup_populated',
    'User manager refused the owned unit stop': 'stop_refused',
    'Owned unit stop could not be confirmed; resources are retained': 'stop_unconfirmed',
    'Private API unit could not be started': 'launch_failed',
    'Private API unit disappeared': 'unit_disappeared',
    'Private API unit stopped during startup': 'unit_stopped',
    'Private API readiness timed out': 'api_timeout',
    'API unit is not running': 'api_state',
    'Owned API process disappeared': 'api_gone',
    'Kernel process identity is incomplete': 'api_identity',
    'Bootstrap process escaped its delegated cgroup': 'bootstrap_cgroup',
    'API process escaped its supervisor cgroup': 'api_cgroup',
    'API executable or storage options do not match': 'api_command',
    'API socket has unsafe ownership or mode': 'api_socket',
    'API socket peer does not match the owned unit': 'api_peer',
    'API readiness response timed out': 'api_response_timeout',
    'API readiness response exceeded its limit': 'api_response_size',
    'API readiness did not return bounded HTTP/1.0 JSON': 'api_http',
    'API did not return its host/store identity': 'api_info',
    'API store or rootless cgroup identity does not match': 'api_store',
    'API process changed during readiness': 'api_pid_changed',
    'Metadata write failed': 'metadata_write',
}
DIAGNOSTIC_RULE_NAMES = set(DIAGNOSTIC_RULES.values()) | {'relay_refusal', 'os_error'}


class RelayError(Exception):
    def __init__(self, message, code='process_failed'):
        super().__init__(message)
        self.code = code
        self.rule = DIAGNOSTIC_RULES.get(message, 'relay_refusal') if isinstance(message, str) else 'relay_refusal'


class CommandUncertain(RelayError):
    """A reaped CLI is not proof that its manager-side transaction completed."""


class CommandUnreaped(RelayError):
    """Do not turn a live, uncollected helper into a successful operation."""


class NotReady(RelayError):
    """The exact owned bootstrap is still becoming the API process."""


def fail(message, code='process_failed'):
    raise RelayError(message, code)


def require(condition, message, code='process_failed'):
    if not condition:
        fail(message, code)


def diagnostic_failure(stage, error):
    code = error.code if isinstance(error, RelayError) else 'os_error'
    rule = error.rule if isinstance(error, RelayError) else 'os_error'
    number = error.errno if isinstance(error, OSError) else None
    return {
        'stage': stage,
        'code': code if isinstance(code, str) and code in DIAGNOSTIC_CODES else 'process_failed',
        'rule': rule if isinstance(rule, str) and rule in DIAGNOSTIC_RULE_NAMES else 'relay_refusal',
        'errno': number if type(number) is int and 0 < number <= 4095 else None,
    }


def validate_startup_failure(value, policy, job_id):
    def check(condition):
        require(condition, 'Invalid startup failure diagnostic', 'resource_not_allowed')

    def failure(item, stages):
        check(isinstance(item, dict) and set(item) == {'stage', 'code', 'rule', 'errno'})
        check(isinstance(item['stage'], str) and item['stage'] in stages and
              isinstance(item['code'], str) and item['code'] in DIAGNOSTIC_CODES and
              isinstance(item['rule'], str) and item['rule'] in DIAGNOSTIC_RULE_NAMES)
        check(item['errno'] is None or (type(item['errno']) is int and 0 < item['errno'] <= 4095))

    check(isinstance(value, dict) and set(value) == {
        'version', 'instanceId', 'jobId', 'primary', 'cleanup', 'recordingErrors'})
    check(type(value['version']) is int and value['version'] == 1 and
          value['instanceId'] == policy['instanceId'] and value['jobId'] == job_id)
    failure(value['primary'], STARTUP_STAGES)
    cleanup = value['cleanup']
    check(isinstance(cleanup, dict) and set(cleanup) == {'stage', 'outcome', 'failure'})
    check(isinstance(cleanup['stage'], str) and cleanup['stage'] in STARTUP_CLEANUP_STAGES)
    check(cleanup['outcome'] in ('pending', 'stopped', 'failed'))
    if cleanup['outcome'] == 'failed':
        check(cleanup['stage'] != 'pending')
        failure(cleanup['failure'], {cleanup['stage']})
    else:
        check(cleanup['failure'] is None and cleanup['stage'] ==
              ('pending' if cleanup['outcome'] == 'pending' else 'persist_stopped'))
    check(isinstance(value['recordingErrors'], list) and len(value['recordingErrors']) <= 2)
    seen = set()
    for item in value['recordingErrors']:
        failure(item, {'diagnostic_initial', 'diagnostic_final'})
        check(item['stage'] not in seen)
        seen.add(item['stage'])
    check(len(json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')) <= 4096)
    return value


def check_cancelled():
    require(not TERMINATED, 'Builder connector was cancelled', 'cancelled')


def termination_signal(_signum, _frame):
    global TERMINATED
    TERMINATED = True


def strict_json(data):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate JSON field', 'invalid_request')
            value[key] = item
        return value
    try:
        value = json.loads(data, object_pairs_hook=object_pairs,
                           parse_constant=lambda _: fail('Non-finite JSON number', 'invalid_request'))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        fail('Invalid JSON', 'invalid_request')
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        require(depth <= 16, 'JSON nesting exceeds its limit', 'invalid_request')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return value


def read_exact(stream, size, deadline, fd):
    parts = []
    while size:
        check_cancelled()
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Request timed out', 'invalid_request')
        if fd is None:
            require(isinstance(stream, io.BytesIO), 'Input has no readable descriptor', 'invalid_request')
            chunk = stream.read(size)
        else:
            ready, _, _ = select.select([fd], [], [], remaining)
            require(ready, 'Request timed out', 'invalid_request')
            chunk = os.read(fd, size)
        require(chunk, 'Request was truncated', 'invalid_request')
        parts.append(chunk)
        size -= len(chunk)
    return b''.join(parts)


def read_request(stream):
    deadline = time.monotonic() + REQUEST_READ_TIMEOUT_SECONDS
    try:
        fd = stream.fileno()
    except (AttributeError, OSError, io.UnsupportedOperation):
        fd = None
    header = read_exact(stream, HEADER_BYTES, deadline, fd)
    require(re.fullmatch(rb'[0-9]{10}', header), 'Invalid request framing', 'invalid_request')
    size = int(header)
    require(0 < size <= MAX_REQUEST_BYTES, 'Request size out of bounds', 'invalid_request')
    value = strict_json(read_exact(stream, size, deadline, fd))
    require(isinstance(value, dict), 'Request must be an object', 'invalid_request')
    return value


def write_response(stream, value):
    body = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(body) > MAX_RESPONSE_BYTES:
        body = b'{"ok":false,"code":"process_failed","error":"Response exceeded its limit"}'
    stream.write(str(len(body)).zfill(HEADER_BYTES).encode('ascii') + body)
    stream.flush()


def uuid(value, label, code='invalid_request'):
    require(isinstance(value, str) and UUID_RE.fullmatch(value), 'Invalid ' + label, code)
    return value


def integer(value, minimum, maximum, label, code='invalid_request'):
    require(type(value) is int and minimum <= value <= maximum, 'Invalid ' + label, code)
    return value


def safe_path(value, label, code='runtime_policy_invalid'):
    require(isinstance(value, str) and PATH_RE.fullmatch(value) and
            value == posixpath.normpath(value) and value != '/' and
            not value.startswith('//'), 'Unsafe ' + label, code)
    return value


def validate_policy(policy):
    code = 'runtime_policy_invalid'
    require(isinstance(policy, dict) and set(policy) == POLICY_FIELDS, 'Policy fields do not match the schema', code)
    require(type(policy['apiVersion']) is int and policy['apiVersion'] == 1, 'Unsupported policy version', code)
    uuid(policy['instanceId'], 'instanceId', code)
    require(isinstance(policy['user'], str) and USER_RE.fullmatch(policy['user']) and
            policy['user'] != 'root', 'Policy requires an approved non-root account', code)
    require(isinstance(policy['controllerUnit'], str) and UNIT_RE.fullmatch(policy['controllerUnit']) and
            not policy['controllerUnit'].startswith(('pw-builder-', 'pw-deploy-build-')),
            'Invalid controllerUnit', code)
    for key in ('stateDir', 'runtimeDir', 'imageStore'):
        safe_path(policy[key], key)
    roots = [policy[key] for key in ('stateDir', 'runtimeDir', 'imageStore')]
    for index, root in enumerate(roots):
        for other in roots[index + 1:]:
            require(not (root == other or root.startswith(other + '/') or other.startswith(root + '/')),
                    'Policy storage, runtime and cache roots must be disjoint', code)
    require(len((policy['runtimeDir'] + '/' + '0' * 36 + '/api.sock').encode('utf-8')) < 108,
            'runtimeDir exceeds the AF_UNIX socket path limit', code)
    integer(policy['maxLifetimeSeconds'], 1, 3600, 'maxLifetimeSeconds', code)
    integer(policy['maxMemoryMiB'], 1, 16384, 'maxMemoryMiB', code)
    integer(policy['maxPids'], 1, 2048, 'maxPids', code)
    return dict(policy)


def validate_request(request, policy, now_ms=None):
    require(isinstance(request, dict), 'Request must be an object', 'invalid_request')
    require(isinstance(request.get('requestId'), str) and REQUEST_ID_RE.fullmatch(request['requestId']),
            'Invalid requestId', 'invalid_request')
    action = request.get('action')
    require(isinstance(action, str) and action in ACTIONS, 'Action is not allowed', 'action_not_allowed')
    fields = {'requestId', 'action'}
    if action != 'builder_probe':
        fields.add('jobId')
        uuid(request.get('jobId'), 'jobId')
    if action == 'job_start':
        fields.update(('deadlineAt', 'memoryMiB', 'pids'))
    require(set(request) == fields, 'Request fields do not match the action', 'invalid_request')
    if action == 'job_start':
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        integer(request['deadlineAt'], now_ms + 1, now_ms + policy['maxLifetimeSeconds'] * 1000, 'deadlineAt')
        integer(request['memoryMiB'], 1, policy['maxMemoryMiB'], 'memoryMiB')
        integer(request['pids'], 1, policy['maxPids'], 'pids')
    return action


def check_environment(environment):
    forbidden = ('PODMAN_', 'CONTAINER_', 'CONTAINERS_', 'STORAGE_', 'BUILDAH_',
                 'LD_', 'PYTHON', 'SYSTEMD_', 'DBUS_', 'XDG_', 'PW_DEPLOY_BUILDER_')
    for key in environment:
        if key.startswith(forbidden) and key not in ('XDG_RUNTIME_DIR', 'XDG_SESSION_ID',
                                                    'XDG_SESSION_TYPE', 'XDG_SESSION_CLASS',
                                                    'DBUS_SESSION_BUS_ADDRESS'):
            fail('Caller environment override is not allowed: ' + key, 'privilege_refused')
    if 'SSH_ORIGINAL_COMMAND' in environment:
        require(environment['SSH_ORIGINAL_COMMAND'] == 'pw-deploy-builder',
                'Only the fixed SSH command is allowed', 'action_not_allowed')


def identity(policy):
    require(sys.platform == 'linux' and pwd is not None and fcntl is not None,
            'Builder connector requires Linux, Python 3.9+ and POSIX file locking', 'runtime_policy_invalid')
    require(sys.version_info >= (3, 9), 'Builder connector requires Python 3.9+', 'runtime_policy_invalid')
    require(os.getuid() > 0 and os.geteuid() == os.getuid(),
            'Root or changed effective identity is refused', 'privilege_refused')
    try:
        account = pwd.getpwnam(policy['user'])
    except KeyError:
        fail('Approved builder account does not exist', 'runtime_policy_invalid')
    require(account.pw_uid == os.getuid() and account.pw_gid == os.getgid() and os.getegid() == os.getgid(),
            'Caller does not match the approved builder identity', 'privilege_refused')
    safe_path(account.pw_dir, 'account home')
    return account


def runtime_environment(account):
    runtime = '/run/user/' + str(account.pw_uid)
    return {
        'PATH': '/usr/bin:/bin', 'HOME': account.pw_dir, 'USER': account.pw_name,
        'LOGNAME': account.pw_name, 'LANG': 'C', 'LC_ALL': 'C',
        'XDG_RUNTIME_DIR': runtime,
        'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus',
    }


@contextlib.contextmanager
def directory(path, uid, private=False, root_only=False, ancestors=None):
    """Walk with openat/O_NOFOLLOW; never resolve an untrusted link or '..'."""
    safe_path(path, 'directory', 'resource_not_allowed')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    try:
        parts = path[1:].split('/')
        current = ''
        for index, part in enumerate(parts):
            current += '/' + part
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if ancestors is not None:
                saved = ancestors.get(current)
                require(isinstance(saved, list) and len(saved) == 3 and
                        [info.st_dev, info.st_ino] == saved[:2] and
                        info.st_uid == (0 if saved[2] != 0 else os.stat('/').st_uid),
                        'Namespace ancestor identity changed', 'resource_not_allowed')
            else:
                require(info.st_uid in ({0} if root_only else {0, uid}),
                        'Directory has unsafe ownership', 'resource_not_allowed')
            require(not info.st_mode & 0o022,
                    'Directory has unsafe ownership or permissions', 'resource_not_allowed')
            if private and index == len(parts) - 1:
                require(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700,
                        'Private directory must be owned by the builder with mode 0700', 'resource_not_allowed')
        yield fd
    finally:
        os.close(fd)


def read_json_at(fd, name, uid, private=True):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
    try:
        info = os.fstat(child)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1 and
                not info.st_mode & (0o077 if private else 0o022) and info.st_size <= MAX_METADATA_BYTES,
                'Unsafe metadata or policy file', 'resource_not_allowed')
        data = bytearray()
        while len(data) <= MAX_METADATA_BYTES:
            chunk = os.read(child, MAX_METADATA_BYTES + 1 - len(data))
            if not chunk:
                break
            data.extend(chunk)
        require(len(data) <= MAX_METADATA_BYTES, 'Metadata exceeds its limit', 'resource_not_allowed')
        return strict_json(bytes(data))
    finally:
        os.close(child)


def write_json_at(fd, name, value):
    data = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
    require(len(data) <= MAX_METADATA_BYTES, 'Metadata exceeds its limit')
    temporary = '.write-' + secrets.token_hex(16)
    child = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600, dir_fd=fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(child, view)
            require(written > 0, 'Metadata write failed')
            view = view[written:]
        os.fsync(child)
    finally:
        os.close(child)
    os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)


def ensure_child(fd, name, uid):
    try:
        os.mkdir(name, 0o700, dir_fd=fd)
        os.fsync(fd)
    except FileExistsError:
        pass
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
    info = os.fstat(child)
    if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(child)
        fail('Unsafe private child directory', 'resource_not_allowed')
    return child


def load_policy():
    try:
        with directory('/etc', 0, root_only=True) as fd:
            return validate_policy(read_json_at(fd, posixpath.basename(DEFAULT_POLICY_FILE), 0, private=False))
    except FileNotFoundError:
        fail('Required root-protected builder policy is absent: ' + DEFAULT_POLICY_FILE, 'runtime_policy_invalid')


def trusted_executable(path, depth=0):
    require(depth < 8, 'Executable link chain is too deep', 'runtime_policy_invalid')
    with directory(posixpath.dirname(path), 0, root_only=True) as fd:
        info = os.stat(posixpath.basename(path), dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode) and path != RELAY_BIN:
            require(info.st_uid == 0, 'Executable link is not root-owned', 'runtime_policy_invalid')
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path),
                                                        os.readlink(posixpath.basename(path), dir_fd=fd)))
            trusted_executable(resolved, depth + 1)
            return
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'Connector or executable is not root-protected: ' + path, 'runtime_policy_invalid')
        if path != RELAY_BIN:
            require(info.st_mode & 0o111, 'Required executable is not executable: ' + path, 'runtime_policy_invalid')


def run_command(argv, env, timeout=COMMAND_TIMEOUT_SECONDS, ignore_cancel=False):
    """Bound memory, time and process lifetime without logging command output."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    output = bytearray()
    end = time.monotonic() + timeout
    try:
        while True:
            if not ignore_cancel:
                check_cancelled()
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise CommandUncertain('Helper deadline exceeded; manager outcome must be reconciled')
            ready, _, _ = select.select([process.stdout], [], [], min(remaining, 0.1))
            if ready:
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > MAX_HELPER_OUTPUT_BYTES:
                    raise CommandUncertain('Helper output exceeded its limit; manager outcome must be reconciled')
        try:
            process.wait(timeout=max(0.001, end - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise CommandUncertain('Helper did not exit; manager outcome must be reconciled')
        return subprocess.CompletedProcess(argv, process.returncode, bytes(output))
    finally:
        try:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    raise CommandUnreaped('Helper could not be reaped; resources are retained')
        finally:
            process.stdout.close()


def systemctl(env, *args, ignore_cancel=False):
    return run_command([SYSTEMCTL_BIN, '--user', '--no-pager', *args], env, ignore_cancel=ignore_cancel)


def show_unit(env, unit, properties=UNIT_PROPERTIES):
    result = systemctl(env, 'show', unit, '--property=' + ','.join(properties), ignore_cancel=True)
    require(result.returncode in (0, 1, 4), 'User manager could not be queried')
    values = {}
    try:
        text = result.stdout.decode('utf-8')
    except UnicodeDecodeError:
        fail('User manager returned invalid property data')
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        require(sep and key in properties and key not in values, 'User manager returned unexpected properties')
        values[key] = value
    missing = set(properties) - values.keys()
    # systemctl prints no line for an unloaded unit's empty ExecStart array.
    require(not missing or (properties == UNIT_PROPERTIES and values.get('LoadState') == 'not-found'
                            and missing == {'ExecStart'}),
            'User manager did not return complete unit properties')
    if result.returncode:
        require(values.get('LoadState') == 'not-found', 'User manager query failed')
    return values


def user_cgroup(uid):
    return '/user.slice/user-{0}.slice/user@{0}.service'.format(uid)


def unit_name(policy, job_id):
    return 'pw-deploy-build-' + policy['instanceId'].replace('-', '') + '-' + job_id + '.service'


def expected_cgroup(record):
    return user_cgroup(record['uid']) + '/app.slice/' + record['unit']


def description(record, deadline=False):
    return 'PW builder ' + ('deadline ' if deadline else '') + record['policy']['instanceId'] + ' ' + record['jobId'] + ' ' + record['nonce']


def deadline_unit(record):
    return record['unit'][:-8] + '-deadline.service'


def metadata_path(record):
    return record['policy']['stateDir'] + '/jobs/' + record['jobId']


def work_path(record):
    return record['policy']['stateDir'] + '/work/' + record['jobId']


def job_home(record):
    return work_path(record) + '/home'


def transfer_path(record):
    return work_path(record) + '/transfer'


def runtime_path(record):
    return record['policy']['runtimeDir'] + '/' + record['jobId']


def new_record(policy, account, job_id):
    return {
        'version': 1, 'policy': dict(policy), 'uid': account.pw_uid, 'gid': account.pw_gid,
        'home': account.pw_dir, 'jobId': job_id, 'unit': unit_name(policy, job_id),
        'nonce': secrets.token_hex(32), 'phase': 'reserved', 'deadlineAt': None,
        'memoryMiB': None, 'pids': None, 'apiIdentity': None, 'workIdentity': None,
        'runtimeIdentity': None, 'launchSettled': False, 'observedUnit': False,
        'cleanupAncestors': None, 'cleanupNamespace': None,
    }


RECORD_FIELDS = {
    'version', 'policy', 'uid', 'gid', 'home', 'jobId', 'unit', 'nonce', 'phase',
    'deadlineAt', 'memoryMiB', 'pids', 'apiIdentity', 'workIdentity', 'runtimeIdentity',
    'launchSettled', 'observedUnit', 'cleanupAncestors', 'cleanupNamespace',
}


def validate_record(record, policy=None, job_id=None, nonce=None):
    require(isinstance(record, dict) and set(record) == RECORD_FIELDS and record['version'] == 1,
            'Job metadata schema mismatch', 'resource_not_allowed')
    saved = validate_policy(record['policy'])
    uuid(record['jobId'], 'metadata jobId', 'resource_not_allowed')
    require(record['unit'] == unit_name(saved, record['jobId']) and
            isinstance(record['nonce'], str) and NONCE_RE.fullmatch(record['nonce']),
            'Job metadata identity mismatch', 'resource_not_allowed')
    require(policy is None or saved == policy, 'Job belongs to another policy or instance', 'resource_not_allowed')
    require(job_id is None or record['jobId'] == job_id, 'Job metadata path mismatch', 'resource_not_allowed')
    require(nonce is None or secrets.compare_digest(record['nonce'], nonce), 'Job nonce mismatch', 'resource_not_allowed')
    integer(record['uid'], 1, 2**32 - 2, 'metadata uid', 'resource_not_allowed')
    integer(record['gid'], 1, 2**32 - 2, 'metadata gid', 'resource_not_allowed')
    safe_path(record['home'], 'metadata home', 'resource_not_allowed')
    require(record['phase'] in ('reserved', 'prepared', 'launching', 'running', 'stopped', 'removed'),
            'Unknown job metadata phase', 'resource_not_allowed')
    for key in ('launchSettled', 'observedUnit'):
        require(type(record[key]) is bool, 'Invalid job launch state', 'resource_not_allowed')
    for key in ('workIdentity', 'runtimeIdentity', 'apiIdentity', 'cleanupNamespace'):
        value = record[key]
        require(value is None or (isinstance(value, list) and len(value) == 2 and
                all(type(part) is int and part >= 0 for part in value)), 'Invalid saved identity', 'resource_not_allowed')
    ancestors = record['cleanupAncestors']
    require(ancestors is None or isinstance(ancestors, dict), 'Invalid cleanup ancestry', 'resource_not_allowed')
    if ancestors is not None:
        for path, saved_identity in ancestors.items():
            safe_path(path, 'cleanup ancestor', 'resource_not_allowed')
            require(isinstance(saved_identity, list) and len(saved_identity) == 3 and
                    all(type(part) is int and part >= 0 for part in saved_identity) and
                    saved_identity[2] in (0, record['uid']), 'Invalid cleanup ancestor identity', 'resource_not_allowed')
    if record['deadlineAt'] is not None:
        integer(record['deadlineAt'], 1, 2**53 - 1, 'metadata deadline', 'resource_not_allowed')
        integer(record['memoryMiB'], 1, saved['maxMemoryMiB'], 'metadata memory', 'resource_not_allowed')
        integer(record['pids'], 1, saved['maxPids'], 'metadata pids', 'resource_not_allowed')
    else:
        require(record['memoryMiB'] is None and record['pids'] is None and record['phase'] in ('reserved', 'stopped', 'removed'),
                'Incomplete job metadata', 'resource_not_allowed')
    return record


class JobStore:
    def __init__(self, policy, account, job_id):
        self.policy, self.account, self.job_id = policy, account, job_id
        self.path = policy['stateDir'] + '/jobs/' + job_id

    def reserve(self):
        with directory(self.policy['stateDir'], self.account.pw_uid, private=True) as parent:
            jobs = ensure_child(parent, 'jobs', self.account.pw_uid)
            try:
                child = ensure_child(jobs, self.job_id, self.account.pw_uid)
                os.close(child)
            finally:
                os.close(jobs)

    @contextlib.contextmanager
    def locked(self):
        with directory(self.path, self.account.pw_uid, private=True) as fd:
            lock = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
            try:
                info = os.fstat(lock)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == self.account.pw_uid and
                        info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600,
                        'Unsafe job lock', 'resource_not_allowed')
                end = time.monotonic() + LOCK_TIMEOUT_SECONDS
                while True:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        require(time.monotonic() < end, 'Job operation remains in progress; resources are retained', 'resource_conflict')
                        time.sleep(0.05)
                yield self
            finally:
                os.close(lock)

    def load(self, missing=False):
        try:
            with directory(self.path, self.account.pw_uid, private=True) as fd:
                record = read_json_at(fd, 'job.json', self.account.pw_uid)
        except FileNotFoundError:
            require(missing, 'Job metadata does not exist', 'resource_conflict')
            return None
        record = validate_record(record, self.policy, self.job_id)
        require(record['uid'] == self.account.pw_uid and record['gid'] == self.account.pw_gid and
                record['home'] == self.account.pw_dir, 'Job account identity changed', 'resource_not_allowed')
        return record

    def save(self, record):
        validate_record(record, self.policy, self.job_id)
        with directory(self.path, self.account.pw_uid, private=True) as fd:
            write_json_at(fd, 'job.json', record)

    def save_startup_failure(self, value, initial=False):
        validate_startup_failure(value, self.policy, self.job_id)
        with directory(self.path, self.account.pw_uid, private=True) as fd:
            try:
                previous = read_json_at(fd, STARTUP_DIAGNOSTIC_FILE, self.account.pw_uid)
            except FileNotFoundError:
                previous = None
            if previous is not None:
                validate_startup_failure(previous, self.policy, self.job_id)
                require(not initial and previous['primary'] == value['primary'],
                        'Startup diagnostic identity changed', 'resource_conflict')
            write_json_at(fd, STARTUP_DIAGNOSTIC_FILE, value)

    def cancel(self):
        with directory(self.path, self.account.pw_uid, private=True) as fd:
            try:
                marker = os.open('cancelled', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 0o600, dir_fd=fd)
            except FileExistsError:
                require(self.cancelled(), 'Cancellation marker is invalid', 'resource_not_allowed')
                return
            try:
                os.fsync(marker)
            finally:
                os.close(marker)
            os.fsync(fd)

    def cancelled(self):
        with directory(self.path, self.account.pw_uid, private=True) as fd:
            try:
                info = os.stat('cancelled', dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return False
            require(stat.S_ISREG(info.st_mode) and info.st_uid == self.account.pw_uid and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0 and info.st_nlink == 1,
                    'Unsafe cancellation marker', 'resource_not_allowed')
            return True

    def prepare_paths(self, record):
        for kind in ('work', 'runtime'):
            parent_path = self.policy['stateDir'] if kind == 'work' else self.policy['runtimeDir']
            with directory(parent_path, self.account.pw_uid, private=True) as parent:
                if kind == 'work':
                    child_parent = ensure_child(parent, 'work', self.account.pw_uid)
                else:
                    child_parent = os.dup(parent)
                try:
                    os.mkdir(self.job_id, 0o700, dir_fd=child_parent)
                    child = os.open(self.job_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                    dir_fd=child_parent)
                    try:
                        info = os.fstat(child)
                        record[kind + 'Identity'] = [info.st_dev, info.st_ino]
                        write_json_at(child, '.pw-builder-owner', {
                            'instanceId': self.policy['instanceId'], 'jobId': self.job_id, 'nonce': record['nonce'],
                        })
                    finally:
                        os.close(child)
                    os.fsync(child_parent)
                    self.save(record)
                finally:
                    os.close(child_parent)
        prepare_job_home(record)
        prepare_job_transfer(record)


def prepare_job_transfer(record):
    with directory(work_path(record), record['uid'], private=True) as work:
        os.mkdir('transfer', 0o700, dir_fd=work)
        os.fsync(work)


def validate_empty_mounts_file(fd, uid):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1 and
            stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0,
            'Private job mounts.conf must be an owned, empty, mode-0600 regular file', 'resource_not_allowed')


def prepare_job_home(record):
    with directory(work_path(record), record['uid'], private=True) as work:
        with contextlib.ExitStack() as stack:
            parent = work
            for name in ('home', '.config', 'containers'):
                parent = ensure_child(parent, name, record['uid'])
                stack.callback(os.close, parent)
            # An existing empty rootless override disables vendor automatic
            # host mounts without reading or changing the vendor configuration.
            fd = os.open('mounts.conf', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=parent)
            try:
                validate_empty_mounts_file(fd, record['uid'])
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)


def validate_job_home(record):
    with directory(job_home(record) + '/.config/containers', record['uid'], private=True) as parent:
        fd = os.open('mounts.conf', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        try:
            validate_empty_mounts_file(fd, record['uid'])
        finally:
            os.close(fd)


def proc_identity(pid):
    integer(pid, 1, 2**31 - 1, 'process ID', 'process_failed')
    try:
        with open('/proc/{}/stat'.format(pid), 'r', encoding='ascii') as stream:
            data = stream.read(8192)
    except FileNotFoundError:
        fail('Owned API process disappeared')
    tail = data.rpartition(') ')[2].split()
    require(len(tail) >= 20 and tail[19].isdigit(), 'Kernel process identity is incomplete')
    return [pid, int(tail[19])]


def process_cgroup(pid):
    with open('/proc/{}/cgroup'.format(pid), 'r', encoding='ascii') as stream:
        lines = stream.read(8192).splitlines()
    require(len(lines) == 1 and lines[0].startswith('0::/'), 'Unified cgroup v2 is required', 'runtime_policy_invalid')
    return lines[0][3:]


def cgroup_populated(record, cleanup=False):
    path = CGROUP_ROOT + expected_cgroup(record)
    try:
        with directory(path, 0 if cleanup else record['uid'],
                       ancestors=record['cleanupAncestors'] if cleanup else None) as fd:
            child = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                data = os.read(child, 4096).decode('ascii')
            finally:
                os.close(child)
    except FileNotFoundError:
        return False
    pairs = {}
    for line in data.splitlines():
        parts = line.split()
        require(len(parts) == 2 and parts[0] not in pairs, 'Kernel cgroup event data is malformed')
        pairs[parts[0]] = parts[1]
    require(pairs.get('populated') in ('0', '1'), 'Kernel did not provide cgroup population state')
    return pairs['populated'] == '1'


def duration_seconds(value):
    if value == 'infinity':
        return float('inf')
    units = {'us': 0.000001, 'ms': 0.001, 's': 1, 'min': 60, 'h': 3600}
    parts = re.findall(r'([0-9]+(?:\.[0-9]+)?)(us|ms|min|s|h)', value)
    require(parts and ''.join(number + unit for number, unit in parts) == value.replace(' ', ''),
            'Unrecognized manager duration')
    return sum(float(number) * units[unit] for number, unit in parts)


def owned_unit(record, properties):
    require(properties['Id'] == record['unit'], 'Unit identity does not match', 'resource_not_allowed')
    if properties['LoadState'] == 'not-found':
        require(properties['ActiveState'] == 'inactive' and properties['MainPID'] == '0' and
                properties['ControlGroup'] == '' and properties['Job'] in ('', '0'),
                'Unloaded unit state is uncertain')
        return False
    require(properties['LoadState'] == 'loaded' and properties['Transient'] == 'yes' and
            properties['Description'] == description(record),
            'Refusing a non-owned unit', 'resource_not_allowed')
    require(record['deadlineAt'] is not None, 'Reserved job unexpectedly has a unit', 'resource_not_allowed')
    require(properties['MainPID'].isdigit() and properties['ActiveState'] in
            ('active', 'activating', 'deactivating', 'inactive', 'failed'),
            'Owned unit process state is incomplete')
    require(properties['ControlGroup'] in ('', expected_cgroup(record)) and
            properties['Type'] == 'exec' and properties['KillMode'] == 'control-group' and
            properties['Delegate'] == 'yes' and properties['MemoryMax'] == str(record['memoryMiB'] * 1048576) and
            properties['TasksMax'] == str(record['pids']) and
            record['policy']['controllerUnit'] in properties['BindsTo'].split() and
            record['policy']['controllerUnit'] in properties['After'].split() and
            properties['StandardOutput'] == 'null' and properties['StandardError'] == 'null' and
            duration_seconds(properties['TimeoutStopUSec']) == 3 and
            0 < duration_seconds(properties['RuntimeMaxUSec']) <= record['policy']['maxLifetimeSeconds'],
            'Owned unit confinement properties do not match', 'resource_not_allowed')
    argv = ' '.join([PYTHON_BIN, '-I', RELAY_BIN, '--unit-entry', metadata_path(record), record['nonce']])
    require(('argv[]=' + argv + ' ;') in properties['ExecStart'],
            'Owned unit entrypoint does not match', 'resource_not_allowed')
    return True


def prove_stopped(record, env):
    properties = show_unit(env, record['unit'])
    present = owned_unit(record, properties)
    if not present:
        require(record['launchSettled'] or record['observedUnit'] or record['phase'] in ('reserved', 'prepared', 'stopped', 'removed'),
                'Start transaction is unresolved; an unloaded unit is not stop proof')
    if present:
        require(properties['ActiveState'] in ('inactive', 'failed') and properties['MainPID'] == '0' and
                properties['Job'] in ('', '0'), 'Owned unit has not finished stopping')
    require(not cgroup_populated(record), 'Owned cgroup still contains processes')
    return True


@contextlib.contextmanager
def prerequisite_directory(label, path, uid, private=False):
    try:
        with directory(path, uid, private=private) as fd:
            yield fd
    except (FileNotFoundError, PermissionError):
        fail(label + ' is missing or inaccessible: ' + path, 'runtime_policy_invalid')


def prerequisites(policy, account, env):
    for path in (PYTHON_BIN, PODMAN_BIN, SYSTEMCTL_BIN, SYSTEMD_RUN_BIN, RELAY_BIN):
        try:
            trusted_executable(path)
        except (FileNotFoundError, PermissionError):
            fail('Required root-protected host executable is missing or inaccessible: ' + path, 'runtime_policy_invalid')
    for key in ('stateDir', 'runtimeDir', 'imageStore'):
        with prerequisite_directory('Approved ' + key, policy[key], account.pw_uid, private=key != 'imageStore'):
            pass
    with prerequisite_directory('User runtime directory or manager bus', '/run/user/' + str(account.pw_uid),
                                account.pw_uid, private=True) as fd:
        bus = os.stat('bus', dir_fd=fd, follow_symlinks=False)
        require(stat.S_ISSOCK(bus.st_mode) and bus.st_uid == account.pw_uid,
                'Approved account has no owned user-manager bus', 'runtime_policy_invalid')
    with prerequisite_directory('Delegated cgroup v2 user manager', CGROUP_ROOT + user_cgroup(account.pw_uid),
                                account.pw_uid) as fd:
        child = os.open('cgroup.controllers', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            controllers = os.read(child, 4096).decode('ascii').split()
        finally:
            os.close(child)
    require({'memory', 'pids'} <= set(controllers),
            'User manager requires delegated cgroup v2 memory and pids controllers', 'runtime_policy_invalid')
    controller = show_unit(env, policy['controllerUnit'], ('Id', 'LoadState', 'ActiveState', 'MainPID', 'ControlGroup'))
    require(controller['Id'] == policy['controllerUnit'] and controller['LoadState'] == 'loaded' and
            controller['ActiveState'] in ('active', 'activating') and controller['MainPID'].isdigit() and
            int(controller['MainPID']) > 0 and controller['ControlGroup'].startswith(user_cgroup(account.pw_uid) + '/'),
            'Configured controller must already be active or activating with a MainPID', 'runtime_policy_invalid')
    require(process_cgroup(int(controller['MainPID'])).startswith(controller['ControlGroup'] + '/') or
            process_cgroup(int(controller['MainPID'])) == controller['ControlGroup'],
            'Controller kernel cgroup identity does not match', 'runtime_policy_invalid')


def api_argv(record):
    return [
        PODMAN_BIN, '--remote=false', '--root', work_path(record) + '/graph',
        '--runroot', runtime_path(record) + '/r', '--tmpdir', runtime_path(record) + '/t',
        '--storage-opt=additionalimagestore=' + record['policy']['imageStore'],
        '--cgroup-manager=cgroupfs', 'system', 'service', '--time=0',
        'unix://' + runtime_path(record) + '/api.sock',
    ]


def service_argv(record, now_ms=None):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    remaining = record['deadlineAt'] - now_ms
    require(remaining > 0, 'Job deadline has elapsed', 'cancelled')
    properties = [
        'Type=exec', 'Slice=app.slice', 'Delegate=yes', 'KillMode=control-group',
        'TimeoutStartSec=10s', 'TimeoutStopSec=3s', 'RuntimeMaxSec={:.3f}s'.format(remaining / 1000),
        'MemoryMax=' + str(record['memoryMiB'] * 1048576), 'TasksMax=' + str(record['pids']),
        'NoNewPrivileges=no', 'Restart=no', 'StandardOutput=null', 'StandardError=null',
        'UMask=0077', 'BindsTo=' + record['policy']['controllerUnit'],
        'After=' + record['policy']['controllerUnit'], 'Description=' + description(record),
        'WorkingDirectory=' + work_path(record),
        'Environment=HOME=' + job_home(record) + ' XDG_CONFIG_HOME=' + job_home(record) + '/.config' +
        ' XDG_RUNTIME_DIR=' + runtime_path(record) +
        ' TMPDIR=' + transfer_path(record) +
        ' PATH=/usr/bin:/bin LANG=C LC_ALL=C',
    ]
    return [SYSTEMD_RUN_BIN, '--user', '--quiet', '--unit=' + record['unit'],
            *['--property=' + item for item in properties], '--',
            PYTHON_BIN, '-I', RELAY_BIN, '--unit-entry', metadata_path(record), record['nonce']]


def deadline_argv(record):
    instant = datetime.datetime.fromtimestamp(record['deadlineAt'] / 1000, datetime.timezone.utc)
    calendar = instant.strftime('%Y-%m-%d %H:%M:%S.') + '{:03d}'.format(record['deadlineAt'] % 1000) + ' UTC'
    return [
        SYSTEMD_RUN_BIN, '--user', '--quiet', '--unit=' + deadline_unit(record),
        '--on-calendar=' + calendar, '--timer-property=AccuracySec=1us',
        '--timer-property=RandomizedDelaySec=0', '--timer-property=RemainAfterElapse=yes',
        '--timer-property=Description=' + description(record, True),
        '--property=Description=' + description(record, True),
        '--property=Type=oneshot', '--property=TimeoutStartSec=30s', '--property=TimeoutStopSec=3s',
        '--property=StandardOutput=null', '--property=StandardError=null',
        '--property=NoNewPrivileges=yes', '--property=UMask=0077', '--',
        PYTHON_BIN, '-I', RELAY_BIN, '--deadline-entry', metadata_path(record), record['nonce'],
    ]


def check_deadline_timer(record, env):
    timer = deadline_unit(record)[:-8] + '.timer'
    properties = show_unit(env, timer, ('Id', 'LoadState', 'ActiveState', 'Description', 'Transient', 'Unit'))
    require(properties == {'Id': timer, 'LoadState': 'loaded', 'ActiveState': 'active',
                           'Description': description(record, True), 'Transient': 'yes',
                           'Unit': deadline_unit(record)},
            'Independent deadline timer is not armed with the owned identity')


def api_ready(record, properties):
    if properties['ActiveState'] == 'activating':
        raise NotReady('Owned unit is still activating')
    require(properties['ActiveState'] == 'active' and properties['SubState'] == 'running' and
            properties['ControlGroup'] == expected_cgroup(record) and properties['MainPID'].isdigit() and
            int(properties['MainPID']) > 0, 'API unit is not running')
    pid = int(properties['MainPID'])
    identity_value = proc_identity(pid)
    cgroup = process_cgroup(pid)
    with open('/proc/{}/cmdline'.format(pid), 'rb') as stream:
        command = stream.read(MAX_HELPER_OUTPUT_BYTES)
    entry = [PYTHON_BIN, '-I', RELAY_BIN, '--unit-entry', metadata_path(record), record['nonce']]
    if command == b'\0'.join(item.encode('utf-8') for item in entry) + b'\0':
        require(cgroup in (expected_cgroup(record), expected_cgroup(record) + '/supervisor'),
                'Bootstrap process escaped its delegated cgroup', 'resource_not_allowed')
        raise NotReady('Owned bootstrap has not executed the API yet')
    require(cgroup == expected_cgroup(record) + '/supervisor',
            'API process escaped its supervisor cgroup', 'resource_not_allowed')
    require(command == b'\0'.join(item.encode('utf-8') for item in api_argv(record)) + b'\0',
            'API executable or storage options do not match', 'resource_not_allowed')
    path = runtime_path(record) + '/api.sock'
    with directory(runtime_path(record), record['uid'], private=True) as fd:
        info = os.stat('api.sock', dir_fd=fd, follow_symlinks=False)
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == record['uid'] and not info.st_mode & 0o077,
                'API socket has unsafe ownership or mode', 'resource_not_allowed')
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(1)
        connection.connect(path)
        peer_pid, peer_uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(peer_pid == pid and peer_uid == record['uid'], 'API socket peer does not match the owned unit', 'resource_not_allowed')
        connection.sendall(b'GET /v1.0.0/libpod/info HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n')
        end = time.monotonic() + 2
        data = bytearray()
        while True:
            connection.settimeout(max(0.001, end - time.monotonic()))
            require(time.monotonic() < end, 'API readiness response timed out')
            chunk = connection.recv(8192)
            if not chunk:
                break
            data.extend(chunk)
            require(len(data) <= MAX_HELPER_OUTPUT_BYTES, 'API readiness response exceeded its limit')
    finally:
        connection.close()
    header, separator, body = bytes(data).partition(b'\r\n\r\n')
    require(separator and header.split(b'\r\n', 1)[0] in (b'HTTP/1.0 200 OK', b'HTTP/1.1 200 OK') and
            b'transfer-encoding:' not in header.lower(), 'API readiness did not return bounded HTTP/1.0 JSON')
    value = strict_json(body)
    require(isinstance(value, dict) and isinstance(value.get('store'), dict) and isinstance(value.get('host'), dict),
            'API did not return its host/store identity')
    store, host = value['store'], value['host']
    require(store.get('graphRoot') == work_path(record) + '/graph' and store.get('runRoot') == runtime_path(record) + '/r' and
            store.get('imageCopyTmpDir') == transfer_path(record) and
            host.get('cgroupManager') == 'cgroupfs' and host.get('cgroupVersion') == 'v2' and
            isinstance(host.get('security'), dict) and host['security'].get('rootless') is True,
            'API store or rootless cgroup identity does not match', 'resource_not_allowed')
    require(proc_identity(pid) == identity_value, 'API process changed during readiness')
    return identity_value


def stop_owned(record, env):
    properties = show_unit(env, record['unit'])
    if owned_unit(record, properties):
        record['observedUnit'] = True
        try:
            result = systemctl(env, 'stop', '--no-block', record['unit'], ignore_cancel=True)
        except CommandUncertain:
            # The CLI was reaped, but its manager-side transaction may still
            # finish. Only the following unit/kernel proof can resolve it.
            result = None
        if result is not None:
            require(result.returncode == 0, 'User manager refused the owned unit stop')
    end = time.monotonic() + STOP_TIMEOUT_SECONDS
    while True:
        properties = show_unit(env, record['unit'])
        present = owned_unit(record, properties)
        if ((not present) or (properties['ActiveState'] in ('inactive', 'failed') and
                              properties['MainPID'] == '0' and properties['Job'] in ('', '0'))):
            if not cgroup_populated(record):
                return prove_stopped(record, env)
        require(time.monotonic() < end, 'Owned unit stop could not be confirmed; resources are retained')
        time.sleep(0.05)


def start_job(policy, account, env, request, store):
    with store.locked():
        require(store.load(missing=True) is None, 'Job ID has already been reserved and cannot be replayed', 'resource_conflict')
        require(not store.cancelled(), 'Job was cancelled before start', 'cancelled')
        record = new_record(policy, account, request['jobId'])
        for key in ('deadlineAt', 'memoryMiB', 'pids'):
            record[key] = request[key]
        store.save(record)
        stage = 'prepare_paths'
        try:
            store.prepare_paths(record)
            record['phase'] = 'prepared'
            stage = 'persist_prepared'
            store.save(record)
            require(not store.cancelled(), 'Job was cancelled', 'cancelled')
            check_cancelled()
            stage = 'deadline_create'
            result = run_command(deadline_argv(record), env)
            require(result.returncode == 0, 'Independent deadline timer could not be created')
            stage = 'deadline_verify'
            check_deadline_timer(record, env)
            require(not store.cancelled(), 'Job was cancelled', 'cancelled')
            stage = 'launch_parameters'
            argv = service_argv(record)
            record['phase'] = 'launching'
            stage = 'persist_launch'
            store.save(record)
            stage = 'launch'
            result = run_command(argv, env)
            record['launchSettled'] = True
            stage = 'persist_launch_result'
            store.save(record)
            stage = 'launch_result'
            require(result.returncode == 0, 'Private API unit could not be started')
            end = min(time.monotonic() + START_TIMEOUT_SECONDS,
                      time.monotonic() + max(0, (record['deadlineAt'] - time.time() * 1000) / 1000))
            while True:
                stage = 'startup_deadline'
                check_cancelled()
                require(not store.cancelled() and time.time() * 1000 < record['deadlineAt'], 'Job was cancelled or expired', 'cancelled')
                stage = 'unit_query'
                properties = show_unit(env, record['unit'])
                stage = 'unit_ownership'
                require(owned_unit(record, properties), 'Private API unit disappeared')
                record['observedUnit'] = True
                stage = 'persist_observation'
                store.save(record)
                stage = 'unit_state'
                require(properties['ActiveState'] not in ('failed', 'inactive', 'deactivating'), 'Private API unit stopped during startup')
                stage = 'api_readiness'
                try:
                    api_identity = api_ready(record, properties)
                    break
                except (NotReady, FileNotFoundError, ConnectionRefusedError, socket.timeout):
                    require(time.monotonic() < end, 'Private API readiness timed out')
                    time.sleep(0.05)
            stage = 'startup_deadline'
            require(not store.cancelled() and time.time() * 1000 < record['deadlineAt'], 'Job was cancelled or expired', 'cancelled')
            record['apiIdentity'] = api_identity
            record['phase'] = 'running'
            stage = 'persist_ready'
            store.save(record)
            return {'instanceId': policy['instanceId'], 'jobId': record['jobId'], 'unit': record['unit'],
                    'socketDirectory': record['jobId'], 'cgroupParent': expected_cgroup(record) + '/payload',
                    'deadlineAt': record['deadlineAt'], 'running': True}
        except (RelayError, OSError) as primary:
            diagnostic = {
                'version': 1, 'instanceId': policy['instanceId'], 'jobId': record['jobId'],
                'primary': diagnostic_failure(stage, primary),
                'cleanup': {'stage': 'pending', 'outcome': 'pending', 'failure': None},
                'recordingErrors': [],
            }
            try:
                store.save_startup_failure(diagnostic, initial=True)
            except (RelayError, OSError) as recording_error:
                diagnostic['recordingErrors'].append(diagnostic_failure('diagnostic_initial', recording_error))
            selected = primary
            cleanup_stage = 'cancel'
            try:
                store.cancel()
                cleanup_stage = 'stop'
                stop_owned(record, env)
                cleanup_stage = 'persist_stopped'
                record['phase'] = 'stopped'
                store.save(record)
                diagnostic['cleanup'] = {'stage': cleanup_stage, 'outcome': 'stopped', 'failure': None}
            except (RelayError, OSError) as cleanup_error:
                selected = cleanup_error
                diagnostic['cleanup'] = {
                    'stage': cleanup_stage, 'outcome': 'failed',
                    'failure': diagnostic_failure(cleanup_stage, cleanup_error),
                }
            try:
                store.save_startup_failure(diagnostic)
            except (RelayError, OSError) as recording_error:
                diagnostic['recordingErrors'].append(diagnostic_failure('diagnostic_final', recording_error))
            selected.startup_failure = diagnostic
            if selected is primary:
                raise
            raise selected from primary


def status_job(policy, env, store):
    with store.locked():
        record = store.load()
        properties = show_unit(env, record['unit'])
        present = owned_unit(record, properties)
        running = present and properties['ActiveState'] == 'active' and properties['SubState'] == 'running'
        if running:
            require(record['phase'] == 'running' and record['apiIdentity'] == proc_identity(int(properties['MainPID'])) and
                    process_cgroup(int(properties['MainPID'])) == expected_cgroup(record) + '/supervisor' and
                    not store.cancelled() and time.time() * 1000 < record['deadlineAt'],
                    'Job is starting, cancelling, expired, or has an uncertain API identity', 'resource_conflict')
            stopped = False
        else:
            stopped = prove_stopped(record, env)
        return {'instanceId': policy['instanceId'], 'jobId': record['jobId'], 'unit': record['unit'],
                'running': running, 'stopped': stopped}


def stop_job(policy, account, env, store, remove=False):
    store.cancel()
    with store.locked():
        record = store.load(missing=True)
        if record is None:
            record = new_record(policy, account, store.job_id)
            store.save(record)
        stop_owned(record, env)
        if record['phase'] != 'removed':
            record['phase'] = 'stopped'
            store.save(record)
        if remove and record['phase'] != 'removed':
            cleanup_job(record, env, store)
            record['phase'] = 'removed'
            store.save(record)
        result = {'instanceId': policy['instanceId'], 'jobId': record['jobId'], 'stopped': True}
        if remove:
            result['removed'] = True
        return result


def dispatch(policy, account, env, request):
    action = validate_request(request, policy)
    if action in ('builder_probe', 'job_start'):
        prerequisites(policy, account, env)
    if action == 'builder_probe':
        return {'instanceId': policy['instanceId'], 'ready': True}
    store = JobStore(policy, account, request['jobId'])
    if action != 'job_status':
        store.reserve()
    if action == 'job_start':
        return start_job(policy, account, env, request, store)
    if action == 'job_status':
        return status_job(policy, env, store)
    return stop_job(policy, account, env, store, remove=action == 'job_remove')


def load_internal(path, nonce, cleanup=False):
    safe_path(path, 'internal metadata path', 'resource_not_allowed')
    require(NONCE_RE.fullmatch(nonce), 'Invalid internal nonce', 'resource_not_allowed')
    owner = 0 if cleanup else os.getuid()
    require(cleanup or owner > 0, 'Root execution is refused', 'privilege_refused')
    if cleanup:
        record = read_namespace_record(path, nonce)
    else:
        with directory(path, owner, private=True) as fd:
            record = validate_record(read_json_at(fd, 'job.json', owner), nonce=nonce)
    require(path == metadata_path(record), 'Internal metadata path does not match', 'resource_not_allowed')
    if cleanup:
        validate_uid_map(record['uid'], record['gid'])
        require(os.getuid() == 0 and os.geteuid() == 0, 'Cleanup must run in the normal rootless user namespace', 'privilege_refused')
        account = type('Account', (), {'pw_uid': 0, 'pw_gid': 0, 'pw_dir': record['home'], 'pw_name': record['policy']['user']})()
    else:
        account = identity(record['policy'])
        require(record['uid'] == account.pw_uid and record['gid'] == account.pw_gid and
                record['home'] == account.pw_dir, 'Internal account identity changed', 'privilege_refused')
    return record, account


def bootstrap(record, account, store):
    check_cancelled()
    require(record['phase'] == 'launching' and not store.cancelled() and time.time() * 1000 < record['deadlineAt'],
            'Job entry was cancelled, replayed or expired', 'cancelled')
    require(process_cgroup('self') == expected_cgroup(record), 'Job entry is not in its exact delegated unit', 'privilege_refused')
    validate_job_home(record)
    with directory(transfer_path(record), record['uid'], private=True):
        pass
    with directory(CGROUP_ROOT + expected_cgroup(record), record['uid']) as fd:
        os.mkdir('supervisor', 0o755, dir_fd=fd)
        child = os.open('supervisor', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            procs = os.open('cgroup.procs', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=child)
            try:
                os.write(procs, str(os.getpid()).encode('ascii'))
            finally:
                os.close(procs)
        finally:
            os.close(child)
        controls = os.open('cgroup.subtree_control', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            os.write(controls, b'+memory +pids')
        finally:
            os.close(controls)
        os.mkdir('payload', 0o755, dir_fd=fd)
    require(process_cgroup('self') == expected_cgroup(record) + '/supervisor', 'Supervisor cgroup move failed')
    require(not store.cancelled() and time.time() * 1000 < record['deadlineAt'], 'Job entry was cancelled or expired', 'cancelled')
    check_cancelled()
    env = runtime_environment(account)
    env['HOME'] = job_home(record)
    env['XDG_CONFIG_HOME'] = job_home(record) + '/.config'
    env['XDG_RUNTIME_DIR'] = runtime_path(record)
    env['TMPDIR'] = transfer_path(record)
    os.umask(0o077)
    os.execve(PODMAN_BIN, api_argv(record), env)


def validate_mapping(text, expected, label):
    rows = []
    for line in text.splitlines():
        require(re.fullmatch(r'\s*\d+\s+\d+\s+\d+\s*', line), 'Malformed ' + label, 'privilege_refused')
        inside, outside, count = map(int, line.split())
        require(count > 0 and outside > 0, label + ' must never map host root', 'privilege_refused')
        rows.append((inside, outside, count))
    require(rows and rows[0] == (0, expected, 1), label + ' does not bind namespace root to the approved account', 'privilege_refused')
    for index, (inside, outside, count) in enumerate(rows):
        for other_in, other_out, other_count in rows[index + 1:]:
            require(inside + count <= other_in or other_in + other_count <= inside, 'Overlapping ' + label, 'privilege_refused')
            require(outside + count <= other_out or other_out + other_count <= outside, 'Overlapping ' + label, 'privilege_refused')


def validate_uid_map(uid, gid):
    for name, expected in (('uid_map', uid), ('gid_map', gid)):
        with open('/proc/self/' + name, 'r', encoding='ascii') as stream:
            validate_mapping(stream.read(8192), expected, name)


def remove_tree_at(parent, name, expected_identity, owner_marker=False, deadline=None, depth=0):
    """Delete through directory FDs; never follow links or cross mount devices."""
    deadline = time.monotonic() + 30 if deadline is None else deadline
    require(time.monotonic() < deadline and depth < 128,
            'Cleanup time or depth limit reached; remaining resources are retained')
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        info = os.fstat(fd)
        require([info.st_dev, info.st_ino] == expected_identity,
                'Cleanup directory identity changed', 'resource_not_allowed')
        expected_device = info.st_dev
        with os.scandir(fd) as entries:
            for item in entries:
                require(time.monotonic() < deadline, 'Cleanup deadline reached; remaining resources are retained')
                entry = item.name
                if owner_marker and entry == '.pw-builder-owner':
                    continue
                info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
                require(info.st_dev == expected_device, 'Cleanup refuses a mounted or foreign filesystem', 'resource_not_allowed')
                if stat.S_ISDIR(info.st_mode):
                    remove_tree_at(fd, entry, [info.st_dev, info.st_ino], deadline=deadline, depth=depth + 1)
                else:
                    # Image-layer links and whiteout devices are unlinked, not
                    # opened or followed. Only the identity-bound tree is touched.
                    os.unlink(entry, dir_fd=fd)
        require(os.stat(name, dir_fd=parent, follow_symlinks=False).st_ino == os.fstat(fd).st_ino,
                'Cleanup directory identity changed', 'resource_not_allowed')
        if owner_marker:
            os.unlink('.pw-builder-owner', dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)
    os.fsync(parent)


def remove_job_path(record, kind, owner):
    path = work_path(record) if kind == 'work' else runtime_path(record)
    saved_identity = record[kind + 'Identity']
    if saved_identity is None:
        require(not os.path.lexists(path), 'Unbound job directory exists; cleanup refused', 'resource_not_allowed')
        return
    with directory(posixpath.dirname(path), owner, private=True,
                   ancestors=record['cleanupAncestors'] if owner == 0 else None) as parent:
        try:
            fd = os.open(record['jobId'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            info = os.fstat(fd)
            require(info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o700 and
                    [info.st_dev, info.st_ino] == saved_identity, 'Job directory identity changed', 'resource_not_allowed')
            marker = read_json_at(fd, '.pw-builder-owner', owner)
            require(marker == {'instanceId': record['policy']['instanceId'], 'jobId': record['jobId'], 'nonce': record['nonce']},
                    'Job directory nonce does not match', 'resource_not_allowed')
        finally:
            os.close(fd)
        remove_tree_at(parent, record['jobId'], saved_identity, owner_marker=True)


def mount_paths():
    with open('/proc/self/mountinfo', 'r', encoding='utf-8') as stream:
        lines = stream.read(1024 * 1024 + 1)
    require(len(lines) <= 1024 * 1024, 'Mount table exceeds the cleanup inspection limit')
    result = []
    for line in lines.splitlines():
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields, 'Kernel mount table is malformed')
        result.append(re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4]))
    return result


def refuse_job_mounts(record):
    for mount in mount_paths():
        for path in (work_path(record), runtime_path(record)):
            require(mount != path and not mount.startswith(path + '/'),
                    'Job storage still contains a mount; resources are retained', 'resource_not_allowed')


def capture_cleanup_ancestors(record):
    ancestors = {}
    roots = [metadata_path(record), posixpath.dirname(work_path(record)), record['policy']['runtimeDir'],
             CGROUP_ROOT + expected_cgroup(record)]
    for root in roots:
        current = ''
        for part in root[1:].split('/'):
            current += '/' + part
            if current in ancestors:
                continue
            try:
                with directory(current, record['uid']) as fd:
                    info = os.fstat(fd)
                    ancestors[current] = [info.st_dev, info.st_ino, info.st_uid]
            except FileNotFoundError:
                require(root == CGROUP_ROOT + expected_cgroup(record),
                        'Cleanup parent disappeared', 'resource_not_allowed')
                break
    return ancestors


def existing_namespace(record):
    pause_dir = '/run/user/{}/libpod/tmp'.format(record['uid'])
    with directory(pause_dir, record['uid']) as fd:
        pause = os.open('pause.pid', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        try:
            info = os.fstat(pause)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == record['uid'] and
                    not info.st_mode & 0o022 and info.st_size <= 32,
                    'Normal rootless pause identity is unsafe', 'resource_not_allowed')
            data = os.read(pause, 33).strip()
        finally:
            os.close(pause)
    require(re.fullmatch(rb'[1-9][0-9]{0,9}', data), 'Normal rootless pause PID is invalid')
    pid = int(data)
    before = proc_identity(pid)
    for name, expected in (('uid_map', record['uid']), ('gid_map', record['gid'])):
        with open('/proc/{}/{}'.format(pid, name), 'r', encoding='ascii') as stream:
            validate_mapping(stream.read(8192), expected, name)
    namespace = os.stat('/proc/{}/ns/user'.format(pid))
    require(proc_identity(pid) == before, 'Normal rootless namespace changed')
    return [namespace.st_dev, namespace.st_ino]


def read_namespace_record(path, nonce):
    require(os.getuid() == 0 and os.geteuid() == 0, 'Cleanup must run in a rootless namespace', 'privilege_refused')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    try:
        for part in path[1:].split('/'):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                'Unsafe namespace metadata directory', 'resource_not_allowed')
        record = validate_record(read_json_at(fd, 'job.json', 0), nonce=nonce)
    finally:
        os.close(fd)
    validate_uid_map(record['uid'], record['gid'])
    require(record['cleanupAncestors'] is not None and record['cleanupNamespace'] is not None,
            'Namespace cleanup was not authorized by a stopped host-side job', 'resource_not_allowed')
    namespace = os.stat('/proc/self/ns/user')
    require([namespace.st_dev, namespace.st_ino] == record['cleanupNamespace'] and os.stat('/').st_uid != 0,
            'Cleanup is not in the previously existing normal rootless namespace', 'privilege_refused')
    with directory(path, 0, private=True, ancestors=record['cleanupAncestors']):
        pass
    return record


def cleanup_job(record, env, store):
    prove_stopped(record, env)
    refuse_job_mounts(record)
    try:
        remove_job_path(record, 'runtime', record['uid'])
        remove_job_path(record, 'work', record['uid'])
    except PermissionError:
        # Normal rootless namespace only: never select the stopped job store,
        # and never start its private pause process just to remove its files.
        record['cleanupAncestors'] = capture_cleanup_ancestors(record)
        try:
            record['cleanupNamespace'] = existing_namespace(record)
        except (FileNotFoundError, PermissionError):
            fail('Existing normal rootless Podman pause namespace is unavailable; job resources are retained')
        store.save(record)
        result = run_command([
            PODMAN_BIN, '--remote=false', 'unshare', PYTHON_BIN, '-I', RELAY_BIN,
            '--cleanup-entry', metadata_path(record), record['nonce'],
        ], env, timeout=30, ignore_cancel=True)
        require(result.returncode == 0, 'Rootless cleanup failed; job metadata and remaining resources are retained')
    for kind in ('runtime', 'work'):
        path = runtime_path(record) if kind == 'runtime' else work_path(record)
        require(not os.path.lexists(path), 'Job cleanup is incomplete; metadata is retained')


def internal_main(args):
    require(len(args) == 3 and args[0] in ('--unit-entry', '--deadline-entry', '--cleanup-entry'),
            'Arguments and policy overrides are not allowed', 'action_not_allowed')
    require(not any(key.startswith('SSH_') for key in os.environ),
            'Internal entrypoints are not available over SSH', 'action_not_allowed')
    record, account = load_internal(args[1], args[2], cleanup=args[0] == '--cleanup-entry')
    if args[0] == '--cleanup-entry':
        require(record['phase'] == 'stopped', 'Cleanup requires persisted stop proof', 'resource_conflict')
        with directory(metadata_path(record), 0, private=True, ancestors=record['cleanupAncestors']) as fd:
            marker = os.stat('cancelled', dir_fd=fd, follow_symlinks=False)
            require(stat.S_ISREG(marker.st_mode) and marker.st_uid == 0 and marker.st_nlink == 1 and
                    marker.st_size == 0 and stat.S_IMODE(marker.st_mode) == 0o600,
                    'Cleanup requires a protected cancellation tombstone', 'resource_conflict')
        require(not cgroup_populated(record, cleanup=True), 'Cleanup refuses a populated job cgroup')
        refuse_job_mounts(record)
        remove_job_path(record, 'runtime', 0)
        remove_job_path(record, 'work', 0)
        return
    store = JobStore(record['policy'], account, record['jobId'])
    if args[0] == '--unit-entry':
        bootstrap(record, account, store)
        fail('API exec unexpectedly returned')
    store.cancel()
    # Do not wait for the public start lock: an absolute deadline must be
    # enforceable even while readiness or the SSH launcher is stuck.
    env = runtime_environment(account)
    stop_owned(record, env)
    with store.locked():
        latest = store.load()
        latest['observedUnit'] = latest['observedUnit'] or record['observedUnit']
        prove_stopped(latest, env)
        if latest['phase'] != 'removed':
            latest['phase'] = 'stopped'
            store.save(latest)


def main():
    signal.signal(signal.SIGTERM, termination_signal)
    signal.signal(signal.SIGINT, termination_signal)
    internal = len(sys.argv) > 1 and sys.argv[1] in ('--unit-entry', '--deadline-entry', '--cleanup-entry') and not any(
        key.startswith('SSH_') for key in os.environ)
    try:
        if len(sys.argv) > 1:
            internal_main(sys.argv[1:])
            return 0
        check_environment(os.environ)
        require(sys.platform == 'linux' and pwd is not None and fcntl is not None,
                'Builder connector requires Linux and POSIX file locking', 'runtime_policy_invalid')
        require(os.getuid() > 0 and os.geteuid() == os.getuid(),
                'Root or changed effective identity is refused', 'privilege_refused')
        policy = load_policy()
        account = identity(policy)
        for key, expected in (('HOME', account.pw_dir), ('USER', account.pw_name), ('LOGNAME', account.pw_name),
                              ('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/' + str(account.pw_uid) + '/bus')):
            require(key not in os.environ or os.environ[key] == expected,
                    'Caller identity environment override is refused: ' + key, 'privilege_refused')
        xdg = os.environ.get('XDG_RUNTIME_DIR')
        require(xdg is None or xdg == '/run/user/' + str(account.pw_uid), 'Caller runtime override is refused', 'privilege_refused')
        response = {'ok': True, 'result': dispatch(policy, account, runtime_environment(account), read_request(sys.stdin.buffer))}
    except RelayError as error:
        response = {'ok': False, 'code': error.code, 'error': str(error)}
        if hasattr(error, 'startup_failure'):
            response.update(error='Private builder startup failed', startupFailure=error.startup_failure)
    except OSError as error:
        response = {'ok': False, 'code': 'process_failed', 'error': 'Builder OS operation failed (errno {})'.format(error.errno)}
        if hasattr(error, 'startup_failure'):
            response.update(error='Private builder startup failed', startupFailure=error.startup_failure)
    if internal:
        # Units use null output; local invocations receive only a bounded error,
        # never helper output, build logs or source.
        sys.stderr.write(response['code'] + ': ' + response['error'][:512] + '\n')
        return 1
    write_response(sys.stdout.buffer, response)
    return 0


if __name__ == '__main__':
    sys.exit(main())
