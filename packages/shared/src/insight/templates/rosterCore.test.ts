import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildRosterModel,
  rosterCoreTemplate,
  ROSTER_MAIN_MIN_GAMES,
  ROSTER_SECONDARY_MIN_GAMES,
  ROSTER_SECONDARY_MIN_SHARE,
} from './rosterCore.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { InsightScope } from '../types.js';
import type { Match } from '../../match.js';

const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function buildMatches(params: {
  fighterId: number;
  count: number;
  idPrefix: string;
  startAtMs?: number;
}): Match[] {
  const { fighterId, count, idPrefix, startAtMs = NOW_MS - count * ONE_HOUR_MS } = params;
  return Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${i}`,
    fighter_id: fighterId,
    opponent_id: 23,
    time: startAtMs + i * ONE_HOUR_MS,
    win: i % 2 === 0,
  }));
}

function characterScope(fighterId: number): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches) => matches.filter((m) => m.fighter_id === fighterId),
  };
}

describe('buildRosterModel', () => {
  it('one 60-game fighter, two 25-game fighters above the share floor, and five 4-game fighters returns exactly 1 main, 2 secondaries and a pooled pocket group of 5 fighters', () => {
    const matches: Match[] = [
      ...buildMatches({ fighterId: 1, count: 60, idPrefix: 'main' }),
      ...buildMatches({ fighterId: 2, count: 25, idPrefix: 'sec-a' }),
      ...buildMatches({ fighterId: 3, count: 25, idPrefix: 'sec-b' }),
      ...buildMatches({ fighterId: 4, count: 4, idPrefix: 'pocket-a' }),
      ...buildMatches({ fighterId: 5, count: 4, idPrefix: 'pocket-b' }),
      ...buildMatches({ fighterId: 6, count: 4, idPrefix: 'pocket-c' }),
      ...buildMatches({ fighterId: 7, count: 4, idPrefix: 'pocket-d' }),
      ...buildMatches({ fighterId: 8, count: 4, idPrefix: 'pocket-e' }),
    ];
    const model = buildRosterModel({ matches });
    expect(model.main).not.toBeNull();
    expect(model.main!.fighterId).toBe(1);
    expect(model.main!.games).toBe(60);
    expect(model.secondaries).toHaveLength(2);
    expect(model.secondaries.map((s) => s.fighterId).sort()).toEqual([2, 3]);
    expect(model.pockets.fighterIds).toEqual([4, 5, 6, 7, 8]);
    expect(model.pockets.games).toBe(20);
    expect(model.totalGames).toBe(130);
  });

  it('a 19-game total fixture returns main === null (no fighter can reach the 20-game floor)', () => {
    const matches = buildMatches({ fighterId: 1, count: 19, idPrefix: 'thin' });
    const model = buildRosterModel({ matches });
    expect(model.main).toBeNull();
    expect(model.totalGames).toBe(19);
  });

  it('a fighter at exactly ROSTER_SECONDARY_MIN_GAMES and exactly ROSTER_SECONDARY_MIN_SHARE is a secondary', () => {
    // total = 250: main 200 games (80%), candidate 20 games (exactly 8% of 250).
    expect(ROSTER_SECONDARY_MIN_GAMES).toBe(20);
    expect(ROSTER_SECONDARY_MIN_SHARE).toBe(0.08);
    const matches: Match[] = [
      ...buildMatches({ fighterId: 1, count: 200, idPrefix: 'main' }),
      ...buildMatches({ fighterId: 2, count: 20, idPrefix: 'candidate' }),
      ...buildMatches({ fighterId: 3, count: 15, idPrefix: 'pocket-a' }),
      ...buildMatches({ fighterId: 4, count: 15, idPrefix: 'pocket-b' }),
    ];
    const model = buildRosterModel({ matches });
    expect(model.totalGames).toBe(250);
    const candidate = model.secondaries.find((s) => s.fighterId === 2);
    expect(candidate).toBeDefined();
    expect(candidate!.games).toBe(20);
    expect(candidate!.share).toBeCloseTo(0.08, 10);
  });

  it('one game below the games floor (same share) is a pocket, not a secondary', () => {
    // total = 237: main 200 games, candidate 19 games (share ~8.02%, above the
    // share floor) — isolates the GAMES boundary alone.
    const matches: Match[] = [
      ...buildMatches({ fighterId: 1, count: 200, idPrefix: 'main' }),
      ...buildMatches({ fighterId: 2, count: 19, idPrefix: 'candidate' }),
      ...buildMatches({ fighterId: 3, count: 18, idPrefix: 'pocket' }),
    ];
    const model = buildRosterModel({ matches });
    expect(model.totalGames).toBe(237);
    const candidateShare = 19 / 237;
    expect(candidateShare).toBeGreaterThanOrEqual(ROSTER_SECONDARY_MIN_SHARE);
    expect(model.secondaries.map((s) => s.fighterId)).not.toContain(2);
    expect(model.pockets.fighterIds).toContain(2);
  });

  it('one share point below the share floor (same games) is a pocket, not a secondary', () => {
    // total = 251: main 200 games, candidate 20 games (share ~7.97%, below
    // the share floor) — isolates the SHARE boundary alone.
    const matches: Match[] = [
      ...buildMatches({ fighterId: 1, count: 200, idPrefix: 'main' }),
      ...buildMatches({ fighterId: 2, count: 20, idPrefix: 'candidate' }),
      ...buildMatches({ fighterId: 3, count: 31, idPrefix: 'pocket' }),
    ];
    const model = buildRosterModel({ matches });
    expect(model.totalGames).toBe(251);
    const candidateShare = 20 / 251;
    expect(candidateShare).toBeLessThan(ROSTER_SECONDARY_MIN_SHARE);
    expect(model.secondaries.map((s) => s.fighterId)).not.toContain(2);
    expect(model.pockets.fighterIds).toContain(2);
  });
});

describe('rosterCoreTemplate', () => {
  it('returns a "fact" Insight naming the main when one is established', () => {
    const matches: Match[] = [
      ...buildMatches({ fighterId: 1, count: 60, idPrefix: 'main' }),
      ...buildMatches({ fighterId: 2, count: 25, idPrefix: 'sec' }),
    ];
    const [insight] = rosterCoreTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('fact');
    expect(insight!.kind).toBe('fact');
    expect(insight!.deltaPoints).toBeNull();
    expect(insight!.doors).toHaveLength(1);
    expect(insight!.doors[0]!.kind).toBe('games');
    expect(insight!.doors[0]!.axes.fighter).toBe(1);
  });

  it('returns the "thin" variant below the main-establishment floor, with deltaPoints null', () => {
    const matches = buildMatches({ fighterId: 1, count: 19, idPrefix: 'thin' });
    const [insight] = rosterCoreTemplate.build({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight).toBeDefined();
    expect(insight!.state).toBe('thin');
    expect(insight!.deltaPoints).toBeNull();
    expect(insight!.doors).toEqual([]);
    expect(insight!.copy.values.count).toBe(ROSTER_MAIN_MIN_GAMES);
  });

  it('returns [] for a non-account scope (the roster model is account-wide only)', () => {
    const matches = buildMatches({ fighterId: 1, count: 60, idPrefix: 'main' });
    const result = rosterCoreTemplate.build({
      matches,
      scope: characterScope(1),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('returns [] for zero games in scope', () => {
    const result = rosterCoreTemplate.build({
      matches: [],
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(result).toEqual([]);
  });

  it('declares windowExpressible: true, read from the built segment', () => {
    expect(rosterCoreTemplate.windowExpressible).toBe(true);
    expect(rosterCoreTemplate.assertsDirection).toBe(false);
    expect(rosterCoreTemplate.scopeKind).toBe('account');
  });
});

describe('the three roster thresholds are declared engine defaults, not acceptance values (review finding C1-M4)', () => {
  it("each constant's doc comment names INSIGHT_POLICY_VERSION and UI-SPEC §8.4 as the source of the PROPOSAL", () => {
    const sourcePath = fileURLToPath(new URL('./rosterCore.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    // The shared doc comment block immediately preceding all three constants.
    expect(source).toContain('INSIGHT_POLICY_VERSION');
    expect(source).toContain('UI-SPEC §8.4');
    expect(source).toContain('declared engine defaults');
    expect(source).toContain('an owner-locked');
  });
});
