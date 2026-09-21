import { describe, expect, it } from 'vitest';
import { secondaryPayoffTemplate } from './secondaryPayoff.js';
import { COHORT_MIN_SIDE_GAMES, SUGGESTION_MIN_GAMES } from '../policy.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAIN_ID = 1;
const SECONDARY_ID = 2;
const MAIN_FILLER_OPPONENT = 90;
const SECONDARY_FILLER_OPPONENT = 91;

/**
 * A roster with exactly two fighters: `MAIN_ID` (established main, always 60
 * total games, top share) and `SECONDARY_ID` (established secondary, always
 * 25 total games — 25/85 = 29.4% share, well above the 8% floor). The tested
 * pairing (`opponentId`) carries the ONLY overlapping opponent-character
 * games between the two; every other game is filler against a distinct
 * dummy opponent, so it never contributes a second candidate pairing.
 */
function buildPayoffFixture(params: {
  opponentId: number;
  mainGamesVsOpponent: number;
  mainWinsVsOpponent: number;
  secondaryGamesVsOpponent: number;
  secondaryWinsVsOpponent: number;
}): Match[] {
  const {
    opponentId,
    mainGamesVsOpponent,
    mainWinsVsOpponent,
    secondaryGamesVsOpponent,
    secondaryWinsVsOpponent,
  } = params;
  const MAIN_TOTAL = 60;
  const SECONDARY_TOTAL = 25;
  const matches: Match[] = [];
  let t = 0;
  const push = (fighterId: number, opponent_id: number, win: boolean): void => {
    matches.push({
      id: `m-${matches.length}`,
      fighter_id: fighterId,
      opponent_id,
      time: NOW_MS - (10_000 - t) * ONE_HOUR_MS,
      win,
    });
    t += 1;
  };
  for (let i = 0; i < mainGamesVsOpponent; i += 1) {
    push(MAIN_ID, opponentId, i < mainWinsVsOpponent);
  }
  for (let i = 0; i < MAIN_TOTAL - mainGamesVsOpponent; i += 1) {
    push(MAIN_ID, MAIN_FILLER_OPPONENT, true);
  }
  for (let i = 0; i < secondaryGamesVsOpponent; i += 1) {
    push(SECONDARY_ID, opponentId, i < secondaryWinsVsOpponent);
  }
  for (let i = 0; i < SECONDARY_TOTAL - secondaryGamesVsOpponent; i += 1) {
    push(SECONDARY_ID, SECONDARY_FILLER_OPPONENT, true);
  }
  return matches;
}

describe('secondaryPayoffTemplate', () => {
  it('returns Suggestion when a secondary clearly outperforms the main at a high-tier sample', () => {
    expect(SUGGESTION_MIN_GAMES).toBe(20);
    const matches = buildPayoffFixture({
      opponentId: 50,
      mainGamesVsOpponent: 30,
      mainWinsVsOpponent: 15, // 50%
      secondaryGamesVsOpponent: 20,
      secondaryWinsVsOpponent: 18, // 90%
    });
    const [insight] = secondaryPayoffTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('suggestion');
    expect(insight!.kind).toBe('recommendation');
    expect(insight!.deltaPoints).toBe(40);
    expect(insight!.doors).toHaveLength(1);
    expect(insight!.doors[0]!.kind).toBe('matchup');
  });

  it('returns Trend when a secondary clearly outperforms the main below the high tier', () => {
    const matches = buildPayoffFixture({
      opponentId: 53,
      mainGamesVsOpponent: 20,
      mainWinsVsOpponent: 10, // 50%
      secondaryGamesVsOpponent: 10,
      secondaryWinsVsOpponent: 9, // 90%
    });
    const [insight] = secondaryPayoffTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('trend');
    expect(insight!.kind).toBe('inference');
    expect(insight!.doors).toHaveLength(1);
    expect(insight!.doors[0]!.kind).toBe('matchup');
  });

  it('returns steady with deltaPoints === null when no pairing clears the notability bar', () => {
    const matches = buildPayoffFixture({
      opponentId: 54,
      mainGamesVsOpponent: 20,
      mainWinsVsOpponent: 10, // 50%
      secondaryGamesVsOpponent: 20,
      secondaryWinsVsOpponent: 10, // 50%, same rate — no notable gap
    });
    const [insight] = secondaryPayoffTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('steady');
    expect(insight!.deltaPoints).toBeNull();
    expect(insight!.doors).toEqual([]);
  });

  it('returns locked with a positive gamesNeeded below COHORT_MIN_SIDE_GAMES on the secondary', () => {
    expect(COHORT_MIN_SIDE_GAMES).toBe(8);
    const matches = buildPayoffFixture({
      opponentId: 55,
      mainGamesVsOpponent: 20,
      mainWinsVsOpponent: 12,
      secondaryGamesVsOpponent: 5, // below the 8-game floor
      secondaryWinsVsOpponent: 5,
    });
    const [insight] = secondaryPayoffTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('locked');
    expect(insight!.gamesNeeded).toBe(3);
    expect(insight!.doors).toEqual([]);
  });

  it('returns [] when no main is established', () => {
    const matches: Match[] = Array.from({ length: 10 }, (_, i) => ({
      id: `thin-${i}`,
      fighter_id: MAIN_ID,
      opponent_id: 50,
      time: NOW_MS - (10 - i) * ONE_HOUR_MS,
      win: true,
    }));
    const result = secondaryPayoffTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('declares windowExpressible: false, read from the built segment', () => {
    expect(secondaryPayoffTemplate.windowExpressible).toBe(false);
    expect(secondaryPayoffTemplate.assertsDirection).toBe(true);
  });
});
