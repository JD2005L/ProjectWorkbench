// Delegating GitHub authorisation to the `gh` CLI.
//
// WHY THIS IS BETTER THAN RUNNING THE DEVICE FLOW OURSELVES
//
// A stored GitHub token here has to be both the push credential pinned into every
// repository its owner owns and what authenticates Copilot in their terminals. A
// hand-made PAT satisfies one and fails the other; an OAuth token from an app GitHub
// trusts for both does not. `gh auth login` produces exactly that, and needs no client
// id from us — gh IS the app. The one token on this box that has always done both jobs
// is a `gho_` of precisely this kind.
//
// So this module does not implement OAuth. It builds the command a person runs in their
// own terminal, and reads back what gh stored — with the two behaviours that make the
// difference between working and quietly lying:
//
//   1. `gh auth token` ECHOES AN AMBIENT GH_TOKEN. Per-user credentials already export
//      one into every pane, so reading the token without sanitising the environment
//      returns the token PW already had and reports a fresh login that never happened.
//      Verified against gh 2.101.0: `GH_TOKEN=x gh auth token` prints `x`.
//   2. With nothing stored it writes to STDERR and exits non-zero, leaving stdout empty.
//      So "did it work" is decided by the shape of stdout, never by the exit code alone.
//
// execFile is injected so both of those are testable without a gh binary or a network.

/** Environment variables gh will prefer over anything it has stored. */
export const GH_TOKEN_ENV_VARS = Object.freeze([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
]);

export const GH_DEFAULT_HOST = 'github.com';
/** repo is what makes the result usable as a push credential; the rest match what gh
 *  itself asks for so a person is not re-prompted later for ordinary gh use. */
export const GH_DEFAULT_SCOPES = 'repo,read:org,workflow';

/**
 * The command a person runs in their own terminal.
 *
 * `--web` is the device flow: gh prints a one-time code and a URL, which is the only
 * shape that works on a box with no browser of its own.
 *
 * `--insecure-storage` is deliberate and is not a downgrade here. gh stores the token in
 * an OS credential store when it finds one and in plain text otherwise; this container
 * has no keyring, so plain text is already what happens. Saying so explicitly makes the
 * result DETERMINISTIC — it lands in <GH_CONFIG_DIR>/hosts.yml, where `gh auth token`
 * can always read it back — instead of depending on the continued absence of a keyring.
 * The file is 0600 inside the person's own 0700 credential directory.
 */
export function ghLoginCommand({ hostname = GH_DEFAULT_HOST, scopes = GH_DEFAULT_SCOPES } = {}) {
  const parts = [
    'gh auth login',
    `--hostname ${hostname}`,
    '--git-protocol https',
    '--web',
    '--insecure-storage',
  ];
  if (scopes) parts.push(`--scopes ${scopes}`);
  return parts.join(' ');
}

/**
 * Does this look like a GitHub token, as opposed to a message or an empty line?
 *
 * The check is on SHAPE because the exit code cannot carry the answer: gh exits non-zero
 * with nothing stored, but a sanitised environment plus an odd config can produce other
 * combinations, and storing "no oauth token found for github.com" as somebody's
 * credential would be a memorable sort of bug.
 */
export function looksLikeGithubToken(value) {
  const v = String(value || '').trim();
  if (!v || /\s/.test(v)) return false;
  return /^(gho_|ghu_|ghp_|ghs_|github_pat_)[A-Za-z0-9_]+$/.test(v);
}

/** The environment gh is asked in: the caller's, minus anything gh would prefer over
 *  what it has stored, plus the config directory that makes the answer per-person. */
export function ghReadEnv(baseEnv, ghConfigDir) {
  const env = { ...baseEnv };
  for (const key of GH_TOKEN_ENV_VARS) delete env[key];
  env.GH_CONFIG_DIR = ghConfigDir;
  // gh must never try to be interactive here: this runs from a request, with no terminal.
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  return env;
}

/**
 * What has this person's gh actually stored? '' when nothing has been authorised yet —
 * which is the normal answer while somebody is still completing the flow, not an error.
 */
export async function readStoredGhToken({
  execFile,
  ghConfigDir,
  hostname = GH_DEFAULT_HOST,
  bin = 'gh',
  env = {},
  timeoutMs = 10000,
}) {
  if (!ghConfigDir) return '';
  let stdout = '';
  try {
    const res = await execFile(bin, ['auth', 'token', '--hostname', hostname], {
      env: ghReadEnv(env, ghConfigDir),
      timeout: timeoutMs,
    });
    stdout = (res && res.stdout) || '';
  } catch (e) {
    // Nothing stored is the common case and arrives as a non-zero exit with empty
    // stdout. A real failure (gh missing, a timeout) also lands here; both mean "no
    // token to report", and the caller polls rather than treating it as fatal.
    stdout = (e && e.stdout) || '';
  }
  const token = String(stdout).trim();
  return looksLikeGithubToken(token) ? token : '';
}
