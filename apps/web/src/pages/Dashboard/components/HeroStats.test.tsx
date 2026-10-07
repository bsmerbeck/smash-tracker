import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { HeroStats } from './HeroStats';
import { TrendsHero } from '@/pages/Trends/components/TrendsHero';

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

  describe('plan 39.1-36 (honest-none-chip): the overall-record chip states its horizon and never a direction below the floor', () => {
    function overallChip(): HTMLElement | null {
      const card = screen.getByText('Overall Record').closest('[data-slot="card"]') as HTMLElement;
      return card.querySelector('[data-slot="delta-chip"]');
    }

    it('plan 39.1-59 (UAT 39.1-33 F17): a stale account (the 12-month bound emptied the window) reads "none in the last 12 months", never "no games · last 30"', () => {
      const now = Date.now();
      const matches = Array.from({ length: 40 }, (_, i) =>
        makeMatch({ id: `s${i}`, time: now - (400 + i) * DAY_MS, win: i % 2 === 0 }),
      );
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      const chip = overallChip();
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute('data-state')).toBe('none');
      expect(chip!.textContent).toBe('none in the last 12 months');
      expect(chip!.textContent).not.toContain('last 30');
    });

    it('a 2-game scoped window reads "n 2 · no direction"', () => {
      const now = Date.now();
      const matches = [
        ...Array.from({ length: 40 }, (_, i) =>
          makeMatch({ id: `s${i}`, time: now - (400 + i) * DAY_MS, win: i % 2 === 0 }),
        ),
        makeMatch({ id: 'n1', time: now - 2 * DAY_MS, win: true }),
        makeMatch({ id: 'n2', time: now - DAY_MS, win: true }),
      ];
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      const chip = overallChip();
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute('data-state')).toBe('thin');
      expect(chip!.textContent).toBe('n 2 · no direction');
    });

    it("a steady 30-game window carries its own horizon label 'last 30'", () => {
      const now = Date.now();
      const matches = [
        ...Array.from({ length: 60 }, (_, i) =>
          makeMatch({ id: `o${i}`, time: now - (200 + i) * DAY_MS, win: i % 2 === 0 }),
        ),
        ...Array.from({ length: 30 }, (_, i) =>
          makeMatch({ id: `r${i}`, time: now - i * DAY_MS, win: i % 2 === 0 }),
        ),
      ];
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      expect(overallChip()!.textContent).toBe('steady· last 30');
    });
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
      expect(ratingCard?.textContent).toMatch(/\d+\s*±\s*\d+/);
    });

    it('singularizes the games-sampled caption for exactly 1 game', () => {
      // Below the unlock threshold, so we're checking the locked-state copy
      // doesn't awkwardly pluralize — separately, confirm the unlocked
      // caption pluralizes correctly at higher counts via the 5-game test above.
      const matches = [makeMatch({ id: '1', time: 1, win: true })];

      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);

      expect(screen.getByText('1/5 games so far')).toBeInTheDocument();
    });

    it('F24 parity: the Rating tile reads the same ratingMove chip as the Trends hero, never the session-to-session arrow (plan 35-05)', () => {
      const HOUR_MS = 60 * 60 * 1000;
      const start = Date.now() - 10 * 24 * HOUR_MS;
      // Session 1: five wins; a day later session 2: L, L, W. The last session
      // underperforms the first (the old arrow read "▼"), while the whole
      // last-30 window rises (ratingMove reads up).
      // Plan 39.1-53 (UAT 39.1-17): an 8-game account's last-30 window holds
      // every game and now collapses (no direction), so the two sessions sit on
      // top of 60 older losses and 22 earlier wins — the last-30 window is 30 of
      // 90 games and still rises.
      const results = [true, true, true, true, true, false, false, true];
      const older = Array.from({ length: 60 }, (_, i) =>
        makeMatch({ id: `o${i}`, time: start - 400 * 24 * HOUR_MS + i * HOUR_MS, win: false }),
      );
      const earlierWins = Array.from({ length: 22 }, (_, i) =>
        makeMatch({ id: `e${i}`, time: start - 5 * 24 * HOUR_MS + i * HOUR_MS, win: true }),
      );
      const matches = [
        ...older,
        ...earlierWins,
        ...results.map((win, i) =>
          makeMatch({
            id: `p${i}`,
            time: start + (i < 5 ? i * HOUR_MS : 24 * HOUR_MS + (i - 5) * HOUR_MS),
            win,
          }),
        ),
      ];

      const dashboard = render(
        <HeroStats matches={matches} timeFilteredMatches={matches} horizon="last30" />,
      );
      const ratingCard = within(dashboard.container)
        .getByText('Rating')
        .closest('[data-slot="card"]') as HTMLElement;
      expect(ratingCard.textContent).not.toMatch(/[▲▼]/);
      const dashboardChip = ratingCard.querySelector('[data-slot="delta-chip"]');
      expect(dashboardChip).not.toBeNull();
      const dashboardText = dashboardChip!.textContent;
      const dashboardAria = dashboardChip!.getAttribute('aria-label');
      const dashboardState = dashboardChip!.getAttribute('data-state');
      dashboard.unmount();

      const trends = render(<TrendsHero matches={matches} horizon="last30" />);
      const trendsFigure = within(trends.container).getByText('Rating')
        .parentElement as HTMLElement;
      const trendsChip = trendsFigure.querySelector('[data-slot="delta-chip"]');
      expect(trendsChip).not.toBeNull();
      expect(trendsChip!.getAttribute('data-state')).toBe('up');
      expect(dashboardState).toBe(trendsChip!.getAttribute('data-state'));
      expect(dashboardText).toBe(trendsChip!.textContent);
      expect(dashboardAria).toBe(trendsChip!.getAttribute('aria-label'));
      // UAT review WR-01: the shared label must carry what the chip shows —
      // direction, the signed move and the horizon — never a self-comparison
      // of the current rating ("1734 recent vs 1734 all time").
      const valueLabel = dashboardChip!.querySelector('.text-foreground')?.textContent ?? '';
      expect(valueLabel).toMatch(/^\+\d+$/);
      expect(dashboardAria).toContain('Rating');
      expect(dashboardAria).toContain('Trending up');
      expect(dashboardAria).toContain(valueLabel);
      expect(dashboardAria).toContain('last 30');
      expect(dashboardAria).not.toMatch(/recent vs/);
    });

    it('a sub-floor window shows no direction on the unlocked Rating tile (plan 35-05)', () => {
      const now = Date.now();
      // 6 games: the tile is unlocked (>= 5) but the window is below the
      // trend floor, so no up / down / steady read and no arrow glyph.
      const matches = Array.from({ length: 6 }, (_, i) =>
        makeMatch({ id: `s${i}`, time: now - (6 - i) * 60 * 60 * 1000, win: true }),
      );

      render(<HeroStats matches={matches} timeFilteredMatches={matches} horizon="last30" />);

      const ratingCard = screen.getByText('Rating').closest('[data-slot="card"]') as HTMLElement;
      expect(ratingCard.textContent).not.toMatch(/[▲▼→]/);
      expect(within(ratingCard).queryByLabelText(/from last session/)).not.toBeInTheDocument();
      const chip = ratingCard.querySelector('[data-slot="delta-chip"]');
      expect(['up', 'down', 'steady']).not.toContain(chip?.getAttribute('data-state'));
    });

    describe('plan 41-14 (UAT 41 test 2): the Rating tile and the Trends hero agree on one rule', () => {
      const HOUR_MS = 60 * 60 * 1000;

      function readDashboardChip(matches: Match[], horizon: 'last30' | 'lastEvent') {
        const view = render(
          <HeroStats matches={matches} timeFilteredMatches={matches} horizon={horizon} />,
        );
        const card = within(view.container)
          .getByText('Rating')
          .closest('[data-slot="card"]') as HTMLElement;
        const chip = card.querySelector('[data-slot="delta-chip"]');
        const read = {
          glyph: /[▲▼]/.test(card.textContent ?? ''),
          state: chip?.getAttribute('data-state') ?? null,
          text: chip?.textContent ?? null,
        };
        view.unmount();
        return read;
      }

      function readTrendsChip(matches: Match[], horizon: 'last30' | 'lastEvent') {
        const view = render(<TrendsHero matches={matches} horizon={horizon} />);
        const figure = within(view.container).getByText('Rating').parentElement as HTMLElement;
        const chip = figure.querySelector('[data-slot="delta-chip"]');
        const read = {
          state: chip?.getAttribute('data-state') ?? null,
          text: chip?.textContent ?? null,
        };
        view.unmount();
        return read;
      }

      // The demo shape: 8 games at one event inside every horizon; the last
      // session (L, L, W) underperforms the first (five wins).
      function thinDemo(): Match[] {
        const start = Date.now() - 3 * 24 * HOUR_MS;
        return [true, true, true, true, true, false, false, true].map((win, i) =>
          makeMatch({
            id: `d${i}`,
            time: start + (i < 5 ? i * HOUR_MS : 24 * HOUR_MS + (i - 5) * HOUR_MS),
            win,
            tournamentName: 'Demo Weekly',
            eventName: 'Ultimate Singles',
          }),
        );
      }

      // 120 games: 90 older losses, then 30 recent wins (a notable rise; the
      // last-30 window is a quarter of the account, so it never collapses).
      function rising(): Match[] {
        const start = Date.now() - 200 * DAY_MS;
        return Array.from({ length: 120 }, (_, i) =>
          makeMatch({ id: `r${i}`, time: start + i * DAY_MS, win: i >= 90 }),
        );
      }

      // 120 games alternating W/L at one pace (steady).
      function steady(): Match[] {
        const start = Date.now() - 200 * DAY_MS;
        return Array.from({ length: 120 }, (_, i) =>
          makeMatch({ id: `s${i}`, time: start + i * DAY_MS, win: i % 2 === 0 }),
        );
      }

      it.each(['last30', 'lastEvent'] as const)(
        'the thin demo account shows no direction on either surface at %s',
        (horizon) => {
          const dashboard = readDashboardChip(thinDemo(), horizon);
          const trends = readTrendsChip(thinDemo(), horizon);
          expect(dashboard.glyph).toBe(false);
          expect(['up', 'down']).not.toContain(dashboard.state);
          expect(['up', 'down']).not.toContain(trends.state);
          expect(dashboard).toMatchObject(trends);
        },
      );

      it.each([
        ['thin all-in-horizon', thinDemo],
        ['notable rise', rising],
        ['steady', steady],
      ] as const)('%s: the tile and the hero read the same chip at last30', (_label, build) => {
        const matches = build();
        const dashboard = readDashboardChip(matches, 'last30');
        const trends = readTrendsChip(matches, 'last30');
        expect(dashboard.state).toBe(trends.state);
        expect(dashboard.text).toBe(trends.text);
      });

      it('the notable-rise fixture does state a rise on both surfaces (the oracle is not vacuous)', () => {
        expect(readDashboardChip(rising(), 'last30').state).toBe('up');
        expect(readTrendsChip(rising(), 'last30').state).toBe('up');
      });
    });
  });
});

