import { describe, expect, it } from 'vitest';
import type {
  FunnelReadoutDay,
  FunnelReadoutResult,
  ReconcileSummary,
} from '../src/jobs/funnelReadout.js';
import { computeDayMetric, computeReadout } from './prep06ReadoutCore.js';

const RECONCILED_EVENT_NAMES = new Set<string>([
  'credits_granted',
  'checkout_completed',
  'credit_spent',
  'credit_refunded',
  'report_started',
  'report_completed',
  'report_failed',
]);

function dayWithSummary(
  overrides: Partial<ReconcileSummary> = {},
  day = '20260920',
): FunnelReadoutDay {
  return {
    day,
    eventCounts: {},
    exceptionCounts: {},
    pendingProjection: 0,
    reconcileSummary: {
      checked: 100,
      missing: 1,
      phantom: 1,
      duplicate: 0,
      generatedAt: 1_700_000_000_000,
      ...overrides,
    },
  };
}

function approximateDay(
  overrides: Partial<Pick<FunnelReadoutDay, 'day' | 'eventCounts' | 'exceptionCounts'>> = {},
): FunnelReadoutDay {
  return {
    day: '20260919',
    eventCounts: {},
    exceptionCounts: {},
    pendingProjection: 0,
    ...overrides,
  };
}

describe('computeDayMetric — exact arm (Task 1)', () => {
  it('computes reconcilePercent and duplicatePercent from the persisted checked denominator', () => {
    const day = dayWithSummary({ checked: 100, missing: 1, phantom: 1, duplicate: 2 });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('exact');
    expect(metric.denominator).toBe(100);
    expect(metric.numerator).toBe(96); // 100 - 1 - 1 - 2
    expect(metric.reconcilePercent).toBeCloseTo(96, 5);
    expect(metric.duplicatePercent).toBeCloseTo(2, 5);
    expect(metric.note).toContain('checked');
    expect(metric.note.length).toBeGreaterThan(0);
  });

  it('returns null percentages and an explanatory note rather than dividing when checked is 0', () => {
    const day = dayWithSummary({ checked: 0, missing: 0, phantom: 0, duplicate: 0 });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('exact');
    expect(metric.reconcilePercent).toBeNull();
    expect(metric.duplicatePercent).toBeNull();
    expect(metric.denominator).toBe(0);
    expect(metric.note.length).toBeGreaterThan(0);
  });

  it('labels the metric method "exact" whenever a persisted summary is present', () => {
    const day = dayWithSummary();

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('exact');
  });
});

describe('computeDayMetric — approximate arm (Task 2)', () => {
  it('computes reconcilePercent and duplicatePercent from eventCounts/exceptionCounts when no summary exists', () => {
    const day = approximateDay({
      eventCounts: { credits_granted: 8, checkout_completed: 2, _unknown: 5 },
      exceptionCounts: { missing_event: 1, duplicate_event: 1 },
    });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    // denominator: credits_granted(8) + checkout_completed(2) = 10 (RECONCILED_EVENT_NAMES only — _unknown excluded)
    expect(metric.method).toBe('approximate');
    expect(metric.denominator).toBe(10);
    expect(metric.numerator).toBe(8); // 10 - (missing_event 1 + duplicate_event 1)
    expect(metric.reconcilePercent).toBeCloseTo(80, 5);
    expect(metric.duplicatePercent).toBeCloseTo(10, 5); // duplicate_event(1) / 10
    expect(metric.note.length).toBeGreaterThan(0);
    expect(metric.note).toContain('eventCounts');
  });

  it('returns null percentages and a note rather than dividing when the reconciled-event denominator is 0', () => {
    const day = approximateDay({ eventCounts: { some_unrelated_event: 5 }, exceptionCounts: {} });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('approximate');
    expect(metric.reconcilePercent).toBeNull();
    expect(metric.duplicatePercent).toBeNull();
    expect(metric.denominator).toBe(0);
    expect(metric.note.length).toBeGreaterThan(0);
  });

  it('labels the metric method "approximate" whenever no persisted summary exists', () => {
    const day = approximateDay({ eventCounts: { credits_granted: 1 } });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('approximate');
  });
});

