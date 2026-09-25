import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { computeRatingHistory } from '../glicko.js';
import { generateSyntheticMatches } from '../testUtils/syntheticMatches.js';
import { calendarBucketBounds } from './periodSeries.js';
import { buildCareerTimeline, careerGamesStep, careerRateStep } from './careerTimeline.js';

/**
 * Plan 39.1-34: the career-timeline engine (UI-SPEC §11, §12.1). The chart
 * never bins — every point and cell asserted here is final engine output.
 *
 * The sparg0-shaped fixture mirrors guard:layout's `career` scale exactly
 * (same seed and options): 8,400 games from 18 Dec 2018, sessions of 6-28
 * games 135h apart, 73% wins — last game 22 Aug 2026, 495 sessions, 93
 * months with games.
 */
const SPARG0_SHAPED: Match[] = generateSyntheticMatches({
  seed: 39_134_001,
  count: 8_400,
  startMs: Date.UTC(2018, 11, 18, 18),
  sessionSizeRange: [6, 28],
  sessionGapMs: 135 * 60 * 60 * 1000,
  winRate: 0.73,
  mainFighterIds: [8, 22],
  opponentFighterIds: [1, 10],
  stageIds: [1],
});
const NOW_MS = Date.UTC(2026, 8, 17);

function buildSparg0Shaped() {
  return buildCareerTimeline({ matches: SPARG0_SHAPED, horizon: 'last30', nowMs: NOW_MS });
}

describe('buildCareerTimeline (plan 39.1-34) — the sparg0-shaped pro path', () => {
  const timeline = buildSparg0Shaped();

  it('is full, on the quarter grain, with 20..60 closes in strictly increasing close order', () => {
    expect(timeline.state).toBe('full');
    expect(timeline.rating.grain).toBe('quarter');
    expect(timeline.rating.points.length).toBeGreaterThanOrEqual(20);
    expect(timeline.rating.points.length).toBeLessThanOrEqual(60);
    const closes = timeline.rating.points.map((p) => p.closeMs);
    for (let i = 1; i < closes.length; i++) {
      expect(closes[i]!).toBeGreaterThan(closes[i - 1]!);
    }
  });

  it("the last point's rating/rd equal computeRatingHistory's current rating", () => {
    const { current } = computeRatingHistory(SPARG0_SHAPED);
    const last = timeline.rating.points[timeline.rating.points.length - 1]!;
    expect(last.rating).toBe(current!.rating);
    expect(last.rd).toBe(current!.rd);
    expect(timeline.rating.current).toEqual({ rating: current!.rating, rd: current!.rd });
  });

  it("every point's rating/rd is the close of the LAST session whose end falls inside that quarter", () => {
    const { periods } = computeRatingHistory(SPARG0_SHAPED);
    for (const point of timeline.rating.points) {
      const inside = periods.filter((p) => p.end >= point.startMs && p.end < point.endMs);
      expect(inside.length).toBeGreaterThan(0);
      const closing = inside[inside.length - 1]!;
      expect(point.rating).toBe(closing.rating);
      expect(point.rd).toBe(closing.rd);
      expect(point.closeMs).toBe(closing.end);
      const bounds = calendarBucketBounds('quarter', point.startMs);
      expect([point.startMs, point.endMs]).toEqual([bounds.startMs, bounds.endMs]);
    }
  });

  it('wide strips: one month cell per UTC month holding a game, each on calendarBucketBounds, totals summing to 8,400', () => {
    const wide = timeline.strips!.wide;
    expect(wide.grain).toBe('month');
    expect(wide.cells.length).toBeLessThanOrEqual(108);
    const monthsWithGames = new Set(
      SPARG0_SHAPED.map((m) => calendarBucketBounds('month', m.time).key),
    );
    expect(wide.cells.map((c) => c.key).sort()).toEqual([...monthsWithGames].sort());
    for (const cell of wide.cells) {
      const bounds = calendarBucketBounds('month', cell.startMs);
      expect([cell.startMs, cell.endMs]).toEqual([bounds.startMs, bounds.endMs]);
    }
    expect(wide.cells.reduce((sum, c) => sum + c.total, 0)).toBe(8_400);
  });

  it('narrow strips: quarter cells, at most 36, also summing to 8,400', () => {
    const narrow = timeline.strips!.narrow;
    expect(narrow.grain).toBe('quarter');
    expect(narrow.cells.length).toBeLessThanOrEqual(36);
    expect(narrow.cells.reduce((sum, c) => sum + c.total, 0)).toBe(8_400);
  });

  it('is pure: the same input twice deep-equals, and the input array is not mutated', () => {
    const before = JSON.stringify(SPARG0_SHAPED);
    const again = buildSparg0Shaped();
    expect(again).toEqual(timeline);
    expect(JSON.stringify(SPARG0_SHAPED)).toBe(before);
  });
});

describe('careerRateStep (sketch 002 stepFor, UI-SPEC §12.1)', () => {
  it('+7 pts over 90 games -> step 3, no reason', () => {
    expect(careerRateStep({ deltaPoints: 7, total: 90 })).toEqual({ step: 3, reason: null });
  });

  it('+0.5 pts -> step 0', () => {
    expect(careerRateStep({ deltaPoints: 0.5, total: 90 }).step).toBe(0);
  });

  it('+15 pts over 10 games -> capped at step 2', () => {
    expect(careerRateStep({ deltaPoints: 15, total: 10 })).toEqual({ step: 2, reason: 'capped' });
  });

  it('+15 pts over 5 games -> neutral, below the floor', () => {
    expect(careerRateStep({ deltaPoints: 15, total: 5 })).toEqual({
      step: 0,
      reason: 'belowFloor',
    });
  });

  it('-7 pts over 90 games -> step -3 (the sign follows the delta)', () => {
    expect(careerRateStep({ deltaPoints: -7, total: 90 }).step).toBe(-3);
  });
});

describe('careerGamesStep (5-step sequential by square root of n)', () => {
  it('the busiest cell is step 5', () => {
    expect(careerGamesStep({ total: 400, maxTotal: 400 })).toBe(5);
  });

  it('a cell with 1/25 of the busiest total is step 1', () => {
    expect(careerGamesStep({ total: 16, maxTotal: 400 })).toBe(1);
  });
});
