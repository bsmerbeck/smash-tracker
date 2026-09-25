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

// ---------------------------------------------------------------------------
// Task 2 (plan 39.1-34): every honest edge — ladder at every account shape,
// close semantics at period boundaries, empty-period gaps, thin and locked
// states, step boundaries, the rating in force per cell, the recent window,
// last / peak / low, the domain, the strip ladders. Small hand-built
// fixtures with explicit times.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EDGE_NOW = Date.UTC(2030, 0, 1);

function game(id: string, time: number, win = true): Match {
  return { id, fighter_id: 8, opponent_id: 23, time, win };
}

/** One session of `count` games, 10 minutes apart, starting at `startMs`. */
function session(prefix: string, startMs: number, count: number, winEvery = 2): Match[] {
  return Array.from({ length: count }, (_, i) =>
    game(`${prefix}-${i}`, startMs + i * 10 * 60 * 1000, i % winEvery === 0),
  );
}

function timelineOf(
  matches: Match[],
  lineTarget?: number,
  horizon: 'last30' | 'last90' = 'last30',
) {
  return buildCareerTimeline({
    matches,
    horizon,
    nowMs: EDGE_NOW,
    ...(lineTarget !== undefined ? { lineTarget } : {}),
  });
}

function gamesIn(matches: Match[], startMs: number, endMs: number): number {
  return matches.filter((m) => m.time >= startMs && m.time < endMs).length;
}

describe('buildCareerTimeline (Task 2) — the ladder at every account shape', () => {
  it('12 sessions -> session grain: one point per session, [first game, last game + 1), closing at the last game', () => {
    const sessions = Array.from({ length: 12 }, (_, s) =>
      session(`s${s}`, Date.UTC(2024, 0, 1 + s * 9, 18), 5),
    );
    const matches = sessions.flat();
    const timeline = timelineOf(matches);
    expect(timeline.rating.grain).toBe('session');
    expect(timeline.rating.points).toHaveLength(12);
    timeline.rating.points.forEach((point, i) => {
      const games = sessions[i]!;
      expect(point.startMs).toBe(games[0]!.time);
      expect(point.endMs).toBe(games[games.length - 1]!.time + 1);
      expect(point.closeMs).toBe(games[games.length - 1]!.time);
      expect(point.wins + point.losses).toBe(games.length);
      expect(point.wins).toBe(games.filter((m) => m.win).length);
    });
    expect(timeline.rating.finerGrainPointCount).toBeNull();
  });

  it('61 sessions inside 20 ISO weeks -> week grain', () => {
    // Three sessions per week (Mon/Wed/Fri) for 20 weeks = 60, plus one more on week 1's Sunday.
    const monday = Date.UTC(2024, 0, 1, 18);
    const matches: Match[] = [];
    for (let w = 0; w < 20; w++) {
      for (const d of [0, 2, 4]) {
        matches.push(...session(`w${w}d${d}`, monday + (w * 7 + d) * DAY, 3));
      }
    }
    matches.push(...session('extra', monday + 6 * DAY, 3));
    const timeline = timelineOf(matches);
    expect(timeline.rating.sessionCount).toBe(61);
    expect(timeline.rating.grain).toBe('week');
    expect(timeline.rating.points).toHaveLength(20);
    expect(timeline.rating.finerGrainPointCount).toBe(61);
  });

  it('more than 60 weeks inside 30 months -> month grain', () => {
    const matches: Match[] = [];
    for (let w = 0; w < 120; w++) {
      matches.push(...session(`w${w}`, Date.UTC(2022, 0, 3, 18) + w * 7 * DAY, 3));
    }
    const timeline = timelineOf(matches);
    expect(timeline.rating.grain).toBe('month');
    expect(timeline.rating.points.length).toBeLessThanOrEqual(30);
    expect(timeline.rating.finerGrainPointCount).toBeGreaterThan(60);
  });

  it('the 8,400-game fixture with lineTarget 9 -> year grain; points never exceed the target', () => {
    // The fixture spans nine calendar years (Dec 2018 - Aug 2026): quarters (32) exceed 9,
    // years (9) fit — the coarsest rung of the ladder.
    const timeline = timelineOf(SPARG0_SHAPED, 9);
    expect(timeline.rating.grain).toBe('year');
    expect(timeline.rating.points).toHaveLength(9);
    expect(timeline.rating.finerGrainPointCount).toBe(buildSparg0Shaped().rating.points.length);
  });

  it('finerGrainPointCount is the month count on the quarter-grained pro fixture', () => {
    const timeline = buildSparg0Shaped();
    const monthly = timelineOf(SPARG0_SHAPED, 1_000);
    expect(monthly.rating.grain).toBe('session');
    const monthCloses = new Set(
      computeRatingHistory(SPARG0_SHAPED).periods.map(
        (p) => calendarBucketBounds('month', p.end).key,
      ),
    );
    expect(timeline.rating.finerGrainPointCount).toBe(monthCloses.size);
    expect(timeline.rating.finerGrainPointCount).toBeGreaterThan(60);
  });
});

