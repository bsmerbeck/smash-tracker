import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TournamentsPage } from './TournamentsPage';
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
const getMe = vi.fn();
const listAliases = vi.fn();

/** Phase 30.3 (Gate 6): the always-present `GET /api/users/me` profile shape. */
function defaultProfile(overrides: { isDemoAccount?: boolean } = {}) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
    ...overrides,
  };
}

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
    opponents: {
      aliases: {
        list: (...args: unknown[]) => listAliases(...args),
      },
    },
  },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tournaments']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/tournaments" element={<TournamentsPage />} />
              <Route path="/dashboard" element={<div>Dashboard page</div>} />
              <Route path="/settings/integrations" element={<div>Integrations page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TournamentsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue(defaultProfile());
    listAliases.mockResolvedValue({});
    setMockUser(makeMockUser());
  });

  it('shows the no-tournaments empty state when there are neither matches nor registry entries', async () => {
    listMatches.mockResolvedValue([]);
    listTournaments.mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(
        'No tournaments yet — sync your start.gg or parry.gg matches and check back here!',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  /**
   * Phase 30.3 (Gate 4): an account whose history was admin-imported may
   * have registry rows with zero locally linked matches — those rows must
   * render, never be hidden behind the no-matches dead end.
   */
  it('renders imported registry entries even when the match list is empty', async () => {
    listMatches.mockResolvedValue([]);
    listTournaments.mockResolvedValue([
      {
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        firstSetAt: Date.UTC(2024, 5, 10),
        lastSetAt: Date.UTC(2024, 5, 10),
        setsPlayed: 5,
        entryKey: '42',
        origin: 'admin-imported',
        provider: 'startgg',
      },
    ]);

    renderPage();

    expect(await screen.findByRole('link', { name: 'The Big House 9' })).toHaveAttribute(
      'href',
      '/tournaments/42',
    );
    expect(screen.getByText('Imported')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'No tournaments yet — sync your start.gg or parry.gg matches and check back here!',
      ),
    ).not.toBeInTheDocument();
  });
});
