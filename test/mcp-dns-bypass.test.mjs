// The sidecar must take DNS out of the path for this host's own FQDN.
//
// All four MCP servers in ~/.claude.json — teamkb, pulse, skillhub,
// visual-identity — are configured with this host's FQDN. An MCP client gets ONE
// resolution attempt at session start and never retries, so a single transient
// negative DNS answer (NXDOMAIN, surfacing as `getaddrinfo ENOTFOUND`) silently
// disables ALL FOUR for that entire session. Observed 2026-09-08; the TeamKB
// project measured the trigger as a transient NXDOMAIN from a GOA resolver — not
// a local misconfiguration, and not a TeamKB defect.
//
// nsswitch on the image is `hosts: files dns`, so a hosts entry wins and DNS is
// never consulted for that name. `--add-host` is how podman injects one: the
// container's /etc/hosts is a tmpfs bind from its own userdata, recreated on every
// restart, so it must be given as a flag rather than edited to persist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
/** The unit with comment lines stripped — the flags only, so an explanation that
 *  happens to mention a flag cannot satisfy or break a structural assertion. */
const unitCode = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('the sidecar bypasses DNS for the MCP FQDN, and keeps the FQDN', () => {
  const unit = read('systemd/pw-tmux.service');
  assert.match(unit, /--add-host vnl2422\.rm\.gov\.ab\.ca:127\.0\.0\.1/, 'the MCP DNS bypass is gone');

  // THE FQDN CANNOT BE SWAPPED FOR AN ADDRESS. The certificate's SAN is
  // DNS:vnl2422.rm.gov.ab.ca only, so https://127.0.0.1/... fails verification
  // (curl exit 60, measured), and dropping to http to avoid that would put the
  // MCP bearer token — and any revealed secret — in cleartext even over loopback.
  // This assertion exists because "just use the IP in the URL" is the obvious
  // wrong simplification, and it was my first suggestion before it was measured.
  // Asserted on stable tokens, not prose: the explanation is a wrapped comment and
  // matching a sentence across the wrap is brittle.
  assert.match(unit, /\bSAN\b/, 'the certificate-SAN reason the FQDN cannot become an IP is no longer recorded');
  assert.match(unit, /curl exit 60/, 'the measured evidence that an IP URL fails verification is gone');

  // 127.0.0.1 is correct ONLY because the sidecar shares the host network
  // namespace. If --network=host ever goes, loopback becomes the container itself
  // and this mapping silently points the MCP clients at nothing.
  const code = unitCode('systemd/pw-tmux.service');
  assert.ok(code.indexOf('--network=host') < code.indexOf('--add-host'),
    '--add-host 127.0.0.1 is only valid while --network=host precedes it');
  assert.match(unit, /--network=host below/, 'the --network=host precondition is no longer stated');
});

test('the bypass is a flag, not an edit to /etc/hosts', () => {
  const unit = read('systemd/pw-tmux.service');
  // A hosts entry written inside the container is lost on restart, so a fix that
  // relied on editing the file would evaporate exactly when the container is
  // recreated — which is when sessions are already being disrupted.
  assert.match(unit, /recreated on every|recreated on restart|tmpfs bind/i,
    'the reason this must be a flag rather than a file edit is no longer recorded');
  assert.ok(!/echo .*>> ?\/etc\/hosts/.test(unit), 'the unit must not try to write /etc/hosts itself');
});
