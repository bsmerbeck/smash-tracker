import type { HorizonKey, Match } from '@smash-tracker/shared';
import { resolveWindow } from '@smash-tracker/shared';

/**
 * Plan 39.1-59 (UAT 39.1-33 F17): true when `matches` hold games in
 * `horizon`'s window BEFORE D-15's 12-month scoped-recency bound is applied.
 * A host passes it as `deltaChipView`'s `recencyBounded`, so a window the
 * bound emptied reads "none in the last 12 months", while a window that was
 * empty anyway (an event-less account's last event) keeps "no games".
 */
export function windowHeldGamesBeforeBound({
  matches,
  horizon,
  nowMs,
}: {
  matches: Match[];
  horizon: HorizonKey;
  nowMs: number;
}): boolean {
  return resolveWindow({ matches, horizon, scoped: false, nowMs }).window.games > 0;
}
