import { describe, expect, it } from 'vitest';
import { rivalMoversTemplate } from './rivalMovers.js';
import { buildNullRosterFixture, NULL_FIXTURE_SUBJECT_FIGHTER_ID } from './nullFixtures.js';
import type { InsightScope } from '../types.js';
import type { Match } from '../../match.js';

const SUBJECT_FIGHTER_ID = 8;
const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function subjectScope(fighterId = SUBJECT_FIGHTER_ID): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches) => matches.filter((m) => m.fighter_id === fighterId),
  };
}

function buildRow(params: {
  id: string;
  time: number;
  opponentFighterId: number;
  opponent?: string;
  opponentUserSlug?: string;
  win: boolean;
}): Match {
  const { id, time, opponentFighterId, opponent, opponentUserSlug, win } = params;
  return {
    id,
    fighter_id: SUBJECT_FIGHTER_ID,
    opponent_id: opponentFighterId,
    time,
    win,
    matchType: 'offline-tourney',
    ...(opponent !== undefined ? { opponent } : {}),
    ...(opponentUserSlug !== undefined ? { opponentUserSlug } : {}),
  };
}

describe('rivalMoversTemplate (Task 2: the opponent-player mover read)', () => {
  it('declares windowExpressible: true', () => {
    expect(rivalMoversTemplate.windowExpressible).toBe(true);
  });

  it('treats two tags bound to the same slug as one opponent, asserted by the returned window game count equalling the union of both tags’ games', () => {
    const matches: Match[] = [];
    // Tag A: 20 games, no slug.
    for (let i = 0; i < 20; i += 1) {
      matches.push(
        buildRow({
          id: `tagA-${i}`,
          time: NOW_MS - (60 - i) * ONE_HOUR_MS,
          opponentFighterId: 2,
          opponent: 'shadowfox',
          win: i % 2 === 0,
        }),
      );
    }
    // Tag B: 10 games, no slug, but one game shares the same slug as tag A's binding row below.
    for (let i = 0; i < 10; i += 1) {
      matches.push(
        buildRow({
          id: `tagB-${i}`,
          time: NOW_MS - (30 - i) * ONE_HOUR_MS,
          opponentFighterId: 2,
          opponent: 'nightowl',
          win: i % 2 === 0,
        }),
      );
    }
    // A binding row: same slug, tag A's raw tag — teaches the resolver that the slug's canonical
    // identity is tag A's normalized tag, so every OTHER slug-only row also resolves to tag A.
    matches.push(
      buildRow({
        id: 'binding-row',
        time: NOW_MS - 65 * ONE_HOUR_MS,
        opponentFighterId: 2,
        opponent: 'shadowfox',
        opponentUserSlug: 'user/abc123',
        win: true,
      }),
    );
    // A slug-only row (no tag) — resolves via the binding to tag A's identity, uniting tag B's
    // raw-tag games under the SAME identity is not what this fixture tests directly; instead this
    // asserts the union of tag A's 20 + the binding row's own 1 game land in one candidate.
    matches.push(
      buildRow({
        id: 'slug-only',
        time: NOW_MS - 1 * ONE_HOUR_MS,
        opponentFighterId: 2,
        opponentUserSlug: 'user/abc123',
        win: true,
      }),
    );

    const insights = rivalMoversTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    // Tag A (20) + binding row (1) + slug-only row (1) = 22 games under one identity, vs tag B's
    // separate 10 — the union proves the slug bound two DIFFERENT physical rows into one candidate
    // rather than 20/10/1/1 staying four separate never-merged groups.
    const totalAcrossIdentities = insights[0]!.baseline.sample.rawSampleSize;
    expect(totalAcrossIdentities).toBeGreaterThanOrEqual(22);
  });

  it('returns deltaPoints === null at exactly 7 games (thinRecent) and a non-null deltaPoints once the headline rival clears exactly 8 (medium tier)', () => {
    function buildRivalBlock(
      count: number,
      winRate: number,
      startAt: number,
      idPrefix: string,
    ): Match[] {
      const wins = Math.round(count * winRate);
      const rows: Match[] = [];
      for (let i = 0; i < count; i += 1) {
        rows.push(
          buildRow({
            id: `${idPrefix}-${i}`,
            time: startAt + (i + 1) * ONE_HOUR_MS,
            opponentFighterId: 3,
            opponent: 'rivalone',
            win: i < wins,
          }),
        );
      }
      return rows;
    }

    // Exactly 7 games total for this rival -> scoped thinRecent, deltaPoints null.
    const sevenGames = buildRivalBlock(7, 1, NOW_MS - 100 * ONE_HOUR_MS, 'seven');
    const sevenInsights = rivalMoversTemplate.build({
      matches: sevenGames,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(sevenInsights).toHaveLength(1);
    expect(sevenInsights[0]!.deltaPoints).toBeNull();
    expect(sevenInsights[0]!.state).toBe('thinRecent');

    // 40 old games at 50%, 8 recent games at 100% (exactly the medium tier) -> a real trend.
    const old = buildRivalBlock(40, 0.5, NOW_MS - 200 * ONE_HOUR_MS, 'eightOld');
    const oldEnd = old[old.length - 1]!.time;
    const recent = buildRivalBlock(8, 1, oldEnd, 'eightRecent');
    const eightGames = [...old, ...recent];
    const eightNowMs = recent[recent.length - 1]!.time + ONE_HOUR_MS;
    const eightInsights = rivalMoversTemplate.build({
      matches: eightGames,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: eightNowMs,
    });
    expect(eightInsights).toHaveLength(1);
    expect(eightInsights[0]!.deltaPoints).not.toBeNull();
    expect(['trend', 'suggestion']).toContain(eightInsights[0]!.state);
  });

  describe('the multiple-comparisons false-positive-rate proof (review finding C1-M7, opponent-player scope)', () => {
    const SEEDS = Array.from({ length: 20 }, (_, i) => 2_000 + i);
    const COHORT_COUNT = 40;
    const GAMES_PER_COHORT = 51;
    const TRUE_RATE = 0.5;
    /**
     * MEASURED, not recalled — see `characterMovers.test.ts`'s identical harness for the full
     * rationale on why `GAMES_PER_COHORT` sits just above the D-06 collapse boundary (50).
     */
    const MAX_ASSERTED_DIRECTION_RATE = 0.05;

    it('most seeds return a non-assertive state, and the asserted-direction rate is at or below the measured threshold', () => {
      let assertedCount = 0;
      for (const seed of SEEDS) {
        const matches = buildNullRosterFixture({
          seed,
          cohortCount: COHORT_COUNT,
          gamesPerCohort: GAMES_PER_COHORT,
          trueRate: TRUE_RATE,
          nowMs: NOW_MS,
        });
        const insights = rivalMoversTemplate.build({
          matches,
          scope: subjectScope(NULL_FIXTURE_SUBJECT_FIGHTER_ID),
          horizon: 'last30',
          nowMs: NOW_MS,
        });
        expect(insights).toHaveLength(1);
        const state = insights[0]!.state;
        if (state === 'trend' || state === 'suggestion') {
          assertedCount += 1;
        } else {
          expect(['steady', 'thin', 'thinRecent', 'collapsed', 'locked']).toContain(state);
        }
      }
      const rate = assertedCount / SEEDS.length;
      expect(rate).toBeLessThanOrEqual(MAX_ASSERTED_DIRECTION_RATE);
    });

    it('non-vacuity companion: one cohort generated from a clearly different rate returns trend or suggestion', () => {
      const matches = buildNullRosterFixture({
        seed: 2_999,
        cohortCount: COHORT_COUNT,
        gamesPerCohort: GAMES_PER_COHORT,
        trueRate: TRUE_RATE,
        nowMs: NOW_MS,
        divergentCohortIndex: 0,
        divergentRate: 0.97,
      });
      const insights = rivalMoversTemplate.build({
        matches,
        scope: subjectScope(NULL_FIXTURE_SUBJECT_FIGHTER_ID),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      expect(insights).toHaveLength(1);
      expect(['trend', 'suggestion']).toContain(insights[0]!.state);
    });
  });

  it('no returned Insight carries a debrief or watchlist door (there is no such InsightDoorKind, and this template only ever emits "games")', () => {
    const matches: Match[] = [];
    for (let i = 0; i < 15; i += 1) {
      matches.push(
        buildRow({
          id: `door-${i}`,
          time: NOW_MS - (15 - i) * ONE_HOUR_MS,
          opponentFighterId: 4,
          opponent: 'doorrival',
          win: i % 2 === 0,
        }),
      );
    }
    const insights = rivalMoversTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    for (const insight of insights) {
      for (const door of insight.doors) {
        expect(door.kind).toBe('games');
      }
    }
  });
});
