import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PeriodGrain, PeriodPoint } from '@smash-tracker/shared';

/**
 * WR-02 (39.1-REVIEW.md): one time-zone rule for every game/set/session
 * label on the Matchups page — the host's LOCAL date, matching the results
 * list (`toLocaleDateString(i18n.language)`), the form-strip tick titles and
 * the session captions. Coarse grains (week/month/quarter/year) stay UTC,
 * because `periodSeries.ts` buckets them in UTC.
 *
 * The zone is pinned before `periodTicks.ts` is imported (its date
 * formatters are cached per locale and capture the host zone on first use),
 * and restored afterwards.
 */
const originalTz = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  return previous;
});

import { formatPeriodRowLabel, formatPeriodTickLabel } from './periodTicks';

afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

function point(grain: PeriodGrain, startMs: number, key: string): PeriodPoint {
  return {
    grain,
    key,
    label: new Date(startMs).toISOString(),
    startMs,
    endMs: startMs + 1,
    wins: 1,
    losses: 0,
    total: 1,
    rate: 1,
    subFloor: false,
    matchIds: [],
  };
}

/** 2023-11-16T03:30Z — the evening of Nov 15 in Los Angeles. */
const EVENING_GAME_MS = Date.UTC(2023, 10, 16, 3, 30);

describe('periodTicks — time-zone rule (WR-02)', () => {
  it('labels an evening game with its LOCAL date on the axis, not the next UTC day', () => {
    expect(formatPeriodTickLabel(point('game', EVENING_GAME_MS, 'game:0'), 'en')).toBe(
      'Nov 15, 2023',
    );
  });

  it('labels the table-twin row of set and session points with the same local date', () => {
    expect(formatPeriodRowLabel(point('set', EVENING_GAME_MS, 'set:0'), 'en')).toBe('Nov 15, 2023');
    expect(
      formatPeriodRowLabel(
        point('eventSession', EVENING_GAME_MS, `eventSession:session:${EVENING_GAME_MS}`),
        'en',
      ),
    ).toBe('Nov 15, 2023');
  });

  it('agrees with the results list local calendar day for the same game', () => {
    const listDate = new Date(EVENING_GAME_MS);
    const axis = formatPeriodTickLabel(point('game', EVENING_GAME_MS, 'game:0'), 'en');
    expect(axis).toContain(String(listDate.getDate()));
  });

  it('keeps coarse grains on UTC buckets (a UTC month start stays that month)', () => {
    const novemberUtc = Date.UTC(2023, 10, 1);
    expect(formatPeriodTickLabel(point('month', novemberUtc, 'month:2023-11'), 'en')).toBe(
      'Nov 2023',
    );
  });
});