/**
 * Plan 39.1-39 (coordinator item 2026-09-25, UI-SPEC §7.3 / §7.4 / §6.5
 * rule 2): each split card's two figures are ONE StatRow (never a hand-rolled
 * two-column grid) and each record wraps whole tokens inside its own cell,
 * so the two records never overprint (39.1-36's capture: "1,0266–184").
 */
describe('HeroStats split cards — one StatRow, wrapping records (plan 39.1-39)', () => {
  const matches = [
    makeMatch({ id: 'm1', time: 1, win: true }),
    makeMatch({ id: 'm2', time: 2, win: false }),
    makeMatch({ id: 'm3', time: 3, win: true }),
    makeMatch({ id: 'c1', time: 4, win: true, source: 'startgg' }),
    makeMatch({ id: 'c2', time: 5, win: false, source: 'startgg' }),
    makeMatch({ id: 'c3', time: 6, win: false, source: 'startgg' }),
    makeMatch({ id: 'q1', time: 7, win: true, matchType: 'quickplay' }),
    makeMatch({ id: 'q2', time: 8, win: true, matchType: 'quickplay' }),
    makeMatch({ id: 'q3', time: 9, win: false, matchType: 'quickplay' }),
    makeMatch({ id: 'f1', time: 10, win: true, matchType: 'offline-friendly' }),
    makeMatch({ id: 'f2', time: 11, win: false, matchType: 'offline-friendly' }),
  ];

  function cardOf(title: string): HTMLElement {
    return screen.getByText(title).closest('[data-slot="card"]') as HTMLElement;
  }

  it.each(['Casual vs Competitive', 'Online vs Offline'])(
    '%s renders exactly one stat-row holding two figures, and no grid-cols-2 gap-2 wrapper',
    (title) => {
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      const card = cardOf(title);
      const rows = card.querySelectorAll('[data-slot="stat-row"]');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.children).toHaveLength(2);
      expect(card.querySelector('.grid-cols-2.gap-2')).toBeNull();
    },
  );

  it.each(['Casual vs Competitive', 'Online vs Offline'])(
    "%s: each figure's record is in whole-token wrap mode",
    (title) => {
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      const records = cardOf(title).querySelectorAll('[data-slot="record"]');
      expect(records.length).toBe(2);
      for (const record of records) {
        const classes = (record as HTMLElement).className.split(/\s+/);
        expect(classes).toContain('flex-wrap');
        expect(classes).not.toContain('whitespace-nowrap');
      }
    },
  );

  it('the empty-side state and the delta line are unchanged', () => {
    const manualOnly = matches.filter((m) => m.source !== 'startgg');
    render(<HeroStats matches={manualOnly} timeFilteredMatches={manualOnly} />);
    const card = cardOf('Casual vs Competitive');
    expect(card.querySelector('[data-slot="stat-row"]')).not.toBeNull();
    expect(within(card).getByText('no data')).toBeInTheDocument();
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
  });
});

