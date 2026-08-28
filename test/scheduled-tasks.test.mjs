// The scheduling rules, tested without a clock change, a tmux server, or a project.
//
// That separation is the point of app/scheduled-tasks.js existing as its own
// module: "is this task due" is the part with the subtle failure modes — DST, a
// missed run while the process was down, a run that drifts later every day — and
// none of them need a running instance to exercise.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  zonedParts, instantForLocal, normalizeTask, evaluateDue,
  resolveTargets, guardedGitCommand, preserveBookkeeping, SCHEDULE_LIMITS, NORTH_AMERICAN_TIMEZONES,
} from '../app/scheduled-tasks.js';

const MT = 'America/Edmonton';
// `schedule` is built last and from its own defaults: spreading `...over` after it
// replaces the whole object, dropping `kind` — which is how the first version of
// this helper made a valid task look invalid.
const daily = (over = {}) => {
  const { schedule, ...rest } = over;
  return normalizeTask({
    id: 'eod', name: 'End of day', command: 'echo hi', timeZone: MT, ...rest,
    schedule: { kind: 'daily', at: '17:00', ...(schedule || {}) },
  });
};

test('a wall-clock time resolves to the right instant on both sides of DST', () => {
  // Alberta is UTC-6 in summer (MDT) and UTC-7 in winter (MST). A single-pass
  // offset calculation gets one of these wrong.
  assert.equal(new Date(instantForLocal(MT, 2026, 8, 27, 17, 0)).toISOString(), '2026-08-27T23:00:00.000Z');
  assert.equal(new Date(instantForLocal(MT, 2026, 1, 15, 17, 0)).toISOString(), '2026-01-16T00:00:00.000Z');
  // Round-trip: the instant must render back as the wall clock we asked for.
  for (const [y, m, d] of [[2026, 3, 8], [2026, 11, 1], [2026, 6, 21]]) {
    const p = zonedParts(new Date(instantForLocal(MT, y, m, d, 17, 0)), MT);
    assert.equal(`${p.hour}:${String(p.minute).padStart(2, '0')}`, '17:00', `${y}-${m}-${d} must round-trip`);
  }
});

test('a daily task fires after its local time and only once that day', () => {
  const t = daily();
  assert.equal(evaluateDue(t, Date.parse('2026-08-27T22:59:00Z')).due, false, 'before 17:00 local');
  const fired = evaluateDue(t, Date.parse('2026-08-27T23:01:00Z'));
  assert.equal(fired.due, true, 'after 17:00 local');

  // lastRun records the SCHEDULED instant, not "now" — otherwise a run that
  // starts late moves tomorrow's deadline later, and the drift compounds.
  assert.equal(new Date(fired.dueAt).toISOString(), '2026-08-27T23:00:00.000Z');

  const ran = { ...t, lastRun: new Date(fired.dueAt).toISOString() };
  assert.equal(evaluateDue(ran, Date.parse('2026-08-27T23:30:00Z')).due, false, 'must not repeat within the day');
});

test('a due time missed while the process was down still fires once', () => {
  // This is Persistent=true by hand. Without it, every restart silently skips
  // whatever fell in the downtime — the failure mode that made the CLI updater
  // and tmux persistence look like they were working here.
  const t = { ...daily(), lastRun: '2026-08-26T23:00:00Z' };
  assert.equal(evaluateDue(t, Date.parse('2026-08-27T23:01:00Z')).due, true);
  assert.equal(evaluateDue(t, Date.parse('2026-08-28T02:00:00Z')).due, true, 'still fires later the same evening');
});

test('weekdaysOnly skips the weekend in the task’s zone, not the server’s', () => {
  const t = daily({ schedule: { at: '17:00', weekdaysOnly: true } });
  assert.equal(evaluateDue(t, Date.parse('2026-08-28T23:01:00Z')).due, true, 'Friday fires');
  assert.equal(evaluateDue(t, Date.parse('2026-08-29T23:01:00Z')).due, false, 'Saturday does not');
  assert.equal(evaluateDue(t, Date.parse('2026-08-30T23:01:00Z')).due, false, 'Sunday does not');
  // 23:01Z on Friday is still Friday 17:01 in Mountain Time but Saturday in UTC —
  // so a server-zone weekend check would get this exact case wrong.
  assert.equal(zonedParts(new Date(Date.parse('2026-08-28T23:01:00Z')), MT).weekday, 5);
});

test('an interval task waits out its period and runs immediately when new', () => {
  const t = normalizeTask({ id: 'iv', name: 'IV', command: 'x', schedule: { kind: 'interval', everyMinutes: 30 } });
  assert.equal(evaluateDue(t, 1_000).due, true, 'a task that has never run is due');
  const now = Date.now();
  assert.equal(evaluateDue({ ...t, lastRun: new Date(now - 20 * 60_000).toISOString() }, now).due, false);
  assert.equal(evaluateDue({ ...t, lastRun: new Date(now - 40 * 60_000).toISOString() }, now).due, true);
});

test('a disabled task is never due', () => {
  assert.equal(evaluateDue({ ...daily(), enabled: false }, Date.parse('2026-08-27T23:01:00Z')).due, false);
});

