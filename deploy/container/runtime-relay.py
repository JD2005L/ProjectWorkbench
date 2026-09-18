#!/usr/bin/env python3
"""Fixed-purpose, non-root runtime connector for contained deployments."""
import hashlib
import io
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit

try:
    import pwd
except ImportError:
    pwd = None

HEADER_BYTES = 10
MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 262144
DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024
MAX_IMPORT_MEMORY_BYTES = DEFAULT_MAX_IMAGE_BYTES * 2
MAX_ARCHIVE_MEMBERS = 64
MAX_METADATA_BYTES = 1024 * 1024
IMPORT_READ_TIMEOUT_SECONDS = 300
IMPORT_LOAD_TIMEOUT_SECONDS = 300
REQUEST_READ_TIMEOUT_SECONDS = 10
HEALTH_PROBE_TIMEOUT_SECONDS = 10
MAX_HELPER_OUTPUT_BYTES = 1024 * 1024
REAP_WAIT_SECONDS = 5
DEFAULT_POLICY_FILE = '/etc/pw-deploy/runtime-policy.json'
PODMAN_BIN = '/usr/bin/podman'
SYSTEMCTL_BIN = '/usr/bin/systemctl'

NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
RESOURCE_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,100}$')
JOB_ID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
IMAGE_ID_RE = re.compile(r'^(?:sha256:)?[a-f0-9]{64}$')
REVISION_RE = re.compile(r'^[a-f0-9]{40}(?:[a-f0-9]{24})?$')
REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
HEALTH_HOST_RE = re.compile(r'^[A-Za-z0-9.:\[\]-]{1,253}$')
VERSION_FIELD_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,63}$')
SHA256_PATH_RE = re.compile(r'^blobs/sha256/([a-f0-9]{64})$')
CAMEL_RE = re.compile(r'([a-z0-9])([A-Z])')
SEPARATOR_RE = re.compile(r'[_.]+')
ALLOWED_ACTIONS = {
    'service_preflight', 'container_status', 'image_tag', 'image_remove_candidate',
    'image_import', 'service_restart', 'service_is_active', 'health_check',
}
LOOPBACK_HOSTS = {'127.0.0.1', '::1', 'localhost'}  # informational; direct binding uses the family-precise sets below
IPV4_LOOPBACK = '127.0.0.1'
IPV6_LOOPBACK = '::1'
DIRECT_LOOPBACK_HOSTS = {IPV4_LOOPBACK, IPV6_LOOPBACK}
IPV4_WILDCARD = '0.0.0.0'
IPV6_WILDCARD = '::'
ALLOWED_POLICY_FIELDS = {'resourceNames', 'healthHosts', 'maxImageBytes', 'healthTargets'}
ACTIVE_PROCESSES = set()
TERMINATED = False


class RelayError(Exception):
    def __init__(self, message, code='process_failed'):
        super().__init__(message)
        self.code = code


def _check_terminated():
    if TERMINATED:
        raise RelayError('Runtime connector was cancelled', 'cancelled')


