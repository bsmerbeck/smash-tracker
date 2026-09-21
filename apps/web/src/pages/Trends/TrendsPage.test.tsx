import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

function renderTrends() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/trends']}>
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
