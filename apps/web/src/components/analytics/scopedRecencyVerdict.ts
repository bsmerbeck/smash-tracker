import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
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

/**
 * Plan 39.1-31 (gap closure, D-07/D-15, item 7): true exactly when the
 * engine's `locked` state is really "the last-30 window has fewer than 3
 * games because D-15's 12-month scoped-recency bound emptied or thinned it,
 * while the pairing's lifetime record is evidenced" — the ONE case this
 * plan maps to a truthful whole-sentence key instead of the engine's own
 * `insights.formNow.locked` (which reads "N more games unlock this read", a
 * sentence about games still NEEDED, not about the window being
 * time-bounded — and whose `copy.values.count` is deliberately `gamesNeeded`
 * per CR-A02, wrong for this purpose). The engine itself is unchanged:
 * `ladder.ts` keeps `locked` before `thinRecent` for every horizon; this is
 * a UI-only reinterpretation of an already-produced `locked` insight. Scoped
 * to `horizon === 'last30'` on purpose — only there is "fewer than 3 in the
 * window" exactly "fewer than 3 in the last 12 months" (D-15's bound IS
 * `last30`'s own scoping); `lastEvent`/`last90` are time-bounded in their
 * own right and keep the engine's stock `locked` copy.
 */
export function headStatesScopedWindow(insight: Insight): boolean {
  return (
    insight.state === 'locked' &&
    insight.horizon === 'last30' &&
    insight.window.scoped &&
    insight.baseline.kind === 'evidenced'
  );
}
