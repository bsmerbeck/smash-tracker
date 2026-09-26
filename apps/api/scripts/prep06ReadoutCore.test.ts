import { describe, expect, it } from 'vitest';
import type {
  FunnelReadoutDay,
  FunnelReadoutResult,
  ReconcileSummary,
} from '../src/jobs/funnelReadout.js';
import {
  assertSendableBaseUrl,
  computeDayMetric,
  computeReadout,
  parseFunnelReadoutResponse,
} from './prep06ReadoutCore.js';
import { funnelReadoutResultSchema } from '../src/routes/internalJobs.js';

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

// ---------------------------------------------------------------------------
// Code review API-WR-05 / API-WR-06 / API-WR-07: an honest readout.
// ---------------------------------------------------------------------------

describe('API-WR-05: a day with no reconcile evidence is never read as 100%', () => {
  it('events present, no exception rows and no persisted summary: the percentage is null, never 100', () => {
    const day = approximateDay({ eventCounts: { credits_granted: 7, credit_spent: 3 } });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('approximate');
    expect(metric.reconcilePercent).toBeNull();
    expect(metric.duplicatePercent).toBeNull();
    expect(metric.note).toContain('no reconcile evidence');
  });

  it('the partial current UTC day (the day generatedAt falls on) is labelled and carries no percentage, even with a summary', () => {
    const generatedAt = Date.UTC(2026, 8, 25, 15, 0, 0);
    const readout = computeReadout(
      {
        generatedAt,
        days: [
          dayWithSummary({ checked: 10, missing: 0, phantom: 0, duplicate: 0 }, '20260925'),
          dayWithSummary({ checked: 10, missing: 1, phantom: 0, duplicate: 0 }, '20260924'),
        ],
        totals: { eventCounts: {}, exceptionCounts: {}, pendingProjection: 0 },
      },
      RECONCILED_EVENT_NAMES,
    );

    const today = readout.days.find((d) => d.day === '20260925')!;
    expect(today.reconcilePercent).toBeNull();
    expect(today.duplicatePercent).toBeNull();
    expect(today.note).toContain('partial');
    const yesterday = readout.days.find((d) => d.day === '20260924')!;
    expect(yesterday.reconcilePercent).not.toBeNull();
    expect(readout.footnotes.some((f) => f.includes('20260925') && f.includes('partial'))).toBe(
      true,
    );
  });
});

describe('API-WR-06: outbox-pending rows never sit in the exact denominator, and no numerator goes negative', () => {
  it('exact arm: the denominator is reconciledUnits + phantom + duplicate — the outbox rows counted into checked are left out', () => {
    // checked 100 = 60 reconciled domain units + 40 outbox-pending rows.
    const day = dayWithSummary({
      checked: 100,
      missing: 3,
      phantom: 2,
      duplicate: 1,
      reconciledUnits: 60,
      outboxPending: 40,
    });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('exact');
    expect(metric.denominator).toBe(63); // 60 + 2 + 1
    expect(metric.numerator).toBe(57); // 60 - 3
    expect(metric.reconcilePercent).toBeCloseTo((57 / 63) * 100, 5);
    expect(metric.duplicatePercent).toBeCloseTo((1 / 63) * 100, 5);
    expect(metric.note).toContain('outbox');
  });

  it('a summary written before reconciledUnits existed is NOT reported as exact (its checked includes outbox rows)', () => {
    const day = dayWithSummary({ checked: 100, missing: 1, phantom: 1, duplicate: 0 });
    delete (day.reconcileSummary as Partial<ReconcileSummary>).reconciledUnits;

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.method).toBe('approximate');
    expect(metric.note).toContain('reconciledUnits');
  });

  it('exact arm: phantoms and duplicates beyond the reconciled units never drive the numerator negative', () => {
    const day = dayWithSummary({
      checked: 5,
      missing: 5,
      phantom: 9,
      duplicate: 4,
      reconciledUnits: 5,
      outboxPending: 0,
    });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.numerator).toBeGreaterThanOrEqual(0);
    expect(metric.reconcilePercent).toBeGreaterThanOrEqual(0);
  });

  it('approximate arm: more exception rows than reconciled ledger rows clamps the numerator at 0 and says so', () => {
    const day = approximateDay({
      eventCounts: { credits_granted: 2 },
      exceptionCounts: { missing_event: 5 },
    });

    const metric = computeDayMetric(day, RECONCILED_EVENT_NAMES);

    expect(metric.numerator).toBe(0);
    expect(metric.reconcilePercent).toBe(0);
    expect(metric.note).toContain('clamped');
  });
});