test('bad definitions are rejected at the boundary, not at run time', () => {
  const cases = [
    ['missing id', { name: 'n', command: 'c', schedule: { kind: 'daily', at: '17:00' } }],
    ['id with edge dashes', { id: '-x-', name: 'n', command: 'c', schedule: { kind: 'daily', at: '17:00' } }],
    ['blank command', { id: 'ab', name: 'n', command: '   ', schedule: { kind: 'daily', at: '17:00' } }],
    ['hour out of range', { id: 'ab', name: 'n', command: 'c', schedule: { kind: 'daily', at: '25:00' } }],
    ['unknown kind', { id: 'ab', name: 'n', command: 'c', schedule: { kind: 'hourly' } }],
    ['interval too small', { id: 'ab', name: 'n', command: 'c', schedule: { kind: 'interval', everyMinutes: 1 } }],
    ['unknown zone', { id: 'ab', name: 'n', command: 'c', schedule: { kind: 'daily', at: '17:00' }, timeZone: 'Mars/Olympus' }],
    ['empty target list', { id: 'ab', name: 'n', command: 'c', schedule: { kind: 'daily', at: '17:00' }, target: [] }],
    ['not an object', 'nope'],
  ];
  for (const [label, raw] of cases) {
    assert.throws(() => normalizeTask(raw), /.+/, `must reject: ${label}`);
  }
  // An unresolvable zone is rejected here precisely because it would otherwise
  // throw inside the ticker on every tick, taking the scheduler down with it.
  assert.doesNotThrow(() => normalizeTask({ id: 'ab', name: 'n', command: 'c', schedule: { kind: 'daily', at: '9:05' } }));
  assert.equal(normalizeTask({ id: 'ab', name: 'n', command: 'c', schedule: { kind: 'daily', at: '9:05' } }).schedule.at, '09:05');
});

test('targets always answer in one shape, and name what did not resolve', () => {
  const projects = [{ name: 'Alpha' }, { name: 'Beta' }];
  assert.deepEqual(resolveTargets(daily({ target: 'all' }), projects), { matched: ['Alpha', 'Beta'], missing: [] });
  assert.deepEqual(resolveTargets(daily({ target: ['Alpha', 'Gone'] }), projects), { matched: ['Alpha'], missing: ['Gone'] });
  assert.deepEqual(resolveTargets(daily({ target: 'all' }), []), { matched: [], missing: [] });
});

test('run bookkeeping cannot be set by whoever edits the task', () => {
  const submitted = { id: 'x', name: 'n', lastRun: '2099-01-01T00:00:00Z', lastStatus: 'ok', lastDetail: 'faked' };
  const stored = { lastRun: '2026-01-01T00:00:00Z', lastStatus: 'failed', lastDetail: 'real' };
  const merged = preserveBookkeeping(submitted, stored);
  assert.equal(merged.lastRun, '2026-01-01T00:00:00Z', 'a submitted lastRun must not suppress the next run');
  assert.equal(merged.lastStatus, 'failed');
  assert.equal(merged.lastDetail, 'real');
  assert.deepEqual(preserveBookkeeping({ id: 'x' }, undefined),
    { id: 'x', lastRun: null, lastStatus: null, lastDetail: null }, 'a brand-new task starts with no history');
});

test('the guarded git command refuses every surprising case', () => {
  const cmd = guardedGitCommand();
  // Each of these is a way blunt add/commit/push loses work or publishes
  // something that cannot be quietly withdrawn.
  assert.match(cmd, /if \[ ! -d \.git \]/, 'a non-repo is skipped, not failed');
  assert.match(cmd, /detached HEAD/, 'detached HEAD is skipped rather than committed onto');
  assert.match(cmd, /git status --porcelain/, 'a clean tree is a no-op');
  assert.match(cmd, /@\{upstream\}/, 'no upstream means commit locally and stop');
  assert.doesNotMatch(cmd, /--force|-f\b/, 'never force-pushes');
  assert.doesNotMatch(cmd, /push\s+--set-upstream|push\s+-u\b/, 'never invents a remote branch');
  assert.match(guardedGitCommand({ message: 'custom msg' }), /"custom msg"/, 'message is quoted, not interpolated raw');
});

test('limits are exported so the UI and the API agree on them', () => {
  assert.equal(typeof SCHEDULE_LIMITS.MIN_INTERVAL_MINUTES, 'number');
  assert.equal(SCHEDULE_LIMITS.TARGET_ALL, 'all');
});

test('the offered timezones are a convenience, not a constraint', () => {
  // Every offered zone must resolve, or the picker hands the operator a value the
  // validator will reject.
  for (const z of NORTH_AMERICAN_TIMEZONES) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-CA', { timeZone: z.id }), `bad zone: ${z.id}`);
  }
  assert.ok(NORTH_AMERICAN_TIMEZONES.some((z) => z.id === 'America/Edmonton'));
  // A zone outside the list must still be accepted: the JSON is editable by hand
  // and a picker is not a whitelist.
  assert.equal(normalizeTask({
    id: 'ab', name: 'n', command: 'c', schedule: { kind: 'daily', at: '17:00' }, timeZone: 'Europe/London',
  }).timeZone, 'Europe/London');
});
