import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { Tournaments, buildTournamentEntryRows } from './Tournaments';

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

const listTournaments = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
  },
}));

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 3),
    setsPlayed: 2,
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

describe('buildTournamentEntryRows', () => {
  it('computes a per-entry record scoped by matchesForEntry', () => {
    const entry = makeEntry({ eventId: 1, eventName: 'Ultimate Singles' });
    const matches = [
      makeMatch({ id: 'm1', time: Date.UTC(2021, 0, 2), win: true, eventName: 'Ultimate Singles' }),
      makeMatch({
        id: 'm2',
        time: Date.UTC(2021, 0, 2),
        win: false,
        eventName: 'Ultimate Singles',
      }),
      makeMatch({ id: 'm3', time: Date.UTC(2021, 0, 2), win: true, eventName: 'Doubles' }),
    ];
    const rows = buildTournamentEntryRows([entry], matches);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.record).toMatchObject({ wins: 1, losses: 1, total: 2 });
  });

  it('sorts entries by lastSetAt descending', () => {
    const older = makeEntry({ eventId: 1, lastSetAt: Date.UTC(2020, 0, 1) });
    const newer = makeEntry({ eventId: 2, lastSetAt: Date.UTC(2022, 0, 1) });
    const rows = buildTournamentEntryRows([older, newer], []);
    expect(rows.map((r) => r.entry.eventId)).toEqual([2, 1]);
  });
});

function renderTournaments(matches: Match[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/trends']}>
        <AuthProvider>
          <Routes>
            <Route path="/trends" element={<Tournaments matches={matches} />} />
            <Route path="/tournaments/:eventId" element={<div>Tournament detail page</div>} />
            <Route path="/settings/integrations" element={<div>Integrations page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Tournaments component', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('shows the resync hint when there are no tournament entries', async () => {
    listTournaments.mockResolvedValue([]);
    renderTournaments([]);

    expect(
      await screen.findByText(/Tournament entries attach on your next start\.gg sync/),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Integrations' });
    expect(link).toHaveAttribute('href', '/settings/integrations');
  });

  it('renders a table row per tournament entry, linking to the detail page', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, eventName: 'Ultimate Singles', tournamentName: 'The Big House 9' }),
    ]);
    const matches = [
      makeMatch({
        id: 'm1',
        time: Date.UTC(2021, 0, 2),
        win: true,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      }),
    ];
    renderTournaments(matches);

    const link = await screen.findByRole('link', { name: 'The Big House 9' });
    expect(link).toHaveAttribute('href', '/tournaments/42');
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(
      screen.queryByText(/Tournament entries attach on your next start\.gg sync/),
    ).not.toBeInTheDocument();
  });

  it('falls back to eventName as the link label when tournamentName is absent', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 7, eventName: 'Ultimate Singles' })]);
    renderTournaments([]);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Ultimate Singles' })).toHaveAttribute(
        'href',
        '/tournaments/7',
      );
    });
  });

  it('shows an outbound start.gg icon-link when the entry has a slug', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, slug: 'tournament/the-box-juice-box-26' }),
    ]);
    renderTournaments([]);

    const link = await screen.findByRole('link', { name: 'View on start.gg' });
    expect(link).toHaveAttribute('href', 'https://start.gg/tournament/the-box-juice-box-26');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('omits the start.gg icon-link when the entry has no slug', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, slug: undefined })]);
    renderTournaments([]);

    await screen.findByRole('link', { name: 'Ultimate Singles' });
    expect(screen.queryByRole('link', { name: 'View on start.gg' })).not.toBeInTheDocument();
  });
});
