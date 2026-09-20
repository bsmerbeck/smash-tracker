import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import {
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
  FIFTY_K_FIXTURE_OPTIONS,
} from '../testUtils/syntheticMatches.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
} from '../testUtils/sparseWorkspaces.js';
import {
  MARK_BOUND_LINE_POINTS,
  NARROW_PLOT_TARGET,
  PERIOD_TREND_MIN_PERIODS,
} from './markBounds.js';
import { buildPeriodSeries, regrainFor, type PeriodGrain } from './periodSeries.js';

/** Minimal, deterministic `Match` builder — only the fields a given test cares about are overridden. */
function makeMatch(id: string, time: number, overrides: Partial<Match> = {}): Match {
  return {
    id,
    fighter_id: 8,
    opponent_id: 23,
    time,
    win: true,
    ...overrides,
  };
}

/**
 * `quarterCount` quarters of 2021 (5th quarter spills into 2022), 3 distinct
 * months and 2 games per month within each quarter — engineered so `game`,
 * `set`/`eventSession` (whether Task 1's placeholder or Task 2's real
 * session grouping) and `week`/`month` grains ALL produce more than the
 * small target this fixture is tested against, while `quarter` (and, once a
 * 5th quarter spills into a new year, `year`) do not.
 */
function buildQuarterBoundaryFixture(quarterCount: 4 | 5): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  for (let q = 0; q < quarterCount; q++) {
    const year = 2021 + Math.floor(q / 4);
    const quarterInYear = q % 4;
    for (let m = 0; m < 3; m++) {
      const month = quarterInYear * 3 + m;
      for (let g = 0; g < 2; g++) {
        const ms = Date.UTC(year, month, 5, g);
        matches.push(makeMatch(`qb-${counter}`, ms, { win: counter % 2 === 0 }));
        counter++;
      }
    }
  }
  return matches;
}

/**
 * Three quarters of 2021: the first and third comfortably clear
 * `ABSTENTION_FLOOR_GAMES`, the middle one (Q2) totals 2 games — sub-floor.
 * Each quarter spreads its games across 3 distinct months so `week`/`month`
 * grain both produce more points than this fixture's target, forcing the
 * ladder down to `quarter`.
 */
function buildSubFloorQuarterFixture(): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  const push = (month: number, count: number): void => {
    for (let i = 0; i < count; i++) {
      const ms = Date.UTC(2021, month, 5, i);
      matches.push(makeMatch(`sf-${counter}`, ms, { win: counter % 2 === 0 }));
      counter++;
    }
  };
  push(0, 4);
  push(1, 4);
  push(2, 4); // Q1 2021: 12 games
  push(3, 1);
  push(4, 1); // Q2 2021: 2 games — sub-floor
  push(6, 4);
  push(7, 4);
  push(8, 4); // Q3 2021: 12 games
  return matches;
}

