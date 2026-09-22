import { DeploymentError } from './protocol.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RELAY_STAGES = new Set([
  'prepare_paths', 'persist_prepared', 'deadline_create', 'deadline_verify',
  'launch_parameters', 'persist_launch', 'launch', 'persist_launch_result',
  'launch_result', 'startup_deadline', 'unit_query', 'unit_ownership',
  'persist_observation', 'unit_state', 'api_readiness', 'persist_ready',
]);
const RELAY_CODES = new Set([
  'invalid_request', 'action_not_allowed', 'resource_not_allowed', 'resource_conflict',
  'runtime_policy_invalid', 'process_failed', 'privilege_refused', 'cancelled', 'os_error',
]);
const RELAY_RULES = new Set([
  'cancelled', 'helper_deadline', 'helper_output', 'helper_exit', 'helper_unreaped',
  'manager_query', 'manager_encoding', 'manager_properties', 'manager_incomplete', 'manager_exit',
  'unit_identity', 'unit_absence', 'unit_owner', 'unit_reserved', 'unit_process', 'unit_confinement',
  'unit_entrypoint', 'unit_duration', 'launch_unresolved', 'unit_stopping', 'cgroup_populated',
  'stop_refused', 'stop_unconfirmed', 'launch_failed', 'unit_disappeared', 'unit_stopped',
  'api_timeout', 'api_state', 'api_gone', 'api_identity', 'bootstrap_cgroup', 'api_cgroup',
  'api_command', 'api_socket', 'api_peer', 'api_response_timeout', 'api_response_size',
  'api_http', 'api_info', 'api_store', 'api_pid_changed', 'metadata_write', 'relay_refusal', 'os_error',
]);
const CLIENT_STAGES = new Set(['client_start', 'client_stop', 'exchange', 'exchange_cleanup', 'journal_write']);
const CLIENT_CODES = new Set([
  ...RELAY_CODES, 'builder_policy_invalid', 'builder_protocol_error', 'builder_unavailable',
  'builder_mutation_uncertain', 'cancellation_failed', 'timeout', 'interrupted',
  'execution_failed', 'io_error', 'invalid_state', 'unsafe_state', 'invalid_configuration',
]);
const IO_CODES = new Set(['EIO', 'ENOSPC', 'EACCES', 'EROFS', 'ENOENT', 'EMFILE', 'ENFILE', 'EDQUOT']);
const relayFailures = new WeakMap();
const exchangeFailures = new WeakMap();
const clientFailures = new WeakMap();

function check(condition) {
  if (!condition) throw new DeploymentError('Invalid private builder startup diagnostic', 502, 'builder_protocol_error');
}