describe('buildCareerTimeline (Task 2) — close semantics at period boundaries', () => {
  // Sessions: Jan 5 / 12 / 19, a session straddling 31 Jan 23:00 -> 1 Feb 01:00 UTC,
  // Feb 10 / 20, Mar 5 / 15 — 8 sessions in 8 ISO weeks, closes in 3 months.
  const straddle = [
    game('x-0', Date.UTC(2024, 0, 31, 23, 0)),
    game('x-1', Date.UTC(2024, 0, 31, 23, 40), false),
    game('x-2', Date.UTC(2024, 1, 1, 0, 30)),
    game('x-3', Date.UTC(2024, 1, 1, 1, 0), false),
  ];
  const matches = [
    ...session('j5', Date.UTC(2024, 0, 5, 18), 4),
    ...session('j12', Date.UTC(2024, 0, 12, 18), 4),
    ...session('j19', Date.UTC(2024, 0, 19, 18), 4),
    ...straddle,
    ...session('f10', Date.UTC(2024, 1, 10, 18), 4),
    ...session('f20', Date.UTC(2024, 1, 20, 18), 4),
    ...session('m5', Date.UTC(2024, 2, 5, 18), 4),
    ...session('m15', Date.UTC(2024, 2, 15, 18), 4),
  ];

  it('a session straddling a month boundary counts its games by game time and closes in the later month', () => {
    const timeline = timelineOf(matches, 3);
    expect(timeline.rating.grain).toBe('month');
    const jan = timeline.rating.points.find((p) => p.key === 'month:2024-01')!;
    const feb = timeline.rating.points.find((p) => p.key === 'month:2024-02')!;
    expect(jan.wins + jan.losses).toBe(12 + 2);
    expect(feb.wins + feb.losses).toBe(2 + 8);
    // January's close is the Jan 19 session; the straddling session closes in February.
    expect(jan.closeMs).toBe(Date.UTC(2024, 0, 19, 18) + 3 * 10 * 60 * 1000);
    expect(feb.closeMs).toBe(Date.UTC(2024, 1, 20, 18) + 3 * 10 * 60 * 1000);
    const history = computeRatingHistory(matches);
    const straddleClose = history.periods.find((p) => p.end === straddle[3]!.time)!;
    expect(new Date(straddleClose.end).getUTCMonth()).toBe(1);
  });

  it("every point's wins + losses equal the fixture games with time in [startMs, endMs)", () => {
    for (const lineTarget of [3, 8, 60]) {
      for (const point of timelineOf(matches, lineTarget).rating.points) {
        expect(point.wins + point.losses).toBe(gamesIn(matches, point.startMs, point.endMs));
      }
    }
  });

  it('a month whose games all belong to a session ending the next month has NO point', () => {
    const aprilOnlyStraddle = [
      ...session('j5', Date.UTC(2024, 0, 5, 18), 4),
      ...session('j20', Date.UTC(2024, 0, 20, 18), 4),
      game('a-0', Date.UTC(2024, 3, 30, 23, 0)),
      game('a-1', Date.UTC(2024, 3, 30, 23, 50)),
      game('a-2', Date.UTC(2024, 4, 1, 0, 40)),
    ];
    const timeline = timelineOf(aprilOnlyStraddle, 2);
    expect(timeline.rating.grain).toBe('month');
    const keys = timeline.rating.points.map((p) => p.key);
    expect(keys).toEqual(['month:2024-01', 'month:2024-05']);
    expect(keys).not.toContain('month:2024-04');
  });
});

