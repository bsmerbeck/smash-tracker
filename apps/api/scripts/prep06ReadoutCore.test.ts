import { describe, expect, it } from 'vitest';
import type { FunnelReadoutDay, ReconcileSummary } from '../src/jobs/funnelReadout.js';
import { ApproximateArmNotImplementedError, computeDayMetric } from './prep06ReadoutCore.js';

const RECONCILED_EVENT_NAMES = new Set<string>([
  'credits_granted',
  'checkout_completed',
  'credit_spent',
  'credit_refunded',
  'report_started',
  'report_completed',
  'report_failed',
]);

function dayWithSummary(overrides: Partial<ReconcileSummary> = {}): FunnelReadoutDay {
  return {
    day: '20260920',
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

  it('throws the named ApproximateArmNotImplementedError for a day with no persisted summary (Task 1 stub)', () => {
    const day: FunnelReadoutDay = {
      day: '20260919',
      eventCounts: { credits_granted: 5 },
      exceptionCounts: {},
      pendingProjection: 0,
    };

    expect(() => computeDayMetric(day, RECONCILED_EVENT_NAMES)).toThrow(
      ApproximateArmNotImplementedError,
    );
  });
});
