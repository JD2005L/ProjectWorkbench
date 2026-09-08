// THE INVARIANT: fixture cleanup must never kill a tmux server it did not create.
//
// test/tmux-owner-fixture.mjs stands private tmux servers up and, since #56, takes
// them down again on process exit — `tmux -L <socket> kill-server` followed by an
// unlink of the socket file. That is a genuinely destructive pair, so the set of
// sockets it is allowed to point at is a security boundary, not housekeeping.
//
// THE DEFECT (PVI review of #57). The refusal list was two literals: the name
// `default`, and `$PW_TMUX_SOCKET`. Neither describes the server the test process
// is actually INSIDE. A ProjectWorkbench terminal runs the suite from within tmux,
// which exports
//
//     TMUX=<socket-path>,<server-pid>,<session-id>
//
// and that first field names the LIVE server. Where the live socket is not called
// `default` and PW_TMUX_SOCKET is not in the runner's environment — a terminal on a
// named socket, a wrapper that scrubs PW_TMUX_*, a container hop — the inherited
// name passed straight through the filter, and cleanup would have issued
// `kill-server` against the running workbench and then unlinked its socket file.
//
// Verified against tmux 3.4 here, because the whole threat depends on it: `-L NAME`
// wins over an inherited `$TMUX`, and resolves to `$TMUX_TMPDIR/tmux-<uid>/NAME`.
// So a kill aimed at the inherited NAME lands on the live server, and `kill-server`
// leaves the socket file behind — which is why the fixture unlinks it, and why the
// unlink is the second destructive limb this file also pins.
//
// AND THE SOCKET PATH IN $TMUX CAN CONTAIN COMMAS. tmux appends `,<server-pid>,
// <session-id>` to the socket path, and `-L` rejects only `/` — a comma is a legal
// socket name. `tmux -L 'pwcomma-a,sentinel'` on tmux 3.4 really does produce
//
//     TMUX=/tmp/pwcm-S3oa/tmux-1000/pwcomma-a,sentinel,2324856,0
//
// so reading the path as everything before the FIRST comma truncates it, derives
// `pwcomma-a` for a server actually called `pwcomma-a,sentinel`, and leaves the
// live server unprotected under its real name. The two trailing numeric fields are
// parsed off the RIGHT instead, which preserves every comma in the path. The last
// test in this file pins that derivation against tmux itself rather than against a
// belief about the format.
//
// HOW THIS IS PROVED SAFELY. Every authority test runs in a child process whose
// PATH contains a FAKE tmux that only records its argv, and whose TMUX_TMPDIR is a
// throwaway directory holding decoy socket files. No real tmux binary is reachable
// from those children and no real socket directory is in scope, so the harness
// cannot touch a live server even when the assertion it is making fails. The two
// tests that do use the real tmux use freshly generated private socket names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OWNER_FIXTURE = fileURLToPath(new URL('./tmux-owner-fixture.mjs', import.meta.url));
const PANE_FIXTURE = fileURLToPath(new URL('./pane-env-fixture.mjs', import.meta.url));
const UID = process.getuid();
const HAVE_TMUX = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------------------
// Command capture: a fake tmux, a private socket directory, decoy socket files
// ---------------------------------------------------------------------------

function stage() {
  // Short prefix on purpose: a unix socket path is capped at ~108 bytes, and the
  // decoys have to sit at a path tmux itself would accept.
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pwfxauth-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'argv.log');
  fs.mkdirSync(bin);
  // Records its argv, one tab-separated line per invocation, and does nothing else.
  const fake = path.join(bin, 'tmux');
  fs.writeFileSync(fake, `#!/bin/sh\n{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}\nexit 0\n`);
  fs.chmodSync(fake, 0o755);
  const sockDir = path.join(root, `tmux-${UID}`);
  fs.mkdirSync(sockDir);
  return { root, bin, log, sockDir };
}

/** A decoy socket file standing in for a server this process must not touch. */
function decoy(st, name) {
  const p = path.join(st.sockDir, name);
  fs.writeFileSync(p, '');
  return p;
}

function childEnv(st, extra = {}) {
  // BUILT, never spread from process.env: spreading would hand the child the real
  // $TMUX and the real socket directory, which is the very thing under test.
  return {
    PATH: `${st.bin}:/usr/bin:/bin`,
    HOME: st.root,
    LANG: 'C.UTF-8',
    TMUX_TMPDIR: st.root,
    ...extra,
  };
}

