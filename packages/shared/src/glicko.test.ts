import { describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import {
  DEFAULT_RATING,
  DEFAULT_RD,
  DEFAULT_VOLATILITY,
  computeRatingHistory,
  updateRating,
} from './glicko.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('updateRating — Glickman worked example', () => {
  // http://www.glicko.net/glicko/glicko2.pdf, "Example" (section after Step 8):
  // player rating 1500, RD 200, volatility 0.06, faces three opponents in one
  // rating period:
  //   opponent 1: rating 1400, RD 30,  result win  (score 1)
  //   opponent 2: rating 1550, RD 100, result loss (score 0)
  //   opponent 3: rating 1700, RD 300, result loss (score 0)
  // The paper publishes new rating 1464.06, RD 151.52, volatility 0.05999 —
  // but it derives those from its OWN intermediate values for v and delta,
  // which the paper itself only prints rounded to 4 decimal places
  // (v=1.7785, delta=-0.4834). Carrying full precision through every step
  // (as this implementation does, and as other independent Glicko-2
  // implementations do) yields 1464.0507 / 151.5165 / 0.0599960 — a few
  // hundredths off the paper's rounded-intermediate figure, not a
  // discrepancy in the algorithm. We assert both: full-precision agreement
  // to 4 decimal places against an independently-derived reference value,
  // and a loose sanity check against the paper's own headline numbers.
  it('matches the paper: new rating ~1464.05, RD ~151.52, volatility ~0.05999', () => {
    const before = { rating: 1500, rd: 200, volatility: 0.06 };
    const results: Array<{ opponentRating: number; opponentRd: number; score: 0 | 1 }> = [
      { opponentRating: 1400, opponentRd: 30, score: 1 },
      { opponentRating: 1550, opponentRd: 100, score: 0 },
      { opponentRating: 1700, opponentRd: 300, score: 0 },
    ];

    const after = updateRating(before, results);

    // Full-precision reference values (independently re-derived step by
    // step from the paper's formulas, see comment above).
    expect(after.rating).toBeCloseTo(1464.0507, 4);
    expect(after.rd).toBeCloseTo(151.5165, 4);
    expect(after.volatility).toBeCloseTo(0.059996, 7);

    // Loose sanity check against the paper's own published (rounded) figures.
    expect(after.rating).toBeCloseTo(1464.06, 0);
    expect(after.rd).toBeCloseTo(151.52, 0);
    expect(after.volatility).toBeCloseTo(0.05999, 3);
  });

  it('leaves rating and volatility unchanged with zero games, but grows RD', () => {
    const before = { rating: 1500, rd: 200, volatility: 0.06 };

    const after = updateRating(before, []);

    expect(after.rating).toBe(1500);
    expect(after.volatility).toBe(0.06);
    expect(after.rd).toBeGreaterThan(200);
    // phi* = sqrt(phi^2 + sigma^2) on the glicko scale — cross-check directly.
    const phi = 200 / 173.7178;
    const sigma = 0.06;
    const expectedPhiStar = Math.sqrt(phi * phi + sigma * sigma);
    expect(after.rd).toBeCloseTo(expectedPhiStar * 173.7178, 6);
  });

  it('is monotonic: an all-win period against a fixed-strength opponent always raises rating', () => {
    const before = { rating: 1500, rd: 100, volatility: 0.06 };
    const results = Array.from({ length: 5 }, () => ({
      opponentRating: 1500,
      opponentRd: 100,
      score: 1 as const,
    }));

    const after = updateRating(before, results);

    expect(after.rating).toBeGreaterThan(before.rating);
  });

  it('is monotonic: an all-loss period against a fixed-strength opponent always lowers rating', () => {
    const before = { rating: 1500, rd: 100, volatility: 0.06 };
    const results = Array.from({ length: 5 }, () => ({
      opponentRating: 1500,
      opponentRd: 100,
      score: 0 as const,
    }));

    const after = updateRating(before, results);

    expect(after.rating).toBeLessThan(before.rating);
  });

  it('RD shrinks with a consistent (non-surprising) result stream', () => {
    const before = { rating: 1500, rd: 200, volatility: 0.06 };
    const results = Array.from({ length: 10 }, () => ({
      opponentRating: 1500,
      opponentRd: 50,
      score: 1 as const,
    }));

    const after = updateRating(before, results);

    expect(after.rd).toBeLessThan(before.rd);
  });
});

