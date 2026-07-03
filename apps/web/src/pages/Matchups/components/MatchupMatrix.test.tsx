import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { MatchupMatrix, MATCHUP_DETAIL_ANCHOR_ID } from './MatchupMatrix';
import { SpriteList } from '@/data/sprites';

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const sonic = SpriteList.find((s) => s.name === 'Sonic')!;
const piranhaPlant = SpriteList.find((s) => s.name === 'Piranha Plant')!;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderMatrix(matches: Match[], overrides: Partial<MatchupsContextValue> = {}) {
  const setFighter = vi.fn();
  const setOpponent = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [mario, luigi],
    fighter: mario,
    setFighter,
    opponent: luigi,
    setOpponent,
    ...overrides,
  };

  render(
    <MatchupsContext.Provider value={contextValue}>
      <div id={MATCHUP_DETAIL_ANCHOR_ID} />
      <MatchupMatrix matches={matches} />
    </MatchupsContext.Provider>,
  );

  return { setFighter, setOpponent };
}

describe('MatchupMatrix', () => {
  it('shows an empty-state message when there are no matches', () => {
    renderMatrix([]);
    expect(screen.getByText(/No matches recorded yet — play some matches/)).toBeInTheDocument();
  });

  it('renders one cell per fighter/opponent pairing with the W-L record as its label', () => {
    renderMatrix([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
    ]);

    const cell = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 2-1` });
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveTextContent('2-1');
  });

  it('orders rows and columns by usage (most-played first)', () => {
    renderMatrix(
      [
        // Luigi faced once, Sonic faced three times — Sonic should sort first.
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
        makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
        makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
        makeMatch({ id: 'm4', fighter_id: mario.id, opponent_id: sonic.id, win: false }),
      ],
      { fighterSprites: [mario] },
    );

    const columnHeaders = screen.getAllByRole('columnheader').slice(1); // drop the corner header
    const headerNames = columnHeaders.map((h) => h.textContent);
    const sonicIndex = headerNames.findIndex((t) => t?.includes(sonic.name));
    const luigiIndex = headerNames.findIndex((t) => t?.includes(luigi.name));
    expect(sonicIndex).toBeGreaterThanOrEqual(0);
    expect(luigiIndex).toBeGreaterThanOrEqual(0);
    expect(sonicIndex).toBeLessThan(luigiIndex);
  });

  it('leaves cells blank for pairings with no recorded matches', () => {
    renderMatrix(
      [makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })],
      { fighterSprites: [mario, piranhaPlant] },
    );

    // Piranha Plant has no matches at all, so it shouldn't even appear as a row
    // (rows are usage-ordered fighters that were actually played).
    expect(screen.queryByText(piranhaPlant.name)).not.toBeInTheDocument();
  });

  it('caps visible columns at 12 by usage and offers a show-all toggle', () => {
    const manyOpponents = SpriteList.slice(0, 15);
    const matches = manyOpponents.map((opp, i) =>
      makeMatch({ id: `m${i}`, fighter_id: mario.id, opponent_id: opp.id, win: true }),
    );

    renderMatrix(matches, { fighterSprites: [mario] });

    // 12 opponent columns + 1 corner column.
    expect(screen.getAllByRole('columnheader')).toHaveLength(13);
    const toggle = screen.getByRole('button', { name: /Show all 15/ });
    expect(toggle).toBeInTheDocument();
  });

  it('reveals all columns when the show-all toggle is clicked', async () => {
    const user = userEvent.setup();
    const manyOpponents = SpriteList.slice(0, 15);
    const matches = manyOpponents.map((opp, i) =>
      makeMatch({ id: `m${i}`, fighter_id: mario.id, opponent_id: opp.id, win: true }),
    );

    renderMatrix(matches, { fighterSprites: [mario] });

    await user.click(screen.getByRole('button', { name: /Show all 15/ }));

    expect(screen.getAllByRole('columnheader')).toHaveLength(16);
    expect(screen.getByRole('button', { name: /Show top 12/ })).toBeInTheDocument();
  });

  it('clicking a cell sets the fighter+opponent selection and scrolls to the detail anchor', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const { setFighter, setOpponent } = renderMatrix([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
    ]);

    await user.click(screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-0` }));

    expect(setFighter).toHaveBeenCalledWith(expect.objectContaining({ id: mario.id }));
    expect(setOpponent).toHaveBeenCalledWith(expect.objectContaining({ id: luigi.id }));
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth', block: 'start' }),
    );
  });
});
