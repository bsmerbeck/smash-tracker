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

  it.each(['last30', 'last90'] as const)(
    'plan 39.1-53 (UAT 39.1-17): a demo-shaped 8-game account states no rating direction at %s',
    (horizon) => {
      const outcomes = [true, true, false, true, true, false, true, true];
      const matches = outcomes.map((win, i) =>
        makeMatch({ id: `d${i}`, time: NOW - (8 - i) * 3 * 60 * 60 * 1000, win }),
      );
      render(<TrendsHero matches={matches} horizon={horizon} />);
      const ratingFigure = screen.getByText('Rating').parentElement as HTMLElement;
      const chip = ratingFigure.querySelector('[data-slot="delta-chip"]');
      expect(['up', 'down']).not.toContain(chip?.getAttribute('data-state'));
      expect(ratingFigure.textContent).not.toMatch(/[+\u2212]\d+/);
    },
  );

  it('renders the sessions figure with an average-games support line', () => {
    const matches = Array.from({ length: 6 }, (_, i) =>
      makeMatch({ id: `g${i}`, time: NOW - (6 - i) * 4 * 60 * 60 * 1000, win: true }),
    );
    render(<TrendsHero matches={matches} horizon="last30" />);

    expect(screen.getByText(/games avg/)).toBeInTheDocument();
  });

  describe('plan 39.1-36 (honest-none-chip): the win-rate chip states its horizon and never a direction below the floor', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function winRateFigure(): HTMLElement {
      return screen.getByText('Win rate').parentElement as HTMLElement;
    }

    it("a 60-game window inside the baseline interval reads 'Steady · last 30'", () => {
      // 60 older games at 50% and 60 recent games at 50%: last 30 sits inside
      // the baseline interval and 30 < 60% of 120, so the state is steady.
      const matches = [
        ...Array.from({ length: 60 }, (_, i) =>
          makeMatch({ id: `o${i}`, time: NOW - (400 + i) * DAY_MS, win: i % 2 === 0 }),
        ),
        ...Array.from({ length: 60 }, (_, i) =>
          makeMatch({ id: `r${i}`, time: NOW - (60 - i) * DAY_MS, win: i % 2 === 0 }),
        ),
      ];
      render(<TrendsHero matches={matches} horizon="last30" />);
      const chip = winRateFigure().querySelector('[data-slot="delta-chip"]')!;
      expect(chip.getAttribute('data-state')).toBe('steady');
      expect(chip.getAttribute('data-recent-games')).toBe('30');
      expect(chip.textContent).toBe('steady· last 30');
    });

    it("the rating chip never labels a rating move with 'pts' (sketch 002-C chipRating)", () => {
      const matches = [
        ...Array.from({ length: 60 }, (_, i) =>
          makeMatch({ id: `o${i}`, time: NOW - (400 + i) * DAY_MS, win: true }),
        ),
        ...Array.from({ length: 30 }, (_, i) =>
          makeMatch({ id: `r${i}`, time: NOW - (30 - i) * DAY_MS, win: false }),
        ),
      ];
      render(<TrendsHero matches={matches} horizon="last30" />);
      const ratingFigure = screen.getByText('Rating').parentElement as HTMLElement;
      const chip = ratingFigure.querySelector('[data-slot="delta-chip"]');
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute('data-state')).toBe('down');
      expect(chip!.textContent).toMatch(/^\u2212\d+· last 30$/);
    });

    it('an empty last-90-days window on a stale account reads "no games · last 90 days"', () => {
      const matches = Array.from({ length: 40 }, (_, i) =>
        makeMatch({ id: `s${i}`, time: NOW - (400 + i) * DAY_MS, win: i % 2 === 0 }),
      );
      render(<TrendsHero matches={matches} horizon="last90" />);
      const chip = winRateFigure().querySelector('[data-slot="delta-chip"]');
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute('data-state')).toBe('none');
      expect(chip!.textContent).toBe('no games· last 90 days');
    });

    it('a 5-game last-90-days window reads "n 5 · no direction", never a direction', () => {
      const matches = [
        ...Array.from({ length: 40 }, (_, i) =>
          makeMatch({ id: `s${i}`, time: NOW - (400 + i) * DAY_MS, win: false }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeMatch({ id: `n${i}`, time: NOW - (5 - i) * DAY_MS, win: true }),
        ),
      ];
      render(<TrendsHero matches={matches} horizon="last90" />);
      const chip = winRateFigure().querySelector('[data-slot="delta-chip"]')!;
      expect(chip.getAttribute('data-state')).toBe('thin');
      expect(chip.textContent).toBe('n 5 · no direction');
    });
  });

  it('carries no stretch utility on its card root (UIX-04)', () => {
    const { container } = render(<TrendsHero matches={[]} horizon="last30" />);
    const cardRoot = container.querySelector('[data-slot="card"]');
    expect(cardRoot?.className).not.toMatch(/\bh-full\b/);
    expect(cardRoot?.className).not.toMatch(/\bflex-1\b/);
  });

  // Plan 39.1-38: sketch 002-C `.statrow.kpi .lead{grid-column:1/-1}` — the ONE
  // StatRow whose lead spans both phone columns.
  it('plan 39.1-38: the KPI StatRow opts into the phone lead span (data-lead-span)', () => {
    const { container } = render(<TrendsHero matches={[]} horizon="last30" />);
    const statRow = container.querySelector('[data-slot="stat-row"]');
    expect(statRow).not.toBeNull();
    expect(statRow).toHaveAttribute('data-lead-span', '');
  });
});
