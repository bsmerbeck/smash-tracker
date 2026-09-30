import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
  layout?: 'table' | 'stack',
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
        <MatchupMatrix matches={matches} layout={layout} />
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

  it('matrix-sketch-a: the grid fills the card (w-full, 480px floor) and the sticky row header is narrow enough to leave room for columns on a phone', () => {
    renderMatrix([makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })]);
    const table = screen.getByRole('table');
    expect(table.className).toMatch(/\bw-full\b/);
    expect(table.className).toMatch(/min-w-\[480px\]/);
    expect(table.className).not.toMatch(/\bw-max\b/);
    const rowHeader = document.querySelector('tbody th[scope="row"]') as HTMLElement;
    expect(rowHeader.className).toMatch(/\bw-28\b/);
    expect(rowHeader.className).not.toMatch(/\bw-40\b/);
  });

  it('matrix-sketch-a: both cell lines are nowrap (the sketch .rec / .sub-l), so a wide record never wraps the rate line at 390', () => {
    renderMatrix([makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true })]);
    const cell = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-0` });
    for (const line of cell.querySelectorAll('span')) {
      expect(line.className).toMatch(/\bwhitespace-nowrap\b/);
    }
  });

  // ---- plan 39.1-48 (matrix-stacked-phone): the final gate enforces table-clip on Matchups ----
  // UI-SPEC 6.6 "< 640 tables become stacked rows": the 5-column matrix scrolled
  // 480-507px inside a 308px card at 390, which the all-route table-clip sweep
  // (enforced for Matchups from this plan) reports as a clipped table.

  describe('matrix-stacked-phone (plan 39.1-48)', () => {
    const lossesAndWins = [
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
      makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: sonic.id, win: true }),
      makeMatch({ id: 'm4', fighter_id: luigi.id, opponent_id: sonic.id, win: true }),
    ];

    it('layout="stack" renders no table: one labelled group per fighter of yours, one cell button per played pairing', () => {
      renderMatrix(lossesAndWins, {}, '/matchups', 'stack');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      const stack = document.querySelector('[data-slot="matchup-matrix-stack"]') as HTMLElement;
      expect(stack).not.toBeNull();
      const groups = within(stack).getAllByRole('group');
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([mario.name, luigi.name]);
      expect(within(groups[0]!).getAllByRole('button')).toHaveLength(2);
      expect(within(groups[1]!).getAllByRole('button')).toHaveLength(1);
    });

    it('a stacked cell keeps the aria label, the record, the rate line and the same ring / heat, and names its opponent on the cell', () => {
      renderMatrix(lossesAndWins, {}, '/matchups', 'stack');
      const cell = screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 1-1` });
      expect(cell).toHaveTextContent('1-1');
      expect(cell).toHaveTextContent('50% · 2');
      expect(cell).toHaveTextContent(luigi.name);
      expect(cell).toHaveAttribute('aria-current', 'true');
      expect(cell.className).toMatch(/\btext-foreground\b/);
      expect(cell.className).toMatch(/\bring-\[1\.5px\]/);
      // A different pairing under the 3-game floor (one game): outlined, not ringed.
      const other = screen.getByRole('button', { name: `${mario.name} vs ${sonic.name}: 1-0` });
      expect(other).not.toHaveAttribute('aria-current');
      expect(other.className).toMatch(/\bring-1\b/);
    });

    it('a stacked cell navigates exactly like a table cell', async () => {
      const user = userEvent.setup();
      mockNavigate.mockClear();
      renderMatrix(lossesAndWins, {}, '/matchups', 'stack');
      await user.click(screen.getByRole('button', { name: `${mario.name} vs ${sonic.name}: 1-0` }));
      expect(mockNavigate.mock.calls[0]?.[0]).toBe(`/matchups?fighter=${mario.id}&vs=${sonic.id}`);
    });

    it('the stack lays cells on a wrapping grid, never a horizontal scroller', () => {
      renderMatrix(lossesAndWins, {}, '/matchups', 'stack');
      const stack = document.querySelector('[data-slot="matchup-matrix-stack"]') as HTMLElement;
      expect(stack.innerHTML).not.toMatch(/overflow-x-(auto|scroll)/);
      const list = stack.querySelector('ul') as HTMLElement;
      expect(list.className).toMatch(/\bgrid\b/);
    });

    it('under a phone matchMedia the default layout is the stack; without matchMedia (jsdom) it is the table', () => {
      renderMatrix(lossesAndWins);
      expect(screen.getByRole('table')).toBeInTheDocument();
      cleanup();
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 639px)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }));
      try {
        renderMatrix(lossesAndWins);
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(document.querySelector('[data-slot="matchup-matrix-stack"]')).not.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('the stacked form keeps the show-all toggle and the empty state', async () => {
      const user = userEvent.setup();
      const many = SpriteList.slice(0, 15).map((opp, i) =>
        makeMatch({ id: `x${i}`, fighter_id: mario.id, opponent_id: opp.id, win: true }),
      );
      renderMatrix(many, { fighterSprites: [mario] }, '/matchups', 'stack');
      const stack = () => document.querySelector('[data-slot="matchup-matrix-stack"]')!;
      expect(within(stack() as HTMLElement).getAllByRole('button')).toHaveLength(12);
      await user.click(screen.getByRole('button', { name: /Show all 15/ }));
      expect(within(stack() as HTMLElement).getAllByRole('button')).toHaveLength(15);
    });
  });
});