describe('computeReadout', () => {
  function readoutResult(days: FunnelReadoutDay[]): FunnelReadoutResult {
    return {
      generatedAt: 1_700_000_000_000,
      days,
      totals: { eventCounts: {}, exceptionCounts: {}, pendingProjection: 0 },
    };
  }

  it('reports methodMix and never blends a mixed window into one aggregate percentage', () => {
    const exactDay = dayWithSummary({}, '20260920');
    const approxDay = approximateDay({ day: '20260919', eventCounts: { credits_granted: 4 } });

    const readout = computeReadout(readoutResult([exactDay, approxDay]), RECONCILED_EVENT_NAMES);

    expect(readout.methodMix).toEqual({ exact: 1, approximate: 1 });
    expect(readout.days).toHaveLength(2);
    expect(readout.days.map((d) => d.method).sort()).toEqual(['approximate', 'exact']);
    // No key on the readout carries a single blended percentage — the shape
    // itself proves no aggregate percentage was computed across methods.
    expect(readout).not.toHaveProperty('reconcilePercent');
    expect(readout).not.toHaveProperty('blendedReconcilePercent');
  });

  it('computes the window firstDay/lastDay/dayCount from the day entries', () => {
    const readout = computeReadout(
      readoutResult([dayWithSummary({}, '20260920'), dayWithSummary({}, '20260918')]),
      RECONCILED_EVENT_NAMES,
    );

    expect(readout.window).toEqual({ firstDay: '20260918', lastDay: '20260920', dayCount: 2 });
  });

  it('every DayMetric carries a non-empty note', () => {
    const readout = computeReadout(
      readoutResult([
        dayWithSummary({}, '20260920'),
        approximateDay({ day: '20260919' }),
        approximateDay({ day: '20260918', eventCounts: { credits_granted: 3 } }),
      ]),
      RECONCILED_EVENT_NAMES,
    );

    for (const day of readout.days) {
      expect(typeof day.note).toBe('string');
      expect(day.note.length).toBeGreaterThan(0);
    }
  });

  it('always includes the v2.5 flip-rule reference footnote, and no code path derives a verdict from it', () => {
    const readout = computeReadout(readoutResult([dayWithSummary()]), RECONCILED_EVENT_NAMES);

    const flipRuleFootnote = readout.footnotes.find((f) => f.includes('98%'));
    expect(flipRuleFootnote).toBeDefined();
    expect(flipRuleFootnote).toContain('Reference');
    // The Readout shape itself is the proof no verdict is computed: no
    // boolean/verdict field exists anywhere on it to compare against the
    // flip rule.
    expect(readout).not.toHaveProperty('flipRulePassed');
    expect(readout).not.toHaveProperty('meetsFlipRule');
    expect(readout).not.toHaveProperty('verdict');
  });

  it('always includes the approximate-method definition footnote (present even in an all-exact window)', () => {
    const allExact = computeReadout(readoutResult([dayWithSummary()]), RECONCILED_EVENT_NAMES);

    expect(allExact.methodMix.approximate).toBe(0);
    expect(allExact.footnotes.some((f) => f.includes('Approximate method:'))).toBe(true);
    // The CONDITIONAL "which days were approximate" sentence is absent when
    // no day in this window is approximate.
    expect(allExact.footnotes.some((f) => f.includes('day(s) in this window are'))).toBe(false);
  });

  it('adds the "which days were approximate" sentence only when methodMix.approximate > 0', () => {
    const mixed = computeReadout(
      readoutResult([dayWithSummary({}, '20260920'), approximateDay({ day: '20260919' })]),
      RECONCILED_EVENT_NAMES,
    );

    expect(mixed.methodMix.approximate).toBe(1);
    expect(mixed.footnotes.some((f) => f.includes('1 of 2 day(s) in this window are'))).toBe(true);
  });
});
