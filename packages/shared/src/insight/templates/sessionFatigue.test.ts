import { describe, expect, it } from 'vitest';
import { sessionFatigueTemplate } from './sessionFatigue.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;
const WITHIN_SESSION_GAP_MS = 60_000;
/** Comfortably above `splitIntoSessions`' 3h default gap. */
const BETWEEN_SESSION_GAP_MS = 4 * 60 * 60 * 1000;

function buildSessionMatches(
  sessionCount: number,
  sessionSize: number,
  outcomeAt: (sessionIndex: number, gameIndex: number) => boolean,
): Match[] {
  const matches: Match[] = [];
  let t = BASE_TIME_MS;
  for (let s = 0; s < sessionCount; s += 1) {
    for (let g = 0; g < sessionSize; g += 1) {
      matches.push({
        id: `s${s}g${g}`,
        fighter_id: 8,
        opponent_id: 23,
        time: t,
        win: outcomeAt(s, g),
      });
      t += WITHIN_SESSION_GAP_MS;
    }
    t += BETWEEN_SESSION_GAP_MS;
  }
  return matches;
}

function buildInsight(matches: Match[]) {
  const result = sessionFatigueTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('sessionFatigueTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'sessionFatigue');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(sessionFatigueTemplate);
  });

  it('is hidden below the declared minimum long-session count (9 long sessions of 21 games each)', () => {
    const matches = buildSessionMatches(9, 21, () => true);
    const insight = buildInsight(matches);
    expect(insight).not.toBeNull();
    expect(insight!.state).toBe('hidden');
  });

  it('is non-hidden at exactly the declared minimum long-session count (10 long sessions of 21 games each)', () => {
    // Alternating win/loss within each session -> late (index 20) and early
    // (indices 0-9) cohorts land close to the same 50% rate.
    const matches = buildSessionMatches(10, 21, (_s, g) => g % 2 === 0);
    const insight = buildInsight(matches);
    expect(insight).not.toBeNull();
    expect(insight!.state).not.toBe('hidden');
  });

  it('every non-hidden state carries the standing caveat value in copy.values', () => {
    const steady = buildInsight(buildSessionMatches(10, 21, (_s, g) => g % 2 === 0))!;
    expect(steady.state).not.toBe('hidden');
    expect(steady.copy.values.caveat).toBeTruthy();

    // Engineered clear fatigue: the first 10 games of every session are all
    // wins (the early cohort), the trailing game (index 20, the late
    // cohort) is always a loss.
    const trendMatches = buildSessionMatches(10, 21, (_s, g) => g < 10);
    const trend = buildInsight(trendMatches)!;
    expect(trend.state).toBe('trend');
    expect(trend.deltaPoints).not.toBeNull();
    expect(trend.deltaPoints!).toBeLessThan(0);
    expect(trend.copy.values.caveat).toBeTruthy();
  });

  it('windowExpressible is false — sessionFatigue is a non-contiguous, in-session cohort', () => {
    expect(sessionFatigueTemplate.windowExpressible).toBe(false);
  });

  it('scopeKind is account and assertsDirection is true', () => {
    expect(sessionFatigueTemplate.scopeKind).toBe('account');
    expect(sessionFatigueTemplate.assertsDirection).toBe(true);
  });
});

/**
 * Plan 39.1-40 (sketch 002-C, DD-12): the SessionFatigue card's three
 * game-number buckets. Bucket 1 and bucket 3 are the verdict's own cohorts
 * (display only — the middle bucket never changes a verdict or a counted
 * set).
 */
describe('sessionFatigue session-buckets mark (39.1-40)', () => {
  interface Bucket {
    fromGame: number;
    toGame: number | null;
    wins: number;
    losses: number;
    total: number;
  }

  function bucketsOf(insight: NonNullable<ReturnType<typeof buildInsight>>): Bucket[] {
    expect(insight.mark?.kind).toBe('sessionBuckets');
    return (insight.mark!.data as { buckets: Bucket[] }).buckets;
  }

  function claimRecord(claim: { kind: string; value?: { wins: number; losses: number } }) {
    expect(claim.kind).toBe('evidenced');
    return { wins: claim.value!.wins, losses: claim.value!.losses };
  }

  it.each([
    ['steady', (_s: number, g: number) => g % 2 === 0],
    ['trend', (_s: number, g: number) => g < 10],
  ] as const)(
    'a %s read carries exactly three buckets (1-10, 11-20, 21+); bucket 1 = the baseline claim, bucket 3 = the recent claim',
    (state, outcome) => {
      const insight = buildInsight(buildSessionMatches(10, 21, outcome))!;
      expect(insight.state).toBe(state);
      const buckets = bucketsOf(insight);
      expect(buckets.map((b) => [b.fromGame, b.toGame])).toEqual([
        [1, 10],
        [11, 20],
        [21, null],
      ]);
      expect({ wins: buckets[0]!.wins, losses: buckets[0]!.losses }).toEqual(
        claimRecord(insight.baseline),
      );
      expect({ wins: buckets[2]!.wins, losses: buckets[2]!.losses }).toEqual(
        claimRecord(insight.recent),
      );
    },
  );

  it('bucket 2 is games 11-20 of every session that reaches game 11', () => {
    // 10 long sessions (21 games: wins at games 1-10, losses after) plus two
    // 15-game sessions (a win on every odd game number) — the short sessions
    // add games 11-15 (wins at 11, 13, 15) to bucket 2 and nothing to bucket 3.
    const long = buildSessionMatches(10, 21, (_s, g) => g < 10);
    const lastTime = long[long.length - 1]!.time;
    const short: Match[] = [];
    let t = lastTime + BETWEEN_SESSION_GAP_MS;
    for (let s = 0; s < 2; s += 1) {
      for (let g = 0; g < 15; g += 1) {
        short.push({
          id: `short${s}g${g}`,
          fighter_id: 8,
          opponent_id: 23,
          time: t,
          win: g % 2 === 0,
        });
        t += WITHIN_SESSION_GAP_MS;
      }
      t += BETWEEN_SESSION_GAP_MS;
    }
    const insight = buildInsight([...long, ...short])!;
    const buckets = bucketsOf(insight);
    expect(buckets[1]).toEqual({ fromGame: 11, toGame: 20, wins: 6, losses: 104, total: 110 });
    expect(buckets[2]!.total).toBe(10);
  });

  it('a hidden result carries no mark, and the mark changes neither state, copy nor countedMatchIds', () => {
    const hidden = buildInsight(buildSessionMatches(9, 21, () => true))!;
    expect(hidden.state).toBe('hidden');
    expect(hidden.mark).toBeUndefined();

    const trend = buildInsight(buildSessionMatches(10, 21, (_s, g) => g < 10))!;
    expect(trend.state).toBe('trend');
    expect(trend.copy.key).toBe('insights.sessionFatigue.trend');
    expect(trend.copy.values.caveat).toBeTruthy();
    // The late cohort: game 21 of each of the ten long sessions.
    expect(trend.countedMatchIds).toHaveLength(10);
    expect(new Set(trend.countedMatchIds)).toEqual(
      new Set(Array.from({ length: 10 }, (_, s) => `s${s}g20`)),
    );
  });
});
