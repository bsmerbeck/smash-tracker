import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { MatchupMatrix, MATCHUP_DETAIL_ANCHOR_ID } from './MatchupMatrix';
import { SpriteList } from '@/data/sprites';

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

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

function renderMatrix(
  matches: Match[],
  overrides: Partial<MatchupsContextValue> = {},
  initialEntry = '/matchups',
) {
  const setFighter = vi.fn();
  const setOpponent = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [mario, luigi],
    fighter: mario,
    setFighter,
    opponent: luigi,
    setOpponent,
    fighterUsageById: new Map(),
    opponentUsage: [],
    drillDownAxes: {},
    setDrillDown: vi.fn(),
    ...overrides,
  };

  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MatchupsContext.Provider value={contextValue}>
        <div id={MATCHUP_DETAIL_ANCHOR_ID} />
        <MatchupMatrix matches={matches} />
      </MatchupsContext.Provider>
    </MemoryRouter>,
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

  it('clicking a cell navigates to the param-aware Matchups route with both character axes set, and scrolls to the detail anchor', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    mockNavigate.mockClear();

    renderMatrix([makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })]);

    await user.click(screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-0` }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const destination = mockNavigate.mock.calls[0]?.[0] as string;
    expect(destination).toBe(`/matchups?fighter=${mario.id}&vs=${luigi.id}`);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth', block: 'start' }),
    );
  });

  it('starts at the card content edge (no auto-centering) and renders every cell button in the foreground text token (39.1-31, item 4)', () => {
    renderMatrix([makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })]);

    // `renderMatrix` (this file's own helper) doesn't return `container` —
    // `screen` is document-bound and finds the table the same way.
    const table = screen.getByRole('table');
    expect(table.className).not.toMatch(/\bmx-auto\b/);

    const cell = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-0` });
    expect(cell.className).toMatch(/\btext-foreground\b/);
    expect(cell.className).not.toMatch(/\btext-white\b/);
  });

  it('under a coach route, clicking a cell navigates to the coach-prefixed Matchups destination', async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();

    renderMatrix(
      [makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })],
      {},
      '/coach/test-client/matchups',
    );

    await user.click(screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-0` }));

    const destination = mockNavigate.mock.calls[0]?.[0] as string;
    expect(destination).toBe(`/coach/test-client/matchups?fighter=${mario.id}&vs=${luigi.id}`);
  });

  // ---- plan 39.1-47 (matrix-sketch-a, sketch 003 A `matrixCard`, PD-47-5) ----

  it('matrix-sketch-a: the card header is the title "Matchup matrix" with the sketch meta line', () => {
    renderMatrix([makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })]);
    expect(screen.getByText('Matchup matrix')).toBeInTheDocument();
    expect(
      screen.getByText(
        'your mains × their characters · fill = win rate · pick a cell to re-scope this page',
      ),
    ).toBeInTheDocument();
  });

  it('matrix-sketch-a: each cell prints the record and a "rate · n" sub line (keeps its aria-label)', () => {
    renderMatrix([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
    ]);
    const cell = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 2-1` });
    expect(cell.querySelectorAll('span')).toHaveLength(2);
    expect(cell.querySelectorAll('span')[0]).toHaveTextContent('2-1');
    expect(cell.querySelectorAll('span')[1]).toHaveTextContent('67% · 3');
  });

  it('matrix-sketch-a: a cell at the 3-game floor is heat-filled in the identity blue scaled by win rate; a sub-floor cell has no heat and a 1px outline', () => {
    renderMatrix(
      [
        // 2-1 over 3 games: at the floor -> heat 8 + (2/3) x 50 = 41%.
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
        makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
        makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
        // 1-0 over 1 game: under the floor -> transparent, outlined.
        makeMatch({ id: 'm4', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
      ],
      { opponent: undefined },
    );
    const heated = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 2-1` });
    expect(heated.style.backgroundColor).toBe(
      'color-mix(in oklch, var(--viz-series-1) 41%, transparent)',
    );
    expect(heated.className).not.toMatch(/ring-border/);
    const sub = screen.getByRole('button', { name: `${mario.name} vs ${sonic.name}: 1-0` });
    expect(sub.style.backgroundColor).toBe('transparent');
    expect(sub.className).toMatch(/ring-1/);
    expect(sub.className).toMatch(/ring-border/);
  });

  it('matrix-sketch-a: no red / emerald heat anywhere — every cell background is the series token mix or transparent', () => {
    renderMatrix(
      [
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
        makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
        makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
        makeMatch({ id: 'm4', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
        makeMatch({ id: 'm5', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
        makeMatch({ id: 'm6', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
      ],
      { opponent: undefined },
    );
    for (const cell of screen.getAllByRole('button', { name: /vs .*: \d+-\d+$/ })) {
      expect(cell.style.backgroundColor).toMatch(
        /^color-mix\(in oklch, var\(--viz-series-1\) \d+%, transparent\)$/,
      );
      expect(cell.outerHTML).not.toMatch(/rgba?\(|emerald|destructive/);
    }
  });

  it('matrix-sketch-a: the effective pairing cell is aria-current with the foreground ring; no other cell is', () => {
    renderMatrix(
      [
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
        makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
      ],
      { fighter: mario, opponent: luigi },
    );
    const current = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-0` });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current.className).toMatch(/ring-foreground/);
    const other = screen.getByRole('button', { name: `${mario.name} vs ${sonic.name}: 1-0` });
    expect(other).not.toHaveAttribute('aria-current');
    expect(other.className).not.toMatch(/ring-foreground/);
  });

  it('matrix-sketch-a: with no effective pairing no cell is marked current', () => {
    renderMatrix(
      [makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })],
      { fighter: undefined, opponent: undefined },
    );
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('matrix-sketch-a: the column toggle is a muted link and the grid is a separated-spacing table', () => {
    const manyOpponents = SpriteList.slice(0, 15);
    renderMatrix(
      manyOpponents.map((opp, i) =>
        makeMatch({ id: `m${i}`, fighter_id: mario.id, opponent_id: opp.id, win: true }),
      ),
      { fighterSprites: [mario] },
    );
    const toggle = screen.getByRole('button', { name: /Show all 15/ });
    expect(toggle).toHaveAttribute('data-variant', 'link');
    expect(toggle.className).toMatch(/text-muted-foreground/);
    expect(screen.getByRole('table').className).toMatch(/border-separate/);
    expect(screen.getByRole('table').className).toMatch(/border-spacing-1/);
  });

  it('matrix-sketch-a: the sprites and the sticky row header are kept (PD-47-5)', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/matchups']}>
        <MatchupsContext.Provider
          value={{
            fighterSprites: [mario],
            fighter: mario,
            setFighter: vi.fn(),
            opponent: luigi,
            setOpponent: vi.fn(),
            fighterUsageById: new Map(),
            opponentUsage: [],
            drillDownAxes: {},
            setDrillDown: vi.fn(),
          }}
        >
          <MatchupMatrix
            matches={[
              makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
            ]}
          />
        </MatchupsContext.Provider>
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('table img').length).toBeGreaterThanOrEqual(2);
    const rowHeader = container.querySelector('tbody th[scope="row"]') as HTMLElement;
    expect(rowHeader.className).toMatch(/\bsticky\b/);
  });
});