describe('buildCareerTimeline (Task 2) — empty calendar periods break the line', () => {
  it('at month grain, the first point after a 3-month hole has gapBefore; adjacent months do not', () => {
    const months = [0, 1, 2, 6, 7];
    const matches = months.flatMap((m) => [
      ...session(`m${m}a`, Date.UTC(2024, m, 3, 18), 4),
      ...session(`m${m}b`, Date.UTC(2024, m, 17, 18), 4),
    ]);
    const timeline = timelineOf(matches, 5);
    expect(timeline.rating.grain).toBe('month');
    expect(timeline.rating.points.map((p) => [p.key, p.gapBefore])).toEqual([
      ['month:2024-01', false],
      ['month:2024-02', false],
      ['month:2024-03', false],
      ['month:2024-07', true],
      ['month:2024-08', false],
    ]);
  });

  it('session grain never sets gapBefore', () => {
    const matches = [
      ...session('a', Date.UTC(2024, 0, 3, 18), 4),
      ...session('b', Date.UTC(2024, 6, 3, 18), 4),
    ];
    const timeline = timelineOf(matches);
    expect(timeline.rating.grain).toBe('session');
    expect(timeline.rating.points.every((p) => !p.gapBefore)).toBe(true);
  });
});

describe('buildCareerTimeline (Task 2) — thin and locked states', () => {
  it('41 games over 3 months -> thin, no strips, session grain', () => {
    const matches = [0, 1, 2]
      .flatMap((m) =>
        [2, 9, 16, 23].map((d, i) =>
          session(`t${m}-${d}`, Date.UTC(2026, 6 + m, d, 18), m === 2 && i === 3 ? 2 : 3),
        ),
      )
      .flat();
    expect(matches).toHaveLength(35);
    const withMore = [...matches, ...session('extra', Date.UTC(2026, 8, 27, 18), 6)];
    expect(withMore).toHaveLength(41);
    const timeline = timelineOf(withMore);
    expect(timeline.state).toBe('thin');
    expect(timeline.strips).toBeNull();
    expect(timeline.rating.grain).toBe('session');
  });

  it('games in exactly 6 distinct months -> full; 5 -> thin', () => {
    const sixMonths = [0, 1, 2, 3, 4, 5].flatMap((m) =>
      session(`six${m}`, Date.UTC(2024, m, 10, 18), 3),
    );
    expect(timelineOf(sixMonths).state).toBe('full');
    const fiveMonths = [0, 1, 2, 3, 4].flatMap((m) =>
      session(`five${m}`, Date.UTC(2024, m, 10, 18), 3),
    );
    expect(timelineOf(fiveMonths).state).toBe('thin');
  });

  it('4 games -> locked with gamesNeeded 1, no points, no strips', () => {
    const timeline = timelineOf(session('four', Date.UTC(2024, 0, 10, 18), 4));
    expect(timeline.state).toBe('locked');
    expect(timeline.gamesNeeded).toBe(1);
    expect(timeline.rating.points).toEqual([]);
    expect(timeline.strips).toBeNull();
  });

  it('0 games -> locked with gamesNeeded 5 and no domain', () => {
    const timeline = timelineOf([]);
    expect(timeline.state).toBe('locked');
    expect(timeline.gamesNeeded).toBe(5);
    expect(timeline.domain).toBeNull();
  });
});

