import type { Match, MatchType } from '../../match.js';
import { SpriteList } from '../../fighterData.js';
import { RECENT_GAME_WINDOW } from '../policy.js';

/**
 * Review finding C1-M7: a deterministic, seeded NULL fixture generator that
 * exists ONLY to exercise the family-wise error rate of a max-of-N selection
 * (`characterMoversTemplate`/`rivalMoversTemplate` each run an independent
 * two-sided Wilson test per cohort and report the maximum). D-07's top-k cap
 * is the LOCKED multiple-comparisons guard; this file does not revisit that
 * policy — it proves what the guard actually buys by running the real
 * `build()` function over many cohorts drawn from ONE underlying rate and
 * measuring how often it still asserts a direction by chance.
 *
 * Deliberately a non-test module (no `.test.ts` suffix) so both
 * `characterMovers.test.ts` and `rivalMovers.test.ts` can import it without
 * re-running each other's suites.
 *
 * The pseudo-random source's state is a LOCAL variable threaded through the
 * closure returned by `localMulberry32` — never a module-level binding — so
 * `purity.test.ts`'s module-level-mutable-state scan stays clean over this
 * directory. This is an inline near-copy of `testUtils/prng.ts`'s
 * `mulberry32`, kept self-contained here rather than imported from
 * `testUtils/` so this production-tree file never carries an edge to the
 * test-only package subpath (`testUtils/index.ts`'s own doc comment: those
 * generators must never enter the production import graph — this file is
 * reachable only by tests today, and keeping it free of a `testUtils/`
 * import keeps that true even if that ever changes).
 */
function localMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed subject fighter for every generated row — the SpriteList's first entry, arbitrary. Exported so a template's own scope-building test can filter to the same subject `buildNullRosterFixture` writes. */
export const NULL_FIXTURE_SUBJECT_FIGHTER_ID = SpriteList[0]!.id;
const SUBJECT_FIGHTER_ID = NULL_FIXTURE_SUBJECT_FIGHTER_ID;
/** All other roster fighters — the pool `cohortCount` opponent-character cohorts draw distinct ids from. */
const OPPONENT_FIGHTER_POOL = SpriteList.filter((f) => f.id !== SUBJECT_FIGHTER_ID).map(
  (f) => f.id,
);
/** Comfortably inside `SCOPED_RECENCY_MONTHS` (12) for any `gamesPerCohort` this plan's tests use. */
const COHORT_GAME_GAP_MS = 6 * 60 * 60 * 1000;
const MATCH_TYPE: MatchType = 'offline-tourney';

export interface NullRosterFixtureOptions {
  /** Seeds the generator; identical options + seed always produce identical output. */
  seed: number;
  /** Number of distinct opponent cohorts (opponent characters AND opponent player tags — see module doc). */
  cohortCount: number;
  /** Games per cohort. Must exceed `RECENT_GAME_WINDOW` (30) for the recent/baseline split below to be meaningful — a cohort with <= 30 games makes its own last-30 window equal its own baseline, which trivially "collapses" (D-06) regardless of the underlying rate and would make both the null test and its non-vacuity companion vacuous. */
  gamesPerCohort: number;
  /** The single underlying win rate every cohort (except an optional divergent one) is drawn from. */
  trueRate: number;
  /** Anchors every generated timestamp — never `Date.now()`. */
  nowMs: number;
  /** 0-based cohort index whose most recent `RECENT_GAME_WINDOW` games are drawn from `divergentRate` instead of `trueRate` — the non-vacuity companion. Omit for a fully null fixture. */
  divergentCohortIndex?: number;
  /** The divergent cohort's recent-window rate, when `divergentCohortIndex` is set. */
  divergentRate?: number;
}

function buildRow(params: {
  id: string;
  time: number;
  opponentFighterId: number;
  opponentTag: string;
  win: boolean;
}): Match {
  const { id, time, opponentFighterId, opponentTag, win } = params;
  return {
    id,
    fighter_id: SUBJECT_FIGHTER_ID,
    opponent_id: opponentFighterId,
    opponent: opponentTag,
    time,
    win,
    matchType: MATCH_TYPE,
  };
}

/**
 * Returns a `Match[]` shaped as `cohortCount` independent cohorts, each
 * `gamesPerCohort` games deep, EVERY cohort generated from the SAME
 * `trueRate` — so any asserted direction a caller's template returns is, by
 * construction, a false positive — except the optional `divergentCohortIndex`
 * cohort, whose most recent `RECENT_GAME_WINDOW` games are drawn from
 * `divergentRate` instead, giving that one cohort a real, detectable
 * recent-vs-baseline shift (the non-vacuity companion: proves the harness
 * CAN detect a real mover, so a null result elsewhere isn't vacuous).
 *
 * Every cohort is grouped by BOTH a distinct opponent fighter id (for
 * `characterMoversTemplate`, which groups by `opponent_id`) AND a distinct
 * opponent tag (for `rivalMoversTemplate`, which groups by resolved opponent
 * identity) — the same `Match[]` drives both templates' null-fixture tests.
 */
export function buildNullRosterFixture(options: NullRosterFixtureOptions): Match[] {
  const {
    seed,
    cohortCount,
    gamesPerCohort,
    trueRate,
    nowMs,
    divergentCohortIndex,
    divergentRate,
  } = options;
  if (cohortCount > OPPONENT_FIGHTER_POOL.length) {
    throw new Error(
      `buildNullRosterFixture: cohortCount (${cohortCount}) exceeds the available opponent-fighter pool (${OPPONENT_FIGHTER_POOL.length})`,
    );
  }

  const rng = localMulberry32(seed);
  const matches: Match[] = [];

  for (let cohortIndex = 0; cohortIndex < cohortCount; cohortIndex += 1) {
    const opponentFighterId = OPPONENT_FIGHTER_POOL[cohortIndex]!;
    const opponentTag = `nullopp${cohortIndex}`;
    const isDivergentCohort = cohortIndex === divergentCohortIndex;

    for (let gameIndex = 0; gameIndex < gamesPerCohort; gameIndex += 1) {
      const isRecentSlice = gameIndex >= gamesPerCohort - RECENT_GAME_WINDOW;
      const rate = isDivergentCohort && isRecentSlice ? (divergentRate ?? trueRate) : trueRate;
      const time = nowMs - (gamesPerCohort - gameIndex) * COHORT_GAME_GAP_MS;
      matches.push(
        buildRow({
          id: `null-${seed}-${cohortIndex}-${gameIndex}`,
          time,
          opponentFighterId,
          opponentTag,
          win: rng() < rate,
        }),
      );
    }
  }

  return matches;
}
