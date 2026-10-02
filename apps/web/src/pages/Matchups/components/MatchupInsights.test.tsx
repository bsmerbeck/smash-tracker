import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MatchupInsights } from './MatchupInsights';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';

/**
 * `useMinStageMatches` is a no-op on write when unauthenticated
 * (`persistSelection`'s documented D-06 unauthenticated-no-persist
 * contract) — this file renders with no `AuthProvider` at all, matching
 * every other test here. Mocked to a plain in-memory `useState` (same
 * default, 3) so the reactivity test below can drive the control without
 * pulling in the whole auth/localStorage stack just to prove the select
 * and the best-stage line share one value.
 */
vi.mock('@/hooks/useMinStageMatches', () => ({
  useMinStageMatches: () => useState(3),
}));

const setDrillDownMock = vi.fn();

function contextValue(): MatchupsContextValue {
  return {
    fighterSprites: [],
    fighter: undefined,
    setFighter: vi.fn(),
    opponent: undefined,
    setOpponent: vi.fn(),
    fighterUsageById: new Map(),
    opponentUsage: [],
    drillDownAxes: {},
    setDrillDown: setDrillDownMock,
  };
}

function renderInsights(matchupMatches: Match[]) {
  return render(
    <MemoryRouter initialEntries={['/matchups']}>
      <TooltipProvider>
        <MatchupsContext.Provider value={contextValue()}>
          <MatchupInsights matchupMatches={matchupMatches} />
        </MatchupsContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const FINAL_DESTINATION = { id: 3, name: 'Final Destination' };
const POKEMON_STADIUM_2 = { id: 59, name: 'Pokémon Stadium 2' };
const SMASHVILLE = { id: 83, name: 'Smashville' };
const TOWN_AND_CITY = { id: 85, name: 'Town and City' };
const SMALL_BATTLEFIELD = { id: 113, name: 'Small Battlefield' };
const HOLLOW_BASTION = { id: 118, name: 'Hollow Bastion' };

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: BATTLEFIELD,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function matchesOnStage(
  stage: { id: number; name: string },
  wins: number,
  losses: number,
): Match[] {
  const result: Match[] = [];
  for (let i = 0; i < wins; i++) {
    result.push(makeMatch({ id: `${stage.name}-w${i}`, map: stage, win: true }));
  }
  for (let i = 0; i < losses; i++) {
    result.push(makeMatch({ id: `${stage.name}-l${i}`, map: stage, win: false }));
  }
  return result;
}

/** Sketch 003 DEEP (brief section 4): seven stages + 30 unstaged games, 64-38 overall (62.7%). */
function deepMatches(): Match[] {
  return [
    ...matchesOnStage(BATTLEFIELD, 12, 6),
    ...matchesOnStage(POKEMON_STADIUM_2, 11, 4),
    ...matchesOnStage(TOWN_AND_CITY, 9, 6),
    ...matchesOnStage(FINAL_DESTINATION, 5, 3),
    ...matchesOnStage(SMALL_BATTLEFIELD, 3, 5),
    ...matchesOnStage(SMASHVILLE, 4, 1),
    ...matchesOnStage(HOLLOW_BASTION, 2, 1),
    ...Array.from({ length: 18 }, (_, i) =>
      makeMatch({ id: `ns-w${i}`, map: undefined, win: true }),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      makeMatch({ id: `ns-l${i}`, map: undefined, win: false }),
    ),
  ];
}

/** The Best / Worst row labels as printed (the prefix sits in its own muted span, so getByText cannot match the whole). */
function labelTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="comparison-bar-label"]')).map(
    (node) => node.textContent ?? '',
  );
}

afterEach(() => {
  setDrillDownMock.mockClear();
});

