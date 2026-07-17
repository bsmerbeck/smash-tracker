import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { TournamentDetailPage } from './TournamentDetailPage';
import { SpriteList } from '@/data/sprites';

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
const listTournaments = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  const eventId = overrides.eventId ?? 42;
  return {
    eventId,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 1, 6),
    setsPlayed: 1,
    // Phase 7: GET /api/tournaments always fills entryKey from the RTDB
    // child key on read — defaulted here to match the numeric eventId so
    // existing fixtures keep routing the same way without every call site
    // needing to pass one explicitly.
    entryKey: String(eventId),
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    eventName: 'Ultimate Singles',
    source: 'startgg',
    ...overrides,
  };
}

function renderPage(eventId = '42') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tournaments/${eventId}`]}>
        <AuthProvider>
          <TooltipProvider>
            <Routes>
              <Route path="/tournaments/:eventId" element={<TournamentDetailPage />} />
              <Route path="/trends" element={<div>Trends page</div>} />
            </Routes>
          </TooltipProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TournamentDetailPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('shows a friendly not-found state for an unknown eventId', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
    listMatches.mockResolvedValue([]);

    renderPage('999');

    expect(await screen.findByText('Tournament not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Trends' })).toHaveAttribute('href', '/trends');
  });

  it('renders the header, set timeline, characters/stages, and retrospective for a known entry', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        numEntrants: 512,
        seed: 408,
        placement: 257,
      }),
    ]);
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'g1',
        time: Date.UTC(2021, 0, 1, 1),
        win: true,
        externalId: 'sgg:100:g1',
        roundText: 'Winners Round 1',
        tournamentName: 'The Big House 9',
      }),
      makeMatch({
        id: 'g2',
        time: Date.UTC(2021, 0, 1, 1, 5),
        win: true,
        externalId: 'sgg:100:g2',
        roundText: 'Winners Round 1',
        tournamentName: 'The Big House 9',
      }),
    ]);

    renderPage('42');

    // Header: tournament name, seed->placement badge.
    expect(await screen.findByText('The Big House 9')).toBeInTheDocument();
    expect(screen.getByText('Outperformed seed: 408 → 257')).toBeInTheDocument();
    expect(screen.getByText('512 entrants')).toBeInTheDocument();

    // Event Results: resync hint when topStandings hasn't synced.
    expect(screen.getByText('Event Results')).toBeInTheDocument();
    expect(screen.getByText('Full results attach on your next start.gg sync.')).toBeInTheDocument();

    // Set timeline: the single set's round label and result.
    expect(screen.getByText('Set Timeline')).toBeInTheDocument();
    expect(screen.getAllByText('Winners Round 1').length).toBeGreaterThan(0);

    // Characters & stages summary cards.
    expect(screen.getByText('Your Characters')).toBeInTheDocument();
    expect(screen.getByText(/Opponents/)).toBeInTheDocument();
    expect(screen.getByText('Stages Played')).toBeInTheDocument();

    // Advisor Retrospective renders (all-no-data since there's no pre-tournament history).
    expect(screen.getByText('Advisor Retrospective')).toBeInTheDocument();
    expect(
      screen.getByText('Not enough pre-tournament data to grade these picks.'),
    ).toBeInTheDocument();
  });

  it('omits the seed/placement badge cleanly when absent', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, seed: undefined, placement: undefined }),
    ]);
    listMatches.mockResolvedValue([]);

    renderPage('42');

    await screen.findByText('Set Timeline');
    expect(screen.queryByText(/Outperformed seed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Underperformed seed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Matched seed/)).not.toBeInTheDocument();
  });

  it('renders Event Results with a winner callout and start.gg deep link when synced', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        slug: 'tournament/the-box-juice-box-26',
        eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
        topStandings: [
          { placement: 1, name: 'Champ', gamerTag: 'Champ' },
          { placement: 2, name: 'RunnerUp', gamerTag: 'RunnerUp' },
        ],
      }),
    ]);
    listMatches.mockResolvedValue([]);

    renderPage('42');

    await screen.findByText('Event Results');
    expect(screen.getByText('Champ won this event')).toBeInTheDocument();
    expect(screen.getByText('RunnerUp')).toBeInTheDocument();

    const startggLink = screen.getByRole('link', { name: /View on start\.gg/ });
    expect(startggLink).toHaveAttribute(
      'href',
      'https://start.gg/tournament/the-box-juice-box-26/event/ultimate-singles',
    );
  });

  it('renders a parry.gg entry gracefully — no numeric eventId, no start.gg links', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: undefined,
        entryKey: 'pgg-the-big-house-9',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        source: 'parrygg',
        slug: undefined,
        eventSlug: undefined,
        topStandings: undefined,
      }),
    ]);
    listMatches.mockResolvedValue([]);

    renderPage('pgg-the-big-house-9');

    expect(await screen.findByText('The Big House 9')).toBeInTheDocument();
    // Event Results falls back to the resync hint since topStandings never
    // synced for a parry.gg entry — no crash, no start.gg-only affordance.
    expect(screen.getByText('Full results attach on your next start.gg sync.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on start\.gg/ })).not.toBeInTheDocument();
  });
});
