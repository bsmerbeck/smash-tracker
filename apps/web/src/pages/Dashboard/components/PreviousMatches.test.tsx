import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { matchesDrillDown } from '@/lib/drillDownParams';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';
import { PreviousMatches } from './PreviousMatches';

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/useDeleteMatch', () => ({
  useDeleteMatch: () => ({ mutateAsync }),
}));

const falco = SpriteList.find((s) => s.name === 'Falco')!;
const mario = SpriteList.find((s) => s.name === 'Mario')!;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: falco.id,
    opponent_id: mario.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderList(matches: Match[], horizon: HorizonKey, entry = '/dashboard') {
  const value: DashboardContextValue = {
    fighterSprites: [falco],
    fighter: falco,
    setFighter: () => {},
  };
  const element = (
    <DashboardContext.Provider value={value}>
      <PreviousMatches matches={matches} horizon={horizon} />
    </DashboardContext.Provider>
  );
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/dashboard" element={element} />
        <Route path="/coach/:clientId/dashboard" element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 50 of Falco's games, one a day ending yesterday, newest a win; the ids sort by age. */
function fiftyGames(): Match[] {
  const now = Date.now();
  return Array.from({ length: 50 }, (_, i) =>
    makeMatch({
      id: `g${String(i).padStart(2, '0')}`,
      time: now - (i + 1) * DAY_MS,
      win: i % 2 === 0,
      ...(i % 3 === 0 ? { source: 'startgg' as const } : {}),
    }),
  );
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="previous-match-row"]'));
}

function queryObject(href: string): Record<string, string> {
  const [path, rest = ''] = href.split('?');
  const [query = '', hash = ''] = rest.split('#');
  return {
    path: path ?? '',
    hash,
    ...Object.fromEntries(new URLSearchParams(query)),
  };
}

beforeEach(() => {
  mutateAsync.mockClear();
});

