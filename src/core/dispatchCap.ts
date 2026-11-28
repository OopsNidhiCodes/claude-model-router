import { nextFamily } from "./escalation";
import { Family } from "./types";

export interface DispatchCapState {
  lastFamily?: Family;
  consecutiveCount: number;
}

export const INITIAL_DISPATCH_CAP_STATE: DispatchCapState = { consecutiveCount: 0 };

export interface DispatchCapResult {
  state: DispatchCapState;
  /** Set only when the cap was just hit: the family the floor should raise to. */
  raiseTo?: Family;
}

/**
 * Tracks consecutive replies served by the same family in one chat. This
 * extension has no tool-execution loop (no agentic step counter to cap), so
 * this is the closest analog available to "the cheap model is burning calls
 * without converging": if the same family keeps answering, with nothing
 * (neither the model nor the user) ever triggering a real escalation, that is
 * itself a sign the task is too big for it. A real escalation already resets
 * this naturally — it changes `servedFamily`, which restarts the count.
 *
 * `maxConsecutiveTurns <= 0` disables this (`claudeRouter.dispatchCap.*`).
 */
export function trackDispatch(state: DispatchCapState, servedFamily: Family, maxConsecutiveTurns: number): DispatchCapResult {
  const consecutiveCount = servedFamily === state.lastFamily ? state.consecutiveCount + 1 : 1;
  const next = nextFamily(servedFamily);

  if (maxConsecutiveTurns > 0 && consecutiveCount >= maxConsecutiveTurns && next) {
    return { state: { lastFamily: servedFamily, consecutiveCount: 0 }, raiseTo: next };
  }
  return { state: { lastFamily: servedFamily, consecutiveCount } };
}
