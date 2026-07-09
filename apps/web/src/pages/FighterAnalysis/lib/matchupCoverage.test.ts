import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
// Bundled-English i18n (test setup) — recommendations take `t` so bullets localize.
import i18n from '@/i18n';
import {
  buildMatchupCoverage,
  buildPracticeRecommendations,
  COVERAGE_TOP_N,
} from './matchupCoverage';

const MARIO = 1;
const LUIGI = 10;
const FOX = 8;

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'> & { opponent_id: number },
): Match {
  return {
    fighter_id: MARIO,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('buildMatchupCoverage', () => {
  it('ranks opponents by how often they are faced across the entire filtered dataset', () => {
    const allMatches = [
      // Luigi faced 3 times (once by a different fighter), Fox faced once.
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: LUIGI, fighter_id: MARIO }),
      makeMatch({ id: 'm2', time: 2, win: true, opponent_id: LUIGI, fighter_id: 99 }),
      makeMatch({ id: 'm3', time: 3, win: false, opponent_id: LUIGI, fighter_id: MARIO }),
      makeMatch({ id: 'm4', time: 4, win: true, opponent_id: FOX, fighter_id: MARIO }),
    ];
    const fighterMatches = allMatches.filter((m) => m.fighter_id === MARIO);

    const coverage = buildMatchupCoverage(allMatches, fighterMatches);

    expect(coverage[0]?.opponentFighterId).toBe(LUIGI);
    expect(coverage[0]?.metaGames).toBe(3);
    expect(coverage[1]?.opponentFighterId).toBe(FOX);
    expect(coverage[1]?.metaGames).toBe(1);
  });

  it('caps the coverage list at COVERAGE_TOP_N opponents', () => {
    const allMatches = Array.from({ length: COVERAGE_TOP_N + 5 }, (_, i) =>
      makeMatch({ id: `m${i}`, time: i, win: true, opponent_id: i + 1, fighter_id: MARIO }),
    );

    const coverage = buildMatchupCoverage(allMatches, allMatches);

    expect(coverage).toHaveLength(COVERAGE_TOP_N);
  });

  it('marks an opponent as "covered" once the selected fighter has 3+ games', () => {
    const fighterMatches = Array.from({ length: 3 }, (_, i) =>
      makeMatch({ id: `m${i}`, time: i, win: true, opponent_id: LUIGI, fighter_id: MARIO }),
    );

    const coverage = buildMatchupCoverage(fighterMatches, fighterMatches);

    expect(coverage[0]?.status).toBe('covered');
    expect(coverage[0]?.record).toEqual({ wins: 3, losses: 0, total: 3, winRate: 100 });
  });

  it('marks an opponent as "thin" with 1-2 games', () => {
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: LUIGI, fighter_id: MARIO }),
    ];

    expect(buildMatchupCoverage(fighterMatches, fighterMatches)[0]?.status).toBe('thin');

    const twoGames = [
      ...fighterMatches,
      makeMatch({ id: 'm2', time: 2, win: false, opponent_id: LUIGI, fighter_id: MARIO }),
    ];
    expect(buildMatchupCoverage(twoGames, twoGames)[0]?.status).toBe('thin');
  });

  it('marks an opponent as "none" when the selected fighter has zero games vs them, even if the meta faces them often', () => {
    const allMatches = [
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: LUIGI, fighter_id: 99 }),
      makeMatch({ id: 'm2', time: 2, win: true, opponent_id: LUIGI, fighter_id: 99 }),
    ];
    const fighterMatches: Match[] = []; // Mario has never fought Luigi

    const coverage = buildMatchupCoverage(allMatches, fighterMatches);

    expect(coverage[0]?.status).toBe('none');
    expect(coverage[0]?.record).toBeNull();
    expect(coverage[0]?.metaGames).toBe(2);
  });

  it('returns an empty list when there is no data at all', () => {
    expect(buildMatchupCoverage([], [])).toEqual([]);
  });
});

