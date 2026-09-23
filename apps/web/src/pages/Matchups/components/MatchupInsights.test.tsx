import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { MatchupInsights } from './MatchupInsights';

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

/**
 * WR-02 regression: `MatchupInsights` reused the generic
 * `shared.evidence.abstained` sentence (with a fabricated `gamesNeeded: 0`)
 * for the worst-stage cell whenever a matchup's games sit entirely on ONE
 * qualifying stage — `getBestWorstStages` deliberately reports `worst: null`
 * in that case ("a single stage can't be both the recommendation and the
 * warning"), even though the query itself is fully evidenced. This produced
 * "Not enough data yet — 0 more games needed", which is both untrue (the
 * query isn't abstained) and impossible to act on (0 more games can never
 * satisfy a message that never resolves). Reachable any time a user has
 * recorded games against an opponent on only one stage — a common
 * early-tracking state.
 */

function renderInsights(matchupMatches: Match[]) {
  return render(
    <MemoryRouter initialEntries={['/matchups']}>
      <MatchupInsights matchupMatches={matchupMatches} />
    </MemoryRouter>,
  );
}

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const FINAL_DESTINATION = { id: 3, name: 'Final Destination' };

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

describe('MatchupInsights — WR-02 single-qualifying-stage worst-stage copy', () => {
  it('never renders "0 more game(s) needed" when the matchup is fully evidenced but only one stage qualifies', () => {
    // Three games on ONE stage — clears the default floor (3), so the
    // overall claim is 'evidenced', but only one stage qualifies, so
    // `getBestWorstStages` reports `best` = Battlefield, `worst` = null.
    const matches = matchesOnStage(BATTLEFIELD, 2, 1);
    renderInsights(matches);

    // The bug: this string must never appear.
    expect(screen.queryByText(/0 more games? needed/i)).not.toBeInTheDocument();
  });

  it('renders the dedicated "not enough distinct stages" copy for the worst-stage cell in the single-qualifying-stage case', () => {
    const matches = matchesOnStage(BATTLEFIELD, 2, 1);
    renderInsights(matches);

    expect(
      screen.getByText(
        'Not enough distinct stages yet — play this matchup on another stage to see a worst-stage warning.',
      ),
    ).toBeInTheDocument();
    // The best-stage cell still renders normally.
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
  });

  it('still renders the real abstained sentence (with a genuine gamesNeeded count) when the whole query is below the floor', () => {
    // Two games total — below the default floor of 3, so the OVERALL claim
    // is genuinely 'abstained' (not the single-stage case above).
    const matches = matchesOnStage(BATTLEFIELD, 1, 1);
    renderInsights(matches);

    expect(screen.getAllByText(/Not enough data yet — 1 more game needed\./)).toHaveLength(2);
  });

  it('renders both best and worst stage normally when two or more stages qualify', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 3, 0),
      ...matchesOnStage(FINAL_DESTINATION, 0, 3),
    ];
    renderInsights(matches);

    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.getByText('Final Destination')).toBeInTheDocument();
    expect(screen.queryByText(/not enough distinct stages/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/more games? needed/i)).not.toBeInTheDocument();
  });
});

describe('MatchupInsights — Min matches control placement (plan 39.1-30, item 6)', () => {
  it('the card header holds no combobox — the Min matches per stage control is not in [data-slot="card-header"]', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 3, 0),
      ...matchesOnStage(FINAL_DESTINATION, 3, 2),
    ];
    const { container } = renderInsights(matches);
    const header = container.querySelector('[data-slot="card-header"]');
    expect(header).not.toBeNull();
    expect(header!.querySelector('[role="combobox"]')).not.toBeInTheDocument();
  });

  it('the Min matches per stage select is labelled by a visible label, sits before the best/worst stage list, and changing it changes the best-stage line (same shared useMinStageMatches value)', async () => {
    const user = userEvent.setup();
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 3, 0), // exactly 3 games — drops out once threshold rises to 5
      ...matchesOnStage(FINAL_DESTINATION, 3, 2), // 5 games — qualifies at both thresholds
    ];
    const { container } = renderInsights(matches);

    const label = screen.getByText('Min matches per stage');
    const select = screen.getByRole('combobox', { name: 'Minimum matches per stage' });
    expect(label.tagName.toLowerCase()).toBe('label');
    expect(label.getAttribute('for')).toBe(select.id);

    // The control sits in the card BODY, before the best/worst stage list —
    // never in the header.
    const content = container.querySelector('[data-slot="card-content"]');
    expect(content).not.toBeNull();
    expect(content!.contains(select)).toBe(true);
    const bestHeading = screen.getByText('Best Stage');
    const bestHeadingFollowsSelect =
      select.compareDocumentPosition(bestHeading) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(bestHeadingFollowsSelect).not.toBe(0);

    expect(screen.getByText('Battlefield')).toBeInTheDocument();

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: '5' }));

    // Battlefield (3 games) no longer qualifies at the 5-game floor — only
    // Final Destination remains, which is the single-qualifying-stage case
    // (best-stage line shows Final Destination, worst shows the dedicated
    // "not enough distinct stages" copy).
    expect(screen.queryByText('Battlefield')).not.toBeInTheDocument();
    expect(screen.getByText('Final Destination')).toBeInTheDocument();
  });
});

describe('MatchupInsights — streak StatRow (plan 39.1-32, item 10)', () => {
  it('the streak block is one fixedColumns StatRow carrying grid-cols-3, with the three labels at the overline role', () => {
    const matches = matchesOnStage(BATTLEFIELD, 3, 0);
    const { container } = renderInsights(matches);
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
    // Newest-first: a win (id 'w1'), then a loss — current streak is 1 win.
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
