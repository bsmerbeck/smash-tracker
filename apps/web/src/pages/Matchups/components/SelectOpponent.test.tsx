import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpriteList } from '@/data/sprites';
import type { FighterUsage } from '@/lib/playerTrueDefaults';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { SelectOpponent } from './SelectOpponent';

const mario = SpriteList.find((s) => s.id === 1)!; // Mario — "you", not an opponent option
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const peach = SpriteList.find((s) => s.id === 14)!; // Peach
const bowser = SpriteList.find((s) => s.id === 16)!; // Bowser (roster also has "Bowser Jr." and "Dr. Mario" —
// exact-text queries below deliberately avoid substring matches against those).
// Alphabetically these three sort Bowser, Luigi, Peach — the ranked fixture
// below deliberately uses the OPPOSITE order so the faced-group assertion
// only passes if the component renders ranked order, not alphabetical.

function makeUsage(id: number, games: number): FighterUsage {
  return { id, games, mostRecentMs: 0 };
}

/** Finds the `option` row whose visible text is exactly `name` (never a substring match). */
function findOptionByExactName(name: string) {
  const options = screen.getAllByRole('option');
  const match = options.find((o) => within(o).queryByText(name) != null);
  if (!match) {
    throw new Error(`No option row found with exact text "${name}"`);
  }
  return match;
}

function renderSelectOpponent(overrides: Partial<MatchupsContextValue> = {}) {
  const setOpponent = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [mario],
    fighter: mario,
    setFighter: vi.fn(),
    opponent: luigi,
    setOpponent,
    fighterUsageById: new Map(),
    opponentUsage: [makeUsage(peach.id, 5), makeUsage(luigi.id, 3), makeUsage(bowser.id, 1)],
    selectedMatchIds: null,
    setSelectedMatchIds: vi.fn(),
    ...overrides,
  };

  render(
    <MatchupsContext.Provider value={contextValue}>
      <SelectOpponent />
    </MatchupsContext.Provider>,
  );

  return { setOpponent };
}

describe('SelectOpponent', () => {
  it('renders a "Faced" group with counts, most-faced first, and a "Not yet faced" group with no counts', async () => {
    const user = userEvent.setup();
    renderSelectOpponent();

    await user.click(screen.getByLabelText('Select opponent fighter'));

    expect(await screen.findByText('Faced')).toBeInTheDocument();
    expect(screen.getByText('Not yet faced')).toBeInTheDocument();

    // Faced rows appear in RANKED order (peach, luigi, bowser) — not the
    // alphabetical order (bowser, luigi, peach) the unfaced group uses.
    const options = screen.getAllByRole('option');
    const peachIndex = options.findIndex((o) => within(o).queryByText(peach.name) != null);
    const luigiIndex = options.findIndex((o) => within(o).queryByText(luigi.name) != null);
    const bowserIndex = options.findIndex((o) => within(o).queryByText(bowser.name) != null);
    expect(peachIndex).toBeGreaterThanOrEqual(0);
    expect(peachIndex).toBeLessThan(luigiIndex);
    expect(luigiIndex).toBeLessThan(bowserIndex);

    const peachOption = findOptionByExactName(peach.name);
    expect(within(peachOption).getByText('5 games')).toBeInTheDocument();
  });

  it('shows no trailing count on "Not yet faced" rows', async () => {
    const user = userEvent.setup();
    renderSelectOpponent();

    await user.click(screen.getByLabelText('Select opponent fighter'));
    await screen.findByText('Not yet faced');

    // Mario is not in opponentUsage, so it renders only in "Not yet faced".
    const marioOption = findOptionByExactName(mario.name);
    expect(within(marioOption).queryByText(/games/)).not.toBeInTheDocument();
  });

  it('omits the "Faced" group entirely when the fighter has faced nobody', async () => {
    const user = userEvent.setup();
    renderSelectOpponent({ opponentUsage: [] });

    await user.click(screen.getByLabelText('Select opponent fighter'));

    expect(await screen.findByText('Not yet faced')).toBeInTheDocument();
    expect(screen.queryByText('Faced')).not.toBeInTheDocument();
  });

  it('renders a single "Faced" row when exactly one character has been faced', async () => {
    const user = userEvent.setup();
    renderSelectOpponent({ opponentUsage: [makeUsage(luigi.id, 2)] });

    await user.click(screen.getByLabelText('Select opponent fighter'));

    expect(await screen.findByText('Faced')).toBeInTheDocument();
    const luigiOption = findOptionByExactName(luigi.name);
    expect(within(luigiOption).getByText('2 games')).toBeInTheDocument();
  });

  it('calls setOpponent when choosing a row from the faced group', async () => {
    const user = userEvent.setup();
    const { setOpponent } = renderSelectOpponent();

    await user.click(screen.getByLabelText('Select opponent fighter'));
    await screen.findByText('Faced');
    await user.click(findOptionByExactName(peach.name));

    expect(setOpponent).toHaveBeenCalledWith(expect.objectContaining({ id: peach.id }));
  });

  it('calls setOpponent when choosing a row from the not-yet-faced group', async () => {
    const user = userEvent.setup();
    const { setOpponent } = renderSelectOpponent();

    await user.click(screen.getByLabelText('Select opponent fighter'));
    await screen.findByText('Not yet faced');
    // Mario is not in opponentUsage, so it renders only in "Not yet faced".
    await user.click(findOptionByExactName(mario.name));

    expect(setOpponent).toHaveBeenCalledWith(expect.objectContaining({ id: mario.id }));
  });
});
