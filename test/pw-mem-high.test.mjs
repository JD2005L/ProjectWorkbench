// HJ-24-3 — the MemoryHigh drop-in must not be a ~2 GiB ceiling on every real machine.
//
// The shipped calculation was:
//
//     awk '/^MemTotal:/ { printf "%d", $2 * 1024 * 0.75 }' /proc/meminfo
//
// On Debian/Ubuntu `/usr/bin/awk` is mawk, whose `%d` goes through a 32-bit int, so the result
// clamps to INT_MAX (2147483647 ≈ 2 GiB) for EVERY machine with MemTotal above ~2.73 GiB. The
// generated drop-in would then throttle and reclaim the one cgroup holding every project's panes
// and agents, below the 8.1 GiB peak of the incident it was added to protect against. On a gawk
// host the identical code is correct — which is exactly why this test pins the arithmetic to
// representative values and, where mawk is present, demonstrates the old formula failing.
//
// Dependency-free: no express, no dashboard. GOA can run this on the exact head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM_HIGH = path.join(REPO, 'scripts', 'pw-mem-high');

function haveBin(name) {
  return (process.env.PATH || '').split(':').some((dir) => {
    try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  });
}

async function meminfoFixture(dir, kb) {
  const file = path.join(dir, `meminfo-${kb}`);
  // Real /proc/meminfo shape: MemTotal is not the only line and the columns are space-padded.
  await fsp.writeFile(file, [
    `MemTotal:       ${kb} kB`,
    `MemFree:         ${Math.floor(kb / 4)} kB`,
    `MemAvailable:    ${Math.floor(kb / 2)} kB`,
    'SwapTotal:             0 kB',
    '',
  ].join('\n'));
  return file;
}

async function memHigh(file, percent) {
  const { stdout } = await execFileAsync(MEM_HIGH, percent ? [file, percent] : [file]);
  return stdout.trim();
}

test('REGRESSION: representative memory sizes produce the exact 64-bit byte value', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-mem-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const cases = [
    // MemTotal kB,   expected 75% bytes,  note
    [4194304, '3221225472', '4 GiB — a small VM'],
    [16777216, '12884901888', '16 GiB — the sample in the review'],
    [7865348, '6040587264', 'the real GOA box, an odd non-power-of-two size'],
    [536870912, '412316860416', '512 GiB — a large host, far past any 32-bit range'],
    [2097152, '1610612736', '2 GiB — below the clamp, where the old code was accidentally right'],
  ];
  for (const [kb, expected, note] of cases) {
    assert.equal(await memHigh(await meminfoFixture(dir, kb)), expected, `${note} (MemTotal=${kb} kB)`);
  }

  // Above ~2.73 GiB the old code returned INT_MAX for everything; the new one must not be constant.
  const a = await memHigh(await meminfoFixture(dir, 4194304));
  const b = await memHigh(await meminfoFixture(dir, 16777216));
  assert.notEqual(a, b, 'two different machines must not be given the same ceiling');
  assert.ok(Number(b) > 2147483647, 'and a 16 GiB host must be given more than INT_MAX bytes');
});

test('REGRESSION: the old awk formula is not portable across the mawk builds we support', async (t) => {
  // GOA asked for this specifically: invoke mawk EXPLICITLY, because on a gawk host the original
  // code passes and the bug is invisible.
  //
  // What running it on two supported baselines actually shows is stronger than "mawk overflows":
  //
  //   mawk 1.3.4 20200120 (GOA, Debian 12) -> 2147483647   (INT_MAX, ~2 GiB)
  //   mawk 1.3.4 20240123 (PVI2)           -> 12884901888  (correct)
  //
  // Same awk implementation, same major version, same expression, different answer. So the fix is
  // not "avoid mawk" and it is certainly not "use %.0f and assume" — it is that the value must not
  // depend on which awk build a host happens to ship at all. Hence bash arithmetic, which is 64-bit
  // everywhere. The clamp is asserted where it can be observed and reported where it cannot; a
  // check that quietly passes when it could not run would be worse than no check.
  if (!haveBin('mawk')) {
    t.skip('mawk is not installed here, so the awk-variant behaviour cannot be observed on this host');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-mem-mawk-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = await meminfoFixture(dir, 16777216);
  const correct = '12884901888';

  const { stdout: old } = await execFileAsync('mawk', ['/^MemTotal:/ { printf "%d", $2 * 1024 * 0.75 }', file]);
  const { stdout: version } = await execFileAsync('mawk', ['-W', 'version']).catch(() => ({ stdout: 'unknown' }));
  const build = version.split('\n')[0].trim();

  // The shipped calculation is correct on every host, which is the actual requirement.
  assert.equal(await memHigh(file), correct, 'the shipped calculation must be right regardless of the local awk');

  if (old.trim() === '2147483647') {
    assert.notEqual(await memHigh(file), old.trim(),
      `this ${build} clamps the old formula to INT_MAX — exactly the ~2 GiB ceiling the fix removes`);
  } else {
    assert.equal(old.trim(), correct, `unexpected third answer from ${build}: ${old.trim()}`);
    console.log(`[pw-mem-high] note: ${build} does NOT clamp (returned ${old.trim()}). `
      + 'The clamp is reproducible on mawk 1.3.4 20200120 (GOA, Debian 12); this host cannot demonstrate it, '
      + 'which is itself the portability argument for dropping awk.');
  }
});

test('the percentage is honoured and the calculation stays exact', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-mem-pct-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = await meminfoFixture(dir, 16777216);
  assert.equal(await memHigh(file, '50'), '8589934592');
  assert.equal(await memHigh(file, '100'), '17179869184');
  // Multiplying before dividing keeps it in integer space; no float rounding anywhere.
  assert.equal(await memHigh(await meminfoFixture(dir, 3), '75'), String(Math.floor(3 * 1024 * 75 / 100)));
});