describe('buildPeriodSeries (VIZ-01) — the grain ladder', () => {
  it('bounds the 8k-game fixture at or under the default line-point cap, with a named grain', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const series = buildPeriodSeries({ matches });
    expect(series.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
    expect(series.grain.length).toBeGreaterThan(0);
    expect(series.points.every((point) => point.total >= 1)).toBe(true);
  });

  it('bounds the 50k-game fixture at or under the default line-point cap', () => {
    const matches = generateSyntheticMatches(FIFTY_K_FIXTURE_OPTIONS);
    const series = buildPeriodSeries({ matches });
    expect(series.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
    expect(series.points.every((point) => point.total >= 1)).toBe(true);
  });

  it('returns an empty series with a named grain and no synthetic period over zero matches, and never throws', () => {
    const series = buildPeriodSeries({ matches: [] });
    expect(series.points).toEqual([]);
    expect(series.grain.length).toBeGreaterThan(0);
    expect(series.totalGames).toBe(0);
    expect(series.boundReached).toBe(true);
  });

  it('selects the grain whose count is exactly the target, and moves one step coarser once one more period appears', () => {
    const atBoundary = buildPeriodSeries({ matches: buildQuarterBoundaryFixture(4), target: 4 });
    expect(atBoundary.grain).toBe('quarter');
    expect(atBoundary.points).toHaveLength(4);

    const overBoundary = buildPeriodSeries({ matches: buildQuarterBoundaryFixture(5), target: 4 });
    expect(overBoundary.grain).toBe('year');
    expect(overBoundary.points).toHaveLength(2);
  });

  it('flags a sub-floor period with its real counts, without dropping it, while adjacent periods at/above the floor stay unflagged', () => {
    const series = buildPeriodSeries({ matches: buildSubFloorQuarterFixture(), target: 5 });
    expect(series.grain).toBe('quarter');
    expect(series.points).toHaveLength(3);
    const [q1, q2, q3] = series.points;
    expect(q1?.total).toBe(12);
    expect(q1?.subFloor).toBe(false);
    expect(q2?.total).toBe(2);
    expect(q2?.subFloor).toBe(true);
    expect(q3?.total).toBe(12);
    expect(q3?.subFloor).toBe(false);
  });

  it('sorts points oldest first by startMs, breaking a tie by ascending key', () => {
    const tiedMs = Date.UTC(2022, 5, 1, 12);
    const matches = [
      makeMatch('zulu', tiedMs, { win: true }),
      makeMatch('alpha', tiedMs, { win: false }),
    ];
    const series = buildPeriodSeries({ matches, target: 60 });
    expect(series.grain).toBe('game');
    expect(series.points.map((point) => point.key)).toEqual(['game:alpha', 'game:zulu']);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the full ladder — set, eventSession and week tiers, ported anchors,
// and narrow-plot re-graining.
// ---------------------------------------------------------------------------

/** Three games sharing one parsed start.gg set id — must collapse to exactly one `set`-grain point. */
function buildSharedSetFixture(): Match[] {
  const base = Date.UTC(2022, 2, 1, 12);
  return [0, 1, 2].map((g) =>
    makeMatch(`set-game-${g}`, base + g * 60_000, {
      externalId: `sgg:S1:g${g + 1}`,
      win: g % 2 === 0,
    }),
  );
}

/**
 * Four games, no `externalId`, sharing one `eventName`, spaced 30h apart
 * (each its own SESSION at the `set`-tier fallback — well over the 3h
 * session gap — but all inside the 4-day tournament-block proximity window,
 * so they collapse to exactly one `eventSession`-grain point).
 */
function buildTournamentBlockFixture(): Match[] {
  const base = Date.UTC(2022, 4, 1, 0);
  const thirtyHoursMs = 30 * 60 * 60 * 1000;
  return [0, 1, 2, 3].map((g) =>
    makeMatch(`event-game-${g}`, base + g * thirtyHoursMs, {
      eventName: 'Genesis 9',
      win: g % 2 === 0,
    }),
  );
}

/**
 * Two 2-day-apart game pairs, one year apart, both landing in ISO week 1 of
 * their respective years (`2021-W01`/`2022-W01`) — engineered so `game` and
 * the session-grouped `set`/`eventSession` tiers all exceed the target while
 * `week` resolves to exactly the two week points.
 */
function buildWeekGrainFixture(): Match[] {
  return [
    makeMatch('week-2021-a', Date.UTC(2021, 0, 4, 0), { win: true }), // Mon, ISO week 2021-W01
    makeMatch('week-2021-b', Date.UTC(2021, 0, 6, 0), { win: false }), // Wed, same ISO week
    makeMatch('week-2022-a', Date.UTC(2022, 0, 3, 0), { win: true }), // Mon, ISO week 2022-W01
    makeMatch('week-2022-b', Date.UTC(2022, 0, 5, 0), { win: false }), // Wed, same ISO week
  ];
}

/**
 * Three months (Jan/Feb/Mar 2021), two isolated sessions per month on
 * different weeks — engineered so `week` (6 distinct weeks) exceeds the
 * target while `month` (3 distinct months) does not.
 */
function buildMonthGrainFixture(): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  for (let month = 0; month < 3; month++) {
    for (const day of [3, 20]) {
      const ms = Date.UTC(2021, month, day, 0);
      matches.push(makeMatch(`month-${counter}`, ms, { win: counter % 2 === 0 }));
      counter++;
    }
  }
  return matches;
}

/**
 * Two Q1s one year apart (2019, 2020), each spread across 3 distinct months
 * — engineered so `month` (6 distinct months) exceeds the target while
 * `quarter` (2 distinct quarters, one per year) does not.
 */
function buildQuarterAcrossYearsFixture(): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  for (const year of [2019, 2020]) {
    for (let month = 0; month < 3; month++) {
      const ms = Date.UTC(year, month, 10, 0);
      matches.push(makeMatch(`qy-${counter}`, ms, { win: counter % 2 === 0 }));
      counter++;
    }
  }
  return matches;
}

/**
 * A wide-span, low-density account (40 months, 2 isolated sessions/month)
 * purpose-built to exercise the narrow-plot re-grain path: `month` (40
 * points) satisfies `MARK_BOUND_LINE_POINTS` (60) but not `NARROW_PLOT_TARGET`
 * (30), forcing a re-grain to `quarter` (14 points) at the narrow target.
 * Measured, real EIGHT_K_FIXTURE_OPTIONS/FIFTY_K_FIXTURE_OPTIONS data lands
 * at `month` with only 5/25 points respectively (both already under 30), so
 * neither exhibits an actual default-vs-narrow difference — this fixture is
 * built specifically to prove the re-grain mechanism fires when it must.
 */
function buildNarrowPlotFixture(): Match[] {
  const matches: Match[] = [];
  let counter = 0;
  for (let month = 0; month < 40; month++) {
    for (const day of [5, 20]) {
      const ms = Date.UTC(2020, month, day, 0);
      matches.push(makeMatch(`narrow-${counter}`, ms, { win: counter % 2 === 0 }));
      counter++;
    }
  }
  return matches;
}

describe('buildPeriodSeries (VIZ-01) — the full ladder (Task 2)', () => {
  it('collapses 3 games sharing one parsed set id into exactly one set-grain point', () => {
    const series = buildPeriodSeries({ matches: buildSharedSetFixture(), target: 1 });
    expect(series.grain).toBe('set');
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.total).toBe(3);
  });

  it('collapses one tournament block into exactly one eventSession-grain point, labelled with the event key', () => {
    const series = buildPeriodSeries({ matches: buildTournamentBlockFixture(), target: 1 });
    expect(series.grain).toBe('eventSession');
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.label).toBe('Genesis 9');
    expect(series.points[0]?.total).toBe(4);
  });

  it('collapses two 2-day spans one year apart into two week-grain points with distinct keys', () => {
    const series = buildPeriodSeries({ matches: buildWeekGrainFixture(), target: 3 });
    expect(series.grain).toBe('week');
    expect(series.points).toHaveLength(2);
    const keys = series.points.map((point) => point.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('collapses three months of two-session-each into three month-grain points', () => {
    const series = buildPeriodSeries({ matches: buildMonthGrainFixture(), target: 4 });
    expect(series.grain).toBe('month');
    expect(series.points).toHaveLength(3);
  });

  it('never equates a week or quarter key across a one-year gap', () => {
    const weekSeries = buildPeriodSeries({ matches: buildWeekGrainFixture(), target: 3 });
    expect(weekSeries.grain).toBe('week');
    const [week2021, week2022] = weekSeries.points;
    expect(week2021?.key).not.toBe(week2022?.key);
    expect(week2021?.label).not.toBe(week2022?.label);

    const quarterSeries = buildPeriodSeries({
      matches: buildQuarterAcrossYearsFixture(),
      target: 5,
    });
    expect(quarterSeries.grain).toBe('quarter');
    expect(quarterSeries.points).toHaveLength(2);
    const [q2019, q2020] = quarterSeries.points;
    expect(q2019?.key).not.toBe(q2020?.key);
    expect(q2019?.label).not.toBe(q2020?.label);
  });

  it('returns grain "game" or "set" for a ~40-game account, never a coarser tier', () => {
    const matches = generateSyntheticMatches({ seed: 40_424, count: 40 });
    const series = buildPeriodSeries({ matches });
    expect(['game', 'set']).toContain(series.grain);
  });

  it('re-grains to a strictly coarser tier at NARROW_PLOT_TARGET than at the default line-point target, over the same data', () => {
    const matches = buildNarrowPlotFixture();
    const atDefault = buildPeriodSeries({ matches, target: MARK_BOUND_LINE_POINTS });
    const atNarrow = regrainFor({ matches, target: NARROW_PLOT_TARGET });

    const ladderIndex: Record<PeriodGrain, number> = {
      game: 0,
      set: 1,
      eventSession: 2,
      week: 3,
      month: 4,
      quarter: 5,
      year: 6,
    };
    expect(atDefault.grain).toBe('month');
    expect(atNarrow.points.length).toBeLessThanOrEqual(NARROW_PLOT_TARGET);
    expect(ladderIndex[atNarrow.grain]).toBeGreaterThan(ladderIndex[atDefault.grain]);
  });

  it('reaches every member of the PeriodGrain union across a fixture set', () => {
    const cases: Array<{ matches: Match[]; target: number }> = [
      {
        matches: [
          makeMatch('solo-a', Date.UTC(2020, 0, 1)),
          makeMatch('solo-b', Date.UTC(2020, 5, 1)),
        ],
        target: 60,
      },
      { matches: buildSharedSetFixture(), target: 1 },
      { matches: buildTournamentBlockFixture(), target: 1 },
      { matches: buildWeekGrainFixture(), target: 3 },
      { matches: buildMonthGrainFixture(), target: 4 },
      { matches: buildQuarterBoundaryFixture(4), target: 4 },
      { matches: buildQuarterBoundaryFixture(5), target: 4 },
    ];
    const reached = new Set(
      cases.map(({ matches, target }) => buildPeriodSeries({ matches, target }).grain),
    );
    const fullUnion: PeriodGrain[] = [
      'game',
      'set',
      'eventSession',
      'week',
      'month',
      'quarter',
      'year',
    ];
    expect([...reached].sort()).toEqual([...fullUnion].sort());
  });

  it('ports (never imports) the tournament-block anchor logic from evidence/eventSeries.ts, declaring its own local proximity constant', () => {
    const sourcePath = fileURLToPath(new URL('./periodSeries.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toMatch(/evidence\/eventSeries\.ts/);
    expect(source).toMatch(/EVENT_SESSION_PROXIMITY_MS/);
    expect(source).not.toMatch(/from\s+['"]\.\.\/evidence\/eventSeries/);
  });
});

// ---------------------------------------------------------------------------
// Task 3: FIXT-02 sparse-workspace conformance and the locked-period-trend
// threshold, driven entirely from engine output (§13.9's engine half).
// ---------------------------------------------------------------------------

describe('buildPeriodSeries — FIXT-02 sparse workspaces (Task 3)', () => {
  const workspaces: Array<[name: string, matches: Match[]]> = [
    ['empty', emptyWorkspace()],
    ['one game', oneGameWorkspace()],
    ['two games', twoGameWorkspace()],
    ['unknown stage only', unknownStageOnlyWorkspace()],
    ['unknown character only', unknownCharacterOnlyWorkspace()],
  ];

  for (const [name, matches] of workspaces) {
    it(`${name} workspace: an empty series (zero games) or game/set grain with only real, never-padded counts`, () => {
      const series = buildPeriodSeries({ matches });
      if (matches.length === 0) {
        expect(series.points).toEqual([]);
      } else {
        expect(['game', 'set']).toContain(series.grain);
        expect(series.points.length).toBeGreaterThan(0);
        expect(series.points.every((point) => point.total > 0)).toBe(true);
      }
    });
  }

  it('reports a below-PERIOD_TREND_MIN_PERIODS series detectably from PeriodSeries alone, never by counting DOM nodes', () => {
    const series = buildPeriodSeries({ matches: twoGameWorkspace() });
    expect(series.points.length).toBeLessThan(PERIOD_TREND_MIN_PERIODS);
  });
});