describe('careerRateStep (Task 2) — every step boundary', () => {
  it.each([
    [0.99, 0],
    [1, 1],
    [2.99, 1],
    [3, 2],
    [6, 3],
    [10, 4],
    [-0.99, 0],
    [-1, -1],
    [-3, -2],
    [-6, -3],
    [-10, -4],
  ])('|delta| %s over 90 games -> step %s (the sign follows the delta)', (deltaPoints, step) => {
    expect(careerRateStep({ deltaPoints, total: 90 })).toEqual({ step, reason: null });
  });

  it('7 games -> neutral, belowFloor', () => {
    expect(careerRateStep({ deltaPoints: 12, total: 7 })).toEqual({
      step: 0,
      reason: 'belowFloor',
    });
  });

  it('8 and 19 games with a 12-pt delta -> capped at 2; 20 games -> step 4, no reason', () => {
    expect(careerRateStep({ deltaPoints: 12, total: 8 })).toEqual({ step: 2, reason: 'capped' });
    expect(careerRateStep({ deltaPoints: 12, total: 19 })).toEqual({ step: 2, reason: 'capped' });
    expect(careerRateStep({ deltaPoints: 12, total: 20 })).toEqual({ step: 4, reason: null });
  });

  it("every strip cell's deltaPoints is round((rate - baseline) x 1000) / 10", () => {
    const timeline = buildSparg0Shaped();
    for (const cell of timeline.strips!.wide.cells) {
      expect(cell.deltaPoints).toBe(Math.round((cell.rate - timeline.baseline.rate) * 1000) / 10);
    }
  });
});

describe('buildCareerTimeline (Task 2) — the rating in force per strip cell', () => {
  it("each cell's ratingAtClose is the LAST rating point starting at or before the cell's last instant", () => {
    const timeline = buildSparg0Shaped();
    const points = timeline.rating.points;
    for (const cell of timeline.strips!.wide.cells) {
      const inForce = [...points].reverse().find((p) => p.startMs <= cell.endMs - 1) ?? null;
      expect(cell.ratingAtClose).toEqual(
        inForce && {
          key: inForce.key,
          label: inForce.label,
          rating: inForce.rating,
          rd: inForce.rd,
        },
      );
    }
    expect(timeline.strips!.wide.cells.some((c) => c.ratingAtClose !== null)).toBe(true);
  });

  it('a cell before the first rating point has no rating in force', () => {
    // January's only games belong to a session closing on 1 Feb, so the month line starts in February.
    const matches = [
      game('s-0', Date.UTC(2024, 0, 31, 23, 0)),
      game('s-1', Date.UTC(2024, 0, 31, 23, 40)),
      game('s-2', Date.UTC(2024, 1, 1, 0, 30)),
      ...[1, 2, 3, 4, 5, 6].flatMap((m) => [
        ...session(`c${m}a`, Date.UTC(2024, m, 8, 18), 4),
        ...session(`c${m}b`, Date.UTC(2024, m, 22, 18), 4),
      ]),
    ];
    const timeline = timelineOf(matches, 6);
    expect(timeline.state).toBe('full');
    expect(timeline.rating.grain).toBe('month');
    expect(timeline.rating.points[0]!.key).toBe('month:2024-02');
    const january = timeline.strips!.wide.cells.find((c) => c.key === 'month:2024-01')!;
    expect(january.ratingAtClose).toBeNull();
    const february = timeline.strips!.wide.cells.find((c) => c.key === 'month:2024-02')!;
    expect(february.ratingAtClose?.key).toBe('month:2024-02');
  });
});

