import { effectiveFloor } from '@smash-tracker/shared';

/**
 * D-13/R1-BLOCKER-6 (plan 37-05): the ONE threshold binding the Counterpick
 * Advisor's header text and its `buildStageEvidence` call both read.
 * `effectiveFloor` already raises a sub-floor caller value to the engine's
 * abstention floor, but a component calling `effectiveFloor` directly in two
 * places — the render argument and the header string — would still be two
 * independent expressions that merely HAPPEN to agree; a gate built on that
 * agreement cannot fail, because there is nothing to observe diverging.
 *
 * This module exists to give the D-13 regression test a seam it can drive:
 * `useMinStageMatches`'s storage boundary (`isValidMinStageMatches` in
 * `apps/web/src/lib/analyticsSelection.ts`) admits only the three shipped
 * `MIN_STAGE_MATCHES_OPTIONS`, and `effectiveFloor(x) === x` for every one of
 * them — so a real persisted value can never exercise the raising behaviour.
 * `advisorThreshold` is a plain, unmounted-testable function precisely so a
 * test can call it with an input the picker can never produce (a sub-floor
 * value, or an above-floor value outside the option list) and observe both
 * the header and the gate follow it.
 *
 * A separate module rather than an export from `CounterpickAdvisor.tsx`
 * follows this repo's own "pure part factored out so it is unit-testable
 * without mounting" convention (`buildTrendSeries`,
 * `pages/Tournaments/lib/retrospective.ts`). It also sidesteps
 * `react-refresh/only-export-components`, which WARNS (not errors, since
 * this repo's `eslint.config.js` allows constant exports at that rule) on a
 * non-component export from a `.tsx` file — a secondary reason, not the
 * load-bearing one; do not undo the split on its strength alone.
 */
export function advisorThreshold(minGames?: number): number {
  return effectiveFloor(minGames);
}
