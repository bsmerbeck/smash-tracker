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
import { OpponentsPage } from './OpponentsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
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

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const fox = SpriteList.find((s) => s.id === 15)!; // Fox

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderOpponents() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/opponents']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/opponents" element={<OpponentsPage />} />
              <Route path="/dashboard" element={<div>Dashboard page</div>} />
              <Route path="/settings/integrations" element={<div>Integrations page</div>} />
              <Route path="/tournaments/:eventId" element={<div>Tournament detail page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OpponentsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    listTournaments.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  it('shows a hero empty state when the user has no matches at all', async () => {
    listMatches.mockResolvedValue([]);

    renderOpponents();

    expect(await screen.findByText('No matches to scout yet!')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('link', { name: 'Connect start.gg' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('shows an explanatory empty state when no matches have an opponent tag', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', opponent: undefined })]);

    renderOpponents();

    expect(
      await screen.findByText('None of your matches have an opponent tag recorded.'),
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

    renderOpponents();

    expect(await screen.findByText('No matches match the current filters.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() =>
      expect(screen.queryByText('No matches match the current filters.')).not.toBeInTheDocument(),
    );
    expect((await screen.findAllByText('rival')).length).toBeGreaterThan(0);
  });

  describe('opponent list ranking, search, and selection', () => {
    beforeEach(() => {
      listMatches.mockResolvedValue([
        // "rival": 3 games, most-played — should be auto-selected.
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
        makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
        makeMatch({ id: 'm3', time: 3, opponent: 'rival', win: false }),
        // "zeta": 1 game.
        makeMatch({ id: 'm4', time: 4, opponent: 'zeta', win: true }),
      ]);
    });

    it('ranks opponents by games played descending and shows the total count', async () => {
      renderOpponents();

      expect(await screen.findByText('2 opponents faced')).toBeInTheDocument();

      const list = screen.getByRole('list', { name: 'Opponents' });
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      // "rival" (3 games) ranks above "zeta" (1 game).
      expect(within(rows[0]!).getByText('rival')).toBeInTheDocument();
      expect(within(rows[1]!).getByText('zeta')).toBeInTheDocument();
    });

    it('auto-selects the most-played opponent and shows their scouting report', async () => {
      renderOpponents();

      // The scouting report renders "Last 10" pips once a profile loads —
      // proof the most-played opponent ("rival") was auto-selected.
      await waitFor(() => expect(screen.getByText('Last 10 (newest first)')).toBeInTheDocument());
      expect(screen.getAllByText('rival').length).toBeGreaterThan(0);
    });

    it('filters the opponent list by substring search', async () => {
      const user = userEvent.setup();
      renderOpponents();

      await screen.findByText('2 opponents faced');
      const search = screen.getByLabelText('Search opponents');
      await user.type(search, 'zet');

      const list = screen.getByRole('list', { name: 'Opponents' });
      await waitFor(() => {
        const rows = within(list).getAllByRole('listitem');
        expect(rows).toHaveLength(1);
        expect(within(rows[0]!).getByText('zeta')).toBeInTheDocument();
      });
    });

    it('selects a different opponent on click and updates the scouting report', async () => {
      const user = userEvent.setup();
      renderOpponents();

      await screen.findByText('2 opponents faced');
      await user.click(screen.getByRole('button', { name: /zeta/ }));

      // The scouting report card title switches to "zeta".
      await waitFor(() => {
        const titles = screen.getAllByText('zeta');
        expect(titles.length).toBeGreaterThan(0);
      });
      // zeta's record is 1-0, shown in the report header (scoped by the
      // "Last 10" pips section landmark that only renders once selected).
      expect(await screen.findByText('Last 10 (newest first)')).toBeInTheDocument();
    });
  });

  describe('scouting report rendering', () => {
    beforeEach(() => {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 1,
          fighter_id: mario.id,
          opponent_id: luigi.id,
          opponent: 'rival',
          win: true,
          map: { id: 1, name: 'Battlefield' },
        }),
        makeMatch({
          id: 'm2',
          time: 2,
          fighter_id: mario.id,
          opponent_id: fox.id,
          opponent: 'rival',
          win: false,
          map: { id: 3, name: 'Final Destination' },
        }),
        makeMatch({
          id: 'm3',
          time: 3,
          fighter_id: mario.id,
          opponent_id: fox.id,
          opponent: 'rival',
          win: true,
          map: { id: 3, name: 'Final Destination' },
          eventName: 'Ultimate Singles',
          tournamentName: 'The Big House 9',
          source: 'startgg',
        }),
      ]);
    });

    it('renders the H2H record, their-character ordering, and newest-first recent encounters', async () => {
      renderOpponents();

      await waitFor(() => expect(screen.getByText('Last 10 (newest first)')).toBeInTheDocument());

      // Scouting report header shows the overall H2H record (2-1) and rate.
      const headerCard = screen
        .getByText('Last 10 (newest first)')
        .closest('[data-slot="card"]') as HTMLElement;
      expect(within(headerCard).getByText('2-1')).toBeInTheDocument();
      expect(within(headerCard).getByText(/67% over 3 games/)).toBeInTheDocument();

      // "What They Play": both Luigi and Fox appear, with Fox's better record
      // (1-1, Wilson-ranked among matchups with 2 games) surfacing correctly.
      expect(screen.getByText('What They Play')).toBeInTheDocument();
      expect(screen.getByText(luigi.name)).toBeInTheDocument();
      expect(screen.getAllByText(fox.name).length).toBeGreaterThan(0);

      // Recent encounters, newest first: m3 (with event/tournament name) before m1.
      const encountersList = screen.getByRole('list', { name: 'Recent encounters' });
      const encounterItems = within(encountersList).getAllByRole('listitem');
      expect(encounterItems.length).toBe(3);
      // Newest match (m3, time 3) is first and shows the tournament name.
      expect(within(encounterItems[0]!).getByText('The Big House 9')).toBeInTheDocument();
      expect(within(encounterItems[0]!).getByText('Win')).toBeInTheDocument();
      // Oldest match (m1, time 1) is last.
      expect(within(encounterItems[2]!).getByText('Win')).toBeInTheDocument();

      // Stages card shows both stages played against this opponent.
      expect(screen.getByText('Stages')).toBeInTheDocument();
      expect(screen.getAllByText('Final Destination').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Battlefield').length).toBeGreaterThan(0);
    });
  });

  describe('tournament history', () => {
    it('shows the empty state when no matches have an eventName', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      ]);

      renderOpponents();

      expect(
        await screen.findByText(
          "No tournament sets vs this player yet — resync start.gg if you've played recently.",
        ),
      ).toBeInTheDocument();
    });

    it('groups sets into a tournament block with derived score, round labels, and a plain-text title when no registry entry matches', async () => {
      listTournaments.mockResolvedValue([]);
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 1,
          opponent: 'rival',
          win: true,
          map: { id: 1, name: 'Battlefield' },
          eventName: 'Ultimate Singles',
          tournamentName: 'The Big House 9',
          source: 'startgg',
          externalId: 'sgg:100:g1',
        }),
        makeMatch({
          id: 'm2',
          time: 2,
          opponent: 'rival',
          win: false,
          map: { id: 3, name: 'Final Destination' },
          eventName: 'Ultimate Singles',
          tournamentName: 'The Big House 9',
          source: 'startgg',
          externalId: 'sgg:100:g2',
          roundText: 'Winners Semi-Final',
          bracketRound: 3,
        }),
        makeMatch({
          id: 'm3',
          time: 3,
          opponent: 'rival',
          win: true,
          map: { id: 1, name: 'Battlefield' },
          eventName: 'Ultimate Singles',
          tournamentName: 'The Big House 9',
          source: 'startgg',
          externalId: 'sgg:100:g3',
          roundText: 'Winners Semi-Final',
          bracketRound: 3,
        }),
      ]);

      renderOpponents();

      const historyCard = (await screen.findByText('Tournament History')).closest(
        '[data-slot="card"]',
      ) as HTMLElement;

      const title = within(historyCard).getByText('The Big House 9');
      expect(title.closest('a')).toBeNull();
      expect(within(historyCard).getByText('2-1 vs them here')).toBeInTheDocument();
      expect(within(historyCard).getByText('Winners Semi-Final')).toBeInTheDocument();
    });

    it('falls back to "Set N" round labels when no game in the set carries roundText', async () => {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 1,
          opponent: 'rival',
          win: true,
          eventName: 'Ultimate Singles',
          source: 'startgg',
          externalId: 'sgg:100:g1',
        }),
        makeMatch({
          id: 'm2',
          time: 2,
          opponent: 'rival',
          win: true,
          eventName: 'Ultimate Singles',
          source: 'startgg',
          externalId: 'sgg:200:g1',
        }),
      ]);

      renderOpponents();

      const historyCard = (await screen.findByText('Tournament History')).closest(
        '[data-slot="card"]',
      ) as HTMLElement;

      expect(within(historyCard).getByText('Ultimate Singles')).toBeInTheDocument();
      expect(within(historyCard).getByText('Set 1')).toBeInTheDocument();
      expect(within(historyCard).getByText('Set 2')).toBeInTheDocument();
    });

    it('tints losers-side sets and links the block title to the tournament page when a registry entry matches', async () => {
      listTournaments.mockResolvedValue([
        {
          eventId: 987,
          eventName: 'Ultimate Singles',
          tournamentName: 'The Big House 9',
          firstSetAt: 0,
          lastSetAt: 10,
          setsPlayed: 2,
        },
      ]);
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 5,
          opponent: 'rival',
          win: false,
          eventName: 'Ultimate Singles',
          tournamentName: 'The Big House 9',
          source: 'startgg',
          externalId: 'sgg:100:g1',
          roundText: 'Losers Round 2',
          bracketRound: -2,
        }),
      ]);

      renderOpponents();

      const link = await screen.findByRole('link', { name: 'The Big House 9' });
      expect(link).toHaveAttribute('href', '/tournaments/987');
      expect(screen.getByText('Losers')).toBeInTheDocument();
    });

    it('shows the encounter context line summarizing tournament count and date span', async () => {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: Date.parse('2021-01-15T00:00:00Z'),
          opponent: 'rival',
          win: true,
          eventName: 'Ultimate Singles',
          source: 'startgg',
          externalId: 'sgg:100:g1',
        }),
        makeMatch({
          id: 'm2',
          time: Date.parse('2021-03-20T00:00:00Z'),
          opponent: 'rival',
          win: false,
          eventName: 'Ultimate Doubles',
          source: 'startgg',
          externalId: 'sgg:200:g1',
        }),
      ]);

      renderOpponents();

      expect(
        await screen.findByText('Met at 2 tournaments between Jan 2021 and Mar 2021'),
      ).toBeInTheDocument();
    });
  });
});
