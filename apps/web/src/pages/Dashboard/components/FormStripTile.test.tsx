import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';
import { FormStripTile } from './FormStripTile';

const falco = SpriteList.find((s) => s.name === 'Falco')!;
const mario = SpriteList.find((s) => s.name === 'Mario')!;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: falco.id,
    opponent_id: mario.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'Rival',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

/** `count` of Falco's manual games, one a day (each its own session-set), ending `endDaysAgo` days ago. */
function dailyGames(count: number, endDaysAgo = 1): Match[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) =>
    makeMatch({
      id: `g${String(i).padStart(3, '0')}`,
      time: now - (endDaysAgo + (count - 1 - i)) * DAY_MS,
      win: i % 2 === 0,
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</p>;
}

function renderTile({
  matches,
  horizon = 'last30',
  entry = '/dashboard',
}: {
  matches: Match[];
  horizon?: HorizonKey;
  entry?: string;
}) {
  const value: DashboardContextValue = {
    fighterSprites: [falco],
    fighter: falco,
    setFighter: () => {},
  };
  const element = (
    <DashboardContext.Provider value={value}>
      <FormStripTile matches={matches} horizon={horizon} />
      <LocationProbe />
    </DashboardContext.Provider>
  );
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/dashboard" element={element} />
        <Route path="/coach/:clientId/dashboard" element={element} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function ticks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="form-strip-tick"]'));
}

function dimmed(tick: HTMLElement): boolean {
  return tick.style.opacity === '0.32';
}

