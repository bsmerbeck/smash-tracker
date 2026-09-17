import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Fighter, Match } from '@smash-tracker/shared';
import { buildMatchupSnapshot, MatchupSnapshot } from './MatchupSnapshot';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';

function makeMatch(id: string, time: number, win: boolean, opponentId: number): Match {
  return {
    id,
    time,
    win,
    fighter_id: 1,
    opponent_id: opponentId,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
  };
}

describe('buildMatchupSnapshot', () => {
  // Phase 36 (D-05/D-07): `rankMatchupsByEvidence`'s default floor is now
  // ABSTENTION_FLOOR_GAMES (3), so every fixture below needs >=3 games per
  // opponent to clear the gate at all.
  it('ranks strongest matchups by Wilson lower bound, best first', () => {
    const matches = [
      // Opponent 2: 3-0 (thin sample, high raw rate but low Wilson bound)
      makeMatch('1', 1, true, 2),
      makeMatch('2', 2, true, 2),
      makeMatch('3', 3, true, 2),
      // Opponent 3: 12-3 (large sample, strong Wilson bound)
      ...Array.from({ length: 12 }, (_, i) => makeMatch(`w${i}`, 10 + i, true, 3)),
      ...Array.from({ length: 3 }, (_, i) => makeMatch(`l${i}`, 30 + i, false, 3)),
    ];

    const { strongest } = buildMatchupSnapshot(matches);

    // 12-3 (80% over 15 games) should outrank a thin 3-0 by Wilson bound,
    // even though the 3-0 has a higher raw ratio.
    expect(strongest[0]?.opponentFighterId).toBe(3);
    expect(strongest.map((s) => s.opponentFighterId)).toContain(2);
  });

  it('caps strongest matchups at 3', () => {
    const matches = [1, 2, 3, 4, 5].flatMap((opponentId) =>
      Array.from({ length: 3 }, (_, i) =>
        makeMatch(`${opponentId}-${i}`, opponentId * 10 + i, true, opponentId),
      ),
    );
    const { strongest } = buildMatchupSnapshot(matches);
    expect(strongest).toHaveLength(3);
  });

  it('only includes matchups with >= 3 games in "toughest", worst first', () => {
    const matches = [
      // Opponent 2: 0-1 (only 1 game — excluded from toughest despite 0%)
      makeMatch('a', 1, false, 2),
      // Opponent 3: 1-4 (5 games, qualifies, worse Wilson bound)
      makeMatch('b1', 2, true, 3),
      makeMatch('b2', 3, false, 3),
      makeMatch('b3', 4, false, 3),
      makeMatch('b4', 5, false, 3),
      makeMatch('b5', 6, false, 3),
      // Opponent 4: 2-3 (5 games, qualifies, less bad)
      makeMatch('c1', 7, true, 4),
      makeMatch('c2', 8, true, 4),
      makeMatch('c3', 9, false, 4),
      makeMatch('c4', 10, false, 4),
      makeMatch('c5', 11, false, 4),
    ];

    const { toughest, needsMoreData } = buildMatchupSnapshot(matches);

    expect(toughest.every((row) => row.totalMatches >= 3)).toBe(true);
    expect(toughest.map((row) => row.opponentFighterId)).not.toContain(2);
    // Worst (lowest Wilson bound) first.
    expect(toughest[0]?.opponentFighterId).toBe(3);
    expect(needsMoreData).toBe(false);
  });

  it('flags needsMoreData when fewer than 2 qualifying (>=3 game) matchups exist', () => {
    const matches = [
      // Exactly one opponent (2) clears the 3-game floor — one qualifying
      // row is still not enough for a "toughest" comparison (needs 2).
      makeMatch('a', 1, true, 2),
      makeMatch('b', 2, false, 2),
      makeMatch('c', 3, true, 2),
    ];

    const { toughest, needsMoreData } = buildMatchupSnapshot(matches);
    expect(toughest).toEqual([]);
    expect(needsMoreData).toBe(true);
  });

  it('does not flag needsMoreData when there is no data at all', () => {
    const { needsMoreData, strongest, toughest } = buildMatchupSnapshot([]);
    expect(needsMoreData).toBe(false);
    expect(strongest).toEqual([]);
    expect(toughest).toEqual([]);
  });

  // Phase 36 (D-05/D-07): acceptance criterion — a 2-0 matchup must never
  // outrank/appear among strongest even alongside a well-proven 6-2.
  it('excludes a 2-0 matchup from strongest even when a proven 6-2 matchup exists', () => {
    const matches = [
      makeMatch('a1', 1, true, 2),
      makeMatch('a2', 2, true, 2),
      // Opponent 3: 6-2 (8 games)
      ...Array.from({ length: 6 }, (_, i) => makeMatch(`b${i}`, 10 + i, true, 3)),
      ...Array.from({ length: 2 }, (_, i) => makeMatch(`c${i}`, 20 + i, false, 3)),
    ];
    const { strongest } = buildMatchupSnapshot(matches);
    expect(strongest.some((row) => row.totalMatches === 2)).toBe(false);
  });
});