describe('API-WR-07: the script only sends the secret to a real API origin and refuses a non-JSON answer loudly', () => {
  it('refuses plain http (except loopback) and the Firebase Hosting domains before any request', () => {
    expect(() => assertSendableBaseUrl('http://example.com')).toThrow(/https/);
    expect(() => assertSendableBaseUrl('https://grandfinals.gg')).toThrow(/Cloud Run/);
    expect(() => assertSendableBaseUrl('https://www.grandfinals.gg/')).toThrow(/Cloud Run/);
    expect(() => assertSendableBaseUrl('https://smash-tracker-f97b7.web.app')).toThrow(/Cloud Run/);
    expect(() => assertSendableBaseUrl('not a url')).toThrow();
    expect(() =>
      assertSendableBaseUrl('https://smash-tracker-api-781901075636.us-central1.run.app'),
    ).not.toThrow();
    expect(() => assertSendableBaseUrl('http://localhost:3001')).not.toThrow();
  });

  const SECRET = 'super-secret-value';
  const HTML_BODY = `<!doctype html><html><body>${SECRET} spa shell</body></html>`;

  it('an HTML 200 (the SPA fallback) is refused with a message that echoes neither the body nor the secret', () => {
    const outcome = parseFunnelReadoutResponse({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      bodyText: HTML_BODY,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/not JSON/);
    expect(outcome.message).not.toContain('<!doctype');
    expect(outcome.message).not.toContain(SECRET);
  });

  it('a JSON content-type with an unparseable body, or a 200 JSON of the wrong shape, is refused without echoing it', () => {
    const garbled = parseFunnelReadoutResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: `{"oops": ${SECRET}`,
    });
    expect(garbled.ok).toBe(false);
    if (!garbled.ok) expect(garbled.message).not.toContain(SECRET);

    const wrongShape = parseFunnelReadoutResponse({
      status: 200,
      contentType: 'application/json',
      bodyText: JSON.stringify({ hello: SECRET }),
    });
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) {
      expect(wrongShape.message).toBe('unexpected response shape');
    }
  });

  it('a non-200 reports its status only', () => {
    const outcome = parseFunnelReadoutResponse({
      status: 401,
      contentType: 'application/json',
      bodyText: JSON.stringify({ message: SECRET }),
    });
    expect(outcome).toEqual({ ok: false, message: 'funnel-readout request failed: HTTP 401' });
  });

  it("a well-formed readout parses, and the core schema agrees with the route's own response schema", () => {
    const body = {
      generatedAt: 1_700_000_000_000,
      days: [
        dayWithSummary({ reconciledUnits: 90, outboxPending: 10 }),
        approximateDay({ eventCounts: { credits_granted: 2 } }),
      ],
      totals: { eventCounts: { credits_granted: 2 }, exceptionCounts: {}, pendingProjection: 0 },
    };
    const outcome = parseFunnelReadoutResponse({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      bodyText: JSON.stringify(body),
    });
    expect(outcome.ok).toBe(true);
    expect(funnelReadoutResultSchema.safeParse(body).success).toBe(true);
    expect(funnelReadoutResultSchema.parse(body).days[0]?.reconcileSummary).toMatchObject({
      reconciledUnits: 90,
      outboxPending: 10,
    });
  });
});
