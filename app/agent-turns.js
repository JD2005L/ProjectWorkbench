// "Has that turn finished, and what did it produce?" — docs/agent-mcp.md phase 3.
//
// WHY NOT JUST THE BELL. The dashboard learns a turn ended from tmux's
// window_bell_flag, and that is the right signal for a tab strip: Claude rings the
// bell, scripts/pw-agent-done.sh rings it for Copilot, and tmux clears the flag
// when the window is selected so "clear on click" is free. Free clearing is
// exactly what makes it insufficient here:
//
//   * tmux sets the flag only for a window that is NOT being viewed. If somebody
//     is watching the agent's lane, the bell may never latch at all.
//   * selecting the window clears it — so a human opening the tab would erase the
//     very event an external caller is waiting for.
//
// So a fresh bell COMPLETES a turn (it is unambiguous when it arrives), but its
// absence proves nothing. The fallback is the cadence model computeWorking()
// already implements, over #{window_activity}: a monotonic stamp that viewing does
// not reset. A turn is finished when work was observed and has then stopped for
// the grace window.
//
// Two properties this shape buys, both of them requirements rather than niceties:
// a human opening the tab cannot complete somebody's turn, and a bell that
// predates the prompt cannot complete it either — the sample taken before the
// paste is what makes the second one true.
//
// AND THE HONEST LIMIT, which belongs in the tool description an agent reads:
// completed means THE AGENT STOPPED, not that it succeeded. A refusal, a crash, a
// question asked back and a finished task all end the same way. The caller reads
// the output to judge.

export const TURN_GRACE_MS = 4000;
export const TURN_MAX_WAIT_MS = 10 * 60 * 1000;
export const TURN_SAMPLE_MS = 1500;
export const TURNS_KEPT = 200;

export const TurnState = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  GONE: 'gone',
});

export function createAgentTurns({
  now = () => Date.now(),
  newId = () => Math.random().toString(16).slice(2, 14),
  graceMs = TURN_GRACE_MS,
  keep = TURNS_KEPT,
} = {}) {
  const turns = new Map();

  const shape = (turn) => ({
    turn_id: turn.id,
    project: turn.project,
    session: turn.session,
    window: turn.window,
    state: turn.state,
    started_at: turn.startedAt,
    finished_at: turn.finishedAt || null,
    // Which signal ended it, because "the bell rang" and "it went quiet" are
    // different levels of confidence and the caller may care.
    completed_by: turn.completedBy || null,
    saw_work: !!turn.sawWork,
    actsAs: turn.actsAs || null,
  });

  function prune() {
    if (turns.size <= keep) return;
    const oldest = [...turns.values()].sort((a, b) => a.startedMs - b.startedMs).slice(0, turns.size - keep);
    for (const turn of oldest) turns.delete(turn.id);
  }

  return {
    /**
     * Open a turn. `sample` is taken BEFORE the prompt is pasted: the activity
     * stamp and bell flag recorded here are what make a pre-existing bell, or
     * somebody else's earlier work, unable to complete this turn.
     */
    start({ project, session, window, tokenId, actsAs, sample = {} }) {
      const turn = {
        id: newId(), project, session, window, tokenId, actsAs,
        state: TurnState.RUNNING,
        startedAt: new Date(now()).toISOString(),
        startedMs: now(),
        activityAtStart: Number(sample.activity) || 0,
        bellAtStart: !!sample.bell,
        historyAtStart: Number(sample.history) || 0,
        sawWork: false,
        lastWorkMs: now(),
      };
      turns.set(turn.id, turn);
      prune();
      return shape(turn);
    },

    get(turnId) {
      const turn = turns.get(String(turnId || ''));
      return turn ? shape(turn) : null;
    },

    /** The stored cursor a since-read needs: how much had scrolled away when the prompt went in. */
    cursor(turnId) {
      const turn = turns.get(String(turnId || ''));
      return turn ? { historyAtStart: turn.historyAtStart, window: turn.window, session: turn.session } : null;
    },

    /**
     * Fold one observation in. Called by whoever is sampling — the waiter, or a
     * status read — so a turn nobody is watching simply has no opinion until
     * somebody looks, which is the same deal the cockpit's tab strip has.
     */
    observe(turnId, sample = {}) {
      const turn = turns.get(String(turnId || ''));
      if (!turn) return null;
      if (turn.state !== TurnState.RUNNING) return shape(turn);

      if (sample.missing) {
        turn.state = TurnState.GONE;
        turn.finishedAt = new Date(now()).toISOString();
        turn.completedBy = 'window-closed';
        return shape(turn);
      }

      const activity = Number(sample.activity) || 0;
      if (activity > turn.activityAtStart) {
        turn.sawWork = true;
        turn.lastWorkMs = now();
        turn.activityAtStart = activity;     // keep the high-water mark
      } else if (sample.working) {
        turn.sawWork = true;
        turn.lastWorkMs = now();
      }

      // A bell that arrived after the prompt is unambiguous, so it wins outright.
      // One that was already set when the prompt went in says nothing.
      const freshBell = !!sample.bell && !turn.bellAtStart;
      if (freshBell) {
        turn.state = TurnState.COMPLETED;
        turn.finishedAt = new Date(now()).toISOString();
        turn.completedBy = 'bell';
        return shape(turn);
      }
      // The bell can be cleared by somebody viewing the window; once it is gone,
      // stop treating the pre-existing one as a reason to ignore the next.
      if (!sample.bell && turn.bellAtStart) turn.bellAtStart = false;

      if (turn.sawWork && !sample.working && now() - turn.lastWorkMs >= graceMs) {
        turn.state = TurnState.COMPLETED;
        turn.finishedAt = new Date(now()).toISOString();
        turn.completedBy = 'quiet';
      }
      return shape(turn);
    },

    /** For tests and for a caller that wants to know how much is being tracked. */
    size: () => turns.size,
  };
}
