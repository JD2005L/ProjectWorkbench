// Container host aliases: a DNS bypass the shared artifact can carry, without
// carrying anybody's hostname.
//
// WHY THE MECHANISM EXISTS. An MCP client gets ONE name resolution at session
// start and never retries, so a single transient negative answer (NXDOMAIN,
// surfacing as `getaddrinfo ENOTFOUND`) silently disables every MCP server
// configured by name for that entire session. nsswitch on the image is
// `hosts: files dns`, so a hosts entry wins and DNS is never consulted for that
// name — and `--add-host` is how podman injects one. It must be a FLAG rather
// than a file edit: the container's /etc/hosts is a tmpfs bind recreated on every
// restart, so a hand-added line evaporates exactly when the container is
// recreated.
//
// WHY THIS FILE REPLACED AN EXACT-HOST REGRESSION. The first fix wrote one
// deployment's FQDN into the canonical unit and then asserted that exact string,
// so the shared container artifact only worked at one site and the test enforced
// that it stay that way. The mapping is deployment configuration, so the tests
// here are about the CONTRACT — absent by default, validated when configured,
// fail-closed when malformed or when its precondition does not hold — and never
// about a particular name. Nothing in this file may name a real deployment's
// host; a fixture uses the reserved example/invalid namespaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseHostAliasArgs, validateHostAliasConfig, requiresHostNetwork,
  CONFIG_ERROR_EXIT,
} from '../app/host-alias.js';
import { CONFIG_ERROR_EXIT as ENV_CONFIG_ERROR_EXIT } from '../app/env-schema.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
/** A unit with comment lines stripped — the directives only, so an explanation
 *  that happens to mention a flag cannot satisfy or break a structural claim. */
const stripComments = (src) => src.split('\n').filter((l) => {
  const t = l.trim();
  return !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('*');
}).join('\n');
const unitCode = (p) => stripComments(read(p));
/** A unit's Exec* directives with backslash continuations folded back into one
 *  line each, so a claim about a command is made against the whole command. */
const execLines = (p) => stripComments(read(p))
  .replace(/\\\n\s*/g, ' ')
  .split('\n')
  .filter((l) => /^Exec(Start|StartPre|StartPost|Stop|Reload)=/.test(l));

const UNIT = 'systemd/pw-tmux.service';
const EXAMPLE_DROPIN = 'deploy/host/files/etc/systemd/system/pw-tmux.service.d/host-alias.conf.example';
const CHECKER = 'scripts/pw-host-alias-check';
const CHECKER_NAME = 'pw-host-alias-check';

// ---------------------------------------------------------------------------
// A — the canonical artifact is portable
// ---------------------------------------------------------------------------

// Deliberately expressed as "no mapping at all", not "not THAT mapping": a test
// that named the offending host would put it back into the tree it is removing
// it from, and would pass for the next deployment that hardcodes its own.
const ADD_HOST_WITH_VALUE = /--add-host[= ]+(?!\$)\S+/;

test('the canonical sidecar unit ships no host mapping of its own', () => {
  const code = unitCode(UNIT);
  assert.equal(ADD_HOST_WITH_VALUE.test(code), false,
    'the shared container artifact hardcodes a host mapping again; it belongs in deployment configuration');
});