def _stop_process(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except OSError:
        try:
            process.terminate()
        except OSError:
            return


def _kill_process(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except OSError:
        process.kill()


def _terminate_and_reap(process):
    """Escalate SIGTERM->SIGKILL and confirm the helper is actually reaped.

    Returns once the process has been collected. If even a post-SIGKILL wait
    cannot confirm the process is gone, a RelayError is raised so the caller
    surfaces an unconfirmed stop instead of a success-shaped cleanup; the
    caller must keep the process tracked in ACTIVE_PROCESSES in that case.
    """
    if process.poll() is not None:
        return
    _stop_process(process)
    try:
        process.wait(timeout=REAP_WAIT_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass
    _kill_process(process)
    try:
        process.wait(timeout=REAP_WAIT_SECONDS)
    except subprocess.TimeoutExpired:
        raise RelayError('Runtime helper could not be stopped', 'process_failed')


def _termination_signal(_signum, _frame):
    global TERMINATED
    TERMINATED = True
    for process in tuple(ACTIVE_PROCESSES):
        _stop_process(process)


def _stream_input_fd(stream):
    try:
        return stream.fileno()
    except (AttributeError, OSError, io.UnsupportedOperation):
        return None


def read_exact(stream, size, deadline, input_fd):
    """Read exactly ``size`` bytes bounded by an absolute wall-clock deadline.

    The deadline is never reset per byte or per chunk, so idle or trickled
    input can never extend the budget. On Linux real descriptors are drained
    with readiness polling plus ``os.read`` so a buffered reader can neither
    prefetch bytes destined for a following stream nor block for a full
    ``read(size)``. Bounded in-memory fixtures (``BytesIO``) expose no
    descriptor and are read directly; they cannot block, so no production
    bypass toggle is involved.
    """
    chunks = []
    remaining = size
    while remaining:
        _check_terminated()
        now = time.monotonic()
        if now >= deadline:
            raise RelayError('Request timed out', 'invalid_request')
        if input_fd is not None:
            ready, _, _ = select.select([input_fd], [], [], deadline - now)
            if not ready:
                raise RelayError('Request timed out', 'invalid_request')
            chunk = os.read(input_fd, remaining)
        else:
            chunk = stream.read(remaining)
        if not chunk:
            raise RelayError('Request was truncated', 'invalid_request')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


def read_request(stream):
    deadline = time.monotonic() + REQUEST_READ_TIMEOUT_SECONDS
    input_fd = _stream_input_fd(stream)
    header = read_exact(stream, HEADER_BYTES, deadline, input_fd)
    if not re.match(rb'^[0-9]{10}$', header):
        raise RelayError('Request framing is invalid', 'invalid_request')
    size = int(header)
    if size < 1 or size > MAX_REQUEST_BYTES:
        raise RelayError('Request size is out of bounds', 'invalid_request')
    try:
        value = json.loads(read_exact(stream, size, deadline, input_fd).decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RelayError('Request was not valid JSON', 'invalid_request')
    if not isinstance(value, dict):
        raise RelayError('Request must be a JSON object', 'invalid_request')
    return value


def write_response(stream, value):
    body = json.dumps(value, separators=(',', ':')).encode('utf-8')
    if len(body) > MAX_RESPONSE_BYTES:
        body = b'{"ok":false,"code":"process_failed","error":"Response exceeded its limit"}'
    stream.write(str(len(body)).zfill(HEADER_BYTES).encode('ascii'))
    stream.write(body)
    stream.flush()


def check_fields(request, allowed, label):
    extra = sorted(set(request) - set(allowed) - {'requestId', 'action'})
    if extra:
        raise RelayError(f'Unknown {label} field: {extra[0]}', 'invalid_request')


def project_name(value):
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise RelayError('Invalid project name', 'invalid_request')
    return value


def target_name(value):
    if value not in ('dev', 'prod'):
        raise RelayError('Target must be dev or prod', 'invalid_request')
    return value


def canonical_resource_name(project, target):
    return SEPARATOR_RE.sub('-', CAMEL_RE.sub(r'\1-\2', project)).lower() + ('-dev' if target == 'dev' else '')


def compact_resource_name(project, target):
    return SEPARATOR_RE.sub('-', project).lower() + ('-dev' if target == 'dev' else '')


def resolve_resource_name(policy, project, target, name, label):
    project, target = project_name(project), target_name(target)
    if not isinstance(name, str) or not RESOURCE_RE.match(name):
        raise RelayError(f'Invalid {label}', 'invalid_request')
    key = f'{project}/{target}'
    binding = policy['resourceNames'].get(key)
    allowed = {binding} if binding else {canonical_resource_name(project, target), compact_resource_name(project, target)}
    reserved = {value for owner, value in policy['resourceNames'].items() if owner != key}
    if name not in allowed or name in reserved:
        raise RelayError(f'The {label} does not belong to the selected project and target', 'resource_not_allowed')
    return name


def job_id(value):
    if not isinstance(value, str) or not JOB_ID_RE.match(value):
        raise RelayError('Invalid job identity', 'invalid_request')
    return value


def image_identity(value, label='image identity'):
    if not isinstance(value, str) or not IMAGE_ID_RE.match(value):
        raise RelayError(f'Invalid {label}', 'invalid_image')
    return value if value.startswith('sha256:') else f'sha256:{value}'


def _valid_target_key(key):
    if not isinstance(key, str):
        return False
    parts = key.split('/')
    return len(parts) == 2 and bool(NAME_RE.match(parts[0])) and parts[1] in ('dev', 'prod')


def _health_url_shape_ok(url, health_hosts):
    if not isinstance(url, str) or not url or len(url) > 2048:
        return False
    try:
        parsed = urlsplit(url)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        return False
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    if port is not None and not 1 <= port <= 65535:
        return False
    return (host or '').strip('[]') in health_hosts


def load_policy(path=DEFAULT_POLICY_FILE):
    try:
        info = os.lstat(path)
    except OSError:
        raise RelayError('Runtime policy is not available', 'runtime_policy_invalid')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RelayError('Runtime policy must be a regular file', 'runtime_policy_invalid')
    if not hasattr(os, 'getuid') or info.st_uid != 0 or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RelayError('Runtime policy ownership is invalid', 'runtime_policy_invalid')
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError):
        raise RelayError('Runtime policy could not be read', 'runtime_policy_invalid')
    if not isinstance(value, dict) or set(value) - ALLOWED_POLICY_FIELDS:
        raise RelayError('Runtime policy is invalid', 'runtime_policy_invalid')
    resource_names, health_hosts = value.get('resourceNames', {}), value.get('healthHosts', [])
    max_image_bytes = value.get('maxImageBytes', DEFAULT_MAX_IMAGE_BYTES)
    health_targets = value.get('healthTargets', {})
    if (not isinstance(resource_names, dict) or any(not _valid_target_key(k) or not isinstance(v, str)
            or not RESOURCE_RE.match(v) for k, v in resource_names.items())
            or not isinstance(health_hosts, list) or not health_hosts or len(health_hosts) > 32
            or any(not isinstance(host, str) or not HEALTH_HOST_RE.match(host) for host in health_hosts)
            or not isinstance(max_image_bytes, int) or isinstance(max_image_bytes, bool)
            or not 1 <= max_image_bytes <= DEFAULT_MAX_IMAGE_BYTES
            or not isinstance(health_targets, dict) or len(health_targets) > 256
            or any(not _valid_target_key(k) or not _health_url_shape_ok(v, health_hosts)
                for k, v in health_targets.items())):
        raise RelayError('Runtime policy is invalid', 'runtime_policy_invalid')
    return {'resourceNames': resource_names, 'healthHosts': health_hosts,
            'maxImageBytes': max_image_bytes, 'healthTargets': health_targets}


def runtime_environment():
    uid = os.getuid()
    runtime_dir = f'/run/user/{uid}'
    home = pwd.getpwuid(uid).pw_dir if pwd is not None else os.path.expanduser('~')
    return {
        'PATH': '/usr/bin:/bin',
        'HOME': home,
        'XDG_RUNTIME_DIR': runtime_dir,
        'DBUS_SESSION_BUS_ADDRESS': f'unix:path={runtime_dir}/bus',
    }


def run_command(argv, *, timeout=30, allowed_exit_codes=(0,), max_output_bytes=MAX_HELPER_OUTPUT_BYTES, env=None):
    _check_terminated()
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=runtime_environment() if env is None else env, start_new_session=True)
    except OSError:
        raise RelayError('Runtime helper could not start', 'process_failed')
    ACTIVE_PROCESSES.add(process)
    stdout_fd = process.stdout.fileno()
    chunks, total, deadline = [], 0, time.monotonic() + timeout
    reaped = False
    try:
        while True:
            _check_terminated()
            now = time.monotonic()
            if now >= deadline:
                raise RelayError('Runtime helper timed out', 'process_failed')
            ready, _, _ = select.select([stdout_fd], [], [], deadline - now)
            if not ready:
                continue
            chunk = os.read(stdout_fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_output_bytes:
                raise RelayError('Runtime helper produced too much output', 'process_failed')
            chunks.append(chunk)
        try:
            process.wait(timeout=REAP_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            raise RelayError('Runtime helper timed out', 'process_failed')
        reaped = True
    except BaseException:
        # Any exceptional or cancellation exit must terminate and confirm the
        # helper is reaped before propagating. If reaping cannot be confirmed
        # (_terminate_and_reap raises) we deliberately keep the process tracked
        # in ACTIVE_PROCESSES and surface that unconfirmed-stop error, rather
        # than closing/discarding a still-live helper. The original error is
        # only re-raised after a confirmed reap.
        _terminate_and_reap(process)
        reaped = True
        raise
    finally:
        if reaped:
            try:
                process.stdout.close()
            except OSError:
                pass
            ACTIVE_PROCESSES.discard(process)
    _check_terminated()
    if process.returncode not in allowed_exit_codes:
        raise RelayError('Runtime helper failed', 'process_failed')
    return type('CommandResult', (), {'returncode': process.returncode, 'stdout': b''.join(chunks)})()


def podman(args, **kwargs):
    return run_command([PODMAN_BIN, *args], **kwargs)


def systemctl(args, **kwargs):
    return run_command([SYSTEMCTL_BIN, '--user', *args], **kwargs)


def _strict_json(data, label):
    def no_duplicate_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('duplicate key')
            value[key] = item
        return value
    if len(data) > MAX_METADATA_BYTES:
        raise RelayError(f'OCI {label} is too large', 'invalid_image')
    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=no_duplicate_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise RelayError(f'OCI {label} is invalid', 'invalid_image')
    if not isinstance(value, dict):
        raise RelayError(f'OCI {label} is invalid', 'invalid_image')
    return value


def _descriptor(value, label):
    if not isinstance(value, dict) or set(value) - {'mediaType', 'digest', 'size', 'annotations'}:
        raise RelayError(f'OCI {label} descriptor is invalid', 'invalid_image')
    digest, size, media_type = value.get('digest'), value.get('size'), value.get('mediaType')
    if (not isinstance(digest, str) or not re.match(r'^sha256:[a-f0-9]{64}$', digest)
            or not isinstance(size, int) or size < 0 or not isinstance(media_type, str) or not media_type):
        raise RelayError(f'OCI {label} descriptor is invalid', 'invalid_image')
    annotations = value.get('annotations', {})
    if not isinstance(annotations, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in annotations.items()):
        raise RelayError(f'OCI {label} annotations are invalid', 'invalid_image')
    return digest, size, annotations


def _non_reference_annotations(value, label):
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        raise RelayError(f'OCI {label} annotations are invalid', 'invalid_image')
    if 'org.opencontainers.image.ref.name' in value:
        raise RelayError('OCI archive has an unexpected tag annotation', 'invalid_image')


def _read_member(archive, member, max_size):
    if member.size > max_size:
        raise RelayError('OCI archive member is too large', 'invalid_image')
    source = archive.extractfile(member)
    if source is None:
        raise RelayError('OCI archive member is unreadable', 'invalid_image')
    data = source.read(member.size + 1)
    if len(data) != member.size:
        raise RelayError('OCI archive member is truncated', 'invalid_image')
    return data


def validate_oci_archive(source, approved_reference, expected_image_id, revision, max_bytes):
    """Validate and canonicalize into a second bounded memfd.

    The input and canonical output are each capped at maxImageBytes (at most
    2 GiB), so the memfd staging budget is bounded to 4 GiB. Canonical output
    prevents Podman from interpreting tar metadata the validator did not.
    """
    expected_image_id = image_identity(expected_image_id, 'expected image identity')
    if not isinstance(revision, str) or not REVISION_RE.match(revision):
        raise RelayError('Invalid expected revision', 'invalid_image')
    try:
        archive = tarfile.open(fileobj=source, mode='r:')
        members = archive.getmembers()
    except (tarfile.TarError, OSError):
        raise RelayError('OCI archive is invalid', 'invalid_image')
    if not 4 <= len(members) <= MAX_ARCHIVE_MEMBERS:
        raise RelayError('OCI archive member count is invalid', 'invalid_image')
    allowed_files = {'oci-layout', 'index.json'}
    allowed_dirs = {'blobs', 'blobs/sha256'}
    seen, member_by_name = set(), {}
    for member in members:
        name = member.name
        if (not name or name in seen or name.startswith('/') or '\\' in name or '/./' in name
                or '/../' in name or name.startswith('../') or member.pax_headers or getattr(member, 'sparse', None)):
            raise RelayError('OCI archive member is unsafe', 'invalid_image')
        seen.add(name)
        valid_blob = SHA256_PATH_RE.match(name)
        if name in allowed_dirs:
            if not member.isdir():
                raise RelayError('OCI archive directory is invalid', 'invalid_image')
        elif name in allowed_files or valid_blob:
            if not member.isreg() or member.size < 0:
                raise RelayError('OCI archive member is unsafe', 'invalid_image')
        else:
            raise RelayError('OCI archive contains an unexpected entry', 'invalid_image')
        member_by_name[name] = member
    if not allowed_dirs <= seen or not allowed_files <= seen or 'manifest.json' in seen:
        raise RelayError('OCI archive layout is incomplete', 'invalid_image')
    layout = _strict_json(_read_member(archive, member_by_name['oci-layout'], MAX_METADATA_BYTES), 'layout')
    if layout != {'imageLayoutVersion': '1.0.0'}:
        raise RelayError('OCI layout is invalid', 'invalid_image')
    index = _strict_json(_read_member(archive, member_by_name['index.json'], MAX_METADATA_BYTES), 'index')
    if (set(index) - {'schemaVersion', 'mediaType', 'manifests', 'annotations'}
            or index.get('schemaVersion') != 2
            or index.get('mediaType') != 'application/vnd.oci.image.index.v1+json'
            or not isinstance(index.get('manifests'), list) or len(index['manifests']) != 1):
        raise RelayError('OCI index is invalid', 'invalid_image')
    _non_reference_annotations(index.get('annotations', {}), 'index')
    manifest_digest, manifest_size, index_annotations = _descriptor(index['manifests'][0], 'index')
    if (index['manifests'][0].get('mediaType') != 'application/vnd.oci.image.manifest.v1+json'
            or index_annotations != {'org.opencontainers.image.ref.name': approved_reference}):
        raise RelayError('OCI archive reference is not approved', 'invalid_image')
    manifest_name = f'blobs/sha256/{manifest_digest[7:]}'
    if manifest_name not in member_by_name:
        raise RelayError('OCI manifest is missing', 'invalid_image')
    manifest_data = _read_member(archive, member_by_name[manifest_name], MAX_METADATA_BYTES)
    if len(manifest_data) != manifest_size or hashlib.sha256(manifest_data).hexdigest() != manifest_digest[7:]:
        raise RelayError('OCI manifest digest is inconsistent', 'invalid_image')
    manifest = _strict_json(manifest_data, 'manifest')
    if (set(manifest) - {'schemaVersion', 'mediaType', 'config', 'layers', 'annotations'}
            or manifest.get('schemaVersion') != 2
            or manifest.get('mediaType') != 'application/vnd.oci.image.manifest.v1+json'
            or not isinstance(manifest.get('layers'), list)):
        raise RelayError('OCI manifest is invalid', 'invalid_image')
    _non_reference_annotations(manifest.get('annotations', {}), 'manifest')
    config_digest, config_size, config_annotations = _descriptor(manifest.get('config'), 'config')
    if config_annotations or config_digest != expected_image_id:
        raise RelayError('OCI config identity is inconsistent', 'invalid_image')
    references = {config_digest: config_size}
    for layer in manifest['layers']:
        digest, layer_size, annotations = _descriptor(layer, 'layer')
        if (not layer.get('mediaType', '').startswith('application/vnd.oci.image.layer.')
                or annotations or digest in references):
            raise RelayError('OCI layer metadata is invalid', 'invalid_image')
        references[digest] = layer_size
    blob_names = {name for name in member_by_name if SHA256_PATH_RE.match(name)}
    expected_names = {manifest_name} | {f'blobs/sha256/{digest[7:]}' for digest in references}
    if blob_names != expected_names:
        raise RelayError('OCI archive has extra or missing blobs', 'invalid_image')
    for digest, expected_size in references.items():
        member = member_by_name[f'blobs/sha256/{digest[7:]}']
        if member.size != expected_size:
            raise RelayError('OCI blob size is inconsistent', 'invalid_image')
        data = _read_member(archive, member, max_bytes)
        if hashlib.sha256(data).hexdigest() != digest[7:]:
            raise RelayError('OCI blob digest is inconsistent', 'invalid_image')
    config_data = _read_member(archive, member_by_name[f'blobs/sha256/{config_digest[7:]}'], MAX_METADATA_BYTES)
    if len(config_data) != config_size:
        raise RelayError('OCI config size is inconsistent', 'invalid_image')
    config = _strict_json(config_data, 'config')
    labels = config.get('config', {}).get('Labels') if isinstance(config.get('config'), dict) else None
    if not isinstance(labels, dict) or labels.get('org.opencontainers.image.revision') != revision:
        raise RelayError('OCI revision is inconsistent', 'invalid_image')
    # Cap the canonical archive size BEFORE staging it. The tar layout is
    # deterministic: a 512-byte header plus 512-padded data for every member,
    # directory headers, two zero end-of-archive blocks (1024), and then the
    # whole file padded up to a multiple of tarfile.RECORDSIZE (10240) on close.
    # Missing that record padding previously let a logically-6144-byte archive
    # be written as 10240 bytes past the limit, so include it here.
    blocks = 1024 + 512 * len(allowed_dirs)
    for name in ['oci-layout', 'index.json', *blob_names]:
        member = member_by_name[name]
        blocks += 512 + (member.size + 511) // 512 * 512
    projected = (blocks + tarfile.RECORDSIZE - 1) // tarfile.RECORDSIZE * tarfile.RECORDSIZE
    if projected > max_bytes:
        raise RelayError('Canonical OCI archive exceeded its limit', 'invalid_image')
    if not hasattr(os, 'memfd_create') or sys.platform != 'linux':
        raise RelayError('Memory-backed OCI import is unavailable on this platform', 'process_failed')
    output_fd = os.memfd_create('pw-deploy-oci-canonical', os.MFD_CLOEXEC)
    output = os.fdopen(output_fd, 'w+b')
    try:
        with tarfile.open(fileobj=output, mode='w') as canonical:
            for directory in sorted(allowed_dirs):
                entry = tarfile.TarInfo(directory)
                entry.type, entry.mode, entry.uid, entry.gid, entry.mtime = tarfile.DIRTYPE, 0o755, 0, 0, 0
                canonical.addfile(entry)
            for name in ['oci-layout', 'index.json', *sorted(blob_names)]:
                member = member_by_name[name]
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode, entry.uid, entry.gid, entry.mtime = member.size, 0o644, 0, 0, 0
                original = archive.extractfile(member)
                if original is None:
                    raise RelayError('OCI archive member is unreadable', 'invalid_image')
                canonical.addfile(entry, original)
        if output.tell() > max_bytes:
            raise RelayError('Canonical OCI archive exceeded its limit', 'invalid_image')
        output.seek(0)
        return output
    except Exception:
        output.close()
        raise
    finally:
        archive.close()


def stage_oci_stream(stream, max_bytes):
    if not hasattr(os, 'memfd_create') or sys.platform != 'linux':
        raise RelayError('Memory-backed OCI import is unavailable on this platform', 'process_failed')
    fd = os.memfd_create('pw-deploy-oci-input', os.MFD_CLOEXEC)
    staged = os.fdopen(fd, 'w+b')
    deadline, total = time.monotonic() + IMPORT_READ_TIMEOUT_SECONDS, 0
    try:
        input_fd = _stream_input_fd(stream)
        while True:
            _check_terminated()
            if time.monotonic() >= deadline:
                raise RelayError('Image stream timed out', 'process_failed')
            if input_fd is not None:
                ready, _, _ = select.select([input_fd], [], [], deadline - time.monotonic())
                if not ready:
                    raise RelayError('Image stream timed out', 'process_failed')
                chunk = os.read(input_fd, min(65536, max_bytes - total + 1))
            else:
                chunk = stream.read(min(65536, max_bytes - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RelayError('Image stream exceeded its limit', 'invalid_request')
            staged.write(chunk)
        staged.seek(0)
        return staged
    except Exception:
        staged.close()
        raise


def handle_service_preflight(policy, request, _stream):
    check_fields(request, {'project', 'target', 'service'}, 'service_preflight')
    service = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('service'), 'service')
    return {'loadState': systemctl(['show', f'{service}.service', '--property=LoadState', '--value']).stdout.decode().strip()}


def handle_container_status(policy, request, _stream):
    check_fields(request, {'project', 'target', 'service'}, 'container_status')
    service = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('service'), 'service')
    if podman(['container', 'exists', service], allowed_exit_codes=(0, 1)).returncode:
        return {'exists': False}
    running, _, image = podman(['inspect', '--format', '{{.State.Running}} {{.Image}}', service]).stdout.decode().strip().partition(' ')
    return {'exists': True, 'running': running == 'true', 'image': image_identity(image.strip(), 'running image identity')}


def handle_image_tag(policy, request, _stream):
    check_fields(request, {'project', 'target', 'image', 'sourceImage', 'tagSuffix'}, 'image_tag')
    image = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('image'), 'image')
    if request.get('tagSuffix') not in ('latest', 'rollback'):
        raise RelayError('Invalid tag suffix', 'invalid_request')
    tag = f'localhost/{image}:{request["tagSuffix"]}'
    podman(['tag', image_identity(request.get('sourceImage'), 'source image identity'), tag])
    return {'tag': tag}


def handle_image_remove_candidate(policy, request, _stream):
    check_fields(request, {'project', 'target', 'image', 'jobId', 'expectedImageId'}, 'image_remove_candidate')
    if 'expectedImageId' not in request:
        raise RelayError('Candidate removal metadata is incomplete', 'invalid_request')
    image = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('image'), 'image')
    candidate = f'localhost/{image}:candidate-{job_id(request.get("jobId"))}'
    expected = image_identity(request['expectedImageId'], 'expected image identity')
    if podman(['image', 'exists', candidate], allowed_exit_codes=(0, 1)).returncode:
        return {'removed': False}
    current = image_identity(
        podman(['image', 'inspect', '--format', '{{.Id}}', candidate]).stdout.decode().strip(),
        'candidate image identity',
    )
    if current != expected:
        raise RelayError('Candidate image was replaced', 'resource_conflict')
    # Atomic removal primitive: ``podman image untag <expectedImageId> <candidate-ref>``.
    # Podman resolves the first argument to the expected image and refuses to
    # remove the tag unless <candidate-ref> is currently one of THAT image's
    # names. If the tag was reassigned to a different image between the inspect
    # above and now, the untag fails and we report the conflict rather than
    # deleting the replacement. Because untag only detaches the exact name (it
    # never removes an image by ID), unrelated tags/aliases of the expected
    # image are preserved. It may leave a normal untagged layer/image cache
    # behind; that is intentional -- we do not garbage collect blindly.
    if podman(['image', 'untag', expected, candidate], allowed_exit_codes=(0, 1, 125)).returncode:
        raise RelayError('Candidate image was replaced', 'resource_conflict')
    # Postcondition: the candidate reference must no longer resolve to the
    # expected image.
    if not podman(['image', 'exists', candidate], allowed_exit_codes=(0, 1)).returncode:
        remaining = image_identity(
            podman(['image', 'inspect', '--format', '{{.Id}}', candidate]).stdout.decode().strip(),
            'candidate image identity',
        )
        if remaining == expected:
            raise RelayError('Candidate image removal did not take effect', 'process_failed')
    return {'removed': True}


def handle_image_import(policy, request, stream):
    check_fields(request, {'project', 'target', 'image', 'jobId', 'expectedImageId', 'revision'}, 'image_import')
    if 'expectedImageId' not in request or 'revision' not in request:
        raise RelayError('Image import metadata is incomplete', 'invalid_request')
    image = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('image'), 'image')
    candidate = f'localhost/{image}:candidate-{job_id(request.get("jobId"))}'
    staged = stage_oci_stream(stream, policy['maxImageBytes'])
    try:
        canonical = validate_oci_archive(staged, candidate, request.get('expectedImageId'), request.get('revision'), policy['maxImageBytes'])
    finally:
        staged.close()
    try:
        try:
            process = subprocess.Popen([PODMAN_BIN, 'load'], stdin=canonical, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=runtime_environment(), start_new_session=True)
        except OSError:
            raise RelayError('Image import process could not start', 'process_failed')
        ACTIVE_PROCESSES.add(process)
        reaped = False
        try:
            _check_terminated()
            try:
                process.wait(timeout=IMPORT_LOAD_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                raise RelayError('Image import timed out', 'process_failed')
            _check_terminated()
            reaped = True
        except BaseException:
            # Terminate and confirm the loader is reaped on any timeout or
            # cancellation; keep it tracked if reaping cannot be confirmed.
            _terminate_and_reap(process)
            reaped = True
            raise
        finally:
            if reaped:
                ACTIVE_PROCESSES.discard(process)
        if process.returncode:
            raise RelayError('Image import failed', 'process_failed')
    finally:
        canonical.close()
    image_id = image_identity(podman(['image', 'inspect', '--format', '{{.Id}}', candidate]).stdout.decode().strip(), 'imported image identity')
    if image_id != image_identity(request['expectedImageId'], 'expected image identity'):
        raise RelayError('Imported image identity is inconsistent', 'invalid_image')
    return {'imageId': image_id}


def handle_service_restart(policy, request, _stream):
    check_fields(request, {'project', 'target', 'service'}, 'service_restart')
    service = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('service'), 'service')
    systemctl(['restart', f'{service}.service'])
    return {}


def handle_service_is_active(policy, request, _stream):
    check_fields(request, {'project', 'target', 'service'}, 'service_is_active')
    service = resolve_resource_name(policy, request.get('project'), request.get('target'), request.get('service'), 'service')
    return {'state': systemctl(['is-active', f'{service}.service'], allowed_exit_codes=(0, 3)).stdout.decode().strip()}





# Health probing runs in a supervised, isolated child interpreter so the WHOLE
# HTTP transaction (connect, headers, body) is bounded by run_command's absolute
# wall-clock deadline, output cap and cancellation-aware reaping. This avoids the
# unbounded/blocking behaviour of a direct urlopen().read() over a dribbling peer
# and never leaves an abandoned thread or socket behind. Proxies are disabled and
# redirects are refused inside the child. The child frames its result on stdout:
#   b'O' + 2-byte big-endian HTTP status + body bytes   (a response was received)
#   b'E'                                                 (connect/transport error)
_HEALTH_PROBE_SCRIPT = (
    "import sys, urllib.request\n"
    "url = sys.argv[1]\n"
    "max_body = int(sys.argv[2])\n"
    "class _NR(urllib.request.HTTPRedirectHandler):\n"
    "    def redirect_request(self, *a, **k):\n"
    "        return None\n"
    "opener = urllib.request.build_opener(_NR, urllib.request.ProxyHandler({}))\n"
    "out = sys.stdout.buffer\n"
    "try:\n"
    "    resp = opener.open(url, timeout=%d)\n"
    "except Exception:\n"
    "    out.write(b'E'); out.flush(); sys.exit(0)\n"
    "try:\n"
    "    status = getattr(resp, 'status', None) or resp.getcode() or 0\n"
    "    body = resp.read(max_body + 1)\n"
    "finally:\n"
    "    resp.close()\n"
    "out.write(b'O')\n"
    "out.write(min(int(status), 65535).to_bytes(2, 'big'))\n"
    "out.write(body)\n"
    "out.flush()\n"
) % HEALTH_PROBE_TIMEOUT_SECONDS


def _validate_health_url(health_url, health_hosts):
    if not isinstance(health_url, str) or not health_url or len(health_url) > 2048:
        raise RelayError('Invalid health URL', 'invalid_request')
    try:
        parsed = urlsplit(health_url)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        raise RelayError('Invalid health URL', 'invalid_request')
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RelayError('Invalid health URL', 'invalid_request')
    if port is not None and not 1 <= port <= 65535:
        raise RelayError('Invalid health URL', 'invalid_request')
    if (host or '').strip('[]') not in health_hosts:
        raise RelayError('Health endpoint host is not approved', 'health_host_not_allowed')
    return parsed


def _require_running_expected_image(service, expected):
    if podman(['container', 'exists', service], allowed_exit_codes=(0, 1)).returncode:
        raise RelayError('Service container is not present', 'health_failed')
    running, _, image = podman(['container', 'inspect', '--format', '{{.State.Running}} {{.Image}}',
        service]).stdout.decode().strip().partition(' ')
    if running != 'true':
        raise RelayError('Service container is not running', 'health_failed')
    if image_identity(image.strip(), 'running image identity') != expected:
        raise RelayError('Service container is not running the expected image', 'health_failed')


def _published_ports(service):
    raw = podman(['container', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', service]).stdout.decode().strip()
    try:
        ports = json.loads(raw) if raw and raw != 'null' else {}
    except json.JSONDecodeError:
        raise RelayError('Container port metadata is invalid', 'health_failed')
    if not isinstance(ports, dict):
        raise RelayError('Container port metadata is invalid', 'health_failed')
    published = set()
    for key, bindings in ports.items():
        # Keys are "<container-port>/<proto>"; the protocol must be preserved so
        # a UDP publication can never satisfy a TCP (HTTP) health probe.
        proto = key.rsplit('/', 1)[1].lower() if isinstance(key, str) and '/' in key else ''
        if bindings is None:
            continue
        if not isinstance(bindings, list):
            raise RelayError('Container port metadata is invalid', 'health_failed')
        for binding in bindings:
            if not isinstance(binding, dict):
                raise RelayError('Container port metadata is invalid', 'health_failed')
            host_ip, host_port = binding.get('HostIp') or '', binding.get('HostPort')
            if isinstance(host_port, str) and host_port.isdigit():
                published.add((proto, host_ip, int(host_port)))
    return published


def _require_direct_loopback_binding(service, parsed):
    host = (parsed.hostname or '').strip('[]')
    # Only literal loopback addresses are accepted for a direct probe. Ambiguous
    # names such as "localhost" (which may resolve to either family) must use an
    # explicit immutable healthTargets binding instead of being guessed here.
    if parsed.scheme != 'http' or host not in DIRECT_LOOPBACK_HOSTS:
        raise RelayError('A direct health URL must use http on a literal loopback address', 'health_target_not_allowed')
    if parsed.port is None:
        raise RelayError('A direct health URL must specify a published port', 'health_target_not_allowed')
    # Bind to the exact TCP protocol, address family and address of the URL.
    # A wildcard host binding only covers the destination when it is the wildcard
    # of the SAME family (0.0.0.0 for IPv4, :: for IPv6); there is no cross-family
    # coverage, and an empty HostIp never matches.
    if host == IPV4_LOOPBACK:
        acceptable = {IPV4_LOOPBACK, IPV4_WILDCARD}
    else:
        acceptable = {IPV6_LOOPBACK, IPV6_WILDCARD}
    published = _published_ports(service)
    reachable = any(proto == 'tcp' and port == parsed.port and host_ip in acceptable
        for proto, host_ip, port in published)
    if not reachable:
        raise RelayError('Health port is not published by this container', 'health_target_not_allowed')


def _probe_health(health_url):
    # Bound the entire transaction with the corrected process budget. The child
    # writes nothing until it has fully read the (bounded) body, so a dribbling
    # or stalled peer is stopped when run_command's absolute deadline fires,
    # after which the child is terminated and reaped. Cancellation is preserved;
    # every other failure is reported as a generic health failure with no
    # subprocess text leaked.
    argv = [sys.executable, '-I', '-c', _HEALTH_PROBE_SCRIPT, health_url, str(MAX_RESPONSE_BYTES)]
    try:
        result = run_command(argv, timeout=HEALTH_PROBE_TIMEOUT_SECONDS,
            max_output_bytes=MAX_RESPONSE_BYTES + 3, env={'PATH': '/usr/bin:/bin'})
    except RelayError as exc:
        if exc.code == 'cancelled':
            raise
        raise RelayError('Health endpoint was unreachable', 'health_failed')
    data = result.stdout
    if not data or data[:1] == b'E':
        raise RelayError('Health endpoint was unreachable', 'health_failed')
    if data[:1] != b'O' or len(data) < 3:
        raise RelayError('Health endpoint response was malformed', 'health_failed')
    if int.from_bytes(data[1:3], 'big') != 200:
        raise RelayError('Health endpoint did not return OK', 'health_failed')
    return data[3:]


def handle_health_check(policy, request, _stream):
    check_fields(request, {'project', 'target', 'service', 'expectedImageId', 'healthUrl', 'versionField'}, 'health_check')
    for required in ('project', 'target', 'service', 'expectedImageId', 'healthUrl'):
        if required not in request:
            raise RelayError('Health check metadata is incomplete', 'invalid_request')
    project, target = project_name(request.get('project')), target_name(request.get('target'))
    service = resolve_resource_name(policy, project, target, request.get('service'), 'service')
    expected = image_identity(request.get('expectedImageId'), 'expected image identity')
    field = request.get('versionField')
    if field is not None and (not isinstance(field, str) or not VERSION_FIELD_RE.match(field)):
        raise RelayError('Invalid version field', 'invalid_request')
    health_url = request.get('healthUrl')
    parsed = _validate_health_url(health_url, policy['healthHosts'])

    _require_running_expected_image(service, expected)

    approved = policy['healthTargets'].get(f'{project}/{target}')
    if approved is not None:
        # A proxy / HTTPS / non-published legacy route: only the exact
        # operator-approved URL for this project and target is accepted.
        if health_url != approved:
            raise RelayError('Health URL is not the approved target for this project', 'health_target_not_allowed')
    else:
        # No operator binding: the URL must be a direct loopback probe bound to
        # one of this exact container's published ports.
        _require_direct_loopback_binding(service, parsed)

    body = _probe_health(health_url)

    _require_running_expected_image(service, expected)

    if len(body) > MAX_RESPONSE_BYTES:
        raise RelayError('Health response was too large', 'health_failed')
    try:
        health = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RelayError('Invalid health response', 'health_failed')
    if not isinstance(health, dict) or not ((health.get('ok') is True or health.get('status') == 'ok')
            and health.get('ok') is not False and health.get('status') in (None, 'ok')):
        raise RelayError('Health endpoint reported an unhealthy status', 'health_failed')
    return {'version': str(health[field]) if health.get(field) is not None else None} if field else {}


ACTIONS = {
    'service_preflight': handle_service_preflight, 'container_status': handle_container_status,
    'image_tag': handle_image_tag, 'image_remove_candidate': handle_image_remove_candidate,
    'image_import': handle_image_import, 'service_restart': handle_service_restart,
    'service_is_active': handle_service_is_active, 'health_check': handle_health_check,
}


def dispatch(policy, request, stream):
    action = request.get('action')
    if not isinstance(action, str) or action not in ALLOWED_ACTIONS:
        raise RelayError('Action is not permitted', 'action_not_allowed')
    if not isinstance(request.get('requestId'), str) or not REQUEST_ID_RE.match(request['requestId']):
        raise RelayError('Invalid request identity', 'invalid_request')
    return ACTIONS[action](policy, request, stream)


def run():
    if not hasattr(os, 'getuid') or os.getuid() == 0:
        write_response(sys.stdout.buffer, {'ok': False, 'code': 'privilege_refused', 'error': 'Runtime connector refuses to run as root'})
        return 0
    if len(sys.argv) != 1:
        write_response(sys.stdout.buffer, {'ok': False, 'code': 'invalid_request', 'error': 'This connector accepts no arguments'})
        return 0
    try:
        policy = load_policy()
        request = read_request(sys.stdin.buffer.raw)
        result = dispatch(policy, request, sys.stdin.buffer.raw)
        write_response(sys.stdout.buffer, {'ok': True, 'result': result})
    except RelayError as error:
        write_response(sys.stdout.buffer, {'ok': False, 'code': error.code, 'error': str(error)})
    except Exception:
        write_response(sys.stdout.buffer, {'ok': False, 'code': 'process_failed', 'error': 'Runtime connector failed'})
    return 0


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _termination_signal)
    signal.signal(signal.SIGHUP, _termination_signal)
    run()
