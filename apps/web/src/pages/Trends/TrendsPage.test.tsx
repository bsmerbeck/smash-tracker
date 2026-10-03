import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
} from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TrendsPage } from './TrendsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const listMatches = vi.fn();
const listTournaments = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
  },
}));

/**
 * Plan 39.1-35: the real CareerTimelineCard plus a probe button that calls
 * whatever `onSelectPeriod` the page passes it with a fixed window — the page
 * only forwards axes, so the page-level test drives the handler directly.
 */
const { DRILL_FROM_MS, DRILL_TO_MS } = vi.hoisted(() => ({
  DRILL_FROM_MS: Date.UTC(2021, 0, 1),
  DRILL_TO_MS: Date.UTC(2021, 0, 31, 23, 59, 59, 999),
}));
vi.mock('./components/CareerTimelineCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/CareerTimelineCard')>();
  function CareerTimelineCardWithProbe(props: ComponentProps<typeof actual.CareerTimelineCard>) {
    const { onSelectPeriod: selectPeriod, onSelectSet: selectSet } = props as {
      onSelectPeriod?: (range: object) => void;
      onSelectSet?: (key: string) => void;
    };
    return (
      <>
        <actual.CareerTimelineCard {...props} />
        <button
          type="button"
          onClick={() => selectPeriod?.({ fromMs: DRILL_FROM_MS, toMs: DRILL_TO_MS })}
        >
          timeline-drill-probe
        </button>
        <button type="button" onClick={() => selectSet?.('SETA')}>
          timeline-set-probe
        </button>
      </>
    );
  }
  return { ...actual, CareerTimelineCard: CareerTimelineCardWithProbe };
});

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>
  );
}

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 2,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderTrends(initialEntry = '/trends') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route
                  path="/trends"
                  element={
                    <>
                      <TrendsPage />
                      <LocationProbe />
                    </>
                  }
                />
                <Route path="/dashboard" element={<div>Dashboard page</div>} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe('TrendsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    listTournaments.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  it('shows a no-matches empty state when the user has no matches', async () => {
    listMatches.mockResolvedValue([]);

    renderTrends();

    expect(
      await screen.findByText(
        'You have no matches, report a match and check back here to view trends!',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('renders every Pro-desk section once matches exist', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      makeMatch({ id: 'm2', win: false, time: Date.UTC(2021, 1, 1), matchType: 'offline-tourney' }),
    ]);

    renderTrends();

    expect(await screen.findByText('Career timeline')).toBeInTheDocument();
    expect(screen.getByText('Sessions & Tilt')).toBeInTheDocument();
    expect(screen.getByText('Recent Events')).toBeInTheDocument();
    expect(screen.getByText('Setting Comparison')).toBeInTheDocument();
    expect(screen.getByText('Match-Type Mix')).toBeInTheDocument();
    // The six-column Tournaments table no longer renders on Trends (DD-10/UI-SPEC §8.2).
    expect(screen.queryByRole('table', { name: /tournament/i })).not.toBeInTheDocument();
  });

  it('plan 39.1-34: renders the career timeline and neither legacy title (the chart.js pair is retired)', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      makeMatch({ id: 'm2', win: false, time: Date.UTC(2021, 1, 1), matchType: 'offline-tourney' }),
    ]);

    const { container } = renderTrends();

    expect(await screen.findByText('Career timeline')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="career-timeline"]')).not.toBeNull();
    expect(screen.queryByText('Rating Curve')).not.toBeInTheDocument();
    expect(screen.queryByText('Monthly Performance')).not.toBeInTheDocument();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('shows the resync hint in the tournaments section when there are no tournament entries yet', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);
    listTournaments.mockResolvedValue([]);

    renderTrends();

    expect(
      await screen.findByText(/Tournament entries attach on your next start\.gg sync/),
    ).toBeInTheDocument();
  });

  it('shows a clear-filters notice when the global filter empties an existing match set', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      ANALYTICS_FILTER_STORAGE_KEY,
      JSON.stringify({ source: 'startgg', range: 'all' }),
    );
    // All matches are manual (no `source`), so the persisted "startgg" filter excludes everything.
    listMatches.mockResolvedValue([makeMatch({ id: 'm1' }), makeMatch({ id: 'm2' })]);

    renderTrends();

    expect(await screen.findByText('No matches match the current filters.')).toBeInTheDocument();
    // Page itself still renders (not the page-level "no matches at all" hero).
    expect(screen.getByText('Career timeline')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Dashboard' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() =>
      expect(screen.queryByText('No matches match the current filters.')).not.toBeInTheDocument(),
    );
  });

  it('carries no stretch utility on any rendered card root (UIX-01/UIX-04, whole-page scan)', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      makeMatch({ id: 'm2', win: false, time: Date.UTC(2021, 1, 1), matchType: 'offline-tourney' }),
    ]);

    const { container } = renderTrends();
    await screen.findByText('Career timeline');

    const cardRoots = container.querySelectorAll('[data-slot="card"]');
    expect(cardRoots.length).toBeGreaterThan(0);
    for (const card of cardRoots) {
      expect(card.className).not.toMatch(/\bh-full\b/);
      expect(card.className).not.toMatch(/\bflex-1\b/);
    }
  });

  describe('T-39.1-24 (gap closure, DD-09 reachability): a rail card door narrows a new page-level terminus to exactly N', () => {
    /** No page-level terminus exists in the URL's absence — the games anchor never mounts. */
    it('renders no #games terminus with no drill axis in the URL', async () => {
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);

      renderTrends();

      await screen.findByText('Career timeline');
      expect(document.getElementById('games')).not.toBeInTheDocument();
    });

    /** 5 small-sample games — clears `RatingMove`'s abstention floor (3) but stays below the trend floor (8), so it asserts a real "thin" fact card carrying a counted-games door. */
    function ratingCardFixture() {
      const now = Date.now();
      return [
        makeMatch({ id: 'g1', time: now - 5 * 60_000, win: true }),
        makeMatch({ id: 'g2', time: now - 4 * 60_000, win: false }),
        makeMatch({ id: 'g3', time: now - 3 * 60_000, win: true }),
        makeMatch({ id: 'g4', time: now - 2 * 60_000, win: false }),
        makeMatch({ id: 'g5', time: now - 1 * 60_000, win: true }),
      ];
    }

    it("clicking the rating-move card's counted-games door mounts a new page-level terminus with data-total-rows equal to the door's own count", async () => {
      const matches = ratingCardFixture();
      listMatches.mockResolvedValue(matches);
      const user = userEvent.setup();

      renderTrends();

      await screen.findByText('Career timeline');
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="insight-rail-card"][data-card-kind="regular"]'),
        ).not.toBeNull(),
      );

      const card = document.querySelector(
        '[data-slot="insight-rail-card"][data-card-kind="regular"]',
      ) as HTMLElement;
      const door = within(card).getAllByRole('link')[0]!;
      const doorLabel = door.textContent ?? '';
      const expectedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
      expect(expectedCount).toBeGreaterThan(0);

      await user.click(door);

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
      // Anchored to the terminus summary line ("<n> games · …"): a bare /<n>/ also matched
      // date cells in the table, so this failed on any calendar day containing the digit.
      expect(
        within(gamesCard).getByText(new RegExp(`^${expectedCount} games\\b`)),
      ).toBeInTheDocument();
    });

    it('an unknown claim= id behaves exactly as with no claim axis (tolerant fallback, never a throw)', async () => {
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);

      renderTrends('/trends?claim=ratingMove:account:doesNotExist');

      await screen.findByText('Career timeline');
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      expect(within(gamesCard).getByRole('table')).toBeInTheDocument();
    });
  });

  it('WR-01 (39.1-REVIEW): the page-level terminus offers Clear filters, which drops every drill axis and unmounts it', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);
    const user = userEvent.setup();

    renderTrends('/trends?stage=1&claim=ratingMove:account:last30#games');

    await screen.findByText('Career timeline');
    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: 'Clear filters' }));

    await waitFor(() => expect(document.getElementById('games')).not.toBeInTheDocument());
  });

  it('WR-02 (39.1-REVIEW): a cold load of a door URL (#games) scrolls the terminus into view once the data lands', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);
    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;

    renderTrends('/trends?claim=ratingMove:account:last30#games');

    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    const gamesCard = document.getElementById('games') as HTMLElement;
    await waitFor(() => expect(scrollSpy.mock.contexts).toContain(gamesCard));
  });

  describe('T-39.1-27 (gap closure): the Setting comparison door lands on exactly N', () => {
    /** 10 online (quickplay) + 10 offline (offline-tourney) games, well past `COHORT_MIN_SIDE_GAMES` (8) on each side — a real SettingGap games door, `countedMatchIds.length === 20`. */
    function settingGapDoorFixture() {
      const now = Date.now();
      const online = Array.from({ length: 10 }, (_, i) =>
        makeMatch({
          id: `on${i}`,
          time: now - (10 - i) * 60_000,
          win: true,
          matchType: 'quickplay',
        }),
      );
      const offline = Array.from({ length: 10 }, (_, i) =>
        makeMatch({
          id: `off${i}`,
          time: now - (10 - i) * 60_000,
          win: false,
          matchType: 'offline-tourney',
        }),
      );
      return [...online, ...offline];
    }

    /**
     * The base fixture plus 5 `unspecified`-type games — settingGap only
     * ever pools online+offline into `countedMatchIds` (never
     * `unspecified`), so the door's own count (20) stays LESS than the
     * page's total match count (25). This is what makes "resolves via the
     * claim id" a real, falsifiable proof rather than a fixture where
     * "resolved" and "unresolved-fallback-shows-everything" happen to print
     * the same number.
     */
    function settingGapDoorFixtureWithFiller() {
      const now = Date.now();
      const filler = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `unspec${i}`, time: now - (5 - i) * 60_000, win: true, matchType: 'none' }),
      );
      return [...settingGapDoorFixture(), ...filler];
    }

    it("clicking the Setting comparison card's counted-games door mounts #games with data-total-rows equal to the door's own count, states the count and the SettingGap sentence in the summary, and scrolls #games into view", async () => {
      const matches = settingGapDoorFixtureWithFiller();
      listMatches.mockResolvedValue(matches);
      const user = userEvent.setup();
      const scrollIntoViewSpy = vi.fn();
      const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

      try {
        renderTrends();

        await screen.findByText('Setting Comparison');
        const settingCard = screen
          .getByText('Setting Comparison')
          .closest('[data-slot="card"]') as HTMLElement;
        const doorSlot = settingCard.querySelector(
          '[data-slot="insight-line-door"]',
        ) as HTMLElement;
        expect(doorSlot).not.toBeNull();
        const door = within(doorSlot).getByRole('link');
        const doorLabel = door.textContent ?? '';
        const expectedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
        expect(expectedCount).toBe(20);

        await user.click(door);

        await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
        const gamesCard = document.getElementById('games') as HTMLElement;
        const table = within(gamesCard).getByRole('table');
        expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
        const summary = gamesCard.querySelector('p.text-sm.text-muted-foreground') as HTMLElement;
        expect(summary).not.toBeNull();
        expect(summary.textContent).toContain(String(expectedCount));
        expect(summary.textContent).toMatch(/Setting/);

        expect(scrollIntoViewSpy).toHaveBeenCalled();
        const lastCallIndex = scrollIntoViewSpy.mock.contexts.length - 1;
        expect(scrollIntoViewSpy.mock.contexts[lastCallIndex]).toBe(gamesCard);
      } finally {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      }
    });

    it('a hand-typed ?claim=<settingGap id> resolves to exactly the door count — never the unresolved-fallback "everything" count', async () => {
      const matches = settingGapDoorFixtureWithFiller();
      listMatches.mockResolvedValue(matches);

      // Insight.id === `${templateId}:${scopeKey}:${horizon}`; ACCOUNT_SCOPE's
      // key is the literal string 'account'; DEFAULT_HORIZON is 'last30'
      // (useHorizon.ts) — this page's own default before any switch press.
      renderTrends('/trends?claim=settingGap:account:last30');

      await screen.findByText('Setting Comparison');
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      // 20 (the door's own count) — NOT 25 (the page's full match total,
      // which an unresolved claim's tolerant fallback would show instead).
      expect(Number(table.getAttribute('data-total-rows'))).toBe(20);
    });
  });

  describe('T-39.1-27 (gap closure): MixShift and VolumeForm doors land on exactly N', () => {
    /**
     * 70 old offline-tourney games (baseline) + 30 recent online-tourney
     * games — a real, visible MixShift 'fact' state (WR-A02's own fixture
     * shape), and a single-month VolumeForm 'locked' state (monthCount < 6)
     * whose own `countedMatchIds` pools every game (100).
     */
    function mixShiftAndVolumeFormFixture() {
      const now = Date.now();
      const old = Array.from({ length: 70 }, (_, i) =>
        makeMatch({
          id: `old-${i}`,
          time: now - (1000 - i) * 60_000,
          win: true,
          matchType: 'offline-tourney',
        }),
      );
      const recent = Array.from({ length: 30 }, (_, i) =>
        makeMatch({
          id: `recent-${i}`,
          time: now - (30 - i) * 60_000,
          win: true,
          matchType: 'online-tourney',
        }),
      );
      return [...old, ...recent];
    }

    it("clicking the Match-type mix card's MixShift door narrows #games to exactly its own count, with the localized match-type label (never the raw enum) in the summary", async () => {
      const matches = mixShiftAndVolumeFormFixture();
      listMatches.mockResolvedValue(matches);
      const user = userEvent.setup();

      renderTrends();

      await screen.findByText('Match-Type Mix');
      const mixCard = screen
        .getByText('Match-Type Mix')
        .closest('[data-slot="card"]') as HTMLElement;
      const mixShiftText = within(mixCard).getAllByText(/Online Tourney/)[0]!;
      const mixShiftLine = mixShiftText.closest('[data-slot="insight-line"]') as HTMLElement;
      const doorSlot = mixShiftLine.querySelector('[data-slot="insight-line-door"]') as HTMLElement;
      expect(doorSlot).not.toBeNull();
      const door = within(doorSlot).getByRole('link');
      const doorLabel = door.textContent ?? '';
      const expectedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
      expect(expectedCount).toBe(30);

      await user.click(door);

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
      const summary = gamesCard.querySelector('p.text-sm.text-muted-foreground') as HTMLElement;
      expect(summary).not.toBeNull();
      expect(summary.textContent).toMatch(/Online Tourney/);
      expect(summary.textContent).not.toMatch(/online-tourney/);
    });

    it("clicking the Match-type mix card's VolumeForm door narrows #games to exactly its own count", async () => {
      const matches = mixShiftAndVolumeFormFixture();
      listMatches.mockResolvedValue(matches);
      const user = userEvent.setup();

      renderTrends();

      await screen.findByText('Match-Type Mix');
      const mixCard = screen
        .getByText('Match-Type Mix')
        .closest('[data-slot="card"]') as HTMLElement;
      const doorSlots = mixCard.querySelectorAll('[data-slot="insight-line-door"]');
      expect(doorSlots.length).toBeGreaterThan(0);
      // VolumeForm is the LAST insight line in this card (MixShift leads).
      const volumeFormDoorSlot = doorSlots[doorSlots.length - 1] as HTMLElement;
      const door = within(volumeFormDoorSlot).getByRole('link');
      const doorLabel = door.textContent ?? '';
      const expectedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
      expect(expectedCount).toBe(100);

      await user.click(door);

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
    });
  });

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern.
  describe('plan 41-03 (B1, DD-41-07): the PlayRhythm door lands on exactly N', () => {
    /**
     * One game every 31 days for 28 games (every game in its own UTC month, a 28-month span): the
     * recent 12-month window counts 12 of them, so the door's count (12) stays below the page's
     * total (28), and "resolves via the claim id" cannot pass on an unresolved-fallback "everything".
     */
    function playRhythmDoorFixture() {
      const now = Date.now();
      return Array.from({ length: 28 }, (_, i) =>
        makeMatch({ id: `rhythm${i}`, time: now - i * 31 * 24 * 60 * 60 * 1000, win: i % 2 === 0 }),
      );
    }

    it("clicking the PlayRhythm card's counted-games door mounts #games with exactly the counted games and states the PlayRhythm sentence", async () => {
      listMatches.mockResolvedValue(playRhythmDoorFixture());
      const user = userEvent.setup();
      HTMLElement.prototype.scrollIntoView = vi.fn();

      const { container } = renderTrends();

      await screen.findByText('Career timeline');
      const readCell = await waitFor(() => {
        const el = container.querySelector('[data-slot="trends-rhythm-read"]');
        if (!el) throw new Error('row 4 read cell not mounted');
        return el as HTMLElement;
      });
      const door = within(readCell).getByRole('link', { name: /See the \d+ games/ });
      const expectedCount = Number((door.textContent ?? '').match(/\d+/)![0]);
      expect(expectedCount).toBe(12);

      await user.click(door);

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
      const summary = gamesCard.querySelector('p.text-sm.text-muted-foreground') as HTMLElement;
      expect(summary.textContent).toContain(String(expectedCount));
      expect(summary.textContent).toMatch(/Play rhythm/);
    });

    it('the PlayRhythm card is mounted once, in row 4, and never inside the centre reads rail (RESEARCH correction 12)', async () => {
      listMatches.mockResolvedValue(playRhythmDoorFixture());
      const { container } = renderTrends();
      await screen.findByText('Career timeline');
      await waitFor(() =>
        expect(container.querySelector('[data-slot="trends-rhythm-read"]')).not.toBeNull(),
      );
      // The centre reads rail never carries the PlayRhythm card (RESEARCH correction 12).
      const rail = container.querySelector('[data-slot="trends-reads-rail"]') as HTMLElement;
      expect(rail.querySelector('[data-slot="play-rhythm-card"]')).toBeNull();
      expect(container.querySelectorAll('[data-slot="play-rhythm-card"]')).toHaveLength(1);
    });
  });

  describe('plan 39.1-35: a timeline period drills to the Trends terminus', () => {
    it('writes from/to through the drill contract, keeps unrelated params, drops every other drill axis, lands on #games and mounts the terminus', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'in1', win: true, time: Date.UTC(2021, 0, 5) }),
        makeMatch({ id: 'in2', win: false, time: Date.UTC(2021, 0, 20) }),
        makeMatch({ id: 'out1', win: true, time: Date.UTC(2021, 1, 3) }),
        makeMatch({ id: 'out2', win: true, time: Date.UTC(2020, 11, 30) }),
      ]);
      const user = userEvent.setup();

      renderTrends('/trends?keep=1&claim=x&event=y&stage=1&fighter=1&vs=2');

      await screen.findByText('Career timeline');
      await user.click(screen.getByRole('button', { name: 'timeline-drill-probe' }));

      await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/#games$/));
      const url = new URL(`http://x${screen.getByTestId('location').textContent}`);
      expect(url.pathname).toBe('/trends');
      expect(url.searchParams.get('from')).toBe(String(DRILL_FROM_MS));
      expect(url.searchParams.get('to')).toBe(String(DRILL_TO_MS));
      expect(url.searchParams.get('keep')).toBe('1');
      for (const dropped of ['claim', 'event', 'stage', 'fighter', 'vs']) {
        expect(url.searchParams.has(dropped), dropped).toBe(false);
      }
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      expect(Number(within(gamesCard).getByRole('table').getAttribute('data-total-rows'))).toBe(2);
    });
  });

  describe('plan 39.1-35: a thin-account FormStrip set drills to exactly its games', () => {
    it('writes event=<set key> + #games, and the terminus uses the shared form-strip resolver so its count equals the set', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'a1', externalId: 'sgg:SETA:g1', time: Date.UTC(2021, 0, 5, 18) }),
        makeMatch({ id: 'a2', externalId: 'sgg:SETA:g2', time: Date.UTC(2021, 0, 5, 18, 10) }),
        makeMatch({ id: 'a3', externalId: 'sgg:SETA:g3', time: Date.UTC(2021, 0, 5, 18, 20) }),
        makeMatch({ id: 'b1', externalId: 'sgg:SETB:g1', time: Date.UTC(2021, 0, 6, 18) }),
        makeMatch({ id: 'm1', time: Date.UTC(2021, 0, 7, 18) }),
      ]);
      const user = userEvent.setup();

      renderTrends('/trends?keep=1&from=1&to=2');

      await screen.findByText('Career timeline');
      await user.click(screen.getByRole('button', { name: 'timeline-set-probe' }));

      await waitFor(() =>
        expect(screen.getByTestId('location').textContent).toMatch(/event=SETA.*#games$/),
      );
      const url = new URL(`http://x${screen.getByTestId('location').textContent}`);
      expect(url.searchParams.get('event')).toBe('SETA');
      expect(url.searchParams.get('keep')).toBe('1');
      expect(url.searchParams.has('from')).toBe(false);
      expect(url.searchParams.has('to')).toBe(false);
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      expect(Number(within(gamesCard).getByRole('table').getAttribute('data-total-rows'))).toBe(3);
    });
  });

  describe('one loading pattern (UIX-07)', () => {
    it('shows the CardSkeleton pattern with the busy status role and the existing loading label while matches load', () => {
      listMatches.mockReturnValue(new Promise(() => {}));

      const { container } = renderTrends();

      const status = container.querySelector('[role="status"][aria-busy="true"]');
      expect(status).not.toBeNull();
      expect(status).toHaveTextContent('Loading trends...');
      expect(container.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
      expect(container.querySelector('div.text-muted-foreground')).toBeNull();
      // The skeleton's grid spans (12, 12, 4, 4, 4) mirror the loaded page's
      // own hero(12)/timeline(12)/rails(4+4+4) spans.
      const spans = Array.from(container.querySelectorAll('[data-span]')).map((el) =>
        el.getAttribute('data-span'),
      );
      expect(spans.sort()).toEqual(['12', '12', '4', '4', '4'].sort());
    });

    it('renders zero skeleton blocks once loaded, and the loaded page reuses the same grid spans as the skeleton', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      ]);

      const { container } = renderTrends();
      await screen.findByText('Career timeline');

      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);
      expect(container.querySelector('[data-slot="trends-hero-body"]')).not.toBeNull();
      const spans = Array.from(container.querySelectorAll('[data-span]')).map((el) =>
        el.getAttribute('data-span'),
      );
      // The loaded page adds row 4's read cell (plan 41-03); a one-game account's read is locked.
      expect(spans.sort()).toEqual(['12', '12', '4', '4', '4', '4'].sort());
    });

    it('on a background refetch, dims the previous frame instead of flashing a skeleton', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      ]);

      const { container, queryClient } = renderTrends();
      await screen.findByText('Career timeline');

      let resolveSecondFetch: (value: unknown) => void = () => {};
      listMatches.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );

      queryClient.invalidateQueries();

      await waitFor(() => {
        const grid = container.querySelector('[data-slot="page-grid"]');
        expect(grid?.className).toMatch(/opacity-60/);
      });
      expect(screen.getByText('Career timeline')).toBeInTheDocument();
      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);

      resolveSecondFetch([
        makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      ]);
      await waitFor(() => {
        const grid = container.querySelector('[data-slot="page-grid"]');
        expect(grid?.className).not.toMatch(/opacity-60/);
      });
    });
  });

  // Plan 39.1-38 (design-audit item 6 / P5; UI-SPEC §10.4, sketch 002-C `.filters`).
  it('plan 39.1-38 filter-row: the first child of the page shell is one unboxed page-filter-row with the h1 "Trends" and the HorizonSwitch; no card contains either', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
    ]);
    const { container } = renderTrends();
    await screen.findByText('Career timeline');
    const shell = container.querySelector('[data-slot="page-shell"]') as HTMLElement;
    const row = shell.firstElementChild as HTMLElement;
    expect(row).toHaveAttribute('data-slot', 'page-filter-row');
    const h1 = screen.getByRole('heading', { level: 1, name: 'Trends' });
    expect(row.contains(h1)).toBe(true);
    const horizonSwitch = container.querySelector('[data-slot="horizon-switch"]') as HTMLElement;
    expect(row.contains(horizonSwitch)).toBe(true);
    expect(h1.closest('[data-slot="card"]')).toBeNull();
    expect(horizonSwitch.closest('[data-slot="card"]')).toBeNull();
  });

  // Plan 39.1-38 (design-audit item 9; UI-SPEC §8.2 "insight before chart"):
  // DOM order = the phone reading order; the desktop composition is restored
  // by lg grid placement, never a CSS `order` utility (UI-SPEC §14.5).
  describe('plan 39.1-38 insight-first phone order', () => {
    const cls = (el: Element) => el.className.split(/\s+/);

    it('DOM order is stat row, reads rail, career timeline, left stack (Sessions, Recent events), right stack (Setting, Mix)', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
        makeMatch({
          id: 'm2',
          win: false,
          time: Date.UTC(2021, 1, 1),
          matchType: 'offline-tourney',
        }),
      ]);
      const { container } = renderTrends();
      await screen.findByText('Career timeline');
      const grid = container.querySelector('[data-slot="page-grid"]') as HTMLElement;
      const cells = Array.from(grid.children) as HTMLElement[];
      const indexOf = (predicate: (cell: HTMLElement) => boolean) => cells.findIndex(predicate);
      const hero = indexOf((c) => Boolean(c.querySelector('[data-slot="trends-hero-body"]')));
      const reads = indexOf((c) => Boolean(c.querySelector('[data-slot="trends-reads-rail"]')));
      const timeline = indexOf((c) => Boolean(c.querySelector('[data-slot="career-timeline"]')));
      const left = indexOf((c) => (c.textContent ?? '').includes('Sessions & Tilt'));
      const right = indexOf((c) => (c.textContent ?? '').includes('Setting Comparison'));
      expect([hero, reads, timeline, left, right]).toEqual([0, 1, 2, 3, 4]);
      expect(cells[left]!.textContent).toContain('Recent Events');
      expect(cells[right]!.textContent).toContain('Match-Type Mix');

      expect(cls(cells[hero]!)).toContain('lg:row-start-1');
      expect(cls(cells[timeline]!)).toContain('lg:row-start-2');
      expect(cls(cells[left]!)).toEqual(
        expect.arrayContaining(['lg:col-start-1', 'lg:row-start-3']),
      );
      expect(cls(cells[reads]!)).toEqual(
        expect.arrayContaining(['lg:col-start-5', 'lg:row-start-3']),
      );
      expect(cls(cells[right]!)).toEqual(
        expect.arrayContaining(['lg:col-start-9', 'lg:row-start-3']),
      );
      for (const cell of cells) expect(cell.className).not.toMatch(/(^|\s)([a-z0-9]+:)*order-/);
    });

    it('the loading skeleton uses the same order and placement', () => {
      listMatches.mockReturnValue(new Promise(() => {}));
      const { container } = renderTrends();
      const grid = container.querySelector('[data-slot="page-grid"]') as HTMLElement;
      const cells = Array.from(grid.children) as HTMLElement[];
      expect(cells.map((c) => c.getAttribute('data-span'))).toEqual(['12', '4', '12', '4', '4']);
      expect(cls(cells[1]!)).toEqual(expect.arrayContaining(['lg:col-start-5', 'lg:row-start-3']));
      expect(cls(cells[2]!)).toContain('lg:row-start-2');
      expect(cls(cells[3]!)).toEqual(expect.arrayContaining(['lg:col-start-1', 'lg:row-start-3']));
      expect(cls(cells[4]!)).toEqual(expect.arrayContaining(['lg:col-start-9', 'lg:row-start-3']));
    });
  });
});