describe('buildPracticeRecommendations', () => {
  const nameFor = (id: number) => (id === LUIGI ? 'Luigi' : id === FOX ? 'Fox' : `Fighter ${id}`);

  it('recommends the worst qualifying matchup ("struggling vs X: 2-7")', () => {
    const fighterMatches = [
      ...Array.from({ length: 2 }, (_, i) =>
        makeMatch({ id: `w${i}`, time: i, win: true, opponent_id: LUIGI }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        makeMatch({ id: `l${i}`, time: 10 + i, win: false, opponent_id: LUIGI }),
      ),
    ];
    const coverage = buildMatchupCoverage(fighterMatches, fighterMatches);

    const recs = buildPracticeRecommendations(fighterMatches, coverage, nameFor, i18n.t);

    expect(recs).toContainEqual({
      kind: 'worst-matchup',
      text: 'Struggling vs Luigi: 2-7',
    });
  });

  it('omits the worst-matchup bullet when no matchup has enough games', () => {
    const fighterMatches = [
      makeMatch({ id: 'm1', time: 1, win: false, opponent_id: LUIGI }),
      makeMatch({ id: 'm2', time: 2, win: false, opponent_id: LUIGI }),
    ]; // only 2 games, below the 3-game minimum
    const coverage = buildMatchupCoverage(fighterMatches, fighterMatches);

    const recs = buildPracticeRecommendations(fighterMatches, coverage, nameFor, i18n.t);

    expect(recs.find((r) => r.kind === 'worst-matchup')).toBeUndefined();
  });

  it('recommends the biggest coverage gap ("no games vs Y — you face them often")', () => {
    const allMatches = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `m${i}`, time: i, win: true, opponent_id: FOX, fighter_id: 99 }),
      ),
    ];
    const fighterMatches: Match[] = []; // selected fighter has never faced Fox
    const coverage = buildMatchupCoverage(allMatches, fighterMatches);

    const recs = buildPracticeRecommendations(fighterMatches, coverage, nameFor, i18n.t);

    expect(recs).toContainEqual({
      kind: 'coverage-gap',
      text: 'No games vs Fox — you face them often',
    });
  });

  it('omits the coverage-gap bullet when the never-faced opponent is rare in the meta', () => {
    const allMatches = [
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: FOX, fighter_id: 99 }),
    ]; // only faced once account-wide, below the gap threshold
    const coverage = buildMatchupCoverage(allMatches, []);

    const recs = buildPracticeRecommendations([], coverage, nameFor, i18n.t);

    expect(recs.find((r) => r.kind === 'coverage-gap')).toBeUndefined();
  });

  it('recommends the worst stage habit ("you keep playing on Z: 1-5")', () => {
    const fighterMatches = [
      makeMatch({
        id: 'm1',
        time: 1,
        win: true,
        opponent_id: LUIGI,
        map: { id: 1, name: 'Battlefield' },
      }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({
          id: `l${i}`,
          time: 10 + i,
          win: false,
          opponent_id: LUIGI,
          map: { id: 1, name: 'Battlefield' },
        }),
      ),
    ];
    const coverage = buildMatchupCoverage(fighterMatches, fighterMatches);

    const recs = buildPracticeRecommendations(fighterMatches, coverage, nameFor, i18n.t);

    expect(recs).toContainEqual({
      kind: 'stage-habit',
      text: 'You keep playing on Battlefield: 1-5',
    });
  });

  it('omits the stage-habit bullet when no stage has enough games', () => {
    const fighterMatches = [
      makeMatch({
        id: 'm1',
        time: 1,
        win: false,
        opponent_id: LUIGI,
        map: { id: 1, name: 'Battlefield' },
      }),
    ];
    const coverage = buildMatchupCoverage(fighterMatches, fighterMatches);

    const recs = buildPracticeRecommendations(fighterMatches, coverage, nameFor, i18n.t);

    expect(recs.find((r) => r.kind === 'stage-habit')).toBeUndefined();
  });

  it('returns an honest empty list when nothing qualifies', () => {
    expect(buildPracticeRecommendations([], [], nameFor, i18n.t)).toEqual([]);
  });

  it('can surface all three recommendations together, each independently triggered', () => {
    const worstMatchupMatches = [
      makeMatch({ id: 'wm1', time: 1, win: true, opponent_id: LUIGI }),
      makeMatch({ id: 'wm2', time: 2, win: false, opponent_id: LUIGI }),
      makeMatch({ id: 'wm3', time: 3, win: false, opponent_id: LUIGI }),
    ];
    const stageHabitMatches = [
      makeMatch({
        id: 'sh1',
        time: 4,
        win: false,
        opponent_id: LUIGI,
        map: { id: 2, name: 'Final Destination' },
      }),
      makeMatch({
        id: 'sh2',
        time: 5,
        win: false,
        opponent_id: LUIGI,
        map: { id: 2, name: 'Final Destination' },
      }),
      makeMatch({
        id: 'sh3',
        time: 6,
        win: false,
        opponent_id: LUIGI,
        map: { id: 2, name: 'Final Destination' },
      }),
    ];
    const fighterMatches = [...worstMatchupMatches, ...stageHabitMatches];
    const metaOnlyFoxMatches = Array.from({ length: 4 }, (_, i) =>
      makeMatch({ id: `fox${i}`, time: 10 + i, win: true, opponent_id: FOX, fighter_id: 99 }),
    );
    const allMatches = [...fighterMatches, ...metaOnlyFoxMatches];
    const coverage = buildMatchupCoverage(allMatches, fighterMatches);

    const recs = buildPracticeRecommendations(fighterMatches, coverage, nameFor, i18n.t);

    expect(recs.map((r) => r.kind).sort()).toEqual(
      ['coverage-gap', 'stage-habit', 'worst-matchup'].sort(),
    );
  });
});
