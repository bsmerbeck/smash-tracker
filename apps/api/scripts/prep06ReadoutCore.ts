/**
 * Phase 39 Plan 02 (PREP-06, D-19 in `.planning/phases/39-evidence-grounded-prep-debrief-spine/39-CONTEXT.md`):
 * the PURE computation behind the PREP-06 soak readout. No network, no
 * `process.env`, no RTDB import anywhere in this module — every input is a
 * value already returned by `runFunnelReadout` (`apps/api/src/jobs/funnelReadout.ts`).
 * That purity is what lets the owner-run entry point (`prep06Readout.ts`)
 * stay a thin composition root, and what lets this module's own test suite
 * prove the arithmetic without a network call or the owner's secret.
 *
 * Reports BOTH numbers, each labelled with its own denominator (D-19):
 *
 * - EXACT: when a day carries a persisted `reconcileSummary`
 *   (`reconcile.ts`'s additive `reconcileSummaries/{day}` write), the
 *   denominator is that run's own `checked` count.
 * - APPROXIMATE: when a day has no persisted summary (an older shard, or a
 *   day served by an API revision that predates the writer), the
 *   denominator is `eventCounts` restricted to `RECONCILED_EVENT_NAMES` —
 *   which works against production exactly as deployed today, and is a
 *   genuine approximation because `eventCounts` counts raw ledger rows while
 *   `checked` counts correlation-id-grouped units (39-RESEARCH.md Common
 *   Pitfalls §3).
 *
 * A window is NEVER blended into one percentage across the two methods — see
 * `computeReadout`'s `methodMix`.
 */
import type { FunnelReadoutDay, FunnelReadoutResult } from '../src/jobs/funnelReadout.js';

export type ReconcileMethod = 'exact' | 'approximate';

export interface DayMetric {
  day: string;
  reconcilePercent: number | null;
  duplicatePercent: number | null;
  method: ReconcileMethod;
  numerator: number;
  denominator: number;
  note: string;
}

/**
 * The approximate arm lands in Task 2 of this plan (see the plan's Task 2
 * `<action>` — it imports `RECONCILE_EXCEPTION_KINDS` from `reconcile.ts`
 * rather than hand-copying the kind strings, per C1-M7). Task 1 implements
 * the exact arm only and leaves the approximate arm throwing this NAMED
 * error rather than shipping a placeholder that would silently return a
 * zero percentage — a silent zero is indistinguishable from a genuinely
 * clean day and would be strictly worse than a loud failure here.
 */
export class ApproximateArmNotImplementedError extends Error {
  constructor() {
    super(
      'computeDayMetric: the approximate arm is not implemented yet — Task 2 of ' +
        'phase 39 plan 02 replaces this error with the real computation.',
    );
    this.name = 'ApproximateArmNotImplementedError';
  }
}

/**
 * Computes one day's metric. The EXACT arm (implemented here): when
 * `day.reconcileSummary` is present, `checked` is the denominator, the
 * numerator is `checked - missing - phantom - duplicate`, and `checked ===
 * 0` returns null percentages with an explanatory note rather than dividing
 * by zero.
 */
export function computeDayMetric(
  day: FunnelReadoutDay,
  // Accepted for the approximate arm Task 2 adds; unused by the exact arm.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reconciledEventNames: ReadonlySet<string>,
): DayMetric {
  const { reconcileSummary } = day;
  if (reconcileSummary) {
    const { checked, missing, phantom, duplicate } = reconcileSummary;
    if (checked === 0) {
      return {
        day: day.day,
        reconcilePercent: null,
        duplicatePercent: null,
        method: 'exact',
        numerator: 0,
        denominator: 0,
        note: 'exact — denominator (checked) is 0 for this day, so no percentage is computed.',
      };
    }
    const numerator = checked - missing - phantom - duplicate;
    return {
      day: day.day,
      reconcilePercent: (numerator / checked) * 100,
      duplicatePercent: (duplicate / checked) * 100,
      method: 'exact',
      numerator,
      denominator: checked,
      note: `exact — denominator is checked (${checked}), the persisted reconcile run's own count.`,
    };
  }

  throw new ApproximateArmNotImplementedError();
}
