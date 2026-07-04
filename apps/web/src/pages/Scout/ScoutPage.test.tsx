import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ScoutPage } from './ScoutPage';
import { ApiError } from '@/lib/api';
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

const scoutLookup = vi.fn();
const matchesList = vi.fn().mockResolvedValue([]);
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    api: {
      scout: { lookup: (...args: unknown[]) => scoutLookup(...args) },
      matches: { list: (...args: unknown[]) => matchesList(...args) },
      users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    },
    ApiError: MockApiError,
  };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/scout']}>
        <AuthProvider>
          <Routes>
            <Route path="/scout" element={<ScoutPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const REPORT = {
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  sampledSets: 3,
  sampledGames: 6,
  characters: [{ fighterId: 67, games: 6, wins: 4 }],
  stages: [{ stageId: 1, games: 6, wins: 4 }],
  recentEvents: [
    {
      eventName: 'Ultimate Singles',
      tournamentName: 'Genesis 9',
      placement: 33,
      numEntrants: 1024,
      lastSetAt: 1_700_000_000_000,
    },
  ],
  commonOpponents: [{ gamerTag: 'PowPow', sets: 2 }],
};

describe('ScoutPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    matchesList.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  it('shows the empty prompt before a search is submitted', () => {
    renderPage();
    expect(
      screen.getByText(/Paste a start\.gg profile URL, slug, or player id above/),
    ).toBeInTheDocument();
  });

  it('submits the query and renders the report', async () => {
    const user = userEvent.setup();
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();

    await user.type(
      screen.getByLabelText(/start\.gg profile URL, slug, or player id/),
      'https://start.gg/user/07dc2239',
    );
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    await waitFor(() =>
      expect(scoutLookup).toHaveBeenCalledWith({ query: 'https://start.gg/user/07dc2239' }),
    );
    expect(await screen.findByText('Pandem1c')).toBeInTheDocument();
    expect(screen.getByText(/Public start\.gg data · sampled last 3 sets/)).toBeInTheDocument();
    expect(screen.getByText('PowPow')).toBeInTheDocument();
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
  });

  it('shows a friendly message on a 404', async () => {
    const user = userEvent.setup();
    scoutLookup.mockRejectedValue(new ApiError(404, 'No start.gg player found for that query'));

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/doesnotexist');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByText(/We couldn't find a start\.gg player/)).toBeInTheDocument();
  });

  it('shows a friendly message on a 429', async () => {
    const user = userEvent.setup();
    scoutLookup.mockRejectedValue(new ApiError(429, 'rate limited'));

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByText(/rate-limiting requests/)).toBeInTheDocument();
  });

  it('shows the "Your History vs Them" strip when the scouted tag matches an existing opponent', async () => {
    const user = userEvent.setup();
    matchesList.mockResolvedValue([
      {
        id: 'm1',
        fighter_id: 1,
        opponent_id: 2,
        time: 1_700_000_000_000,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'pandem1c',
        notes: '',
        matchType: 'quickplay',
        win: true,
      },
      {
        id: 'm2',
        fighter_id: 1,
        opponent_id: 2,
        time: 1_700_100_000_000,
        map: { id: 1, name: 'Battlefield' },
        opponent: 'pandem1c',
        notes: '',
        matchType: 'quickplay',
        win: false,
      },
    ]);
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    expect(await screen.findByText('Your History vs Them')).toBeInTheDocument();
    expect(screen.getByText('1-1', { exact: false })).toBeInTheDocument();
  });

  it('does not show the history strip when the scouted tag has no match history', async () => {
    const user = userEvent.setup();
    matchesList.mockResolvedValue([]);
    scoutLookup.mockResolvedValue(REPORT);

    renderPage();
    await user.type(screen.getByLabelText(/start\.gg profile URL/), 'user/07dc2239');
    await user.click(screen.getByRole('button', { name: 'Scout' }));

    await screen.findByText('Pandem1c');
    expect(screen.queryByText('Your History vs Them')).not.toBeInTheDocument();
  });
});
