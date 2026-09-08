// Container host aliases — the ONE place a deployment's name-to-address mapping
// is described, parsed and refused.
//
// ============================================================================
// WHY THIS EXISTS
//
// An MCP client resolves each configured server's name ONCE at session start and
// never retries, so a single transient negative answer (NXDOMAIN, surfacing as
// `getaddrinfo ENOTFOUND`) silently disables every name-configured MCP server for
// that whole session. The image's nsswitch is `hosts: files dns`, so a hosts
// entry wins and DNS is never consulted for that name; `--add-host` is how podman
// injects one, and it has to be a FLAG rather than a file edit because the
// container's /etc/hosts is a tmpfs bind recreated on every restart.
//
// That mechanism is general. The MAPPING is not: it names one site's host and one
// site's address. Writing it into systemd/pw-tmux.service made the shared
// container artifact work at exactly one deployment, which is the portability
// blocker this module exists to close. The unit now carries an expansion point
// with an empty default, and the mapping is deployment configuration.
//
// FAIL CLOSED, AND NEVER THROUGH A SHELL. The configured value reaches podman as
// argv, so anything this module accepts becomes podman's command line. It is
// therefore a whitelist, not a sanitiser: the value must be nothing but
// `--add-host <host>:<literal address>` repetitions, so a stray token cannot
// smuggle in another flag (`--privileged` being the one that matters). Nothing
// here evaluates, interpolates or expands the value; it is split exactly the way
// systemd splits an unbraced expansion — at whitespace — so what is validated is
// what podman receives.
//
// AND THE ADDRESS MUST BE A LITERAL. A name would be resolved by the very
// resolver this mapping exists to take out of the path, so `a:b.example` is
// refused rather than quietly reintroducing the failure it was configured to
// prevent.
// ============================================================================

import net from 'node:net';

// Distinct from a generic failure so a supervisor and an operator can tell "this
// instance is misconfigured" from "this check crashed". 78 is EX_CONFIG from
// sysexits.h. Deliberately restated rather than imported from env-schema.js:
// this module is installed on a host on its own, beside a checker that must not
// drag the environment contract along with it. A test asserts the two agree.
export const CONFIG_ERROR_EXIT = 78;

/** The variable the sidecar unit expands into podman's argv. */
export const HOST_ALIAS_ENV = 'PW_TMUX_HOST_ALIAS_ARGS';
/** The variable the sidecar unit uses to declare its network mode, so the
 *  loopback precondition below can be checked before the container starts. */
export const NETWORK_MODE_ENV = 'PW_TMUX_NETWORK_MODE';

const FLAG = '--add-host';
const MAX_NAME = 253;
const MAX_LABEL = 63;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

const fail = (error) => ({ ok: false, error, aliases: [], args: [] });

/** A DNS name podman will accept as the alias side of the mapping. Rejects the
 *  characters that would make it something other than a name — a slash, a space,
 *  a scheme — and the leading/trailing hyphens that are not legal labels. */
function isHostName(value) {
  if (!value || value.length > MAX_NAME) return false;
  const labels = value.split('.');
  return labels.every((l) => l.length >= 1 && l.length <= MAX_LABEL && LABEL.test(l));
}

/** The eight 16-bit groups of an IPv6 literal Node has already accepted, with an
 *  embedded IPv4 tail folded in. Only used to answer "is this loopback". */