describe('FormStripTile', () => {
  it('draws at most 30 ticks of a 45-game fighter and states the shown-of foot', () => {
    const { container } = renderTile({ matches: dailyGames(45) });

    expect(ticks(container).length).toBeGreaterThan(0);
    expect(ticks(container).length).toBeLessThanOrEqual(30);
    expect(container.querySelector('[data-slot="form-strip-shown-of-total"]')).toHaveTextContent(
      '30 of 45 games shown',
    );
    expect(screen.getByRole('group', { name: 'Form strip, 30 of 45 games' })).toBeInTheDocument();
  });

  it('heads the strip with the overline, the swatch legend and no headline figure', () => {
    const { container } = renderTile({ matches: dailyGames(12) });

    expect(container.querySelector('[data-slot="form-strip-overline"]')).toHaveTextContent(
      'Form · last 30 games',
    );
    expect(container.querySelectorAll('[data-slot="form-strip-legend-item"]')).toHaveLength(4);
    // The tile hosts the strip only: no stat figure, no card title.
    expect(container.querySelector('[data-slot="card-header"]')).toBeNull();
    expect(container.querySelector('[data-slot="stat-figure"]')).toBeNull();
  });

  it('puts the record of the drawn games and the set count on one support line', () => {
    // 12 games, one a day, i % 2 === 0 wins: 6-6 across 12 sets.
    const { container } = renderTile({ matches: dailyGames(12) });

    const support = container.querySelector('[data-slot="form-strip-support"]');
    expect(support).not.toBeNull();
    expect(support).toHaveTextContent('6–6');
    expect(support).toHaveTextContent('12 sets');
  });

  it('states the support record over the games actually drawn, not all of the fighter’s games', () => {
    // 45 games a day apart, wins on even indexes: the newest 30 are indexes 15..44 — 15 wins, 15 losses.
    const { container } = renderTile({ matches: dailyGames(45) });

    const support = container.querySelector('[data-slot="form-strip-support"]')!;
    expect(support).toHaveTextContent('15–15');
    expect(support).toHaveTextContent('30 sets');
  });

  it('keeps the strip identical across horizons and only dims the games outside the highlight', () => {
    // 10 games a day ending 100 days ago (outside last 90) + 5 games ending yesterday.
    const matches = [
      ...dailyGames(10, 100),
      ...dailyGames(5, 1).map((m) => ({ ...m, id: `n${m.id}` })),
    ];

    const last30 = renderTile({ matches, horizon: 'last30' });
    const last30Ticks = ticks(last30.container);
    expect(last30Ticks).toHaveLength(15);
    expect(last30Ticks.some(dimmed)).toBe(false);
    last30.unmount();

    const last90 = renderTile({ matches, horizon: 'last90' });
    const last90Ticks = ticks(last90.container);
    expect(last90Ticks).toHaveLength(15);
    expect(last90Ticks.filter(dimmed)).toHaveLength(10);
    expect(last90.container.querySelector('[data-slot="form-strip-overline"]')).toHaveTextContent(
      'Form · last 30 games, last 90 days highlighted',
    );
    expect(last90.container.querySelector('[data-slot="form-strip-window-note"]')).toBeNull();
  });

  it('lastEvent emphasises the last event’s games and dims the rest', () => {
    const now = Date.now();
    const matches = [
      ...dailyGames(4, 20),
      makeMatch({ id: 'e1', time: now - DAY_MS, win: true, tournamentName: 'Genesis' }),
      makeMatch({ id: 'e2', time: now - DAY_MS + 60_000, win: false, tournamentName: 'Genesis' }),
    ];

    const { container } = renderTile({ matches, horizon: 'lastEvent' });

    const all = ticks(container);
    expect(all).toHaveLength(6);
    expect(all.filter((tick) => !dimmed(tick))).toHaveLength(2);
    expect(container.querySelector('[data-slot="form-strip-overline"]')).toHaveTextContent(
      'Form · last 30 games, last event highlighted',
    );
  });

  it('window-empty: every tick is dimmed and the foot says why', () => {
    // No game within the last 90 days: the highlight is empty but the strip keeps its games.
    const { container } = renderTile({ matches: dailyGames(6, 200), horizon: 'last90' });

    const all = ticks(container);
    expect(all).toHaveLength(6);
    expect(all.every(dimmed)).toBe(true);
    expect(container.querySelector('[data-slot="form-strip-window-note"]')).toHaveTextContent(
      'No games in the last 90 days — the last 30 shown, none highlighted.',
    );
  });

  it('1 game: one real tick and the singular aria', () => {
    const { container } = renderTile({ matches: dailyGames(1) });

    expect(ticks(container)).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Form strip, 1 of 1 game' })).toBeInTheDocument();
  });

  it('empty: names the fighter, renders the overline, and no strip, legend or group', () => {
    const { container } = renderTile({
      matches: [makeMatch({ id: 'x', time: Date.now(), win: true, fighter_id: mario.id })],
    });

    expect(screen.getByText('No games for Falco in this view yet.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="form-strip-overline"]')).toHaveTextContent(
      'Form · last 30 games',
    );
    expect(ticks(container)).toHaveLength(0);
    expect(container.querySelector('[data-slot="form-strip-legend-item"]')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('only the selected fighter’s games are drawn', () => {
    const matches = [
      ...dailyGames(3),
      makeMatch({ id: 'other', time: Date.now(), win: true, fighter_id: mario.id }),
    ];
    const { container } = renderTile({ matches });

    expect(ticks(container)).toHaveLength(3);
  });

  it('a set is the tab stop and ticks are not', () => {
    const { container } = renderTile({ matches: dailyGames(4) });

    const sets = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]'));
    expect(sets).toHaveLength(4);
    for (const set of sets) {
      expect(set).toHaveAttribute('tabindex', '0');
    }
    for (const tick of ticks(container)) {
      expect(tick).not.toHaveAttribute('tabindex');
    }
  });

  it('clicking a set opens exactly its games in Fighter Analysis #games', async () => {
    const user = userEvent.setup();
    const { container } = renderTile({ matches: dailyGames(4) });

    const sets = container.querySelectorAll('[data-slot="form-strip-set"]');
    await user.click(sets[sets.length - 1]!);

    const location = screen.getByTestId('location').textContent!;
    expect(location.startsWith('/fighter-analysis?')).toBe(true);
    expect(location.endsWith('#games')).toBe(true);
    const params = new URLSearchParams(location.split('?')[1]!.split('#')[0]);
    expect(params.get('fighter')).toBe(String(falco.id));
    expect(params.get('event')).toMatch(/^manual-session:/);
  });

  it('keeps the coach prefix on the drill under a coach subject', async () => {
    const user = userEvent.setup();
    const { container } = renderTile({
      matches: dailyGames(4),
      entry: '/coach/client-7/dashboard',
    });

    await user.click(container.querySelector('[data-slot="form-strip-set"]')!);

    expect(
      screen.getByTestId('location').textContent!.startsWith('/coach/client-7/fighter-analysis?'),
    ).toBe(true);
  });
});
