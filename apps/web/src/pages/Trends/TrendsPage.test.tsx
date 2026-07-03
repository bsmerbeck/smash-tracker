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
import { TrendsPage } from './TrendsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
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
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/trends']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/trends" element={<TrendsPage />} />
              <Route path="/dashboard" element={<div>Dashboard page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TrendsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
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

  it('renders all five trend sections once matches exist', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', win: true, time: Date.UTC(2021, 0, 1), matchType: 'quickplay' }),
      makeMatch({ id: 'm2', win: false, time: Date.UTC(2021, 1, 1), matchType: 'offline-tourney' }),
    ]);

    renderTrends();

    expect(await screen.findByText('Monthly Performance')).toBeInTheDocument();
    expect(screen.getByText('Sessions & Tilt')).toBeInTheDocument();
    expect(screen.getByText('Setting Comparison')).toBeInTheDocument();
    expect(screen.getByText('Tournaments')).toBeInTheDocument();
    expect(screen.getByText('Match-Type Mix Over Time')).toBeInTheDocument();
  });

  it('shows the resync hint in the tournaments section when no match has a tournamentName', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', win: true })]);

    renderTrends();

    expect(
      await screen.findByText(/Tournament names attach on your next start\.gg sync/),
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
});
