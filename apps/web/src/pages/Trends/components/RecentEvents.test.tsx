import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { RecentEvents } from './RecentEvents';

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

const listTournaments = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    tournaments: { list: (...args: unknown[]) => listTournaments(...args) },
  },
}));

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  const eventId = overrides.eventId ?? 1;
  return {
    eventId,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 3),
    setsPlayed: 2,
    entryKey: String(eventId),
    ...overrides,
  };
}

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

function renderRecentEvents(matches: Match[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/trends']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/trends" element={<RecentEvents matches={matches} />} />
              <Route path="/tournaments/:entryKey" element={<div>Tournament detail page</div>} />
              <Route path="/tournaments" element={<div>Tournaments page</div>} />
              <Route path="/settings/integrations" element={<div>Integrations page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecentEvents', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    setMockUser(makeMockUser());
  });

  it('shows the resync hint when there are no tournament entries', async () => {
    listTournaments.mockResolvedValue([]);
    renderRecentEvents([]);

    expect(
      await screen.findByText(/Tournament entries attach on your next start\.gg sync/),
    ).toBeInTheDocument();
  });

  it('renders placement and seed when the registry entry carries them', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 1, placement: 3, numEntrants: 2048, seed: 12 }),
    ]);
    renderRecentEvents([]);

    expect(await screen.findByText('3 of 2048 · Seed 12')).toBeInTheDocument();
  });

  it('renders the record alone when the registry entry carries neither placement nor seed', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 1 })]);
    const matches = [
      makeMatch({ id: 'm1', time: Date.UTC(2021, 0, 2), win: true, eventName: 'Ultimate Singles' }),
      makeMatch({
        id: 'm2',
        time: Date.UTC(2021, 0, 2),
        win: false,
        eventName: 'Ultimate Singles',
      }),
    ];
    renderRecentEvents(matches);

    await screen.findByText('Ultimate Singles');
    expect(screen.getByText('1–1')).toBeInTheDocument();
    expect(screen.queryByText(/of \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Seed/)).not.toBeInTheDocument();
  });

  it('links each row to the tournament detail page', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, tournamentName: 'The Big House 9' }),
    ]);
    renderRecentEvents([]);

    await screen.findByText('The Big House 9');
    expect(screen.getByRole('link')).toHaveAttribute('href', '/tournaments/42');
  });

  it('caps at LIST_CAP_RAIL (5) with a show-all control and a terminus link to /tournaments', async () => {
    listTournaments.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        makeEntry({
          eventId: i + 1,
          tournamentName: `Event ${i + 1}`,
          lastSetAt: Date.now() - i * 60_000,
        }),
      ),
    );
    renderRecentEvents([]);

    await screen.findByText('Event 1');
    expect(screen.getAllByRole('link').length).toBe(5);
    const showAll = screen.getByRole('button', { name: 'Show all 8' });
    expect(showAll).toBeInTheDocument();
  });
});