describe('PreviousMatches (plan 39.1-50, OOS-12b: the page horizon, the kit list, no card control)', () => {
  it('renders no select or combobox in the card', () => {
    const { container } = renderList(fiftyGames(), 'last30');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('select, [data-slot="select-trigger"]')).toBeNull();
    expect(screen.queryByText('Limit')).toBeNull();
  });

  it('last30 on 50 games: 8 rows newest first, then Show all 30', () => {
    const games = fiftyGames();
    const { container } = renderList(games, 'last30');
    const shown = rows(container);
    expect(shown).toHaveLength(8);
    expect(shown.map((row) => row.getAttribute('data-match-id'))).toEqual(
      games.slice(0, 8).map((game) => game.id),
    );
    expect(screen.getByRole('button', { name: 'Show all 30' })).toBeInTheDocument();
  });

  it('Show all 30 expands to 25 rows and a terminus that opens exactly the 30 windowed games', async () => {
    const games = fiftyGames();
    const { container } = renderList(games, 'last30');
    await userEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
    expect(rows(container)).toHaveLength(25);
    const terminus = screen.getByRole('link', { name: 'All 30 games →' });
    const href = terminus.getAttribute('href')!;
    expect(queryObject(href)).toEqual({
      path: '/fighter-analysis',
      hash: 'games',
      fighter: String(falco.id),
      from: String(games[29]!.time),
      to: String(games[0]!.time),
    });
  });

  it('keeps the coach prefix on the terminus under a coach subject', async () => {
    renderList(fiftyGames(), 'last30', '/coach/client-7/dashboard');
    await userEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
    const href = screen.getByRole('link', { name: /games →$/ }).getAttribute('href')!;
    expect(href.startsWith('/coach/client-7/fighter-analysis?')).toBe(true);
  });

  it("the terminus N counts a tie at the window's oldest edge — exactly what matchesDrillDown selects", async () => {
    const games = fiftyGames();
    const oldestInWindow = games[29]!;
    const tie = makeMatch({ id: 'tie', time: oldestInWindow.time, win: true });
    const all = [...games, tie];
    renderList(all, 'last30');
    await userEvent.click(screen.getByRole('button', { name: /^Show all/ }));
    const link = screen.getByRole('link', { name: /games →$/ });
    const q = queryObject(link.getAttribute('href')!);
    const opened = all.filter((m) =>
      matchesDrillDown(m, { fighterId: Number(q.fighter), from: Number(q.from), to: Number(q.to) }),
    );
    expect(opened).toHaveLength(31);
    expect(link).toHaveTextContent('All 31 games →');
  });

  it('last90 with 12 games inside 90 days: 8 rows, Show all 12, expands inline with no terminus', async () => {
    const now = Date.now();
    const games = [
      ...Array.from({ length: 12 }, (_, i) =>
        makeMatch({ id: `n${i}`, time: now - (i + 1) * 5 * DAY_MS, win: true }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        makeMatch({ id: `o${i}`, time: now - (200 + i) * DAY_MS, win: false }),
      ),
    ];
    const { container } = renderList(games, 'last90');
    expect(rows(container)).toHaveLength(8);
    await userEvent.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(rows(container)).toHaveLength(12);
    expect(screen.queryByRole('link', { name: /games →$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });

  it('last90 with no game inside 90 days but older games: the window-empty line', () => {
    const now = Date.now();
    const games = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `o${i}`, time: now - (200 + i) * DAY_MS, win: false }),
    );
    const { container } = renderList(games, 'last90');
    expect(rows(container)).toHaveLength(0);
    expect(screen.getByText('No games in the last 90 days.')).toBeInTheDocument();
  });

  it('a fighter with no games keeps the empty-account line', () => {
    renderList([], 'last30');
    expect(screen.getByText('No matches recorded yet.')).toBeInTheDocument();
  });

  it('rows use the kit look: no row box, a 6 px mark beside a foreground result word, one truncating pairing slot, a meta line', () => {
    const games = fiftyGames();
    const { container } = renderList(games, 'last30');
    const shown = rows(container);
    expect(shown.length).toBeGreaterThan(1);
    shown.forEach((row, i) => {
      const game = games[i]!;
      expect(row.className).not.toMatch(/\bborder\b|\brounded-md\b/);
      const mark = row.querySelector('[data-slot="previous-match-mark"]') as HTMLElement;
      expect(mark).not.toBeNull();
      expect(mark).toHaveAttribute('aria-hidden', 'true');
      expect(mark.className).toMatch(/\bsize-1\.5\b/);
      const expected = game.win ? CHART_TOKENS.win : CHART_TOKENS.loss;
      expect(mark.getAttribute('style') ?? '').toContain(expected);
      const result = row.querySelector('[data-slot="previous-match-result"]') as HTMLElement;
      expect(result.textContent).toBe(game.win ? 'Win' : 'Loss');
      expect(result.className).not.toMatch(/text-emerald-500|text-destructive/);
      const pairing = row.querySelector('[data-slot="previous-match-pairing"]') as HTMLElement;
      expect(pairing.className).toMatch(/\bmin-w-0\b/);
      expect(pairing.className).toMatch(/\btruncate\b/);
      expect(pairing.textContent).toBe('Falco vs Mario');
      expect(pairing).toHaveAttribute('title', 'Falco vs Mario');
      const meta = row.querySelector('[data-slot="previous-match-meta"]') as HTMLElement;
      expect(meta.textContent).toContain('Battlefield');
      const date = new Date(game.time).toLocaleDateString('en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      expect(meta.textContent).toContain(date);
    });
  });

  // Plan 39.1-50 Task 3 (DEFECT found on the after capture): the 32 px
  // delete button grew its row past the 20 px text line, so manual and
  // synced rows had different heights. Its negative block margin keeps the
  // row on the text line's height.
  it('the delete button never grows its row past the text line (negative block margin)', () => {
    const games = fiftyGames();
    const { container } = renderList(games, 'last30');
    const buttons = Array.from(container.querySelectorAll('[aria-label="Delete match"]'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.className).toMatch(/(^|\s)-my-1\.5(\s|$)/);
  });

  it('the delete action renders only for a manual game, and confirming deletes that id', async () => {
    const games = fiftyGames();
    const { container } = renderList(games, 'last30');
    const shown = rows(container);
    shown.forEach((row, i) => {
      const button = within(row).queryByRole('button', { name: 'Delete match' });
      if (games[i]!.source) expect(button).toBeNull();
      else expect(button).not.toBeNull();
    });
    const manualIndex = games.findIndex((game) => !game.source);
    await userEvent.click(
      within(shown[manualIndex]!).getByRole('button', { name: 'Delete match' }),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(mutateAsync).toHaveBeenCalledWith(games[manualIndex]!.id);
  });
});
