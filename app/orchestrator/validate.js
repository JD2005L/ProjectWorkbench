// Strict, declarative payload validation for the orchestration contract.
//
// The Pydantic models on the orchestrator side use `extra="forbid"` and bounded scalar types. That
// is a security control, not hygiene: it stops an inbound payload smuggling a field past validation
// and into a stored blob. This validator reproduces the same discipline for the ProjectWorkbench
// side — unknown keys are an error, types are never coerced, and every string is length- and
// pattern-bounded before it can reach the store, a command line, or the filesystem.
//
// Schemas are plain data: { name, fields: { <field>: <spec> } }. A spec is
//   { type, required?, default?, min?, max?, minItems?, maxItems?, values?, items?, schema? }
// where `type` is one of the primitives below.

import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  MAX_LIST_ITEMS,
  TEXT_LIMITS,
  PATTERNS,
  ErrorCode,
} from './contract.js';

/** Keys that must never be copied out of an inbound object, whatever a schema says. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ValidationError extends Error {
  constructor(message, { code = ErrorCode.VALIDATION_FAILED, fieldErrors = [] } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function fail(fieldErrors, message = 'payload failed validation', code = ErrorCode.VALIDATION_FAILED) {
  throw new ValidationError(message, { code, fieldErrors });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded, pattern-checked string primitives. Whitespace is stripped, then min length 1 applies. */
function validateText(value, { kind, path, errors, maxLength, pattern, allowEmpty = false }) {
  if (typeof value !== 'string') {
    errors.push({ field: path, message: `expected a ${kind} string` });
    return undefined;
  }
  const stripped = value.trim();
  if (!allowEmpty && stripped.length < 1) {
    errors.push({ field: path, message: `${kind} must not be empty` });
    return undefined;
  }
  if (stripped.length > maxLength) {
    errors.push({ field: path, message: `${kind} exceeds ${maxLength} characters` });
    return undefined;
  }
  if (stripped.includes('\0')) {
    errors.push({ field: path, message: `${kind} must not contain NUL` });
    return undefined;
  }
  if (pattern && !pattern.test(stripped)) {
    errors.push({ field: path, message: `${kind} has an invalid format` });
    return undefined;
  }
  return stripped;
}

/**
 * A repository-relative path. Absolute paths, parent traversal, backslashes, NUL, and whitespace
 * are all rejected — this type is what stops a "typed field" being an arbitrary path parameter.
 */
function validateRelativePath(value, path, errors) {
  const text = validateText(value, {
    kind: 'relative path', path, errors, maxLength: TEXT_LIMITS.relativePath,
  });
  if (text === undefined) return undefined;
  const bad =
    text.startsWith('/') ||
    text.includes('\\') ||
    /\s/.test(text) ||
    text.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');
  if (bad) {
    errors.push({ field: path, message: 'relative path must not be absolute, traversing, or contain whitespace' });
    return undefined;
  }
  return text;
}

function validateValue(spec, value, path, errors) {
  switch (spec.type) {
    case 'slug':
      return validateText(value, { kind: 'slug', path, errors, maxLength: TEXT_LIMITS.slug, pattern: PATTERNS.slug });
    case 'identifier':
      return validateText(value, { kind: 'identifier', path, errors, maxLength: TEXT_LIMITS.identifier, pattern: PATTERNS.identifier });
    case 'modelAlias':
      return validateText(value, { kind: 'model alias', path, errors, maxLength: TEXT_LIMITS.modelAlias, pattern: PATTERNS.modelAlias });
    case 'gitSha':
      return validateText(value, { kind: 'git sha', path, errors, maxLength: 40, pattern: PATTERNS.gitSha });
    case 'branch':
      return validateBranch(value, path, errors);
    case 'mediaType':
      return validateText(value, { kind: 'media type', path, errors, maxLength: 100, pattern: PATTERNS.mediaType });
    case 'shortText':
      return validateText(value, { kind: 'text', path, errors, maxLength: TEXT_LIMITS.shortText });
    case 'mediumText':
      return validateText(value, { kind: 'text', path, errors, maxLength: TEXT_LIMITS.mediumText });
    case 'longText':
      return validateText(value, { kind: 'text', path, errors, maxLength: TEXT_LIMITS.longText });
    case 'criterionText':
      return validateText(value, { kind: 'text', path, errors, maxLength: TEXT_LIMITS.criterionText });
    case 'excerpt':
      // Excerpts are bounded but may legitimately be empty and contain arbitrary log characters.
      return validateText(value, {
        kind: 'excerpt', path, errors, maxLength: spec.max ?? 4_000, allowEmpty: true,
      });
    case 'relativePath':
      return validateRelativePath(value, path, errors);
    case 'int':
      return validateInt(spec, value, path, errors);
    case 'float':
      return validateFloat(spec, value, path, errors);
    case 'bool':
      if (typeof value !== 'boolean') {
        errors.push({ field: path, message: 'expected a boolean' });
        return undefined;
      }
      return value;
    case 'datetime':
      return validateDatetime(value, path, errors);
    case 'url':
      return validateUrl(value, path, errors);
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push({ field: path, message: `expected one of: ${spec.values.join(', ')}` });
        return undefined;
      }
      return value;
    case 'list':
      return validateList(spec, value, path, errors);
    case 'object':
      return validateObject(spec.schema, value, path, errors);
    default:
      throw new Error(`unknown schema type: ${spec.type}`);
  }
}

function validateBranch(value, path, errors) {
  const text = validateText(value, {
    kind: 'branch', path, errors, maxLength: TEXT_LIMITS.branch, pattern: PATTERNS.branch,
  });
  if (text === undefined) return undefined;
  // A ref that could be read as an option is refused before it can ever reach a git argv.
  if (text.startsWith('-') || text.includes('..') || text.endsWith('.lock') || text.endsWith('/')) {
    errors.push({ field: path, message: 'branch name is not a safe ref' });
    return undefined;
  }
  return text;
}