/**
 * Register each socket with the fixture and run cleanup, in a child process, so
 * both the explicit call and the process-exit hook are exercised.
 */
function runCleanup(st, sockets, env) {
  const script = path.join(st.root, 'probe.mjs');
  fs.writeFileSync(script, [
    `import { registerFixtureTmuxServer, killFixtureTmuxServers } from ${JSON.stringify(OWNER_FIXTURE)};`,
    'for (const s of JSON.parse(process.argv[2])) registerFixtureTmuxServer(s);',
    'killFixtureTmuxServers();',
  ].join('\n'));
  const r = spawnSync(process.execPath, [script, JSON.stringify(sockets)], {
    env, encoding: 'utf8', timeout: 60000,
  });
  return r;
}

/** The `-L` argument of every kill-server the fake tmux was asked to run. */
function killedSockets(st) {
  if (!fs.existsSync(st.log)) return [];
  return fs.readFileSync(st.log, 'utf8').split('\n').filter(Boolean)
    .map((line) => line.split('\t').filter((f) => f !== ''))
    .filter((argv) => argv.includes('kill-server'))
    .map((argv) => (argv.indexOf('-L') >= 0 ? argv[argv.indexOf('-L') + 1] : argv.join(' ')));
}

function withStage(fn) {
  const st = stage();
  try { return fn(st); } finally { fs.rmSync(st.root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// The blocker: the server this process is INSIDE, named only by $TMUX
// ---------------------------------------------------------------------------

test('cleanup never kills the native tmux server inherited through $TMUX', () => {
  withStage((st) => {
    const name = 'sentinel-inherited-native';
    const socketFile = decoy(st, name);
    const env = childEnv(st, { TMUX: `${socketFile},999999,13` });

    const child = runCleanup(st, [name], env);
    assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

    assert.deepEqual(killedSockets(st), [],
      `cleanup issued kill-server for ${name}, the socket $TMUX names as the server this process `
      + 'is running inside — a server the fixture did not create');
    assert.equal(fs.existsSync(socketFile), true,
      `cleanup unlinked ${socketFile}, the inherited server's own socket file`);
  });
});

test('cleanup never kills the inherited server named by its full socket PATH either', () => {
  withStage((st) => {
    const name = 'sentinel-inherited-native';
    const socketFile = decoy(st, name);
    const env = childEnv(st, { TMUX: `${socketFile},999999,13` });

    const child = runCleanup(st, [socketFile], env);
    assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

    assert.deepEqual(killedSockets(st), [],
      'cleanup accepted the inherited socket path as a fixture socket');
    assert.equal(fs.existsSync(socketFile), true, 'the inherited socket file was unlinked');
  });
});

// ---------------------------------------------------------------------------
// ...whose socket name may itself contain commas
// ---------------------------------------------------------------------------

// A socket path is not comma-free, so it cannot be read as "everything before the
// first comma". These two are the same pair as above, for a live server whose real
// -L name carries the separator that $TMUX also uses.
const COMMA_NAME = 'pwcomma-a,sentinel';

test('cleanup never kills an inherited server whose socket NAME contains commas', () => {
  withStage((st) => {
    const socketFile = decoy(st, COMMA_NAME);
    const env = childEnv(st, { TMUX: `${socketFile},2324856,0` });

    const child = runCleanup(st, [COMMA_NAME], env);
    assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

    assert.deepEqual(killedSockets(st), [],
      `cleanup issued kill-server for ${COMMA_NAME}: reading $TMUX up to the FIRST comma derives `
      + '"pwcomma-a" and leaves the live server unprotected under the name it actually has');
    assert.equal(fs.existsSync(socketFile), true,
      "cleanup unlinked the comma-named inherited server's own socket file");
  });
});

test('cleanup never kills an inherited comma-bearing server named by its full socket PATH', () => {
  withStage((st) => {
    const socketFile = decoy(st, COMMA_NAME);
    const env = childEnv(st, { TMUX: `${socketFile},2324856,0` });

    const child = runCleanup(st, [socketFile], env);
    assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

    assert.deepEqual(killedSockets(st), [],
      'cleanup accepted the truncated inherited socket path as a fixture socket');
    assert.equal(fs.existsSync(socketFile), true, 'the inherited socket file was unlinked');
  });
});

test('the fixture refuses to stand a session up on a comma-bearing inherited server', () => {
  withStage((st) => {
    const script = path.join(st.root, 'mark.mjs');
    fs.writeFileSync(script, [
      `import { markOwnedServer } from ${JSON.stringify(OWNER_FIXTURE)};`,
      `try { markOwnedServer({ socket: process.argv[2], dir: ${JSON.stringify(st.root)} }); }`,
      "catch (e) { console.log('REFUSED: ' + e.message); process.exit(0); }",
      "console.log('ACCEPTED');",
    ].join('\n'));
    const env = childEnv(st, { TMUX: `${path.join(st.sockDir, COMMA_NAME)},2324856,0` });

    const child = spawnSync(process.execPath, [script, COMMA_NAME], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);
    assert.match(child.stdout, /^REFUSED: /, `markOwnedServer accepted ${COMMA_NAME}: ${child.stdout}`);
    assert.equal(fs.existsSync(st.log), false, 'the fixture ran tmux against the inherited server before refusing');
  });
});

// ---------------------------------------------------------------------------
// The protections that already existed, pinned so the repair cannot drop them
// ---------------------------------------------------------------------------

for (const [what, socket, extraEnv] of [
  ['the shared default server', 'default', {}],
  ['the server $PW_TMUX_SOCKET names', 'sentinel-pw-socket', { PW_TMUX_SOCKET: 'sentinel-pw-socket' }],
]) {
  test(`cleanup never kills ${what}`, () => {
    withStage((st) => {
      const socketFile = decoy(st, socket);
      const env = childEnv(st, { TMUX: `${path.join(st.sockDir, 'someone-elses')},999999,13`, ...extraEnv });

      const child = runCleanup(st, [socket], env);
      assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

      assert.deepEqual(killedSockets(st), [], `cleanup issued kill-server for ${socket}`);
      assert.equal(fs.existsSync(socketFile), true, `cleanup unlinked ${socketFile}`);
    });
  });
}

// ---------------------------------------------------------------------------
// A $TMUX that cannot be read must not widen what cleanup may kill
// ---------------------------------------------------------------------------

for (const malformed of [',,', ',', '   ', '/,1,0']) {
  test(`an inherited $TMUX of ${JSON.stringify(malformed)} names no server, so cleanup claims none`, () => {
    withStage((st) => {
      // Deliberately a name that LOOKS like a private fixture socket. Inside a tmux
      // server whose socket cannot be identified, no name can be proven private —
      // so the safe answer is to claim nothing and leak, never to guess and kill.
      const socket = 'pwfx-looks-private';
      const socketFile = decoy(st, socket);
      const env = childEnv(st, { TMUX: malformed });

      const child = runCleanup(st, [socket], env);
      assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

      assert.deepEqual(killedSockets(st), [],
        'an unreadable $TMUX still leaves this process inside SOME server; cleanup must not guess');
      assert.equal(fs.existsSync(socketFile), true, 'cleanup unlinked a socket file it could not vouch for');
    });
  });
}

// ---------------------------------------------------------------------------
// And the point of the mechanism still works
// ---------------------------------------------------------------------------

test('cleanup DOES kill a private fixture socket, and removes its socket file', () => {
  withStage((st) => {
    const socket = `pwfx-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const socketFile = decoy(st, socket);
    const env = childEnv(st, { TMUX: `${path.join(st.sockDir, 'default')},999999,13`, PW_TMUX_SOCKET: 'pw' });

    const child = runCleanup(st, [socket], env);
    assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);

    assert.deepEqual(killedSockets(st), [socket], 'a genuinely private fixture server must still be reaped');
    assert.equal(fs.existsSync(socketFile), false, 'and its socket file must not be left behind');
  });
});

// ---------------------------------------------------------------------------
// Against the REAL tmux, on throwaway private sockets: both creation orders
// ---------------------------------------------------------------------------

function privateSocket(tag) {
  return `pwfxauth-${tag}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function serverIsLive(socket) {
  return spawnSync('tmux', ['-L', socket, 'list-sessions'], { stdio: 'ignore' }).status === 0;
}

function realSocketFile(socket) {
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${UID}`, socket);
}

for (const [order, body] of [
  ['created by the fixture itself', `
    const { ownedTmuxFixture } = await import(${JSON.stringify(OWNER_FIXTURE)});
    ownedTmuxFixture({ socket: SOCKET, dir: DIR });
  `],
  ['adopted from a pre-scrubbed server', `
    const { startCleanTmuxServer } = await import(${JSON.stringify(PANE_FIXTURE)});
    const { ownedTmuxFixture } = await import(${JSON.stringify(OWNER_FIXTURE)});
    startCleanTmuxServer(SOCKET);
    ownedTmuxFixture({ socket: SOCKET, dir: DIR });
  `],
]) {
  test(`a private fixture server ${order} is reaped, socket file included`, { skip: HAVE_TMUX ? false : 'not run: tmux is not installed here' }, () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pwfxreal-')));
    const socket = privateSocket('real');
    try {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const SOCKET = ${JSON.stringify(socket)}; const DIR = ${JSON.stringify(dir)};\n${body}`,
      ], { encoding: 'utf8', timeout: 60000 });
      assert.equal(child.status, 0, `the fixture child failed: ${child.stderr}`);
      assert.equal(child.stderr.includes('no server running'), false, child.stderr);

      assert.equal(serverIsLive(socket), false,
        `the fixture left a live tmux server on ${socket} after its process exited`);
      assert.equal(fs.existsSync(realSocketFile(socket)), false,
        `the fixture left ${realSocketFile(socket)} behind — kill-server does not unlink its own socket`);
    } finally {
      spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
      fs.rmSync(realSocketFile(socket), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// The derivation itself, as a pure function
// ---------------------------------------------------------------------------

test('the inherited identity is derived from $TMUX, and says so when it cannot be', async () => {
  const { inheritedTmuxIdentity } = await import('./tmux-owner-fixture.mjs');

  for (const [tmux, expected] of [
    // The documented shape: <socket-path>,<server-pid>,<session-id>.
    ['/tmp/tmux-1000/default,3406243,13', { present: true, ambiguous: false, names: ['default'], paths: ['/tmp/tmux-1000/default'] }],
    // A live server that is NOT called `default` — the case the old two literals missed.
    ['/run/tmux-1000/pw,42,0', { present: true, ambiguous: false, names: ['pw'], paths: ['/run/tmux-1000/pw'] }],
    // A comma is legal in a socket name, so the path is read from the RIGHT. This is
    // the literal value tmux 3.4 produced for `tmux -L 'pwcomma-a,sentinel'`.
    ['/tmp/pwcm-S3oa/tmux-1000/pwcomma-a,sentinel,2324856,0',
      { present: true, ambiguous: false, names: ['pwcomma-a,sentinel'], paths: ['/tmp/pwcm-S3oa/tmux-1000/pwcomma-a,sentinel'] }],
    // ...however many commas it carries, and even where a trailing pair looks numeric.
    ['/tmp/tmux-1000/a,b,c,42,7', { present: true, ambiguous: false, names: ['a,b,c'], paths: ['/tmp/tmux-1000/a,b,c'] }],
    ['/tmp/tmux-1000/x,5,6,999,13', { present: true, ambiguous: false, names: ['x,5,6'], paths: ['/tmp/tmux-1000/x,5,6'] }],
    // An empty session id still parses: the pid field is what ends the path.
    ['/tmp/tmux-1000/default,3406243,', { present: true, ambiguous: false, names: ['default'], paths: ['/tmp/tmux-1000/default'] }],
    // Not inside tmux at all — nothing inherited, and nothing to protect.
    [undefined, { present: false, ambiguous: false, names: [], paths: [] }],
    ['', { present: false, ambiguous: false, names: [], paths: [] }],
    // Inside SOME server, described by a value that is not the documented shape.
    // Ambiguous — cleanup claims nothing — while still protecting all that can be
    // gleaned, because over-refusing is the safe direction.
    ['/tmp/tmux-1000/lonely', { present: true, ambiguous: true, names: ['lonely'], paths: ['/tmp/tmux-1000/lonely'] }],
    ['/tmp/tmux-1000/default,notapid,13', { present: true, ambiguous: true, names: [], paths: [] }],
    [',,', { present: true, ambiguous: true, names: [], paths: [] }],
    [',1,0', { present: true, ambiguous: true, names: [], paths: [] }],
    ['   ', { present: true, ambiguous: true, names: [], paths: [] }],
    // Parses, but yields no usable socket NAME — also ambiguous.
    ['/,1,0', { present: true, ambiguous: true, names: [], paths: ['/'] }],
  ]) {
    assert.deepEqual(
      inheritedTmuxIdentity(tmux === undefined ? {} : { TMUX: tmux }), expected,
      `inherited identity of TMUX=${JSON.stringify(tmux)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Refusing to TOUCH, not merely refusing to kill
// ---------------------------------------------------------------------------

// Cleanup authority is the destructive half, but it is not the only way a fixture
// reaches a server it does not own: markOwnedServer() would otherwise stand a
// keepalive session up on the shared server and stamp the production owner marker
// onto it. Refused before any tmux runs, and OUTSIDE the try that absorbs a lost
// creation race, so the refusal cannot be swallowed as "raced".
for (const [what, socket, extraEnv] of [
  ['the shared default server', 'default', {}],
  ['the server $PW_TMUX_SOCKET names', 'sentinel-pw-socket', { PW_TMUX_SOCKET: 'sentinel-pw-socket' }],
  ['the server inherited through $TMUX', 'sentinel-inherited-native', {}],
]) {
  test(`the fixture refuses to stand a session up on ${what} at all`, () => {
    withStage((st) => {
      const script = path.join(st.root, 'mark.mjs');
      fs.writeFileSync(script, [
        `import { markOwnedServer } from ${JSON.stringify(OWNER_FIXTURE)};`,
        `try { markOwnedServer({ socket: process.argv[2], dir: ${JSON.stringify(st.root)} }); }`,
        "catch (e) { console.log('REFUSED: ' + e.message); process.exit(0); }",
        "console.log('ACCEPTED');",
      ].join('\n'));
      const env = childEnv(st, {
        TMUX: `${path.join(st.sockDir, 'sentinel-inherited-native')},999999,13`, ...extraEnv,
      });

      const child = spawnSync(process.execPath, [script, socket], { env, encoding: 'utf8', timeout: 60000 });
      assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);
      assert.match(child.stdout, /^REFUSED: /, `markOwnedServer accepted ${socket}: ${child.stdout}`);
      assert.equal(fs.existsSync(st.log), false,
        `the fixture ran tmux against ${socket} before refusing: ${fs.existsSync(st.log) ? fs.readFileSync(st.log, 'utf8') : ''}`);
    });
  });
}

// ---------------------------------------------------------------------------
// The teardown handle: authority that came from the act of creating the server
// ---------------------------------------------------------------------------

test('createFixtureTmuxServer() hands back a handle that reaps exactly its own server', { skip: HAVE_TMUX ? false : 'not run: tmux is not installed here' }, async () => {
  const { createFixtureTmuxServer, killFixtureTmuxServers } = await import('./tmux-owner-fixture.mjs');
  const mine = privateSocket('handle');
  const other = privateSocket('other');
  try {
    const handle = createFixtureTmuxServer({ socket: mine });
    const otherHandle = createFixtureTmuxServer({ socket: other });
    assert.ok(handle && otherHandle, 'creation must return teardown handles');
    assert.ok(serverIsLive(mine) && serverIsLive(other), 'sanity: both private servers really started');

    handle.release();
    assert.equal(serverIsLive(mine), false, 'release() did not reap the server it was handed back for');
    assert.equal(fs.existsSync(realSocketFile(mine)), false, 'release() left the socket file behind');
    assert.equal(serverIsLive(other), true, 'release() reached a server it was not the handle for');

    killFixtureTmuxServers();
    assert.equal(serverIsLive(other), false, 'the remaining fixture server was not reaped');
  } finally {
    for (const socket of [mine, other]) {
      spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
      fs.rmSync(realSocketFile(socket), { force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// The derivation, pinned against the real tmux rather than against a belief
// ---------------------------------------------------------------------------

// The comma defect got in because the FORMAT was assumed. This asks tmux instead:
// stand a private server up on a socket name carrying the same separator $TMUX
// uses, read the $TMUX its own pane was given, and require the derivation to
// recover the socket path tmux reports for that server. Wholly disposable — its own
// TMUX_TMPDIR, its own server, killed in finally — and the live server is never
// addressed.
test('the derivation recovers the socket path REAL tmux puts in $TMUX, commas and all', { skip: HAVE_TMUX ? false : 'not run: tmux is not installed here' }, async () => {
  const { inheritedTmuxIdentity } = await import('./tmux-owner-fixture.mjs');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pwcm-'));
  const name = `pwcomma-${crypto.randomBytes(2).toString('hex')},sentinel,x`;
  // BUILT, so nothing about this run can reach the server the suite is running in.
  const env = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TMUX_TMPDIR: root };
  const tmux = (...args) => execFileSync('tmux', ['-L', name, ...args], { env, encoding: 'utf8', timeout: 20000 }).trim();
  try {
    tmux('new-session', '-d', '-s', 'p', 'sleep 60');
    const socketPath = tmux('display-message', '-p', '#{socket_path}');
    const panePid = tmux('list-panes', '-F', '#{pane_pid}').split('\n')[0];
    const paneEnv = fs.readFileSync(`/proc/${panePid}/environ`, 'utf8').split('\0').filter(Boolean);
    const inherited = paneEnv.find((kv) => kv.startsWith('TMUX='))?.slice('TMUX='.length);

    assert.ok(inherited, 'tmux gave its own pane no $TMUX, so this test proves nothing');
    assert.ok(inherited.startsWith(`${socketPath},`),
      `$TMUX (${inherited}) is not "<socket-path>,..." for ${socketPath} — the format assumed here has changed`);
    assert.ok(socketPath.includes(','), 'sanity: the socket path under test must actually contain a comma');

    const identity = inheritedTmuxIdentity({ TMUX: inherited });
    assert.equal(identity.ambiguous, false, `real tmux $TMUX read as ambiguous: ${inherited}`);
    assert.deepEqual(identity.paths, [socketPath],
      `derived ${JSON.stringify(identity.paths)} from ${inherited}, but tmux says the socket is ${socketPath}`);
    assert.deepEqual(identity.names, [name],
      `derived ${JSON.stringify(identity.names)}, but the live server's -L name is ${JSON.stringify(name)}`);
  } finally {
    spawnSync('tmux', ['-L', name, 'kill-server'], { env, stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// An unidentifiable $TMUX withholds TOUCH authority, not just cleanup authority
// ---------------------------------------------------------------------------

// Refusing to KILL under an ambiguous $TMUX is not enough. markOwnedServer()
// stamps the production owner marker with `set-option -s`, which mutates whatever
// server the name resolves to — and while the inherited identity is unreadable,
// any name could be the live one. The same refusal that withholds cleanup
// authority therefore has to be asked before the FIRST tmux invocation of the
// creation and marking paths too, not only at teardown.
//
// Zero tmux calls is the assertion: a refusal that still ran `has-session` has
// already addressed the server it could not identify.
for (const malformed of [',,', ',', '   ', '/,1,0', '/tmp/tmux-1000/default,notapid,13']) {
  for (const [entry, call] of [
    ['markOwnedServer', `markOwnedServer({ socket: SOCKET, dir: DIR })`],
    ['createFixtureTmuxServer', `createFixtureTmuxServer({ socket: SOCKET })`],
  ]) {
    test(`${entry}() runs no tmux at all while $TMUX ${JSON.stringify(malformed)} names no server`, () => {
      withStage((st) => {
        const socket = 'could-be-the-unidentified-live-server';
        const script = path.join(st.root, 'touch.mjs');
        fs.writeFileSync(script, [
          `import { markOwnedServer, createFixtureTmuxServer } from ${JSON.stringify(OWNER_FIXTURE)};`,
          `const SOCKET = ${JSON.stringify(socket)}; const DIR = ${JSON.stringify(st.root)};`,
          `try { ${call}; } catch (e) { console.log('REFUSED: ' + e.message); process.exit(0); }`,
          "console.log('ACCEPTED');",
        ].join('\n'));

        const child = spawnSync(process.execPath, [script], {
          env: childEnv(st, { TMUX: malformed }), encoding: 'utf8', timeout: 60000,
        });
        assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);
        assert.match(child.stdout, /^REFUSED: /,
          `${entry}() accepted ${socket} while the inherited server could not be identified: ${child.stdout}`);
        assert.equal(fs.existsSync(st.log), false,
          `${entry}() ran tmux against a server it could not rule out being the live one: `
          + `${fs.existsSync(st.log) ? fs.readFileSync(st.log, 'utf8') : ''}`);
      });
    });
  }
}
