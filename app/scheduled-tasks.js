// Scheduled tasks: run a command in projects on a clock.
//
// WHY IN-PROCESS AND NOT SYSTEMD TIMERS. A generated timer per task would need
// host wiring that does not exist in container mode, and this repo has already
// been bitten twice by exactly that: pw-tmux-save.timer and the CLI updater were
// both host units that a container install either never had or could not be
// reached by, and both failed silently for months. A node-side ticker behaves
// identically in host and container mode and needs no privileged host change.
// Persisting lastRun buys back the one thing timers give you for free —
// Persistent=true's catch-up after downtime.
//
// WHAT RUNS THE COMMAND. Not this module. It computes *what is due* and nothing
// else, so the scheduling rules are unit-testable without a tmux server, a clock
// change, or a project. The caller injects the command through the same
// newTmuxWindow() path the tab UI uses, which means the command runs as the pane
// account rather than as the root dashboard, and its output stays visible in a
// tab afterwards instead of vanishing into a log.
//
// TIME IS COMPUTED IN THE TASK'S ZONE, NOT THE PROCESS'S. A container runs in
// UTC; "17:00" means 17:00 where the operator is. Doing this with Intl rather
// than a date library keeps the dependency footprint at zero, at the cost of the
// two-step offset resolution in instantForLocal() below.

/** Fields a task may carry, and the shape the rest of the app can rely on. */
const SCHEDULE_KINDS = Object.freeze(['daily', 'interval']);
const TARGET_ALL = 'all';
const MAX_NAME = 80;
const MAX_COMMAND = 4000;
const MIN_INTERVAL_MINUTES = 5;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Zone-aware calendar fields for an instant. Weekday is 0=Sunday. */
export function zonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const out = {};
  for (const { type, value } of dtf.formatToParts(date)) out[type] = value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    // Intl renders midnight as 24 in some locales/zones; normalise it.
    hour: Number(out.hour) % 24, minute: Number(out.minute),
    weekday: weekdays[out.weekday],
  };
}

/**
 * The UTC instant at which a given wall-clock time occurs in a zone.
 *
 * Resolved in two passes rather than one: the offset to apply depends on the
 * instant, and the instant depends on the offset. One pass is wrong for the
 * hour on either side of a DST transition; the second pass corrects it. A third
 * pass cannot change the answer, so two is the whole story.
 */
export function instantForLocal(timeZone, year, month, day, hour, minute) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass++) {
    const p = zonedParts(new Date(guess), timeZone);
    const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    guess += asUtc - rendered;
  }
  return guess;
}

/** Validate and canonicalise a task from disk or from the API. Throws on bad input. */
export function normalizeTask(raw, { defaultTimeZone = 'UTC' } = {}) {
  if (!isPlainObject(raw)) throw new Error('task must be an object');

  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw new Error('task id must be 2-50 chars of a-z, 0-9 and dashes, not starting or ending with a dash');

  const name = String(raw.name ?? '').trim().slice(0, MAX_NAME);
  if (!name) throw new Error('task name is required');

  const command = String(raw.command ?? '').replace(/\r/g, '');
  if (!command.trim()) throw new Error('task command is required');
  if (command.length > MAX_COMMAND) throw new Error(`task command must be under ${MAX_COMMAND} characters`);

  const kind = String(raw.schedule?.kind ?? '').trim();
  if (!SCHEDULE_KINDS.includes(kind)) throw new Error(`schedule.kind must be one of: ${SCHEDULE_KINDS.join(', ')}`);

  const schedule = { kind };
  if (kind === 'daily') {
    const at = String(raw.schedule?.at ?? '').trim();
    const m = TIME_RE.exec(at);
    if (!m) throw new Error('schedule.at must be HH:MM (24-hour)');
    schedule.at = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
    schedule.weekdaysOnly = !!raw.schedule?.weekdaysOnly;
  } else {
    const every = Number(raw.schedule?.everyMinutes);
    if (!Number.isInteger(every) || every < MIN_INTERVAL_MINUTES) {
      throw new Error(`schedule.everyMinutes must be an integer of at least ${MIN_INTERVAL_MINUTES}`);
    }
    schedule.everyMinutes = every;
  }

  // A zone that Intl cannot resolve would throw on every tick, so it is rejected
  // at the boundary rather than at run time.
  const timeZone = String(raw.timeZone ?? '').trim() || defaultTimeZone;
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); }
  catch { throw new Error(`unknown timeZone: ${timeZone}`); }

  let target = raw.target ?? TARGET_ALL;
  if (target !== TARGET_ALL) {
    if (!Array.isArray(target)) throw new Error(`target must be "${TARGET_ALL}" or an array of project names`);
    target = target.map((t) => String(t).trim()).filter(Boolean);
    if (!target.length) throw new Error('target list cannot be empty — use "all" instead');
  }

  return {
    id,
    name,
    enabled: raw.enabled !== false,
    schedule,
    timeZone,
    target,
    window: String(raw.window ?? '').trim().slice(0, MAX_NAME) || name.slice(0, 24),
    command,
    // Carried through because this same function loads tasks from disk, where the
    // bookkeeping is the scheduler's own record. It is NOT safe to accept from an
    // API caller — a submitted lastRun would let them suppress the next run or
    // force a catch-up — so the API layer overwrites these from the stored task
    // rather than trusting the request. See preserveBookkeeping().
    lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : null,
    lastStatus: ['ok', 'failed', 'partial'].includes(raw.lastStatus) ? raw.lastStatus : null,
    lastDetail: typeof raw.lastDetail === 'string' ? raw.lastDetail.slice(0, 2000) : null,
  };
}

