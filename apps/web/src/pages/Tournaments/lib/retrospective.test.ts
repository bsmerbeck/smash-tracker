import { describe, expect, it } from 'vitest';
import { RULESET_CONTRACT_VERSION, stageIdKey } from '@smash-tracker/shared';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { buildRetrospective } from './retrospective';

// Real stage ids from packages/shared/src/stageData.ts. Every stage used as
// pre-tournament evidence or as a played game below is tournament-legal
// (`TOURNAMENT_LEGAL_STAGE_IDS`) UNLESS a test is specifically exercising the
// D-14 outside-the-ruleset clause — see `OFF_RULESET_STAGE` below.
//
// R1-BLOCKER-5 (37-REVIEWS.md, inherited via 37-05's disposition ledger):
// this file's pre-Phase-37-06 fixtures used `BIG_BATTLEFIELD` (id 2),
// `NEW_DONK_CITY` (id 4) and `GREAT_PLATEAU` (id 5) as "the worst ranked
// stage(s)" — none of the three are members of `TOURNAMENT_LEGAL_STAGE_IDS`,
// so once `buildRetrospective` filters ranking candidates to the event's
// legal stage set (this plan), those fixtures' games would silently become
// `outside-ruleset` instead of exercising the ordinary ban/neutral math they
// were written to test. Swapped for legal stand-ins (`SMALL_BATTLEFIELD`,
// `HOLLOW_BASTION`, `LYLAT_CRUISE`) with IDENTICAL win/loss counts and rank
// positions, so every pre-existing expectation is unchanged in VALUE — only
// the stage id/name backing "the worst stage" changed. `BIG_BATTLEFIELD` is
// kept alive as `OFF_RULESET_STAGE`, the fixture that exercises the case the
// legality filter actually earns (mirrors 37-05's identical disposition).
const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const SMALL_BATTLEFIELD = { id: 113, name: 'Small Battlefield' };
const FINAL_DESTINATION = { id: 3, name: 'Final Destination' };
const HOLLOW_BASTION = { id: 118, name: 'Hollow Bastion' };
const LYLAT_CRUISE = { id: 56, name: 'Lylat Cruise' };
const SMASHVILLE = { id: 83, name: 'Smashville' };
const TOWN_AND_CITY = { id: 85, name: 'Town and City' };
const NO_SELECTION = { id: 0, name: 'no selection' };
/** Not a member of `TOURNAMENT_LEGAL_STAGE_IDS` under the house default ruleset — the dedicated outside-the-ruleset fixture. */
const OFF_RULESET_STAGE = { id: 2, name: 'Big Battlefield' };

const FIGHTER = 1;
const OPPONENT = 10;

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_000_000,
    lastSetAt: 2_000_000,
    setsPlayed: 1,
    ...overrides,
  };
}

