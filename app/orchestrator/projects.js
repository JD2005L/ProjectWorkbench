// Project resolution and capability advertisement.
//
// A project is never located because a hostname or a directory name looked right. It must appear in
// the orchestrator project configuration, be granted to the presented credential, and resolve to a
// workspace directory that is genuinely inside the configured workspace root. All three are
// checked, and the third is checked against the *real* path, so a symlink pointing out of the root
// is not a way to address arbitrary parts of the filesystem through a typed field.

import fs from 'fs';
import path from 'path';

import { ApiError, notFound, projectNotAuthorized } from './errors.js';
import { ErrorCode, PATTERNS, TEXT_LIMITS, CapabilityFlag, CodingBackend, SCHEMA_VERSION } from './contract.js';

const KNOWN_CAPABILITIES = new Set(Object.values(CapabilityFlag));

/** Per-project orchestration configuration, cached against the file's mtime. */
export class ProjectConfigStore {
  constructor(projectsPath) {
    this.projectsPath = projectsPath;
    this._cache = { key: null, projects: new Map() };
  }

  load() {
    let stat;
    try {
      stat = fs.statSync(this.projectsPath);
    } catch {
      this._cache = { key: null, projects: new Map() };
      return this._cache.projects;
    }

    const key = `${stat.mtimeMs}:${stat.size}`;
    if (this._cache.key === key) return this._cache.projects;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.projectsPath, 'utf8'));
    } catch {
      this._cache = { key, projects: new Map() };
      return this._cache.projects;
    }

    const projects = new Map();
    for (const [projectId, raw] of Object.entries(parsed?.projects ?? {})) {
      if (!isSafeProjectId(projectId)) continue;
      projects.set(projectId, Object.freeze({
        project_id: projectId,
        display_name: String(raw?.display_name ?? projectId).slice(0, 200),
        // An absent flag means "not offered", never "assume yes" — so an unrecognised capability
        // name is dropped rather than passed through.
        capabilities: Object.freeze((Array.isArray(raw?.capabilities) ? raw.capabilities : [])
          .filter((flag) => KNOWN_CAPABILITIES.has(flag))),
        verification_commands: Object.freeze((Array.isArray(raw?.verification_commands) ? raw.verification_commands : [])
          .map((cmd) => String(cmd).slice(0, 200))),
        default_branch: raw?.default_branch ? String(raw.default_branch).slice(0, 200) : null,
        has_ci: raw?.has_ci === true,
        publication_note: raw?.publication_note ? String(raw.publication_note).slice(0, 200) : null,
        // Optional explicit workspace override; otherwise the project id under the workspace root.
        workspace_subdir: raw?.workspace_subdir ? String(raw.workspace_subdir) : projectId,
      }));
    }

    this._cache = { key, projects: Object.freeze(projects) };
    return this._cache.projects;
  }
}

/**
 * A project id must be a slug, and must not be a relative-path element.
 *
 * The slug pattern alone permits `.` and `..`, which are legal identifiers but illegal path
 * segments — the one place where "a valid identifier" and "safe to join onto a root" diverge.
 */
export function isSafeProjectId(projectId) {
  if (typeof projectId !== 'string') return false;
  if (projectId.length < 1 || projectId.length > TEXT_LIMITS.slug) return false;
  if (!PATTERNS.slug.test(projectId)) return false;
  if (projectId === '.' || projectId === '..') return false;
  return true;
}

export function assertSafeProjectId(projectId) {
  if (!isSafeProjectId(projectId)) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the project identifier is not a valid slug', {
      fieldErrors: [{ field: 'project_id', message: 'must be an identifier-safe slug' }],
    });
  }
}

/**
 * Resolve the workspace directory for a project, refusing anything that escapes the root.
 *
 * `realpathSync` is what makes this a containment check rather than a string-prefix check: a
 * symlinked workspace that points outside the root is rejected even though its configured path
 * looks fine.
 */
export function resolveWorkspacePath(config, project) {
  const root = path.resolve(config.workspaceRoot);
  const candidate = path.resolve(root, project.workspace_subdir);

  const withinRoot = (target) => target === root || target.startsWith(root + path.sep);
  if (!withinRoot(candidate)) {
    throw new ApiError(ErrorCode.UNSAFE_PATH, 'the configured workspace is outside the workspace root');
  }

  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    // Not yet created. The lexical containment check above still applies.
    return candidate;
  }

  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* root itself may not exist yet */ }
  if (!(real === realRoot || real.startsWith(realRoot + path.sep))) {
    throw new ApiError(ErrorCode.UNSAFE_PATH, 'the workspace resolves outside the workspace root');
  }
  return real;
}

/**
 * Resolve a project for a credential.
 *
 * Order matters. The grant is checked before existence, so an ungranted project cannot be
 * distinguished from a nonexistent one by its status code — the endpoint must not become a way to
 * enumerate what this instance hosts.
 */
export function resolveProject(config, projectStore, token, projectId) {
  assertSafeProjectId(projectId);
  if (!token.projects.includes(projectId)) throw projectNotAuthorized();
  const project = projectStore.load().get(projectId);
  if (!project) throw notFound('no such project on this workbench instance');
  return project;
}

/** The `Project` contract payload. */
export function projectPayload(config, project) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: project.project_id,
    display_name: project.display_name,
    workbench_instance_id: config.instanceId,
    authorized: true,
    default_backend: CodingBackend.CLAUDE_CODE,
    verification_commands: [...project.verification_commands],
    publication_note: project.publication_note,
    last_successful_job_at: null,
  };
}

/** The `ProjectCapabilities` contract payload. */
export function capabilitiesPayload(config, project) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: project.project_id,
    workbench_instance_id: config.instanceId,
    capabilities: [...project.capabilities],
    verification_commands: [...project.verification_commands],
    default_branch: project.default_branch,
    has_ci: project.has_ci,
  };
}

/** Projects this credential may see. Anything not granted is not disclosed at all. */
export function listGrantedProjects(config, projectStore, token) {
  const configured = projectStore.load();
  return token.projects
    .filter((projectId) => configured.has(projectId))
    .map((projectId) => projectPayload(config, configured.get(projectId)));
}