describe('buildCareerTimeline (Task 2) — the recent window is resolveWindow’s own InsightWindow', () => {
  it("'last30' on the 8,400-game fixture -> the last 30 games' window", () => {
    const timeline = buildSparg0Shaped();
    const sorted = [...SPARG0_SHAPED].sort((a, b) => a.time - b.time);
    const last30 = sorted.slice(-30);
    expect(timeline.recentWindow).toEqual({
      horizon: 'last30',
      fromMs: last30[0]!.time,
      toMs: last30[29]!.time,
      games: 30,
      scoped: false,
    });
  });

  it("'last30' on a 41-game account collapses (30 / 41 >= HORIZON_COLLAPSE_RATIO) -> no band", () => {
    const matches = Array.from({ length: 41 }, (_, i) =>
      game(`c${i}`, Date.UTC(2026, 6, 1) + i * DAY),
    );
    expect(timelineOf(matches).recentWindow).toBeNull();
  });

  it("'last90' with no game in the 90 days before now -> no band", () => {
    const matches = Array.from({ length: 20 }, (_, i) =>
      game(`o${i}`, Date.UTC(2020, 0, 1) + i * DAY),
    );
    expect(timelineOf(matches, undefined, 'last90').recentWindow).toBeNull();
  });
});

describe('buildCareerTimeline (Task 2) — last / peak / low', () => {
  it('lastIndex is the last point; peak / low are the highest / lowest ratings, ties keeping the earlier point', () => {
    const timeline = buildSparg0Shaped();
    const points = timeline.rating.points;
    expect(timeline.rating.lastIndex).toBe(points.length - 1);
    let peak = 0;
    let low = 0;
    points.forEach((p, i) => {
      if (p.rating > points[peak]!.rating) peak = i;
      if (p.rating < points[low]!.rating) low = i;
    });
    expect(timeline.rating.peakIndex).toBe(peak === points.length - 1 ? null : peak);
    expect(timeline.rating.lowIndex).toBe(
      low === points.length - 1 || low === peak || points.length <= 4 ? null : low,
    );
  });

  it('peakIndex is null when the peak is the last point (a steadily improving account)', () => {
    const matches = Array.from({ length: 10 }, (_, s) =>
      session(`up${s}`, Date.UTC(2024, 0, 1 + s * 5, 18), 4, 1),
    ).flat();
    const timeline = timelineOf(matches);
    expect(timeline.rating.points[timeline.rating.points.length - 1]!.rating).toBe(
      Math.max(...timeline.rating.points.map((p) => p.rating)),
    );
    expect(timeline.rating.peakIndex).toBeNull();
  });

  it('lowIndex is null with 4 or fewer points', () => {
    const matches = [0, 1, 2, 3].flatMap((s) =>
      session(`few${s}`, Date.UTC(2024, 0, 1 + s * 5, 18), 4, s % 2 === 0 ? 1 : 4),
    );
    const timeline = timelineOf(matches);
    expect(timeline.rating.points).toHaveLength(4);
    expect(timeline.rating.lowIndex).toBeNull();
  });
});

describe('buildCareerTimeline (Task 2) — the domain', () => {
  it('spans the first game to the last game', () => {
    const timeline = buildSparg0Shaped();
    const times = SPARG0_SHAPED.map((m) => m.time);
    expect(timeline.domain).toEqual({ startMs: Math.min(...times), endMs: Math.max(...times) });
  });

  it('is padded 12 hours each side when every game shares one instant', () => {
    const t = Date.UTC(2024, 5, 1, 12);
    const matches = Array.from({ length: 6 }, (_, i) => game(`same${i}`, t, i % 2 === 0));
    expect(timelineOf(matches).domain).toEqual({ startMs: t - 12 * HOUR, endMs: t + 12 * HOUR });
  });
});

describe('buildCareerTimeline (Task 2) — the strip ladders', () => {
  it('more than 108 months with games -> wide quarter strips; more than 36 quarters -> narrow year strips', () => {
    const matches = Array.from({ length: 112 }, (_, m) =>
      session(`long${m}`, Date.UTC(2015, m, 10, 18), 2),
    ).flat();
    const timeline = timelineOf(matches);
    expect(timeline.state).toBe('full');
    expect(timeline.strips!.wide.grain).toBe('quarter');
    expect(timeline.strips!.wide.cells.length).toBeLessThanOrEqual(108);
    expect(timeline.strips!.narrow.grain).toBe('year');
    expect(timeline.strips!.narrow.cells.length).toBeLessThanOrEqual(36);
  });
});
