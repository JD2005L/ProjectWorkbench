// Isolation policy. Safe by default: an instance runs ISOLATED (no host
// tmux/ttyd/nginx/systemd side effects) unless its registry IS the canonical
// registry. Deployments that intentionally keep the real registry elsewhere
// (e.g. GOA under /etc) must say so explicitly via PW_CANONICAL_REGISTRY —
// host mode is never inferred from what the path merely looks like.
// PW_ISOLATED=1 always forces isolation, even on the canonical registry.

export const DEFAULT_CANONICAL_REGISTRY = '/opt/project-workbench/projects.json';

export function resolveIsolation(env = process.env) {
 const canonicalRegistry = env.PW_CANONICAL_REGISTRY || DEFAULT_CANONICAL_REGISTRY;
 const registryPath = env.PW_REGISTRY_PATH || canonicalRegistry;
 const isolated = env.PW_ISOLATED === '1' || registryPath !== canonicalRegistry;
 return { canonicalRegistry, registryPath, isolated };
}
