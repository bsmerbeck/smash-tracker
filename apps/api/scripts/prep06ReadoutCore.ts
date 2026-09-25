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
 * A window is NEVER blended into one percentage across the two methods —
 * `computeReadout` reports `methodMix` and leaves every `DayMetric` labelled
 * by its own method; nothing here sums an exact day and an approximate day
 * into one aggregate percentage.
 */
import type { FunnelReadoutDay, FunnelReadoutResult } from '../src/jobs/funnelReadout.js';
import { RECONCILE_EXCEPTION_KINDS } from '../src/jobs/reconcile.js';

// C1-M7: derived from the IMPORTED tuple by position, never retyped as a
// fresh string literal — a second hand-copied `'duplicate_event'` here is
// exactly the drift class the export exists to prevent.
const [, , DUPLICATE_EVENT_KIND] = RECONCILE_EXCEPTION_KINDS;

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

export interface ReadoutWindow {
  firstDay: string;
  lastDay: string;
  dayCount: number;
}

export interface ReadoutMethodMix {
  exact: number;
  approximate: number;
}

export interface Readout {
  days: DayMetric[];
  window: ReadoutWindow;
  methodMix: ReadoutMethodMix;
  footnotes: string[];
}

/**
 * Computes one day's metric.
 *
 * EXACT arm: when `day.reconcileSummary` is present, `checked` is the
 * denominator, the numerator is `checked - missing - phantom - duplicate`,
 * and `checked === 0` returns null percentages with an explanatory note
 * rather than dividing by zero.
 *
 * APPROXIMATE arm: when no summary is present, the denominator is
 * `day.eventCounts` restricted to `reconciledEventNames`, and the numerator
 * subtracts `day.exceptionCounts` over the IMPORTED `RECONCILE_EXCEPTION_KINDS`
 * (never hand-copied — C1-M7). A zero denominator returns null percentages
 * with an explanatory note, exactly like the exact arm's zero-`checked`
 * guard.
 */
export function computeDayMetric(
  day: FunnelReadoutDay,
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

  let denominator = 0;
  for (const [eventName, count] of Object.entries(day.eventCounts)) {
    if (reconciledEventNames.has(eventName)) {
      denominator += count;
    }
  }

  const APPROX_NOTE_SUFFIX =
    "eventCounts counts raw ledger rows while the exact method's checked counts " +
    'correlation-id-grouped units.';

  if (denominator === 0) {
    return {
      day: day.day,
      reconcilePercent: null,
      duplicatePercent: null,
      method: 'approximate',
      numerator: 0,
      denominator: 0,
      note:
        'approximate — denominator is eventCounts summed over RECONCILED_EVENT_NAMES, ' +
        `which is 0 for this day, so no percentage is computed. ${APPROX_NOTE_SUFFIX}`,
    };
  }

  let exceptionCount = 0;
  for (const kind of RECONCILE_EXCEPTION_KINDS) {
    exceptionCount += day.exceptionCounts[kind] ?? 0;
  }
  const duplicateCount = day.exceptionCounts[DUPLICATE_EVENT_KIND] ?? 0;
  const numerator = denominator - exceptionCount;

  return {
    day: day.day,
    reconcilePercent: (numerator / denominator) * 100,
    duplicatePercent: (duplicateCount / denominator) * 100,
    method: 'approximate',
    numerator,
    denominator,
    note:
      `approximate — denominator is eventCounts summed over RECONCILED_EVENT_NAMES (${denominator}). ` +
      APPROX_NOTE_SUFFIX,
  };
}

/** Verbatim, in order — see `computeReadout`'s doc comment. */
const FLIP_RULE_FOOTNOTE =
  "Reference, not an enforced threshold: v2.5's flip rule reads >=98% reconcile and <0.5% " +
  'duplicates as the bar the owner compares these numbers against at the 39-14 checkpoint before ' +
  'deciding PREP_PAID_REPORTS_ENABLED — this script does not compute a pass/fail verdict.';

const APPROXIMATE_METHOD_FOOTNOTE =
  'Approximate method: eventCounts (raw ledger rows for RECONCILED_EVENT_NAMES) as the ' +
  "denominator, minus exceptionCounts over RECONCILE_EXCEPTION_KINDS as the numerator's " +
  'subtraction — an approximation because eventCounts counts raw ledger rows while the exact ' +
  "method's checked counts correlation-id-grouped units.";

/**
 * Aggregates a `FunnelReadoutResult` into per-day metrics plus a window
 * summary. NEVER computes a single blended percentage across exact and
 * approximate days — `methodMix` reports the split, and each `DayMetric`
 * carries its own `method`.
 *
 * `footnotes` always contains, verbatim and in this order: the v2.5 flip-rule
 * reference (stated as a reference, never enforced here), the approximate
 * method's definition, and — only when `methodMix.approximate > 0` — a
 * sentence naming which days were approximate and why a day can have no
 * summary.
 */
export function computeReadout(
  result: FunnelReadoutResult,
  reconciledEventNames: ReadonlySet<string>,
): Readout {
  const days = result.days.map((day) => computeDayMetric(day, reconciledEventNames));

  const methodMix: ReadoutMethodMix = { exact: 0, approximate: 0 };
  for (const metric of days) {
    methodMix[metric.method] += 1;
  }

  const sortedDayKeys = [...result.days].map((entry) => entry.day).sort();
  const window: ReadoutWindow = {
    firstDay: sortedDayKeys[0] ?? '',
    lastDay: sortedDayKeys[sortedDayKeys.length - 1] ?? '',
    dayCount: result.days.length,
  };

  const footnotes: string[] = [FLIP_RULE_FOOTNOTE, APPROXIMATE_METHOD_FOOTNOTE];
  if (methodMix.approximate > 0) {
    footnotes.push(
      `${methodMix.approximate} of ${result.days.length} day(s) in this window are ` +
        'approximate — a day has no persisted summary because it is from before this ' +
        "plan's reconcileSummaries writer took effect (the owner's next deploy), or the " +
        'shard predates that deploy.',
    );
  }

  return { days, window, methodMix, footnotes };
}