const mario: Fighter = { id: 1, name: 'Mario', url: '/assets/sprites/1-mario-sprite.png' };

function renderWithContext(
  matches: Match[],
  contextOverrides: Partial<DashboardContextValue> = {},
  initialPath = '/dashboard',
) {
  const contextValue: DashboardContextValue = {
    fighterSprites: [mario],
    fighter: mario,
    setFighter: () => {},
    ...contextOverrides,
  };
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <DashboardContext.Provider value={contextValue}>
        <Routes>
          <Route path="/coach/:clientId/*" element={<MatchupSnapshot matches={matches} />} />
          <Route path="*" element={<MatchupSnapshot matches={matches} />} />
        </Routes>
      </DashboardContext.Provider>
    </MemoryRouter>,
  );
}

describe('MatchupSnapshot', () => {
  it('shows a no-matches state when there are no matches', () => {
    renderWithContext([]);
    expect(screen.getByText('No matches reported')).toBeInTheDocument();
  });

  it('links to the Matchup Lab', () => {
    const matches = Array.from({ length: 5 }, (_, i) => makeMatch(`${i}`, i, true, 2));
    renderWithContext(matches);
    expect(screen.getByRole('link', { name: 'Open Matchup Lab' })).toHaveAttribute(
      'href',
      '/matchups',
    );
  });

  it('shows a build-more-data hint for toughest matchups when under threshold', () => {
    // Phase 36 (D-05/D-07): exactly one opponent clears the 3-game floor —
    // still not enough qualifying rows (needs 2) for a "toughest" comparison.
    // The bespoke "Play a few more games" copy is replaced by the shared
    // abstained sentence (EVID-06).
    const matches = [
      makeMatch('1', 1, true, 2),
      makeMatch('2', 2, false, 2),
      makeMatch('3', 3, true, 2),
    ];
    renderWithContext(matches);
    expect(screen.getByText(/Not enough data yet.*1 more game needed/)).toBeInTheDocument();
  });

  // Phase 11 fix round 3 (FB-6, the originally-reported bug): in a client
  // workspace, "Open Matchup Lab" must stay under /coach/:clientId/... —
  // previously it hardcoded the personal /matchups route, escaping the
  // workspace into the coach's own data.
  it('FB-6 regression: stays subject-aware in a coaching client workspace', () => {
    const matches = Array.from({ length: 5 }, (_, i) => makeMatch(`${i}`, i, true, 2));
    renderWithContext(matches, {}, '/coach/tetra/dashboard');
    expect(screen.getByRole('link', { name: 'Open Matchup Lab' })).toHaveAttribute(
      'href',
      '/coach/tetra/matchups',
    );
  });
});
