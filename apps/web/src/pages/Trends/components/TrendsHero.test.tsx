import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { TrendsHero } from './TrendsHero';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const NOW = Date.now();

describe('TrendsHero', () => {
  it('renders exactly five figures with the win-rate lead figure first, on an empty account', () => {
    render(<TrendsHero matches={[]} horizon="last30" />);

    expect(screen.getByText('Win rate')).toBeInTheDocument();
    expect(screen.getByText('Rating')).toBeInTheDocument();
    expect(screen.getByText('Peak Rating')).toBeInTheDocument();
    expect(screen.getByText('Best Month')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    // Win rate is locked below the abstention floor (0 games).
    expect(screen.getByText('3 more games unlock this read.')).toBeInTheDocument();
  });

  it('renders the win-rate figure first among the five StatFigures (large-figure lead role)', () => {
    const matches = Array.from({ length: 40 }, (_, i) =>
      makeMatch({ id: `g${i}`, time: NOW - i * 60_000, win: i % 2 === 0 }),
    );
    const { container } = render(<TrendsHero matches={matches} horizon="last30" />);
    const labels = [...container.querySelectorAll('[class*="uppercase"]')].map(
      (n) => n.textContent,
    );
    expect(labels[0]).toBe('Win rate');
  });

  it('collapses the win-rate figure to one value with no delta chip when the recent horizon is (almost) the whole record', () => {
    // 10 games, all within the last30 window -> recent/baseline ratio hits
    // the 60% collapse threshold (recent === baseline here).
    const matches = Array.from({ length: 10 }, (_, i) =>
      makeMatch({ id: `g${i}`, time: NOW - i * 60_000, win: true }),
    );
    render(<TrendsHero matches={matches} horizon="last30" />);

    expect(screen.getByText('= all games')).toBeInTheDocument();
    expect(screen.getByText('10 of 10 games')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders the best-month figure as an em dash with its unlock caption and no percent sign when no month reaches the minimum', () => {
    // 3 games, all in the same month -> below BEST_MONTH_MIN_GAMES (5).
    const matches = [
      makeMatch({ id: 'm1', time: Date.UTC(2021, 0, 1), win: true }),
      makeMatch({ id: 'm2', time: Date.UTC(2021, 0, 2), win: true }),
      makeMatch({ id: 'm3', time: Date.UTC(2021, 0, 3), win: false }),
    ];
    render(<TrendsHero matches={matches} horizon="last30" />);

    expect(screen.getByText('Needs a month with 5+ games')).toBeInTheDocument();
    const bestMonthLabel = screen.getByText('Best Month');
    const card = bestMonthLabel.closest('div');
    expect(card?.textContent).not.toMatch(/%/);
    expect(card?.textContent).toMatch(/—/);
  });

  it('renders a real best-month read once a month clears the minimum', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `jan-${i}`, time: Date.UTC(2021, 0, i + 1), win: true }),
    );
    render(<TrendsHero matches={matches} horizon="last30" />);

    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText(/Jan 2021/)).toBeInTheDocument();
  });

  it('WR-C01: never mislabels the rating delta chip "Thin" when ratingMove is locked below the abstention floor', () => {
    // 2 total games -> `ratingMoveTemplate`'s own `resolveWindow` call is
    // unscoped (no 12-month bound), so `last30` takes the last min(total,30)
    // games — here, both of them: recent.total(2) < ABSTENTION_FLOOR_GAMES(3),
    // the honesty ladder's `locked` state (a different tier than `thin`).
    // `computeRatingHistory` still unlocks the hero's own rating figure at 1+
    // game, so this exercises the `!hero.currentRating` FALSE branch.
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: false }),
    ];
    render(<TrendsHero matches={matches} horizon="last30" />);

    const ratingCard = screen.getByText('Rating').closest('div') as HTMLElement;
    expect(within(ratingCard).queryByText('Thin')).not.toBeInTheDocument();
  });

  it('renders the rating figure with a muted RD suffix once the rating curve unlocks', () => {
    const matches = Array.from({ length: 8 }, (_, i) =>
      makeMatch({ id: `g${i}`, time: NOW - (8 - i) * 3 * 60 * 60 * 1000, win: i % 2 === 0 }),
    );
    render(<TrendsHero matches={matches} horizon="last30" />);

    expect(screen.getByText('Rating')).toBeInTheDocument();
    expect(screen.getByText(/^±\d+$/)).toBeInTheDocument();
  });

  it('renders the sessions figure with an average-games support line', () => {
    const matches = Array.from({ length: 6 }, (_, i) =>
      makeMatch({ id: `g${i}`, time: NOW - (6 - i) * 4 * 60 * 60 * 1000, win: true }),
    );
    render(<TrendsHero matches={matches} horizon="last30" />);

    expect(screen.getByText(/games avg/)).toBeInTheDocument();
  });

  it('carries no stretch utility on its card root (UIX-04)', () => {
    const { container } = render(<TrendsHero matches={[]} horizon="last30" />);
    const cardRoot = container.querySelector('[data-slot="card"]');
    expect(cardRoot?.className).not.toMatch(/\bh-full\b/);
    expect(cardRoot?.className).not.toMatch(/\bflex-1\b/);
  });
});