describe('computeRatingHistory', () => {
  it('returns an empty history for no matches', () => {
    const history = computeRatingHistory([]);

    expect(history.periods).toEqual([]);
    expect(history.current).toBeNull();
  });

  it('starts every player at the default rating/RD/volatility before their first period', () => {
    const matches: Match[] = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1000, win: true }),
    ];

    const history = computeRatingHistory(matches);

    expect(history.periods).toHaveLength(1);
    expect(history.periods[0]?.games).toBe(2);
    // Two wins vs a synthetic 1500/350 opponent should raise the rating
    // above the 1500 default, and RD should shrink from the 350 default.
    expect(history.periods[0]?.rating).toBeGreaterThan(DEFAULT_RATING);
    expect(history.periods[0]?.rd).toBeLessThan(DEFAULT_RD);
  });

  it('groups matches into sessions using the default gap and one session per period', () => {
    const matches: Match[] = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: HOUR_MS, win: true }),
      // > 3h default gap after the last match of session 1 (which ends at 1h).
      makeMatch({ id: '3', time: HOUR_MS + 4 * HOUR_MS, win: false }),
    ];

    const history = computeRatingHistory(matches);

    expect(history.periods).toHaveLength(2);
    expect(history.periods[0]?.games).toBe(2);
    expect(history.periods[1]?.games).toBe(1);
  });

  it('respects a custom gapMs the same way session splitting does', () => {
    const matches: Match[] = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 30 * 60 * 1000, win: true }), // 30 min later
    ];

    // With a 15-minute gap, these two matches split into separate sessions.
    const split = computeRatingHistory(matches, 15 * 60 * 1000);
    expect(split.periods).toHaveLength(2);

    // With the default (3h) gap, they're one session.
    const merged = computeRatingHistory(matches);
    expect(merged.periods).toHaveLength(1);
  });

  it('raises rating over a sustained win streak across multiple sessions (monotonicity sanity)', () => {
    const matches: Match[] = [];
    let t = 0;
    for (let session = 0; session < 6; session++) {
      for (let g = 0; g < 4; g++) {
        matches.push(makeMatch({ id: `${session}-${g}`, time: t, win: true }));
        t += HOUR_MS;
      }
      t += 4 * HOUR_MS; // force a new session
    }

    const history = computeRatingHistory(matches);

    expect(history.periods.length).toBeGreaterThan(1);
    const ratings = history.periods.map((p) => p.rating);
    for (let i = 1; i < ratings.length; i++) {
      expect(ratings[i]).toBeGreaterThanOrEqual(ratings[i - 1] ?? 0);
    }
    expect(history.current?.rating).toBeGreaterThan(DEFAULT_RATING);
  });

  it('lowers rating over a sustained loss streak', () => {
    const matches: Match[] = [];
    let t = 0;
    for (let session = 0; session < 4; session++) {
      for (let g = 0; g < 4; g++) {
        matches.push(makeMatch({ id: `${session}-${g}`, time: t, win: false }));
        t += HOUR_MS;
      }
      t += 4 * HOUR_MS;
    }

    const history = computeRatingHistory(matches);

    expect(history.current?.rating).toBeLessThan(DEFAULT_RATING);
  });

  it('grows RD across a long gap of inactivity between two sessions', () => {
    const nearMatches: Match[] = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: HOUR_MS, win: false }),
      makeMatch({ id: '3', time: 2 * HOUR_MS, win: true }),
    ];
    const longGapMatches: Match[] = [
      ...nearMatches,
      // A session ~200 days later — many idle rating periods elapse.
      makeMatch({ id: '4', time: 200 * DAY_MS, win: true }),
    ];
    const shortGapMatches: Match[] = [
      ...nearMatches,
      // A session shortly after (still respects the 3h default gap as a new
      // session, but with ~0 idle periods synthesized in between).
      makeMatch({ id: '4', time: 2 * HOUR_MS + 4 * HOUR_MS, win: true }),
    ];

    const longHistory = computeRatingHistory(longGapMatches);
    const shortHistory = computeRatingHistory(shortGapMatches);

    expect(longHistory.periods).toHaveLength(2);
    expect(shortHistory.periods).toHaveLength(2);

    // Both start the 2nd session's RD from the same post-session-1 value,
    // but the long-gap scenario synthesizes many idle periods beforehand —
    // its RD going into (and coming out of) session 2 must be higher.
    expect(longHistory.periods[1]?.rd).toBeGreaterThan(shortHistory.periods[1]?.rd ?? 0);
    // RD never exceeds the paper's ceiling (the default/starting RD).
    expect(longHistory.current?.rd).toBeLessThanOrEqual(DEFAULT_RD);
  });

  it('caps synthesized idle periods so a multi-year gap does not throw or diverge', () => {
    const matches: Match[] = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: HOUR_MS, win: true }),
      // ~5 years later.
      makeMatch({ id: '3', time: 5 * 365 * DAY_MS, win: true }),
    ];

    const history = computeRatingHistory(matches);

    expect(history.periods).toHaveLength(2);
    expect(history.current?.rd).toBeLessThanOrEqual(DEFAULT_RD);
    expect(Number.isFinite(history.current?.rating)).toBe(true);
  });

  it('rounds display values but keeps volatility unrounded internally', () => {
    const matches: Match[] = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: HOUR_MS, win: true }),
    ];

    const history = computeRatingHistory(matches);

    expect(Number.isInteger(history.periods[0]?.rating)).toBe(true);
    expect(Number.isInteger(history.periods[0]?.rd)).toBe(true);
    expect(history.periods[0]?.volatility).not.toBe(DEFAULT_VOLATILITY);
  });
});