test('an unreadable or malformed MemTotal exits non-zero and prints nothing', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-mem-bad-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => execFileAsync(MEM_HIGH, [path.join(dir, 'nope')]),
    (e) => e.code === 1 && e.stdout === '', 'the caller must not write a drop-in from a value it never got');

  const garbage = path.join(dir, 'garbage');
  await fsp.writeFile(garbage, 'MemTotal:       not-a-number kB\n');
  await assert.rejects(() => execFileAsync(MEM_HIGH, [garbage]), (e) => e.code === 1 && e.stdout === '');

  const good = await meminfoFixture(dir, 4194304);
  await assert.rejects(() => execFileAsync(MEM_HIGH, [good, '0']), (e) => e.code === 2);
});

test('the generated drop-in is a value systemd itself accepts, and reports it back unchanged', async (t) => {
  if (!haveBin('systemd-analyze')) {
    t.skip('systemd-analyze is not available here, so the generated unit cannot be validated against systemd');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-mem-systemd-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const bytes = await memHigh(await meminfoFixture(dir, 16777216));

  // Exactly what install.sh writes, in a unit shaped like the one it drops into.
  const unitPath = path.join(dir, 'pw-mem-probe.service');
  await fsp.writeFile(unitPath, [
    '[Unit]',
    'Description=Project Workbench MemoryHigh drop-in probe',
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/true',
    'MemoryAccounting=yes',
    `MemoryHigh=${bytes}`,
    '',
  ].join('\n'));

  const { stdout, stderr } = await execFileAsync('systemd-analyze', ['verify', unitPath], { timeout: 30000 })
    .catch((e) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }));
  const output = `${stdout}\n${stderr}`;
  assert.ok(!/MemoryHigh/.test(output),
    `systemd rejected the generated MemoryHigh value ${bytes}:\n${output}`);
  assert.ok(!/Failed to parse|Invalid|out of range/i.test(output),
    `systemd reported a problem with the generated unit:\n${output}`);
  // Reported for the record, so the effective value is in the run log rather than inferred.
  console.log(`[pw-mem-high] systemd accepted MemoryHigh=${bytes} (16 GiB sample) via ${unitPath}`);
});

test('install.sh sizes the drop-in with this script and no longer does awk arithmetic on MemTotal', () => {
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  assert.match(sh, /pw-mem-high/, 'the installer must use the tested calculation, not its own copy');
  // Comments are stripped first: install.sh deliberately QUOTES the old formula to explain why it
  // was removed, and a check that cannot tell an explanation from an implementation would force the
  // next person to delete the explanation.
  const code = sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/awk[^\n]*MemTotal/.test(code),
    'THE REGRESSION: any awk arithmetic on MemTotal is a 32-bit clamp waiting to happen on a mawk host');
  assert.ok(!/\$2 ?\* ?1024 ?\* ?0\.75/.test(code), 'the float-and-%d formula must be gone entirely');
  // The drop-in is still seeded only when absent, so operator tuning survives an update.
  assert.match(sh, /\[ ! -f \/etc\/systemd\/system\/pw-tmux-server\.service\.d\/memory\.conf \]/);
});
