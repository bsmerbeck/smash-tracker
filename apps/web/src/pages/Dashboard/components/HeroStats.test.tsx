import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { HeroStats } from './HeroStats';

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

const DAY_MS = 24 * 60 * 60 * 1000;

describe('HeroStats', () => {
  it('renders the account-wide overall record as a win-rate lead with its record as the support line (UIX-04)', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    const overallCard = screen
      .getByText('Overall Record')
      .closest('[data-slot="card"]') as HTMLElement;
    // The record primitive's en-dash format is the ONE record everywhere
    // (UIX-04) — never the old bespoke hyphenated "2-1" string.
    expect(within(overallCard).getByText('2–1')).toBeInTheDocument();
    expect(within(overallCard).queryByText('2-1')).not.toBeInTheDocument();
    // The win rate is the LARGE lead figure (StatFigure's own value role);
    // "67%" ALSO appears once more inside the Record support line's own
    // rate segment (the same established pairing `FighterHero.tsx`'s
    // all-time figure uses) — assert the lead specifically by its role class.
    const leadValue = overallCard.querySelector('.text-\\[1\\.75rem\\]');
    expect(leadValue?.textContent).toBe('67%');
    expect(within(overallCard).queryByText('3 games')).not.toBeInTheDocument();
    expect(within(overallCard).getByText('3')).toBeInTheDocument();
  });

  it('shows an empty state for the overall record when there are no matches', () => {
    render(<HeroStats matches={[]} timeFilteredMatches={[]} />);

    expect(screen.getAllByText('No match data to report yet.').length).toBeGreaterThan(0);
  });

  it('renders a delta chip with a genuine recent-vs-baseline trend, under the active horizon', () => {
    const now = Date.now();
    // 30 older losses (well outside the last-30-games window) + 30 recent
    // wins (all inside the 12-month scoped-recency floor) — baseline sits at
    // 50%, recent at 100%, and recent.total(30) stays below
    // HORIZON_COLLAPSE_RATIO(0.6) * baseline.total(60) = 36, so this
    // genuinely asserts a direction rather than collapsing.
    const older = Array.from({ length: 30 }, (_, i) =>
      makeMatch({ id: `o${i}`, time: now - (200 + i) * DAY_MS, win: false }),
    );
    const recent = Array.from({ length: 30 }, (_, i) =>
      makeMatch({ id: `r${i}`, time: now - i * DAY_MS, win: true }),
    );

    render(
      <HeroStats matches={[...older, ...recent]} timeFilteredMatches={[...older, ...recent]} />,
    );

    expect(screen.getByText('+50 pts')).toBeInTheDocument();
  });

  it('renders one figure and no delta chip when the recent window collapses onto the baseline', () => {
    const now = Date.now();
    // A small, all-recent account (10 games, all within the last-30-games
    // window AND past TREND_MIN_RECENT_GAMES(8) so it clears `thinRecent`
    // first) — recent === baseline exactly, the `collapsed` state.
    const matches = Array.from({ length: 10 }, (_, i) =>
      makeMatch({ id: `${i}`, time: now - i * DAY_MS, win: i % 3 !== 0 }),
    );

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    const overallCard = screen
      .getByText('Overall Record')
      .closest('[data-slot="card"]') as HTMLElement;
    const leadValue = overallCard.querySelector('.text-\\[1\\.75rem\\]');
    expect(leadValue?.textContent).toBe('60%');
    expect(within(overallCard).queryByText(/pts$/)).not.toBeInTheDocument();
    expect(within(overallCard).queryByText('Thin')).not.toBeInTheDocument();
  });

  it('WR-C01: never mislabels the delta chip "Thin" when the recent window is locked below the abstention floor', () => {
    // 2 total games -> recent.total(2) < ABSTENTION_FLOOR_GAMES(3): the
    // honesty ladder's `locked` state, a different tier than `thin` (enough
    // games to count but not to assert a direction).
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: false }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    const overallCard = screen
      .getByText('Overall Record')
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(overallCard).queryByText('Thin')).not.toBeInTheDocument();
  });

  it('renders the current streak in the form card', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: false }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: true }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    expect(screen.getByText('2W')).toBeInTheDocument();
  });

  it('computes the casual-vs-competitive delta from timeFilteredMatches, ignoring the source filter', () => {
    // matches (source-filtered) only contains the manual bucket, but
    // timeFilteredMatches carries both — the card must use the latter.
    const manual = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
    ]; // 50%
    const competitive = [
      makeMatch({ id: 'c1', time: 3, win: true, source: 'startgg' }),
      makeMatch({ id: 'c2', time: 4, win: true, source: 'startgg' }),
      makeMatch({ id: 'c3', time: 5, win: false, source: 'startgg' }),
    ]; // 67%

    render(<HeroStats matches={manual} timeFilteredMatches={[...manual, ...competitive]} />);

    expect(screen.getByText('Casual')).toBeInTheDocument();
    expect(screen.getByText('Competitive')).toBeInTheDocument();
    // 67 - 50 = +17pts
    expect(screen.getByText('+17pts')).toBeInTheDocument();
  });

  it('shows "no data" for a bucket with zero matches instead of a delta', () => {
    const manual = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
    ];

    render(<HeroStats matches={manual} timeFilteredMatches={manual} />);

    expect(screen.getByText('no data')).toBeInTheDocument();
    // The casual/competitive delta reads "+Npts" — the em-dash empty-state
    // caption from `StatFigure`'s own zero-record split is unrelated text,
    // so scoping to the trailing "pts" suffix stays a precise check.
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
  });

  it('every hero card that carries a real win/loss split renders it through the Record primitive (UIX-04)', () => {
    const manual = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
    ];
    const competitive = [
      makeMatch({ id: 'c1', time: 3, win: true, source: 'startgg' }),
      makeMatch({ id: 'c2', time: 4, win: true, source: 'startgg' }),
    ];
    const online = [makeMatch({ id: 'q1', time: 5, win: true, matchType: 'quickplay' })];
    const offline = [makeMatch({ id: 'f1', time: 6, win: false, matchType: 'offline-friendly' })];
    const matches = [...manual, ...competitive, ...online, ...offline];

    const { container } = render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    // Every W–L pair anywhere on the hero row renders with the Record
    // primitive's en-dash — never a plain hyphen. Overall record (1) +
    // casual/competitive splits (2) + online/offline splits (2) = 5.
    const enDashRecords = (container.textContent?.match(/\d+–\d+/g) ?? []).length;
    expect(enDashRecords).toBe(5);
    expect(container.textContent).not.toMatch(/\d+-\d+/); // never a plain hyphen record
  });

  it('renders the online/offline split respecting all global filters', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, matchType: 'quickplay' }),
      makeMatch({ id: '2', time: 2, win: false, matchType: 'offline-friendly' }),
    ];

    render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows an empty state for online/offline when there are no matches', () => {
    render(<HeroStats matches={[]} timeFilteredMatches={[]} />);

    const onlineOfflineCard = screen.getByText('Online vs Offline').closest('div');
    expect(onlineOfflineCard).not.toBeNull();
  });

  describe('Rating card', () => {
    it('shows the locked state below the 5-game unlock threshold', () => {
      const matches = [
        makeMatch({ id: '1', time: 1, win: true }),
        makeMatch({ id: '2', time: 2, win: true }),
        makeMatch({ id: '3', time: 3, win: false }),
      ];

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.getByText('Rating unlocks at 5 games')).toBeInTheDocument();
      expect(screen.getByText('3/5 games so far')).toBeInTheDocument();
    });

    it('shows the locked state for zero matches', () => {
      render(<HeroStats matches={[]} timeFilteredMatches={[]} />);

      expect(screen.getByText('Rating unlocks at 5 games')).toBeInTheDocument();
      expect(screen.getByText('0/5 games so far')).toBeInTheDocument();
    });

    it('shows a rating, RD, sample size, and caption once unlocked at 5+ games', () => {
      const matches = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `${i}`, time: i * 1000, win: true }),
      );

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.queryByText('Rating unlocks at 5 games')).not.toBeInTheDocument();
      expect(screen.getByText('5 games sampled')).toBeInTheDocument();
      expect(screen.getByText('Glicko-2, session-based · unofficial')).toBeInTheDocument();
      // Rating + RD render together in one node, e.g. "1521 ±..."; assert the
      // ± glyph appears alongside a numeric rating rather than pinning an
      // exact number (keeps this test decoupled from glicko.ts's internals).
      const ratingCard = screen.getByText('Rating').closest('[data-slot="card"]');
      expect(ratingCard?.textContent).toMatch(/\d+\s*±\d+/);
    });

    it('singularizes the games-sampled caption for exactly 1 game', () => {
      // Below the unlock threshold, so we're checking the locked-state copy
      // doesn't awkwardly pluralize — separately, confirm the unlocked
      // caption pluralizes correctly at higher counts via the 5-game test above.
      const matches = [makeMatch({ id: '1', time: 1, win: true })];

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.getByText('1/5 games so far')).toBeInTheDocument();
    });

    it('shows an upward trend arrow when the latest session outperforms the previous one', () => {
      const HOUR_MS = 60 * 60 * 1000;
      const matches = [
        // Session 1: a loss and a win (net neutral-ish, establishes a baseline).
        makeMatch({ id: '1', time: 0, win: false }),
        makeMatch({ id: '2', time: HOUR_MS, win: false }),
        // Gap > 3h default -> new session.
        // Session 2: all wins -> should outperform session 1 and trend up.
        makeMatch({ id: '3', time: 5 * HOUR_MS, win: true }),
        makeMatch({ id: '4', time: 6 * HOUR_MS, win: true }),
        makeMatch({ id: '5', time: 7 * HOUR_MS, win: true }),
      ];

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.getByLabelText('Rating up from last session')).toBeInTheDocument();
    });

    it('shows a downward trend arrow when the latest session underperforms the previous one', () => {
      const HOUR_MS = 60 * 60 * 1000;
      const matches = [
        // Session 1: all wins (establishes a strong baseline).
        makeMatch({ id: '1', time: 0, win: true }),
        makeMatch({ id: '2', time: HOUR_MS, win: true }),
        // Gap > 3h default -> new session.
        // Session 2: all losses -> should underperform session 1 and trend down.
        makeMatch({ id: '3', time: 5 * HOUR_MS, win: false }),
        makeMatch({ id: '4', time: 6 * HOUR_MS, win: false }),
        makeMatch({ id: '5', time: 7 * HOUR_MS, win: false }),
      ];

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.getByLabelText('Rating down from last session')).toBeInTheDocument();
    });

    it('omits the trend arrow when only one session exists (nothing to compare against)', () => {
      const matches = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `${i}`, time: i * 1000, win: true }),
      );

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.queryByLabelText('Rating up from last session')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Rating down from last session')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Rating unchanged from last session')).not.toBeInTheDocument();
    });
  });
});