/**
 * Is this task due, and why.
 *
 * Returns { due, reason, dueAt } — dueAt being the instant the task was supposed
 * to fire, which is what gets recorded as lastRun. Recording the scheduled
 * instant rather than "now" is what stops a late run from shifting the schedule.
 */
export function evaluateDue(task, now = Date.now()) {
  if (!task.enabled) return { due: false, reason: 'disabled' };
  const lastRun = task.lastRun ? Date.parse(task.lastRun) : NaN;
  const last = Number.isFinite(lastRun) ? lastRun : null;

  if (task.schedule.kind === 'interval') {
    const everyMs = task.schedule.everyMinutes * 60_000;
    if (last === null) return { due: true, reason: 'never run', dueAt: now };
    if (now - last >= everyMs) return { due: true, reason: `${task.schedule.everyMinutes}m elapsed`, dueAt: now };
    return { due: false, reason: 'not yet' };
  }

  // daily
  const [hh, mm] = task.schedule.at.split(':').map(Number);
  const p = zonedParts(new Date(now), task.timeZone);
  const todayDue = instantForLocal(task.timeZone, p.year, p.month, p.day, hh, mm);

  if (now < todayDue) return { due: false, reason: 'not yet today' };
  if (task.schedule.weekdaysOnly) {
    const dueParts = zonedParts(new Date(todayDue), task.timeZone);
    if (dueParts.weekday === 0 || dueParts.weekday === 6) return { due: false, reason: 'weekend' };
  }
  // Catch-up: a due time that passed while the process was down still fires,
  // once, because lastRun is older than it. This is Persistent=true, by hand.
  if (last !== null && last >= todayDue) return { due: false, reason: 'already ran today' };
  return { due: true, reason: `daily ${task.schedule.at} ${task.timeZone}`, dueAt: todayDue };
}

/**
 * Which projects a task applies to, given the live registry.
 *
 * Always { matched, missing } — never a bare array for one branch and an object
 * for the other, which is the kind of shape that gets one caller right and the
 * next one wrong. `missing` matters: silently dropping a renamed or deleted
 * project is how a task quietly stops covering something an operator believes it
 * covers, so the names that did not resolve are reported rather than filtered.
 */
export function resolveTargets(task, projects) {
  const names = projects.map((p) => p.name);
  if (task.target === TARGET_ALL) return { matched: names, missing: [] };
  return {
    matched: task.target.filter((t) => names.includes(t)),
    missing: task.target.filter((t) => !names.includes(t)),
  };
}

/**
 * A commit-and-push that refuses to do anything surprising.
 *
 * Blunt `add -A && commit && push` across a dozen repos will eventually commit a
 * secret, a build artifact, or half-finished work, and push it somewhere it
 * cannot be quietly withdrawn from. Every clause here exists to make the
 * no-op case the default:
 *   - nothing to commit -> say so and stop, so a clean repo is not a failure
 *   - detached HEAD -> stop; committing there strands the work
 *   - no upstream -> commit locally, do not invent a remote branch
 *   - push is a plain fast-forward; no --force of any kind, ever
 * It also prints what it did, because the point of running in a visible tab is
 * that the operator can read it afterwards.
 */
export function guardedGitCommand({ message = 'chore: end-of-day checkpoint' } = {}) {
  return [
    'set -u',
    'echo "== $(basename "$PWD") =="',
    'if [ ! -d .git ]; then echo "not a git repo — skipping"; exit 0; fi',
    'branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"',
    'if [ "$branch" = "HEAD" ]; then echo "detached HEAD — skipping, commit it yourself"; exit 0; fi',
    'if [ -z "$(git status --porcelain)" ]; then echo "clean — nothing to commit"; else',
    '  git add -A',
    `  git commit -m ${JSON.stringify(message)} || { echo "commit failed (hook?) — leaving the tree staged"; exit 1; }`,
    '  echo "committed on $branch"',
    'fi',
    'if git rev-parse --abbrev-ref "@{upstream}" >/dev/null 2>&1; then',
    '  git push && echo "pushed $branch" || echo "push failed — commit is safe locally"',
    'else',
    '  echo "no upstream for $branch — committed locally, not pushed"',
    'fi',
  ].join('\n');
}

/**
 * Keep the scheduler's own record when a task is edited through the API.
 *
 * Without this, an editor could submit lastRun and either suppress the next run
 * or fake a missed one into firing. The submitter owns the definition; the
 * scheduler owns the history.
 */
export function preserveBookkeeping(incoming, existing) {
  return {
    ...incoming,
    lastRun: existing?.lastRun ?? null,
    lastStatus: existing?.lastStatus ?? null,
    lastDetail: existing?.lastDetail ?? null,
  };
}

export const SCHEDULE_LIMITS = Object.freeze({ MIN_INTERVAL_MINUTES, MAX_COMMAND, MAX_NAME, TARGET_ALL });