function shape(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

function identity(value, jobId, instanceId) {
  check(value.version === 1 && typeof value.jobId === 'string' && value.jobId.length === 36 && UUID.test(value.jobId)
    && typeof value.instanceId === 'string' && value.instanceId.length === 36 && UUID.test(value.instanceId)
    && value.jobId === jobId && (instanceId === undefined || value.instanceId === instanceId));
}

function failure(value, stages, codes, rules) {
  shape(value, ['stage', 'code', 'rule', 'errno']);
  check(stages.has(value.stage) && codes.has(value.code) && rules.has(value.rule)
    && (value.errno === null || (Number.isInteger(value.errno) && value.errno > 0 && value.errno <= 4095)));
}

function clientFailure(value, stage) {
  failure(value, new Set([stage]), CLIENT_CODES, new Set(['client_failure', 'io_error']));
}

export function describeBuilderFailure(error, stage) {
  check(CLIENT_STAGES.has(stage));
  const io = IO_CODES.has(error?.code);
  const number = error?.errno;
  return {
    stage,
    code: io ? 'io_error' : CLIENT_CODES.has(error?.code) ? error.code : 'execution_failed',
    rule: io ? 'io_error' : 'client_failure',
    errno: Number.isInteger(number) && Math.abs(number) > 0 && Math.abs(number) <= 4095 ? Math.abs(number) : null,
  };
}

export function validateRelayStartupFailure(value, jobId, instanceId) {
  shape(value, ['version', 'instanceId', 'jobId', 'primary', 'cleanup', 'recordingErrors']);
  identity(value, jobId, instanceId);
  failure(value.primary, RELAY_STAGES, RELAY_CODES, RELAY_RULES);
  const cleanup = value.cleanup;
  shape(cleanup, ['stage', 'outcome', 'failure']);
  check(['pending', 'cancel', 'stop', 'persist_stopped'].includes(cleanup.stage));
  if (cleanup.outcome === 'failed') {
    check(cleanup.stage !== 'pending');
    failure(cleanup.failure, new Set([cleanup.stage]), RELAY_CODES, RELAY_RULES);
  } else {
    check((cleanup.outcome === 'pending' || cleanup.outcome === 'stopped')
      && cleanup.failure === null
      && cleanup.stage === (cleanup.outcome === 'pending' ? 'pending' : 'persist_stopped'));
  }
  check(Array.isArray(value.recordingErrors) && value.recordingErrors.length <= 2);
  const seen = new Set();
  for (const item of value.recordingErrors) {
    failure(item, new Set(['diagnostic_initial', 'diagnostic_final']), RELAY_CODES, RELAY_RULES);
    check(!seen.has(item.stage));
    seen.add(item.stage);
  }
  check(Buffer.byteLength(JSON.stringify(value)) <= 4096);
  return structuredClone(value);
}

export function validateBuilderStartupFailure(value, jobId, instanceId) {
  shape(value, ['version', 'instanceId', 'jobId', 'primary', 'relay', 'exchange', 'cleanup', 'recordingFailure']);
  identity(value, jobId, instanceId);
  clientFailure(value.primary, 'client_start');
  if (value.relay !== null) validateRelayStartupFailure(value.relay, jobId, value.instanceId);
  if (value.exchange !== null) {
    shape(value.exchange, ['primary', 'cleanup']);
    clientFailure(value.exchange.primary, 'exchange');
    clientFailure(value.exchange.cleanup, 'exchange_cleanup');
  }
  check(Array.isArray(value.cleanup) && value.cleanup.length <= 2);
  for (const item of value.cleanup) {
    shape(item, ['outcome', 'failure']);
    if (item.outcome === 'failed') clientFailure(item.failure, 'client_stop');
    else check(item.outcome === 'stopped' && item.failure === null);
  }
  if (value.recordingFailure !== null) clientFailure(value.recordingFailure, 'journal_write');
  check(Buffer.byteLength(JSON.stringify(value)) <= 8192);
  return structuredClone(value);
}

export function attachRelayStartupFailure(error, value, jobId) {
  relayFailures.set(error, validateRelayStartupFailure(value, jobId));
}

export function relayStartupFailure(error) {
  return relayFailures.get(error);
}

export function exchangeStartupFailure(error) {
  return exchangeFailures.get(error);
}

export function attachBuilderStartupFailure(error, value) {
  validateBuilderStartupFailure(value, value.jobId, value.instanceId);
  clientFailures.set(error, value);
}

export function builderStartupFailure(error) {
  const value = clientFailures.get(error);
  return value && validateBuilderStartupFailure(value, value.jobId, value.instanceId);
}

export function carryStartupFailure(target, original) {
  for (const failures of [relayFailures, exchangeFailures, clientFailures]) {
    if (failures.has(original)) failures.set(target, failures.get(original));
  }
}

export function attachExchangeStartupFailure(cleanup, primary) {
  carryStartupFailure(cleanup, primary);
  exchangeFailures.set(cleanup, {
    primary: describeBuilderFailure(primary, 'exchange'),
    cleanup: describeBuilderFailure(cleanup, 'exchange_cleanup'),
  });
}