test('no tracked runtime file hardcodes a host-to-address mapping', () => {
  // The class, not the instance. Runtime content only: documentation and
  // operator runbooks legitimately name the host they are instructions for, and
  // `.example` files are templates whose placeholders are checked separately.
  const RUNTIME_DIRS = ['app/', 'scripts/', 'systemd/', 'deploy/', 'config/', 'nginx/', 'bin/', 'tools/', 'standards/'];
  const RUNTIME_FILES = ['install.sh', 'deploy-local.sh', 'Containerfile'];
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const runtime = tracked.filter((f) => (
    (RUNTIME_FILES.includes(f) || RUNTIME_DIRS.some((d) => f.startsWith(d)))
    && !f.endsWith('.md') && !f.endsWith('.example') && !f.includes('.example.')
    && !f.startsWith('app/node_modules/')
  ));
  assert.ok(runtime.length >= 20, `the scan must actually cover the runtime tree; found ${runtime.length}`);

  // A hosts-file line — `<address> <name>` — is the same defect wearing the
  // other mechanism, so it is caught here too rather than after the next fix.
  const HOSTS_LINE = /^\s*\d{1,3}(?:\.\d{1,3}){3}\s+[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/m;
  const offenders = [];
  for (const f of runtime) {
    // Comment lines stripped, the same way the structural claims below read a
    // unit: prose that explains the mechanism necessarily writes the flag out,
    // and an explanation is not a mapping the runtime carries.
    const src = stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'));
    if (ADD_HOST_WITH_VALUE.test(src)) offenders.push(`${f}: --add-host carries a literal value`);
    if (HOSTS_LINE.test(src)) offenders.push(`${f}: a literal hosts-file mapping`);
  }
  assert.deepEqual(offenders, [], `hardcoded host mappings are back:\n  ${offenders.join('\n  ')}`);
});

test('the shipped example uses a reserved name, so it can never be a real deployment', () => {
  // The DIRECTIVE, not the prose: the comment block tells an operator to put
  // their own host in, and a "your.host.here" placeholder in an instruction is
  // clearer than a reserved TLD. What must never be real is the value that
  // ships as configuration.
  const src = stripComments(read(EXAMPLE_DROPIN));
  const values = [...src.matchAll(/--add-host[= ]+(\S+)/g)].map((m) => m[1]);
  assert.ok(values.length >= 1, 'the example must actually demonstrate the flag');
  for (const v of values) {
    const host = v.slice(0, v.indexOf(':'));
    assert.match(host, /\.(example|invalid|test|localhost)$|\.example\.(com|net|org)$/,
      `the example maps ${host}, which is not in a reserved namespace`);
  }
});

// ---------------------------------------------------------------------------
// B — the unit's wiring: configured, default-absent, fixed argv, no shell
// ---------------------------------------------------------------------------

test('the unit takes host aliases from configuration and defaults to none', () => {
  const code = unitCode(UNIT);
  assert.match(code, /ExecStart=[\s\S]*\$PW_TMUX_HOST_ALIAS_ARGS/,
    'the unit has no configuration-driven place for host aliases');
  // Unbraced on purpose: systemd splits an unbraced expansion at whitespace, so
  // an empty value contributes ZERO arguments. `${...}` would pass one empty
  // argument instead, which podman rejects — the default would not be "absent",
  // it would be "broken".
  assert.equal(/\$\{PW_TMUX_HOST_ALIAS_ARGS\}/.test(code), false,
    'a braced expansion passes one empty argument when unset instead of none');

  const defaultAt = code.indexOf('Environment=PW_TMUX_HOST_ALIAS_ARGS=');
  assert.ok(defaultAt >= 0, 'the unit must declare the empty default in canonical source');
  assert.match(code, /^Environment=PW_TMUX_HOST_ALIAS_ARGS=\s*$/m, 'the shipped default must be no override');

  // Order is the contract: systemd applies Environment= and EnvironmentFile= in
  // the order they appear, so the file can only override a default declared
  // before it.
  const fileAt = code.indexOf('EnvironmentFile=-/etc/project-workbench/pw.env');
  assert.ok(fileAt >= 0, 'the unit must offer the deployment an optional environment file');
  assert.ok(defaultAt < fileAt, 'the empty default must precede the environment file, or configuration cannot override it');
});

test('a loopback alias is only meaningful while the sidecar shares the host network namespace', () => {
  const code = unitCode(UNIT);
  // 127.0.0.1 means "the host" only because of --network=host. Without it,
  // loopback is the container itself and the alias silently points at nothing —
  // so the unit must declare the mode where the checker can read it, and the two
  // must agree.
  const sharesHostNet = /--network=host\b/.test(code);
  const declaresMode = /^Environment=PW_TMUX_NETWORK_MODE=host$/m.test(code);
  assert.equal(sharesHostNet, declaresMode,
    '--network=host and PW_TMUX_NETWORK_MODE must agree, or the loopback precondition cannot be checked');
  assert.ok(code.indexOf('--network=host') < code.indexOf('$PW_TMUX_HOST_ALIAS_ARGS'),
    'the aliases are only valid while --network=host precedes them');
});

test('the unit never edits /etc/hosts and never hands configuration to a shell', () => {
  const code = unitCode(UNIT);
  assert.equal(/>>\s*\/etc\/hosts/.test(code), false, 'the unit must not write /etc/hosts itself');
  assert.equal(/Exec\w+=[^\n]*\b(?:sh|bash)\s+-c\b/.test(code), false,
    'configuration must never be shell-evaluated; Exec lines are fixed argv');
});

/** The unit's own validating gate: a non-ignored ExecStartPre that runs the
 *  checker. Returned as a string so the assertions below can read its argv. */
const gateLine = () => execLines(UNIT).find((l) => l.includes(CHECKER_NAME) && l.startsWith('ExecStartPre='));

test('THE BYPASS: no configuration path the canonical unit advertises can skip validation', () => {
  // The defect this replaces. The unit advertised
  // `EnvironmentFile=-/etc/project-workbench/pw.env` as a supported way to set
  // the aliases, while the only ExecStartPre that validated them lived in an
  // OPTIONAL drop-in. An operator who used the advertised path — the documented
  // one — got no validation at all, so "fail closed" held for exactly the
  // configuration route that happened to carry its own checker.
  //
  // The gate therefore belongs to the unit that expands the value, and it is
  // asserted from the unit ALONE: whatever a deployment adds on top, reading
  // this one file has to prove every configured value is checked.
  const code = unitCode(UNIT);
  const expands = code.includes('$PW_TMUX_HOST_ALIAS_ARGS');
  assert.ok(expands, 'the unit no longer expands the aliases; this test is guarding nothing');

  const gate = gateLine();
  assert.ok(gate, `the unit expands host aliases but never runs ${CHECKER_NAME}; a configured pw.env would reach podman unvalidated`);
  assert.equal(gate.startsWith('ExecStartPre=-'), false,
    'a `-` prefix ignores the failure, which is the opposite of failing closed');
  assert.equal(/ExecStartPre=[-@:+!]*[-]/.test(gate), false, 'no systemd prefix may make the gate non-fatal');

  // Every source of the value is inside the gated unit. If a future change adds
  // another EnvironmentFile, it is covered by construction; what must never
  // happen is the value being read somewhere the gate is not.
  const sources = code.split('\n').filter((l) => /^EnvironmentFile=/.test(l));
  assert.ok(sources.length >= 1, 'the advertised environment-file path is gone; the test above assumed it');
  assert.ok(code.indexOf('Environment=PW_TMUX_HOST_ALIAS_ARGS=') >= 0);
});

test('the gate is not vacuous: it is handed the configured value and the network mode', () => {
  // A checker that runs without the variables validates an empty environment and
  // passes every time — a green gate in front of an unvalidated command line.
  const gate = gateLine();
  assert.ok(gate, 'no gate to check');
  for (const name of ['PW_TMUX_HOST_ALIAS_ARGS', 'PW_TMUX_NETWORK_MODE']) {
    assert.match(gate, new RegExp(`-e ${name}(?![A-Z_])`), `the gate never receives ${name}, so it cannot be checking it`);
  }
});

test('the gate exists because the same artifact the unit already requires carries it', () => {
  // The reason this is safe to make fatal. A non-`-` ExecStartPre naming a host
  // path that is not there is 203/EXEC — for THIS unit, every terminal on the
  // host failing to start — and install.sh refuses to run beside this sidecar,
  // so no host installer ships it. Running the checker out of the image the
  // ExecStart already depends on means the gate cannot be missing while the
  // thing it guards can still run.
  const gate = gateLine();
  const start = execLines(UNIT).find((l) => l.startsWith('ExecStart=/usr/bin/podman run'));
  assert.ok(gate && start, 'unit must have both a gate and a run line');
  const image = /(\S+:latest)\b/.exec(start);
  assert.ok(image, 'the ExecStart no longer names a tagged image');
  assert.ok(gate.includes(image[1]), `the gate must run ${image[1]}, the image whose presence the ExecStart already requires`);
  assert.match(gate, /\/usr\/bin\/podman/, 'the gate must use the same runtime the unit already requires');

  // Least privilege: validating configuration needs neither the host's PID
  // namespace nor privileged mode, and must not silently acquire them by being
  // copy-pasted from the run line below it.
  assert.equal(/--privileged\b/.test(gate), false, 'the gate must not run privileged');
  assert.equal(/--pid=host\b/.test(gate), false, 'the gate must not join the host PID namespace');

  // ...and the image really does carry it, at the path the gate names.
  const containerfile = read('Containerfile');
  assert.match(containerfile, /^COPY scripts\/ \/opt\/project-workbench\/scripts\/$/m,
    'the image no longer bakes scripts/, so the gate would 127 at every start');
  assert.match(containerfile, /^WORKDIR \/opt\/project-workbench\/app$/m);
  assert.match(containerfile, /^COPY app\/ \.\/$/m,
    'the image no longer bakes app/, so the checker could not resolve ../app/host-alias.js');
  const gatePath = new RegExp(`/opt/project-workbench/scripts/${CHECKER_NAME}`);
  assert.match(gate, gatePath, 'the gate must run the checker from the path the image bakes it to');
});

test('the deployment drop-in carries the value and nothing else', () => {
  const src = read(EXAMPLE_DROPIN);
  assert.match(src, /^Environment=PW_TMUX_HOST_ALIAS_ARGS=/m, 'the drop-in is where the value lives');
  // Validation is the unit's job, not something each deployment has to remember
  // to wire. A drop-in that carried its own ExecStartPre would suggest the
  // canonical unit does not already check — the confusion that produced the
  // bypass this file now guards.
  assert.equal(/^ExecStartPre=/m.test(src), false,
    'the drop-in must not carry a gate of its own; the canonical unit gates every configured value');
});

test('the operator can run the same checker by hand before restarting the unit', () => {
  // Convenience, NOT the gate: the authoritative check runs from the image on
  // every start. This one lets an operator validate an edited drop-in before
  // `systemctl restart` takes every terminal down with it.
  const src = read('deploy/host/install.sh');
  assert.match(src, new RegExp(`/usr/local/sbin/${CHECKER_NAME}`), 'the manual preflight is installed nowhere');
  // The Round 12 defect: an ES module installed flat resolves `../app/…` to
  // /usr/local/app and dies ERR_MODULE_NOT_FOUND on every invocation. It goes
  // beside app/ and reaches PATH through a symlink, exactly like the others.
  assert.match(src, /app\/host-alias\.js/, 'the module the checker imports is not installed with it');
});

// ---------------------------------------------------------------------------
// C — the contract: default absent, configured valid, malformed, precondition
// ---------------------------------------------------------------------------

test('the default is no override: unset, empty and whitespace all mean zero aliases', () => {
  for (const raw of [undefined, null, '', '   ', '\t\n ']) {
    const r = parseHostAliasArgs(raw);
    assert.equal(r.ok, true, `${JSON.stringify(raw)} must be accepted as "no override"`);
    assert.deepEqual(r.aliases, []);
    assert.deepEqual(r.args, [], 'an unconfigured instance must contribute no arguments at all');
  }
});

test('a configured mapping resolves to fixed argv, never to a string a shell would split', () => {
  const r = parseHostAliasArgs('--add-host mcp.example.invalid:127.0.0.1');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.args, ['--add-host', 'mcp.example.invalid:127.0.0.1']);
  assert.deepEqual(r.aliases, [{ host: 'mcp.example.invalid', address: '127.0.0.1', family: 4, loopback: true }]);
});

