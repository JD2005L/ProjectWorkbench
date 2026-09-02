// Candidate C — the dispositions it must NOT quietly overturn, and portability.
//
// GOA-2 originally deferred container replay: keep exit-on-dead-server /
// self-restore host-mode-only and preserve existing container behaviour. That
// half was REVISED on 2026-09-02 — PVI accepted the revision in principle
// ("container rebuild persistence is required") because container mode had no
// snapshot/replay at all, so an image rebuild destroyed every session. The two
// assertions that pinned the deferral are therefore replaced below by the
// contract the accepted feature must meet; everything else in GOA-2 stands.
// GOA-5 was DISPUTED and withdrawn: the documented host default is retained, and
// no new refusal on ambiguous deploy mode may be introduced.
//
// A candidate that "improves" either of those is out of contract, so both are
// pinned here rather than left to reviewer memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const NEW_SOURCES = ['app/tmux-owner.js', 'app/tmux-owner-gate.js', 'scripts/pw-tmux-assert-owner', 'scripts/pw-tmux-keepalive.sh', 'systemd/pw-tmux-server.service'];

// --- GOA-2: supervision retained, replay deferred ---------------------------

test('GOA-2 (revised): the owner UNIT still adds no restore, and replay is container-only', () => {
  // Unchanged half: the host owner unit must not gain restore. Host mode already
  // has pw-tmux-persist.service for that, and ExecStartPost is how the superseded
  // candidate smuggled replay into the owner.
  const unit = read('systemd/pw-tmux-server.service');
  assert.equal(/pw-tmux-restore/.test(unit), false, 'the host owner unit must not invoke restore');
  assert.equal(/ExecStartPost/.test(unit), false, 'ExecStartPost must not reintroduce restore into the owner unit');
  // Revised half: the sidecar MAY replay, but only in container mode, because the
  // sidecar has no systemd and nothing else can do it there.
  const keepalive = read('scripts/pw-tmux-keepalive.sh');
  assert.match(keepalive, /pw-tmux-restore/, 'container replay is now required (GOA-2 revised 2026-09-02)');
  assert.match(keepalive, /if \[\[ "\$HOST_MODE" != 1 \]\]; then/, 'replay must stay gated to container mode');
});

test('GOA-2: container supervision is retained, not converted to host-only behaviour', () => {
  const keepalive = read('scripts/pw-tmux-keepalive.sh');
  // The sidecar must still supervise in the FOREGROUND and never exit on its own;
  // the snapshot loop replaced `tail -f /dev/null` but must keep that property,
  // because the server's cgroup lives and dies with this process.
  assert.match(keepalive, /^while :; do$/m, 'the container foreground supervision must remain');
  assert.match(keepalive, /trap term TERM INT/, 'the sidecar must still exit cleanly on signal, not abort');
  // And readiness must never be an exit path in container mode.
  assert.match(keepalive, /PW_TMUX_HOST_MODE/, 'readiness must be gated on host mode');
  // Only actual INVOCATIONS matter; a `command -v systemd-notify` guard is the
  // mechanism that makes absence tolerable, not a call that could exit.
  const notifyCalls = keepalive.split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /(^|[^-\w])systemd-notify\s+--/.test(l));
  assert.ok(notifyCalls.length > 0, 'expected a readiness call to exist at all');
  for (const line of notifyCalls) {
    assert.match(line, /\|\|\s*true/, `systemd-notify must be tolerated-absent, never an exit path: ${line.trim()}`);
  }
});

test('GOA-2: no opt-in restore-on-start switch was added', () => {
  for (const f of ['scripts/pw-tmux-keepalive.sh', 'systemd/pw-tmux-server.service', 'install.sh']) {
    assert.equal(/RESTORE_ON_START|restore_on_start|PW_TMUX_RESTORE_ON_START/.test(read(f)), false,
      `${f} introduces an opt-in restore-on-start, which GOA-2 defers`);
  }
});

// --- GOA-5: documented host default retained --------------------------------

test('GOA-5: host remains the default deploy mode, with no new ambiguity refusal', () => {
  for (const f of ['scripts/pw-tmux-keepalive.sh', 'app/tmux-owner.js', 'install.sh']) {
    const src = read(f);
    // The default must be host, expressed as a default rather than a demand.
    assert.equal(/PW_DEPLOY_MODE[^\n]*(is required|must be set|unset with no default)/i.test(src), false,
      `${f} makes PW_DEPLOY_MODE mandatory, which GOA-5 withdrew`);
  }
  assert.match(read('app/tmux-owner.js'), /PW_DEPLOY_MODE \|\| 'host'/, 'host must remain the documented default');
});

// --- C10 hermeticity / C11 portability --------------------------------------

test('the tmux harnesses scrub every variable that could make them lie', () => {
  const harness = read('test/tmux-owner-readiness.test.mjs');
  for (const v of ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'NOTIFY_SOCKET', 'PW_ENV_FILE', 'PW_DEPLOY_MODE']) {
    assert.ok(harness.includes(v), `the readiness harness does not neutralise ${v}`);
  }
  // Socket paths are bounded by sockaddr_un (~104 bytes); a long mkdtemp root
  // makes a passing suite fail for an unrelated reason.
  assert.match(harness, /mkdtempSync\('\/tmp\/pwt-'\)/, 'the harness must use a short private socket root');
});

test('no credential-boundary or tmux source embeds an environment-specific path or identity', () => {
  const forbidden = [/\bpvi2?\b/i, /\bgoa\b/i, /\/home\/admin\b/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\.local\b/];
  // CODE only. These files legitimately cite GOA/PVI in comments — they record
  // which coordination constraint a line exists to satisfy, which is exactly the
  // provenance a reviewer needs. What must never appear is an environment-specific
  // value the product actually USES.
  for (const f of NEW_SOURCES) {
    const code = read(f).split('\n')
      .filter((l) => { const t = l.trim(); return !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('*'); })
      .join('\n');
    for (const pattern of forbidden) {
      const hit = code.match(pattern);
      assert.equal(hit, null, `${f} embeds an environment-specific literal in code: ${hit && hit[0]}`);
    }
  }
});

test('the owner resolves its identity from configuration, never a baked-in account', () => {
  for (const f of ['app/tmux-owner.js', 'scripts/pw-tmux-keepalive.sh']) {
    const src = read(f);
    for (const line of src.split('\n')) {
      const code = line.replace(/^\s+/, '');
      if (code.startsWith('#') || code.startsWith('//')) continue;
      assert.equal(/['"]admin['"]/.test(code), false, `${f} hard-codes an account name: ${code.trim().slice(0, 90)}`);
    }
  }
});