/**
 * Quick 261002-leg (DESIGN §2-§3): the hero is four 3-span cells — two
 * stacks (Overall Record over Rating, Form over the fighter record) and the
 * two split tiles — every card at UI-SPEC §6.2 compact density, and the
 * Casual vs Competitive caveat only while a source filter is active.
 */
describe('HeroStats — four-cell hero, compact density, gated caveat (quick 261002-leg)', () => {
  const CAVEAT = 'Ignores the source filter above (time range still applies).';
  const matches = [
    makeMatch({ id: '1', time: 1, win: false }),
    makeMatch({ id: '2', time: 2, win: true }),
    makeMatch({ id: '3', time: 3, win: true }),
  ];
  const tokens = (el: Element) => el.className.split(/\s+/);
  const heroCells = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-span="3"]'));
  const cardsOf = (cell: Element) =>
    Array.from(cell.children).filter(
      (c) => c.getAttribute('data-slot') === 'card',
    ) as HTMLElement[];

  it('renders exactly four span-3 cells: two stacks, then two plain split tiles, all overriding to lg:col-span-6 xl:col-span-3', () => {
    const { container } = render(
      <HeroStats
        matches={matches}
        timeFilteredMatches={matches}
        fighterTile={<div data-testid="fighter-tile-stub" />}
      />,
    );
    const cells = heroCells(container);
    expect(cells).toHaveLength(4);
    for (const stack of [cells[0]!, cells[1]!]) {
      expect(tokens(stack)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'gap-4']));
    }
    for (const plain of [cells[2]!, cells[3]!]) {
      expect(tokens(plain)).not.toContain('flex-col');
    }
    for (const cell of cells) {
      expect(tokens(cell)).toContain('lg:col-span-6');
      expect(tokens(cell)).toContain('xl:col-span-3');
      // twMerge dropped GridCell's own lg:col-span-3.
      expect(tokens(cell)).not.toContain('lg:col-span-3');
    }
    const [overall, rating] = cardsOf(cells[0]!);
    expect(cardsOf(cells[0]!)).toHaveLength(2);
    expect(within(overall!).getByText('Overall Record')).toBeInTheDocument();
    expect(within(rating!).getByText('Rating')).toBeInTheDocument();
    const stub = within(cells[1]!).getByTestId('fighter-tile-stub');
    const formCard = stub.previousElementSibling as HTMLElement;
    expect(formCard.getAttribute('data-slot')).toBe('card');
    expect(within(formCard).getByText('Form')).toBeInTheDocument();
  });

  it('without a fighterTile, the Form stack holds exactly one card', () => {
    const { container } = render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
    expect(cardsOf(heroCells(container)[1]!)).toHaveLength(1);
  });

  it('every hero card is at compact density (gap-4 py-4 sm:py-5 shadow-none, px-4 sm:px-5 header/content)', () => {
    const { container } = render(
      <HeroStats matches={matches} timeFilteredMatches={matches} fighterTile={<span />} />,
    );
    const cards = Array.from(container.querySelectorAll('[data-slot="card"]'));
    // Overall Record, Rating, Form, Casual vs Competitive, Online vs Offline.
    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(tokens(card)).toEqual(
        expect.arrayContaining(['gap-4', 'py-4', 'sm:py-5', 'shadow-none']),
      );
      for (const dropped of ['py-6', 'gap-6', 'shadow-sm']) {
        expect(tokens(card)).not.toContain(dropped);
      }
    }
    const parts = Array.from(
      container.querySelectorAll('[data-slot="card-content"], [data-slot="card-header"]'),
    );
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(tokens(part)).toEqual(expect.arrayContaining(['px-4', 'sm:px-5']));
      expect(tokens(part)).not.toContain('px-6');
    }
  });

  describe('Casual vs Competitive caveat', () => {
    const cvcContent = () =>
      screen
        .getByText('Casual vs Competitive')
        .closest('[data-slot="card"]')!
        .querySelector('[data-slot="card-content"]') as HTMLElement;

    it('is absent while no source filter is active', () => {
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      expect(screen.queryByText(CAVEAT)).not.toBeInTheDocument();
    });

    it('shows as the LAST child of the card content when sourceFilterActive', () => {
      render(<HeroStats matches={matches} timeFilteredMatches={matches} sourceFilterActive />);
      const caveat = screen.getByText(CAVEAT);
      expect(cvcContent().lastElementChild).toBe(caveat);
    });
  });

  describe('Form tile', () => {
    it('puts the pips and the streak chip in one value row, with a visible meta line and no card header', () => {
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      const formCard = screen.getByText('Form').closest('[data-slot="card"]') as HTMLElement;
      expect(formCard.querySelector('[data-slot="card-header"]')).toBeNull();
      const pips = formCard.querySelector('[aria-label^="Last"]') as HTMLElement;
      const chip = within(formCard).getByText('2W');
      expect(pips).not.toBeNull();
      expect(chip.parentElement!.contains(pips)).toBe(true);
      expect(within(formCard).getByText('Last 3 results, newest first')).toBeInTheDocument();
    });

    it('with zero matches shows an em dash and the empty caption, and no pips element', () => {
      render(<HeroStats matches={[]} timeFilteredMatches={[]} />);
      const formCard = screen.getByText('Form').closest('[data-slot="card"]') as HTMLElement;
      expect(formCard.querySelector('[aria-label^="Last"]')).toBeNull();
      expect(within(formCard).getByText('—')).toBeInTheDocument();
      expect(within(formCard).getByText('No matches yet.')).toBeInTheDocument();
    });
  });

  describe('Rating tile', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );

    it('has no card header; the overline shares a row with the explainer trigger; meta is two separate spans', () => {
      render(<HeroStats matches={five} timeFilteredMatches={five} />);
      const overline = screen.getByText('Rating');
      const ratingCard = overline.closest('[data-slot="card"]') as HTMLElement;
      expect(ratingCard.querySelector('[data-slot="card-header"]')).toBeNull();
      expect(within(overline.parentElement as HTMLElement).getByRole('button')).toBeInTheDocument();
      const sampled = within(ratingCard).getByText('5 games sampled');
      const caption = within(ratingCard).getByText('Glicko-2, session-based · unofficial');
      expect(sampled).not.toBe(caption);
      expect(sampled.parentElement).toBe(caption.parentElement);
    });

    it('keeps the overline + explainer in the locked state, with no header', () => {
      render(<HeroStats matches={matches} timeFilteredMatches={matches} />);
      const ratingCard = screen.getByText('Rating').closest('[data-slot="card"]') as HTMLElement;
      expect(ratingCard.querySelector('[data-slot="card-header"]')).toBeNull();
      expect(within(ratingCard).getByText('Rating unlocks at 5 games')).toBeInTheDocument();
    });
  });
});
