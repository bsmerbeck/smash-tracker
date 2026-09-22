import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { MatchWinLossCard } from './MatchWinLossCard';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/** N countable games, one per day, ending today — every game lands inside `last30`'s window and D-15's 12-month scoped-recency bound. */
function recentSequence(count: number, results?: boolean[]): Match[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, i) => {
    const win = results ? results[i % results.length]! : i % 3 !== 0;
    return makeMatch({ id: `m${i}`, time: now - (count - i) * dayMs, win });
  });
}

describe('MatchWinLossCard', () => {
  it('with an empty match array renders the existing record-empty string', () => {
    render(<MatchWinLossCard matchupMatches={[]} horizon="last30" />);
    expect(screen.getByText('No reported matches against this fighter')).toBeInTheDocument();
  });

  it('renders exactly one games figure and a lead win-rate figure with a delta chip beside it', () => {
    const matches = [
      makeMatch({ id: 'm1', win: true }),
      makeMatch({ id: 'm2', win: true }),
      makeMatch({ id: 'm3', win: false }),
    ];
    render(<MatchWinLossCard matchupMatches={matches} horizon="last30" />);

    // The games count (3) appears exactly once — as the games figure's
    // value. It must not also appear as a second, independent occurrence
    // elsewhere in the card's text (UIX-04: a figure is never stated twice).
    const gamesFigureValue = screen.getByText('3');
    expect(gamesFigureValue).toBeInTheDocument();

    expect(screen.getByText('67%')).toBeInTheDocument(); // lead win-rate figure
    expect(screen.getByText('2–1')).toBeInTheDocument(); // bare record figure
  });

  it('WR-C01: never mislabels the delta chip "Thin" when the recent window is locked below the abstention floor', () => {
    // Both matches use the default `time: 1000` (near epoch) -> outside the
    // 12-month D-15 scoped-recency bound relative to the real `Date.now()`,
    // so `recent.total` = 0 < ABSTENTION_FLOOR_GAMES(3): the honesty
    // ladder's `locked` state, a different tier than `thin`.
    const matches = [makeMatch({ id: 'm1', win: true }), makeMatch({ id: 'm2', win: false })];
    render(<MatchWinLossCard matchupMatches={matches} horizon="last30" />);

    expect(screen.queryByText('Thin')).not.toBeInTheDocument();
  });

  it('renders a full-width record bar and a mini strip of the recent window', () => {
    const { container } = render(
      <MatchWinLossCard matchupMatches={recentSequence(10)} horizon="last30" />,
    );
    expect(container.querySelector('[data-slot="record-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="mini-strip"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="mini-strip"] > span').length).toBe(10);
  });

  it("neither the card's root nor its stat row carries a stretch utility (flex-1/grow on a sibling column)", () => {
    const { container } = render(
      <MatchWinLossCard matchupMatches={recentSequence(5)} horizon="last30" />,
    );
    const root = container.querySelector('[data-slot="card"]') ?? container.firstElementChild;
    expect(root?.className ?? '').not.toMatch(/\bflex-1\b|\bgrow\b/);
  });
});
