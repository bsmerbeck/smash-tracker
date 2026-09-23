import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
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
                <Route path="/trends" element={<TrendsPage />} />
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

    expect(await screen.findByText('Monthly Performance')).toBeInTheDocument();
    expect(screen.getByText('Rating Curve')).toBeInTheDocument();
    expect(screen.getByText('Sessions & Tilt')).toBeInTheDocument();
    expect(screen.getByText('Recent Events')).toBeInTheDocument();
    expect(screen.getByText('Setting Comparison')).toBeInTheDocument();
    expect(screen.getByText('Match-Type Mix')).toBeInTheDocument();
    // The six-column Tournaments table no longer renders on Trends (DD-10/UI-SPEC §8.2).
    expect(screen.queryByRole('table', { name: /tournament/i })).not.toBeInTheDocument();
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
    expect(screen.getByText('Monthly Performance')).toBeInTheDocument();
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
    await screen.findByText('Monthly Performance');

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

      await screen.findByText('Monthly Performance');
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

      await screen.findByText('Monthly Performance');
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
      expect(within(gamesCard).getByText(new RegExp(String(expectedCount)))).toBeInTheDocument();
    });

    it('an unknown claim= id behaves exactly as with no claim axis (tolerant fallback, never a throw)', async () => {
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);

      renderTrends('/trends?claim=ratingMove:account:doesNotExist');

      await screen.findByText('Monthly Performance');
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      expect(within(gamesCard).getByRole('table')).toBeInTheDocument();
    });
  });

  it('WR-01 (39.1-REVIEW): the page-level terminus offers Clear filters, which drops every drill axis and unmounts it', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);
    const user = userEvent.setup();

    renderTrends('/trends?stage=1&claim=ratingMove:account:last30#games');

    await screen.findByText('Monthly Performance');
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
      await screen.findByText('Monthly Performance');

      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);
      expect(container.querySelector('[data-slot="trends-hero-body"]')).not.toBeNull();
      const spans = Array.from(container.querySelectorAll('[data-span]')).map((el) =>
        el.getAttribute('data-span'),
      );
      expect(spans.sort()).toEqual(['12', '12', '4', '4', '4'].sort());
    });

    it('on a background refetch, dims the previous frame instead of flashing a skeleton', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      ]);

      const { container, queryClient } = renderTrends();
      await screen.findByText('Monthly Performance');

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
      expect(screen.getByText('Monthly Performance')).toBeInTheDocument();
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
});