describe('MatchupInsights — the rail card as sketch 003 A (plan 39.1-46, insights-card)', () => {
  it('insights-card: ONE top line — the Fact chip, "Matchup Insights · all time" and the confidence glyph — names the card region', () => {
    const { container } = renderInsights(deepMatches());
    const region = screen.getByRole('region', { name: 'Matchup Insights · all time' });
    expect(region).toBeInTheDocument();
    const top = within(region).getByText('Matchup Insights · all time').parentElement!;
    expect(within(top).getByText('Fact')).toBeInTheDocument();
    // 102 games: high confidence, exposed as the glyph's sentence.
    expect(
      within(top).getByRole('img', { name: 'high confidence, 102 games' }),
    ).toBeInTheDocument();
    // One top line: no separate card title / description block any more.
    expect(container.querySelector('[data-slot="card-header"]')).toBeNull();
    expect(screen.queryByText('Statistical inference from your recorded games.')).toBeNull();
    // Not mixed: no badge.
    expect(screen.queryByText('Mixed context')).not.toBeInTheDocument();
  });

  it('insights-card: the mixed-context badge joins the top line only when the cohort is mixed', () => {
    const mixed = [
      ...Array.from({ length: 9 }, (_, i) =>
        makeMatch({ id: `on${i}`, matchType: 'online-tourney', win: i % 2 === 0 }),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        makeMatch({ id: `off${i}`, matchType: 'offline-tourney', win: i % 2 === 0 }),
      ),
    ];
    renderInsights(mixed);
    const region = screen.getByRole('region', { name: 'Matchup Insights · all time' });
    expect(within(region).getByText('Mixed context')).toBeInTheDocument();
  });

  it('insights-card: no pip row, no By Match Type list, no coloured Best / Worst headings', () => {
    const { container } = renderInsights(deepMatches());
    expect(container.querySelector('[aria-label^="Last"]')).toBeNull();
    expect(screen.queryByText('Recent Form (newest first)')).not.toBeInTheDocument();
    expect(screen.queryByText('By Match Type')).not.toBeInTheDocument();
    expect(screen.queryByText('Best Stage')).not.toBeInTheDocument();
    expect(
      container.querySelector(
        '[class*="text-emerald"], [class*="text-destructive"], [class*="bg-emerald"], [class*="bg-destructive"]',
      ),
    ).toBeNull();
  });

  it('insights-card: the streak block is one fixedColumns StatRow — 3 figures, overline labels, no colour token', () => {
    const { container } = renderInsights(matchesOnStage(BATTLEFIELD, 3, 0));
    const statRow = container.querySelector('[data-slot="stat-row"][data-fixed-columns]');
    expect(statRow).not.toBeNull();
    expect((statRow as HTMLElement).className).toContain('grid-cols-3');
    const children = Array.from(statRow!.children) as HTMLElement[];
    expect(children).toHaveLength(3);
    const overlineClasses = [
      'text-[0.6875rem]',
      'leading-4',
      'font-semibold',
      'tracking-wider',
      'text-muted-foreground',
      'uppercase',
    ];
    const expectedLabels = ['Current Streak', 'Longest Win Streak', 'Longest Loss Streak'];
    children.forEach((child, i) => {
      const label = child.firstElementChild as HTMLElement;
      expect(label.textContent).toBe(expectedLabels[i]);
      for (const cls of overlineClasses) {
        expect(label.className).toContain(cls);
      }
    });
  });

  it('a single win after a loss renders the current streak as "1" with unit "win"; no streak element carries a colour token', () => {
    const matches = [
      makeMatch({ id: 'w1', time: 2000, win: true }),
      makeMatch({ id: 'l1', time: 1000, win: false }),
    ];
    const { container } = renderInsights(matches);
    const statRow = container.querySelector('[data-slot="stat-row"][data-fixed-columns]')!;
    const currentStreakFigure = statRow.children[0] as HTMLElement;
    expect(currentStreakFigure.textContent).toContain('1');
    expect(currentStreakFigure.textContent).toContain('win');
    expect(statRow.querySelector('.text-emerald-500')).toBeNull();
    expect(statRow.querySelector('.text-destructive')).toBeNull();
  });

  it('three straight newest losses render the current streak as "3" with unit "losses"', () => {
    const matches = [
      makeMatch({ id: 'l1', time: 3000, win: false }),
      makeMatch({ id: 'l2', time: 2000, win: false }),
      makeMatch({ id: 'l3', time: 1000, win: false }),
    ];
    const { container } = renderInsights(matches);
    const statRow = container.querySelector('[data-slot="stat-row"][data-fixed-columns]')!;
    const currentStreakFigure = statRow.children[0] as HTMLElement;
    expect(currentStreakFigure.textContent).toContain('3');
    expect(currentStreakFigure.textContent).toContain('losses');
    expect(statRow.querySelector('.text-emerald-500')).toBeNull();
    expect(statRow.querySelector('.text-destructive')).toBeNull();
  });
});