test('both flag spellings, several aliases and irregular spacing all parse', () => {
  const r = parseHostAliasArgs('  --add-host=a.example:10.0.0.5   --add-host b.example:2001:db8::1  ');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.args, ['--add-host', 'a.example:10.0.0.5', '--add-host', 'b.example:2001:db8::1']);
  assert.equal(r.aliases[1].address, '2001:db8::1', 'an IPv6 literal keeps its colons; only the first one separates');
  assert.equal(r.aliases[0].loopback, false);
});

test('the address must be a LITERAL — a name would put DNS back in the path', () => {
  const r = parseHostAliasArgs('--add-host a.example:b.example');
  assert.equal(r.ok, false);
  assert.match(r.error, /literal/i, 'the reason must say why a name is refused');
});

test('malformed configuration fails closed, and the reason names the offending token', () => {
  const cases = [
    ['--add-host', 'a flag with no value'],
    ['--add-host ', 'a flag with no value'],
    ['--add-host a.example', 'no separator'],
    ['--add-host :127.0.0.1', 'an empty host'],
    ['--add-host a.example:', 'an empty address'],
    ['--add-host a.example:127.0.0.256', 'an out-of-range octet'],
    ['--add-host a.example:0177.0.0.1', 'an octal-looking octet'],
    ['--add-host -a.example:127.0.0.1', 'a label starting with a hyphen'],
    ['--add-host a b.example:127.0.0.1', 'a space inside the value'],
    ['--add-host a/b.example:127.0.0.1', 'a slash in the host'],
    ['--privileged', 'a flag that is not --add-host'],
    ['--add-host a.example:127.0.0.1 --privileged', 'an extra flag smuggled in behind a valid one'],
    ['--add-host a.example:127.0.0.1 extra', 'a bare trailing token'],
    ['--add-host a.example:127.0.0.1 --add-host a.example:10.0.0.5', 'the same host mapped twice, differently'],
  ];
  for (const [raw, why] of cases) {
    const r = parseHostAliasArgs(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} (${why}) was accepted`);
    assert.ok(typeof r.error === 'string' && r.error.length > 10, `${JSON.stringify(raw)} must explain itself`);
    assert.deepEqual(r.args, [], 'a refused configuration must never yield partial arguments');
  }
});

test('the same host mapped twice to the same address is not a conflict', () => {
  const r = parseHostAliasArgs('--add-host a.example:10.0.0.5 --add-host a.example:10.0.0.5');
  assert.equal(r.ok, true, r.error);
});

test('the loopback precondition: a loopback alias without host networking fails closed', () => {
  const loopback = '--add-host a.example:127.0.0.1';
  assert.equal(validateHostAliasConfig({ raw: loopback, networkMode: 'host' }).ok, true);
  for (const mode of [undefined, '', 'bridge', 'none', 'slirp4netns']) {
    const r = validateHostAliasConfig({ raw: loopback, networkMode: mode });
    assert.equal(r.ok, false, `a loopback alias must be refused with network mode ${JSON.stringify(mode)}`);
    assert.match(r.error, /network/i);
    assert.deepEqual(r.args, []);
  }
  // A routable address carries no such precondition.
  assert.equal(validateHostAliasConfig({ raw: '--add-host a.example:10.0.0.5', networkMode: 'bridge' }).ok, true);
  // ...and neither does the default, which is the whole point of defaulting off.
  assert.equal(validateHostAliasConfig({ raw: '', networkMode: 'bridge' }).ok, true);
});

test('IPv6 loopback counts as loopback, including the IPv4-mapped spelling', () => {
  assert.equal(requiresHostNetwork(parseHostAliasArgs('--add-host a.example:::1').aliases), true);
  assert.equal(requiresHostNetwork(parseHostAliasArgs('--add-host a.example:::ffff:127.0.0.1').aliases), true);
  assert.equal(requiresHostNetwork(parseHostAliasArgs('--add-host a.example:2001:db8::1').aliases), false);
  assert.equal(requiresHostNetwork([]), false);
});

test('the configuration-error exit is EX_CONFIG, the same one the environment contract uses', () => {
  assert.equal(CONFIG_ERROR_EXIT, 78);
  assert.equal(CONFIG_ERROR_EXIT, ENV_CONFIG_ERROR_EXIT, 'two config-error codes would let a supervisor read one as a crash');
});

// ---------------------------------------------------------------------------
// D — the checker the drop-in runs
// ---------------------------------------------------------------------------

/** The checker runs as its own process, the way the drop-in runs it, so the exit
 *  code the gate depends on is the one actually observed. */
const runCheck = (env) => spawnSync(process.execPath, [path.join(REPO, CHECKER)], {
  env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
});

test('the checker passes an unconfigured instance without consulting anything', () => {
  const r = runCheck({});
  assert.equal(r.status, 0, r.stderr);
});

test('the checker passes a valid configured mapping', () => {
  const r = runCheck({ PW_TMUX_HOST_ALIAS_ARGS: '--add-host a.example:127.0.0.1', PW_TMUX_NETWORK_MODE: 'host' });
  assert.equal(r.status, 0, r.stderr);
});

test('the checker exits EX_CONFIG and explains itself on a malformed value', () => {
  const r = runCheck({ PW_TMUX_HOST_ALIAS_ARGS: '--add-host a.example:not-an-address' });
  assert.equal(r.status, CONFIG_ERROR_EXIT, 'a misconfigured instance must be distinguishable from a crashed one');
  assert.match(r.stderr, /PW_TMUX_HOST_ALIAS_ARGS/, 'the operator must be told which variable is wrong');
});

test('the checker exits EX_CONFIG when the loopback precondition does not hold', () => {
  const r = runCheck({ PW_TMUX_HOST_ALIAS_ARGS: '--add-host a.example:127.0.0.1', PW_TMUX_NETWORK_MODE: 'bridge' });
  assert.equal(r.status, CONFIG_ERROR_EXIT);
  assert.match(r.stderr, /network/i);
});