function hextets(address) {
  let value = address.split('%')[0];
  const dot = value.lastIndexOf('.');
  if (dot !== -1) {
    const cut = value.lastIndexOf(':') + 1;
    const quad = value.slice(cut).split('.').map(Number);
    value = `${value.slice(0, cut)}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }
  const [head, tail] = value.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail ? tail.split(':').filter(Boolean) : [];
  const middle = value.includes('::') ? new Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...middle, ...right].map((h) => parseInt(h, 16));
}

/** Whether an address means "this machine". The distinction matters because a
 *  loopback alias is only correct while the container shares the host's network
 *  namespace — see validateHostAliasConfig. */
function isLoopback(address, family) {
  if (family === 4) return Number(address.split('.')[0]) === 127;
  const h = hextets(address);
  if (h.length !== 8) return false;
  const zeroTop = h.slice(0, 5).every((x) => x === 0);
  if (zeroTop && h[5] === 0 && h[6] === 0 && h[7] === 1) return true;      // ::1
  return zeroTop && h[5] === 0xffff && (h[6] >> 8) === 127;                // ::ffff:127.0.0.0/8
}

/**
 * Parse the configured value into the argv the unit will pass podman.
 *
 * Returns `{ ok: true, aliases, args }` — `args` a fixed argv array, never a
 * string for something else to split — or `{ ok: false, error, aliases: [],
 * args: [] }`. An unset, empty or blank value is the DEFAULT and is `ok` with no
 * aliases: an unconfigured instance contributes no arguments at all.
 */
export function parseHostAliasArgs(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const aliases = [];
  const seen = new Map();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let value;
    if (token === FLAG) {
      value = tokens[++i];
      if (value === undefined) return fail(`${FLAG} was given without a value`);
    } else if (token.startsWith(`${FLAG}=`)) {
      value = token.slice(FLAG.length + 1);
    } else {
      // The whitelist. Everything that is not this flag is refused by name,
      // because the alternative is passing an operator's typo — or another
      // podman flag entirely — straight through to the container's command line.
      return fail(`unexpected token ${JSON.stringify(token)}: only ${FLAG} entries are accepted here`);
    }

    const cut = value.indexOf(':');
    if (cut === -1) return fail(`${JSON.stringify(value)} is not a mapping: expected <host>:<address>`);
    const host = value.slice(0, cut);
    // The FIRST colon separates, so an IPv6 literal keeps the rest of its own.
    const address = value.slice(cut + 1);

    if (!host) return fail(`${JSON.stringify(value)} has an empty host name`);
    if (!isHostName(host)) return fail(`${JSON.stringify(host)} is not a valid host name`);
    if (!address) return fail(`${JSON.stringify(value)} has an empty address`);

    const family = net.isIP(address);
    if (family === 0) {
      return fail(`${JSON.stringify(address)} is not a literal IP address; a name would be resolved by the resolver this mapping exists to bypass`);
    }

    const previous = seen.get(host);
    if (previous !== undefined && previous !== address) {
      return fail(`${JSON.stringify(host)} is mapped to both ${JSON.stringify(previous)} and ${JSON.stringify(address)}`);
    }
    seen.set(host, address);
    aliases.push({ host, address, family, loopback: isLoopback(address, family) });
  }

  return { ok: true, aliases, args: aliases.flatMap((a) => [FLAG, `${a.host}:${a.address}`]) };
}

/** Whether any alias only makes sense inside the host's network namespace. */
export function requiresHostNetwork(aliases = []) {
  return aliases.some((a) => a.loopback);
}

/**
 * The full gate: the value parses, AND its precondition holds.
 *
 * THE PRECONDITION. 127.0.0.1 means "the host" only because the sidecar runs
 * --network=host; without that, loopback is the container itself and the alias
 * silently points at nothing — the mapping appears configured and every client
 * it was meant to rescue fails anyway. A deployment that does not share the host
 * network namespace must map its own reachable address instead, so a loopback
 * alias is REFUSED rather than accepted into a configuration that cannot work.
 * An unknown mode is refused for the same reason: unverifiable is not satisfied.
 */
export function validateHostAliasConfig({ raw, networkMode } = {}) {
  const parsed = parseHostAliasArgs(raw);
  if (!parsed.ok) return parsed;
  if (requiresHostNetwork(parsed.aliases) && networkMode !== 'host') {
    return fail(
      `a loopback host alias requires the container to share the host network namespace, `
      + `but ${NETWORK_MODE_ENV} is ${networkMode ? JSON.stringify(networkMode) : 'unset'}; `
      + `map a reachable address instead`,
    );
  }
  return parsed;
}