describe('MatchupInsights — Stages head, the threshold behind "change", Best / Worst rows (plan 39.1-46)', () => {
  it('insights-card: the stages head names the threshold and offers a "change" link; no select sits in the card until it is opened', async () => {
    const user = userEvent.setup();
    renderInsights(deepMatches());
    expect(screen.getByText('Stages · min 3 games')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'change' }));
    // The existing select, labelled by the visible label, now lives in the popover.
    const select = await screen.findByRole('combobox', { name: 'Min matches per stage' });
    expect(select).not.toHaveAttribute('aria-label');
    expect(screen.getByText('Min matches per stage').getAttribute('for')).toBe(select.id);
  });

  it('insights-card: changing the threshold in the popover re-ranks the rows (same shared useMinStageMatches value)', async () => {
    const user = userEvent.setup();
    const { container } = renderInsights([
      ...matchesOnStage(BATTLEFIELD, 3, 0), // exactly 3 games — drops out at a 5-game floor
      ...matchesOnStage(FINAL_DESTINATION, 3, 2), // 5 games — qualifies at both
    ]);
    expect(labelTexts(container)).toEqual(['Best · Battlefield', 'Worst · Final Destination']);

    await user.click(screen.getByRole('button', { name: 'change' }));
    await user.click(await screen.findByRole('combobox', { name: 'Min matches per stage' }));
    await user.click(await screen.findByRole('option', { name: '5' }));

    // Battlefield no longer qualifies: only Final Destination remains (the
    // single-qualifying-stage case).
    expect(labelTexts(container)).toEqual(['Best · Final Destination']);
    expect(screen.getByText('Stages · min 5 games')).toBeInTheDocument();
  });

  it('insights-card: deep data — Best = Smashville 4–1, Worst = Small Battlefield 3–5, both series rows against the 63% reference', () => {
    const { container } = renderInsights(deepMatches());
    const rows = Array.from(
      container.querySelectorAll('[data-slot="comparison-bars-series"] > li'),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Best · Smashville');
    expect(rows[0]!.textContent).toContain('4–1');
    expect(rows[1]!.textContent).toContain('Worst · Small Battlefield');
    expect(rows[1]!.textContent).toContain('3–5');
    const ticks = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-reference"]');
    expect(ticks).toHaveLength(2);
    expect(parseFloat(ticks[0]!.style.left)).toBeCloseTo(62.7, 1);
    // The prefix is meta-toned, the stage name is not; the title carries the whole label.
    const label = rows[0]!.querySelector<HTMLElement>('[data-slot="comparison-bar-label"]')!;
    expect(label.getAttribute('title')).toBe('Best · Smashville');
    expect(within(label).getByText('Best ·', { exact: false }).className).toContain(
      'text-muted-foreground',
    );
  });

  it('insights-card: each Best / Worst row is a stage drill', async () => {
    const user = userEvent.setup();
    const anchor = document.createElement('div');
    anchor.id = MATCHUP_TABLE_ANCHOR_ID;
    document.body.appendChild(anchor);
    renderInsights(deepMatches());
    await user.click(screen.getByRole('button', { name: /Best ·\s*Smashville/ }));
    expect(setDrillDownMock).toHaveBeenLastCalledWith({ stageId: 83 });
    await user.click(screen.getByRole('button', { name: /Worst ·\s*Small Battlefield/ }));
    expect(setDrillDownMock).toHaveBeenLastCalledWith({ stageId: 113 });
    anchor.remove();
  });

  it('insights-card: the unstaged games are disclosed as one muted line', () => {
    renderInsights(deepMatches());
    expect(screen.getByText('Unknown (30 games, excluded)')).toBeInTheDocument();
  });

  it('WR-02: never renders "0 more game(s) needed" when fully evidenced but only one stage qualifies', () => {
    renderInsights(matchesOnStage(BATTLEFIELD, 2, 1));
    expect(screen.queryByText(/0 more games? needed/i)).not.toBeInTheDocument();
  });

  it('WR-02: the dedicated "not enough distinct stages" copy stands in for the Worst row, the Best row renders normally', () => {
    const { container } = renderInsights(matchesOnStage(BATTLEFIELD, 2, 1));
    expect(
      screen.getByText(
        'Not enough distinct stages yet — play this matchup on another stage to see a worst-stage warning.',
      ),
    ).toBeInTheDocument();
    expect(labelTexts(container)).toEqual(['Best · Battlefield']);
  });

  it('thin data: the abstained sentence renders ONCE (not per cell), with its genuine gamesNeeded count, and the unstaged line follows', () => {
    const { container } = renderInsights([
      ...matchesOnStage(BATTLEFIELD, 1, 1),
      makeMatch({ id: 'n1', map: undefined }),
      makeMatch({ id: 'n2', map: undefined }),
    ]);
    expect(screen.getAllByText(/Not enough data yet — 1 more game needed\./)).toHaveLength(1);
    expect(container.querySelector('[data-slot="comparison-bars-series"]')).toBeNull();
    expect(screen.getByText('Unknown (2 games, excluded)')).toBeInTheDocument();
  });

  it('renders the empty copy and no stage section for a pairing with no games', () => {
    const { container } = renderInsights([]);
    expect(screen.getByText('No matches recorded for this matchup yet.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="comparison-bars-series"]')).toBeNull();
    expect(screen.queryByText(/^Stages ·/)).not.toBeInTheDocument();
  });
});