let idCounter = 0;
function makeMatch(overrides: Partial<Match> & Pick<Match, 'time' | 'win'>): Match {
  idCounter += 1;
  return {
    id: `m${idCounter}`,
    fighter_id: FIGHTER,
    opponent_id: OPPONENT,
    map: BATTLEFIELD,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

/** n pre-tournament games on a given stage for the FIGHTER/OPPONENT pairing. */
function preMatchesOnStage(
  stage: { id: number; name: string },
  wins: number,
  losses: number,
): Match[] {
  const result: Match[] = [];
  for (let i = 0; i < wins; i++) {
    result.push(makeMatch({ time: 100 + i, win: true, map: stage }));
  }
  for (let i = 0; i < losses; i++) {
    result.push(makeMatch({ time: 100 + wins + i, win: false, map: stage }));
  }
  return result;
}

describe('buildRetrospective', () => {
  it('classifies a game on a top-3 evidence-ranked stage as followed', () => {
    const pre = [
      ...preMatchesOnStage(BATTLEFIELD, 5, 0), // best
      ...preMatchesOnStage(TOWN_AND_CITY, 1, 4), // worse but qualifies
    ];
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const gameOnBf = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([...pre, gameOnBf], [gameOnBf], entry);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.games[0]?.classification).toBe('followed');
    expect(result.rows[0]?.games[0]?.reasonKind).toBe('graded');
  });

  it('classifies a game on a bottom-3 (ban-worthy) evidence-ranked stage as against', () => {
    // 4 qualifying stages -> top 3 are picks, the 4th (worst) is the sole ban.
    const pre = [
      ...preMatchesOnStage(BATTLEFIELD, 5, 0),
      ...preMatchesOnStage(TOWN_AND_CITY, 4, 1),
      ...preMatchesOnStage(SMASHVILLE, 3, 2),
      ...preMatchesOnStage(SMALL_BATTLEFIELD, 0, 5), // worst -> ban
    ];
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const gameOnBanned = makeMatch({
      time: 1_500_000,
      win: false,
      map: SMALL_BATTLEFIELD,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([...pre, gameOnBanned], [gameOnBanned], entry);

    expect(result.rows[0]?.games[0]?.classification).toBe('against');
    expect(result.rows[0]?.games[0]?.reasonKind).toBe('graded');
  });

  it('classifies a game on a ranked-but-neither pick-nor-ban stage as neutral', () => {
    // 7 qualifying stages: top 3 are picks, bottom 3 (disjoint from picks)
    // are bans, leaving exactly one stage (rank 4 of 7) as neutral.
    const pre = [
      ...preMatchesOnStage(BATTLEFIELD, 7, 0), // rank 1
      ...preMatchesOnStage(TOWN_AND_CITY, 6, 1), // rank 2
      ...preMatchesOnStage(SMASHVILLE, 5, 2), // rank 3
      ...preMatchesOnStage(FINAL_DESTINATION, 4, 3), // rank 4 -> neutral
      ...preMatchesOnStage(HOLLOW_BASTION, 3, 4), // rank 5 -> ban
      ...preMatchesOnStage(LYLAT_CRUISE, 2, 5), // rank 6 -> ban
      ...preMatchesOnStage(SMALL_BATTLEFIELD, 0, 7), // rank 7 -> ban
    ];
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const gameOnNeutral = makeMatch({
      time: 1_500_000,
      win: true,
      map: FINAL_DESTINATION,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([...pre, gameOnNeutral], [gameOnNeutral], entry);

    expect(result.rows[0]?.games[0]?.classification).toBe('neutral');
    expect(result.rows[0]?.games[0]?.reasonKind).toBe('no-stance');
  });

  // Phase 36 (D-24): the floor is now the engine's ABSTENTION_FLOOR_GAMES
  // (3), not the pre-Phase-36 local MIN_GAMES of 2 — 1 pre-tournament game
  // is below either value, so this fixture's expected outcome is unchanged.
  it('classifies a game with fewer than 3 pre-tournament pairing games on any stage as no-data', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const onlyOnePre = makeMatch({ time: 500, win: true, map: BATTLEFIELD });
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([onlyOnePre, game], [game], entry);

    expect(result.rows[0]?.games[0]?.classification).toBe('no-data');
    expect(result.rows[0]?.games[0]?.reasonKind).toBe('no-data');
  });

  it('classifies a game with an unknown stage (map.id 0) as no-data even with ample pairing evidence', () => {
    const pre = preMatchesOnStage(BATTLEFIELD, 10, 2);
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: NO_SELECTION,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([...pre, game], [game], entry);

    expect(result.rows[0]?.games[0]?.classification).toBe('no-data');
    expect(result.rows[0]?.games[0]?.reasonKind).toBe('no-data');
  });

  it('only uses matches strictly before entry.firstSetAt as evidence (excludes same-tournament games)', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    // Three pre-tournament games on Battlefield (qualifies at the Phase 36
    // abstention floor of 3), but a bunch more "future" games on Town and
    // City that must NOT count as evidence.
    const pre = preMatchesOnStage(BATTLEFIELD, 3, 0);
    const duringTournament = preMatchesOnStage(TOWN_AND_CITY, 5, 0).map((m) => ({
      ...m,
      time: 1_100_000 + m.time,
    }));
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: TOWN_AND_CITY,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([...pre, ...duringTournament, game], [game], entry);

    // Town and City has zero PRE-tournament evidence, so even though it has
    // in-tournament games, it isn't ranked -> the single ranked stage
    // (Battlefield) is picked, and Town and City is neutral (ranked list
    // has only 1 entry, so bans are empty and it's not a pick either).
    expect(result.rows[0]?.games[0]?.classification).toBe('neutral');
    expect(result.rows[0]?.games[0]?.reasonKind).toBe('no-stance');
  });

  it('scopes evidence to the same fighter/opponent pairing as the graded game', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    // Plenty of evidence, but for a DIFFERENT opponent fighter.
    const otherPairingPre = preMatchesOnStage(BATTLEFIELD, 10, 0).map((m) => ({
      ...m,
      opponent_id: 999,
    }));
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:1:g1',
    });

    const result = buildRetrospective([...otherPairingPre, game], [game], entry);

    expect(result.rows[0]?.games[0]?.classification).toBe('no-data');
  });

  it('classifies games in the "other matches" bucket (no parseable setId) alongside set rows', () => {
    const pre = preMatchesOnStage(BATTLEFIELD, 5, 0);
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const manualGame = makeMatch({ time: 1_500_000, win: true, map: BATTLEFIELD }); // no externalId

    const result = buildRetrospective([...pre, manualGame], [manualGame], entry);

    expect(result.rows).toHaveLength(0);
    expect(result.otherGames).toHaveLength(1);
    expect(result.otherGames[0]?.classification).toBe('followed');
  });

  describe('ruleset grading (D-14, EVID-04, plan 37-06)', () => {
    it('grades under the house default ruleset when the entry has no stored override', () => {
      const entry = makeEntry();
      const result = buildRetrospective([], [], entry);

      expect(result.resolvedRuleset.source).toBe('default-preset');
    });

    it('grades under the resolved event override, never listing an override-excluded stage as recommended', () => {
      // Only Battlefield and Town and City are legal under this override —
      // Smashville is excluded even though it has ample qualifying evidence.
      const pre = [
        ...preMatchesOnStage(BATTLEFIELD, 5, 0),
        ...preMatchesOnStage(TOWN_AND_CITY, 4, 1),
        ...preMatchesOnStage(SMASHVILLE, 10, 0),
      ];
      const entry = makeEntry({
        firstSetAt: 1_000_000,
        rulesetOverride: {
          contractVersion: RULESET_CONTRACT_VERSION,
          starterStageIds: {
            [stageIdKey(BATTLEFIELD.id)]: true,
            [stageIdKey(TOWN_AND_CITY.id)]: true,
          },
        },
      });
      const game = makeMatch({
        time: 1_500_000,
        win: true,
        map: BATTLEFIELD,
        externalId: 'sgg:1:g1',
      });

      const result = buildRetrospective([...pre, game], [game], entry);

      expect(result.resolvedRuleset.source).toBe('event-override');
      const everyRecommendedId = [
        ...result.rows.flatMap((r) => r.games),
        ...result.otherGames,
      ].flatMap((g) => g.recommendedStageIds);
      expect(everyRecommendedId).not.toContain(SMASHVILLE.id);
    });

    it('grades a game played on a stage outside the event ruleset as no stance, not folded into followed/against', () => {
      const pre = [
        ...preMatchesOnStage(BATTLEFIELD, 5, 0),
        ...preMatchesOnStage(TOWN_AND_CITY, 1, 4),
      ];
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const gameOffRuleset = makeMatch({
        time: 1_500_000,
        win: true,
        map: OFF_RULESET_STAGE,
        externalId: 'sgg:1:g1',
      });

      const result = buildRetrospective([...pre, gameOffRuleset], [gameOffRuleset], entry);

      expect(result.rows[0]?.games[0]?.classification).toBe('neutral');
      expect(result.rows[0]?.games[0]?.reasonKind).toBe('outside-ruleset');
      expect(result.rows[0]?.games[0]?.recommendedStageIds).toEqual([]);
      expect(result.rows[0]?.games[0]?.banStageIds).toEqual([]);
    });
  });

  describe('adherence summary', () => {
    it('computes adherence rate and the followed/against win-rate split', () => {
      const pre = [
        ...preMatchesOnStage(BATTLEFIELD, 5, 0),
        ...preMatchesOnStage(TOWN_AND_CITY, 4, 1),
        ...preMatchesOnStage(SMASHVILLE, 3, 2),
        ...preMatchesOnStage(SMALL_BATTLEFIELD, 0, 5), // sole ban
      ];
      const entry = makeEntry({ firstSetAt: 1_000_000 });

      // 3 followed games: 2 wins, 1 loss -> 67% (rounded).
      const followedGames = [
        makeMatch({ time: 1_500_001, win: true, map: BATTLEFIELD, externalId: 'sgg:1:g1' }),
        makeMatch({ time: 1_500_002, win: true, map: TOWN_AND_CITY, externalId: 'sgg:1:g2' }),
        makeMatch({ time: 1_500_003, win: false, map: SMASHVILLE, externalId: 'sgg:1:g3' }),
      ];
      // 2 against games: 1 win, 1 loss -> 50%.
      const againstGames = [
        makeMatch({ time: 1_500_004, win: true, map: SMALL_BATTLEFIELD, externalId: 'sgg:2:g1' }),
        makeMatch({ time: 1_500_005, win: false, map: SMALL_BATTLEFIELD, externalId: 'sgg:2:g2' }),
      ];

      const entryMatches = [...followedGames, ...againstGames];
      const result = buildRetrospective([...pre, ...entryMatches], entryMatches, entry);

      // Unchanged from before this task (R1-BLOCKER-5): only the "worst
      // stage" fixture's id/name changed (BIG_BATTLEFIELD -> SMALL_BATTLEFIELD),
      // never the win/loss counts or rank positions these numbers derive from.
      expect(result.summary.followed).toBe(3);
      expect(result.summary.against).toBe(2);
      expect(result.summary.classifiable).toBe(5);
      expect(result.summary.adherenceRate).toBe(60); // 3/5
      expect(result.summary.followedWinRate).toBe(67); // 2/3 rounded
      expect(result.summary.againstWinRate).toBe(50); // 1/2
    });

    it('omits the followed/against win-rate halves that have zero samples', () => {
      const pre = preMatchesOnStage(BATTLEFIELD, 5, 0); // single ranked stage -> only ever "followed" or "neutral"
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const game = makeMatch({
        time: 1_500_000,
        win: true,
        map: BATTLEFIELD,
        externalId: 'sgg:1:g1',
      });

      const result = buildRetrospective([...pre, game], [game], entry);

      expect(result.summary.followed).toBe(1);
      expect(result.summary.against).toBe(0);
      expect(result.summary.followedWinRate).toBe(100);
      expect(result.summary.againstWinRate).toBeNull();
    });

    it('reports a null adherence rate and both win rates when nothing is classifiable', () => {
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const game = makeMatch({
        time: 1_500_000,
        win: true,
        map: NO_SELECTION,
        externalId: 'sgg:1:g1',
      });

      const result = buildRetrospective([game], [game], entry);

      expect(result.summary.classifiable).toBe(0);
      expect(result.summary.adherenceRate).toBeNull();
      expect(result.summary.followedWinRate).toBeNull();
      expect(result.summary.againstWinRate).toBeNull();
      expect(result.summary.noData).toBe(1);
    });

    it('counts neutral and no-data games separately from the classifiable total', () => {
      const pre = [
        ...preMatchesOnStage(BATTLEFIELD, 7, 0),
        ...preMatchesOnStage(TOWN_AND_CITY, 6, 1),
        ...preMatchesOnStage(SMASHVILLE, 5, 2),
        ...preMatchesOnStage(FINAL_DESTINATION, 4, 3), // neutral
        ...preMatchesOnStage(HOLLOW_BASTION, 3, 4), // ban
        ...preMatchesOnStage(LYLAT_CRUISE, 2, 5), // ban
        ...preMatchesOnStage(SMALL_BATTLEFIELD, 0, 7), // ban
      ];
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const neutralGame = makeMatch({
        time: 1_500_000,
        win: true,
        map: FINAL_DESTINATION,
        externalId: 'sgg:1:g1',
      });
      const noDataGame = makeMatch({
        time: 1_500_001,
        win: false,
        map: NO_SELECTION,
        externalId: 'sgg:1:g2',
      });

      const result = buildRetrospective(
        [...pre, neutralGame, noDataGame],
        [neutralGame, noDataGame],
        entry,
      );

      expect(result.summary.neutral).toBe(1);
      expect(result.summary.noData).toBe(1);
      expect(result.summary.classifiable).toBe(0);
      expect(result.summary.adherenceRate).toBeNull();
    });
  });

  it('handles an all-no-data tournament (no pairing had 2+ pre-tournament games)', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const games = [
      makeMatch({ time: 1_500_000, win: true, map: BATTLEFIELD, externalId: 'sgg:1:g1' }),
      makeMatch({ time: 1_500_001, win: false, map: SMASHVILLE, externalId: 'sgg:1:g2' }),
    ];

    const result = buildRetrospective(games, games, entry);

    expect(result.summary.classifiable).toBe(0);
    expect(result.summary.followed).toBe(0);
    expect(result.summary.against).toBe(0);
    expect(result.summary.noData).toBe(2);
  });
});
