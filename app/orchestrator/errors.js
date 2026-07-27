// The error contract (pw-contract.md §10).
//
// Two rules govern everything here. First, the condition-to-status-to-code mapping is a table, not
// a set of ad-hoc `res.status(...)` calls scattered through the routes, so it can be asserted
// wholesale. Second, no error body may contain a stack trace, an environment dump, a credential, or
// an unredacted command — which means an *unexpected* exception must degrade to a fixed internal
// error rather than being described. Describing it is how internals leak.

import { SCHEMA_VERSION, MAX_LIST_ITEMS, ErrorCode, TEXT_LIMITS } from './contract.js';
import { redactText } from './redact.js';

/** Condition → HTTP status, transcribed from the §10 table. */
const STATUS_BY_CODE = Object.freeze({
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.UNSUPPORTED_SCHEMA_VERSION]: 400,
  [ErrorCode.UNSAFE_PATH]: 400,
  [ErrorCode.MODEL_POLICY_VIOLATION]: 400,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.FORBIDDEN_SCOPE]: 403,
  [ErrorCode.PROJECT_NOT_AUTHORIZED]: 403,
  [ErrorCode.DIRECT_CODING_FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.INVALID_TRANSITION]: 409,
  [ErrorCode.LEASE_LOST]: 409,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.WORKBENCH_UNAVAILABLE]: 503,
});

export function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 500;
}

/** A failure the caller is allowed to be told about, in the contract's own vocabulary. */
export class ApiError extends Error {
  constructor(code, message, { detail = null, fieldErrors = [], retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
    this.fieldErrors = fieldErrors;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get status() {
    return statusForCode(this.code);
  }
}

// Convenience constructors for the conditions the routes raise most often. Having them here keeps
// the code/message pairing consistent across the API and the MCP adapter.
export const unauthenticated = (m = 'the service credential was rejected') => new ApiError(ErrorCode.UNAUTHENTICATED, m);
export const forbiddenScope = (m = 'the token lacks the required scope') => new ApiError(ErrorCode.FORBIDDEN_SCOPE, m);
export const projectNotAuthorized = (m = 'this project is not owned by this workbench instance') => new ApiError(ErrorCode.PROJECT_NOT_AUTHORIZED, m);
export const notFound = (m = 'no such job, project, or artifact') => new ApiError(ErrorCode.NOT_FOUND, m);
export const idempotencyKeyReused = (m = 'the idempotency key was reused with different content') => new ApiError(ErrorCode.IDEMPOTENCY_KEY_REUSED, m);
export const leaseLost = (m = 'the submitted fencing token is older than the accepted one') => new ApiError(ErrorCode.LEASE_LOST, m);
export const invalidTransition = (m = 'the requested state change is not legal') => new ApiError(ErrorCode.INVALID_TRANSITION, m);
export const payloadTooLarge = (m = 'the body or artifact exceeds the configured limit') => new ApiError(ErrorCode.PAYLOAD_TOO_LARGE, m);
export const rateLimited = (m = 'the coding backend is rate or usage limited', retryAfterSeconds = null) => new ApiError(ErrorCode.RATE_LIMITED, m, { retryAfterSeconds });
export const workbenchUnavailable = (m = 'the coding backend is signed out or unreachable') => new ApiError(ErrorCode.WORKBENCH_UNAVAILABLE, m);

function boundedMessage(text, fallback) {
  const redacted = redactText(String(text ?? ''), { maxLength: TEXT_LIMITS.shortText });
  const trimmed = redacted.trim();
  return trimmed.length ? trimmed.slice(0, TEXT_LIMITS.shortText) : fallback;
}

/**
 * Build the wire error envelope. Anything that is not an `ApiError` is treated as an internal
 * defect: the caller is told only that one occurred. That is deliberate — a `TypeError` message
 * routinely carries file paths, and an `ENOENT` carries the path of a credential store.
 */
export function errorEnvelope(err, correlationId = null) {
  const isApi = err instanceof ApiError;
  const code = isApi ? err.code : ErrorCode.INTERNAL_ERROR;
  const envelope = {
    schema_version: SCHEMA_VERSION,
    error: code,
    message: isApi ? boundedMessage(err.message, 'the request was refused') : 'an internal error occurred',
  };

  if (isApi && err.detail) {
    envelope.detail = redactText(String(err.detail), { maxLength: 2_000 });
  }
  if (correlationId) envelope.correlation_id = correlationId;
  if (isApi && err.fieldErrors?.length) {
    envelope.field_errors = err.fieldErrors.slice(0, MAX_LIST_ITEMS).map((f) => ({
      schema_version: SCHEMA_VERSION,
      field: redactText(String(f.field ?? ''), { maxLength: 200 }).slice(0, 200),
      message: boundedMessage(f.message, 'invalid value'),
    }));
  }
  return envelope;
}

/** Write an error response with the contract envelope and the mapped status. */
export function sendError(res, err, correlationId = null) {
  const status = err instanceof ApiError ? err.status : 500;
  if (err instanceof ApiError && err.code === ErrorCode.RATE_LIMITED && err.retryAfterSeconds != null) {
    res.set('Retry-After', String(Math.max(0, Math.floor(err.retryAfterSeconds))));
  }
  res.status(status).json(errorEnvelope(err, correlationId));
}
