import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpriteList } from '@/data/sprites';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { SelectFighter } from './SelectFighter';

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const bowser = SpriteList.find((s) => s.id === 16)!; // Bowser — alphabetically first of these three

/**
 * `fighterSprites` is supplied PRE-ORDERED (usage-ranked) by the fixture,
 * matching what `usePersistedSelection`'s `orderedFighterSprites` provides in
 * production — this component performs no sorting of its own (D-13).
 */
function renderSelectFighter(overrides: Partial<MatchupsContextValue> = {}) {
  const setFighter = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [mario, luigi, bowser],
    fighter: mario,
    setFighter,
    opponent: undefined,
    setOpponent: vi.fn(),
    fighterUsageById: new Map([
      [mario.id, 5],
      [luigi.id, 2],
      // bowser deliberately absent — a saved fighter with zero games still
      // appears (D-04/D-07) and its count must default to 0.
    ]),
    opponentUsage: [],
    drillDownAxes: {},
    setDrillDown: vi.fn(),
    ...overrides,
  };

  render(
    <MatchupsContext.Provider value={contextValue}>
      <SelectFighter />
    </MatchupsContext.Provider>,
  );

  return { setFighter };
}

describe('SelectFighter', () => {
  it('renders options in the order the context supplies them (most-used first, per fixture)', async () => {
    const user = userEvent.setup();
    renderSelectFighter();

    await user.click(screen.getByLabelText('Select your fighter'));

    const options = await screen.findAllByRole('option');
    const names = options.map((o) => o.textContent ?? '');
    expect(names[0]).toContain(mario.name);
    expect(names[1]).toContain(luigi.name);
    expect(names[2]).toContain(bowser.name);
  });

  it('shows a localized game count trailing each option, alphabetically-first fighter not privileged', async () => {
    const user = userEvent.setup();
    renderSelectFighter();

    await user.click(screen.getByLabelText('Select your fighter'));

    const marioOption = await screen.findByRole('option', { name: new RegExp(mario.name) });
    expect(within(marioOption).getByText('5 games')).toBeInTheDocument();

    const luigiOption = screen.getByRole('option', { name: new RegExp(luigi.name) });
    expect(within(luigiOption).getByText('2 games')).toBeInTheDocument();
  });

  it('still renders a saved fighter with zero games, showing a zero count', async () => {
    const user = userEvent.setup();
    renderSelectFighter();

    await user.click(screen.getByLabelText('Select your fighter'));

    const bowserOption = await screen.findByRole('option', { name: new RegExp(bowser.name) });
    expect(within(bowserOption).getByText('0 games')).toBeInTheDocument();
  });

  it('calls setFighter with the selected fighter when a different option is chosen', async () => {
    const user = userEvent.setup();
    const { setFighter } = renderSelectFighter();

    await user.click(screen.getByLabelText('Select your fighter'));
    await user.click(await screen.findByRole('option', { name: new RegExp(luigi.name) }));

    expect(setFighter).toHaveBeenCalledWith(expect.objectContaining({ id: luigi.id }));
  });
});