function validateInt(spec, value, path, errors) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ field: path, message: 'expected an integer' });
    return undefined;
  }
  if (spec.min !== undefined && value < spec.min) {
    errors.push({ field: path, message: `must be >= ${spec.min}` });
    return undefined;
  }
  if (spec.max !== undefined && value > spec.max) {
    errors.push({ field: path, message: `must be <= ${spec.max}` });
    return undefined;
  }
  return value;
}

function validateFloat(spec, value, path, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field: path, message: 'expected a number' });
    return undefined;
  }
  if (spec.min !== undefined && value < spec.min) {
    errors.push({ field: path, message: `must be >= ${spec.min}` });
    return undefined;
  }
  if (spec.max !== undefined && value > spec.max) {
    errors.push({ field: path, message: `must be <= ${spec.max}` });
    return undefined;
  }
  return value;
}

function validateDatetime(value, path, errors) {
  if (typeof value !== 'string' || value.length > 40) {
    errors.push({ field: path, message: 'expected an ISO-8601 timestamp' });
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    errors.push({ field: path, message: 'expected an ISO-8601 timestamp' });
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function validateUrl(value, path, errors) {
  if (typeof value !== 'string' || value.length > 2_000) {
    errors.push({ field: path, message: 'expected a URL' });
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push({ field: path, message: 'expected a URL' });
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push({ field: path, message: 'only http and https URLs are accepted' });
    return undefined;
  }
  return parsed.toString();
}

function validateList(spec, value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push({ field: path, message: 'expected a list' });
    return undefined;
  }
  const maxItems = spec.maxItems ?? MAX_LIST_ITEMS;
  if (value.length > maxItems) {
    errors.push({ field: path, message: `list exceeds ${maxItems} items` });
    return undefined;
  }
  if (spec.minItems !== undefined && value.length < spec.minItems) {
    errors.push({ field: path, message: `list requires at least ${spec.minItems} item(s)` });
    return undefined;
  }
  const out = [];
  value.forEach((item, index) => {
    const validated = validateValue(spec.items, item, `${path}[${index}]`, errors);
    if (validated !== undefined) out.push(validated);
  });
  return out;
}

function validateObject(schema, value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push({ field: path || schema.name, message: 'expected an object' });
    return undefined;
  }

  // Reject the pollution keys outright rather than skipping them: a caller sending `__proto__` is
  // not making an honest mistake, and silently dropping it would hide the attempt from the audit.
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      errors.push({ field: path ? `${path}.${key}` : key, message: 'forbidden property name' });
      return undefined;
    }
  }

  const out = Object.create(null);

  // Every contract model is versioned. A payload may omit it (defaulting to the current version)
  // but may never claim an unsupported one.
  const rawVersion = Object.hasOwn(value, 'schema_version') ? value.schema_version : SCHEMA_VERSION;
  if (typeof rawVersion !== 'string' || !PATTERNS.schemaVersion.test(rawVersion)) {
    errors.push({ field: path ? `${path}.schema_version` : 'schema_version', message: 'invalid schema version' });
    return undefined;
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(rawVersion)) {
    throw new ValidationError(`unsupported schema version: ${rawVersion}`, {
      code: ErrorCode.UNSUPPORTED_SCHEMA_VERSION,
      fieldErrors: [{ field: path ? `${path}.schema_version` : 'schema_version', message: 'unsupported contract version' }],
    });
  }
  out.schema_version = rawVersion;

  // extra="forbid": anything not in the schema is an error, not something to ignore.
  for (const key of Object.keys(value)) {
    if (key === 'schema_version') continue;
    if (!Object.hasOwn(schema.fields, key)) {
      errors.push({ field: path ? `${path}.${key}` : key, message: 'unknown field' });
    }
  }

  for (const [field, spec] of Object.entries(schema.fields)) {
    const fieldPath = path ? `${path}.${field}` : field;
    const present = Object.hasOwn(value, field) && value[field] !== undefined;
    const raw = present ? value[field] : undefined;

    if (!present || raw === null) {
      if (raw === null && spec.nullable) { out[field] = null; continue; }
      if (spec.required) {
        errors.push({ field: fieldPath, message: 'field is required' });
        continue;
      }
      if (Object.hasOwn(spec, 'default')) {
        out[field] = typeof spec.default === 'function' ? spec.default() : spec.default;
      } else if (raw === null) {
        out[field] = null;
      }
      continue;
    }

    const validated = validateValue(spec, raw, fieldPath, errors);
    if (validated !== undefined) out[field] = validated;
  }

  return out;
}

/**
 * Validate `payload` against `schema`, returning a fresh plain object containing only schema
 * fields. Throws `ValidationError` — never returns a partially valid value.
 */
export function validate(schema, payload) {
  const errors = [];
  const result = validateObject(schema, payload, '', errors);
  if (errors.length) fail(errors, `${schema.name} failed validation`);
  // Return a null-prototype-free plain object so downstream `JSON.stringify` and spread behave.
  return { ...result };
}

/** Validate an *outbound* payload. A response that does not satisfy the contract is a defect here,
 *  so this throws rather than shipping a body the orchestrator would reject. */
export function validateResponse(schema, payload) {
  try {
    return validate(schema, payload);
  } catch (err) {
    if (err instanceof ValidationError) {
      const detail = err.fieldErrors.map((f) => `${f.field}: ${f.message}`).join('; ');
      throw new Error(`outbound ${schema.name} violates the contract — ${detail}`);
    }
    throw err;
  }
}
