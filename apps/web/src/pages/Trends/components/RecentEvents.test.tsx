import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
} from '@/context/AnalyticsFilterContext';
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

function renderRecentEvents(matches: Match[], allMatches: Match[] = matches) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/trends']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route
                path="/trends"
                element={<RecentEvents matches={matches} allMatches={allMatches} />}
              />
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

  describe('plan 41-04: the card-scoped "All time" override (B3, DD-41-10)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    function setRange(range: string, source = 'all') {
      window.localStorage.setItem(ANALYTICS_FILTER_STORAGE_KEY, JSON.stringify({ source, range }));
    }

    /** `recentCount` entries inside the last 30 days, `oldCount` back in 2021 (outside every range). */
    function entriesAcrossRange(recentCount: number, oldCount: number): TournamentEntry[] {
      return [
        ...Array.from({ length: recentCount }, (_, i) =>
          makeEntry({
            eventId: 100 + i,
            tournamentName: `Recent ${i}`,
            firstSetAt: Date.now() - (10 + i) * DAY,
            lastSetAt: Date.now() - (10 + i) * DAY + 1_000,
          }),
        ),
        ...Array.from({ length: oldCount }, (_, i) =>
          makeEntry({
            eventId: 200 + i,
            tournamentName: `Old ${i}`,
            firstSetAt: Date.UTC(2021, 0, 1 + i * 7),
            lastSetAt: Date.UTC(2021, 0, 3 + i * 7),
          }),
        ),
      ];
    }

    it('range "all": no control and no outside-range line', async () => {
      setRange('all');
      listTournaments.mockResolvedValue(entriesAcrossRange(1, 3));
      renderRecentEvents([]);

      await screen.findByText('Recent 0');
      expect(screen.queryByRole('button', { name: 'All time' })).not.toBeInTheDocument();
      expect(screen.queryByText(/outside the current range/)).not.toBeInTheDocument();
    });

    it('nothing hidden by the range: no control and no line', async () => {
      setRange('3m');
      listTournaments.mockResolvedValue(entriesAcrossRange(2, 0));
      renderRecentEvents([]);

      await screen.findByText('Recent 0');
      expect(screen.queryByRole('button', { name: 'All time' })).not.toBeInTheDocument();
      expect(screen.queryByText(/outside the current range/)).not.toBeInTheDocument();
    });

    it('one hidden entry reads the singular line, three read the count', async () => {
      setRange('3m');
      listTournaments.mockResolvedValue(entriesAcrossRange(1, 1));
      const one = renderRecentEvents([]);
      expect(await screen.findByText('1 more outside the current range')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      one.unmount();

      listTournaments.mockResolvedValue(entriesAcrossRange(1, 3));
      renderRecentEvents([]);
      expect(await screen.findByText('3 more outside the current range')).toBeInTheDocument();
    });

    it('All time lists every entry with honest out-of-range records, states the note, and Back to range restores the range list; the global range is never written', async () => {
      setRange('3m');
      listTournaments.mockResolvedValue(entriesAcrossRange(1, 2));
      const oldMatches = [
        makeMatch({
          id: 'o1',
          time: Date.UTC(2021, 0, 2),
          win: true,
          eventName: 'Ultimate Singles',
          tournamentName: 'Old 0',
        }),
        makeMatch({
          id: 'o2',
          time: Date.UTC(2021, 0, 2, 1),
          win: true,
          eventName: 'Ultimate Singles',
          tournamentName: 'Old 0',
        }),
        makeMatch({
          id: 'o3',
          time: Date.UTC(2021, 0, 2, 2),
          win: false,
          eventName: 'Ultimate Singles',
          tournamentName: 'Old 0',
        }),
      ];
      const user = userEvent.setup();
      // The range-filtered matches exclude the 2021 games; ALL own-account matches keep them.
      renderRecentEvents([], oldMatches);
      const storedBefore = window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY);

      await screen.findByText('Recent 0');
      expect(screen.queryByText('Old 0')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'All time' }));
      const pressed = screen.getByRole('button', { name: 'Back to range' });
      expect(pressed).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Old 0')).toBeInTheDocument();
      expect(screen.getByText('Old 1')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Showing all time — the source filter still applies; the range filter still scopes every other card.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/more outside the current range/)).not.toBeInTheDocument();
      // An out-of-range row's record comes from all own-account matches, not 0–0.
      expect(screen.getAllByText('2–1').length).toBeGreaterThan(0);

      await user.click(pressed);
      expect(screen.queryByText('Old 0')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY)).toBe(storedBefore);
    });

    // 41-REVIEW WR-04: "All time" overrides only the range. With the source filter on "manual" the
    // all-time rows must not start counting start.gg games the range-mode rows excluded.
    it("WR-04: All time keeps the global source filter, so a row's W-L does not change when start.gg games join", async () => {
      setRange('3m', 'manual');
      listTournaments.mockResolvedValue(entriesAcrossRange(1, 1));
      const game = (id: string, hour: number, win: boolean, source?: 'startgg') =>
        makeMatch({
          id,
          time: Date.UTC(2021, 0, 2, hour),
          win,
          eventName: 'Ultimate Singles',
          tournamentName: 'Old 0',
          ...(source ? { source } : {}),
        });
      const allMatches = [
        game('m1', 0, true),
        game('m2', 1, false),
        game('s1', 2, true, 'startgg'),
        game('s2', 3, true, 'startgg'),
        game('s3', 4, true, 'startgg'),
      ];
      const user = userEvent.setup();
      renderRecentEvents([], allMatches);

      await screen.findByText('Recent 0');
      await user.click(screen.getByRole('button', { name: 'All time' }));
      expect(screen.getByText('Old 0')).toBeInTheDocument();
      // Manual-only: 1 win, 1 loss. The three start.gg wins are filtered out, not added (4–1).
      expect(screen.getAllByText('1–1').length).toBeGreaterThan(0);
      expect(screen.queryByText('4–1')).not.toBeInTheDocument();
    });

    it('the all-time list is still capped at the rail cap with a show-all control', async () => {
      setRange('3m');
      listTournaments.mockResolvedValue(entriesAcrossRange(1, 7));
      const user = userEvent.setup();
      renderRecentEvents([]);

      await screen.findByText('Recent 0');
      await user.click(screen.getByRole('button', { name: 'All time' }));
      expect(screen.getAllByRole('link').length).toBe(5);
      expect(screen.getByRole('button', { name: 'Show all 8' })).toBeInTheDocument();
    });

    it('remounting resets the override (in-memory only)', async () => {
      setRange('3m');
      listTournaments.mockResolvedValue(entriesAcrossRange(1, 1));
      const user = userEvent.setup();
      const first = renderRecentEvents([]);
      await screen.findByText('Recent 0');
      await user.click(screen.getByRole('button', { name: 'All time' }));
      expect(screen.getByText('Old 0')).toBeInTheDocument();
      first.unmount();

      renderRecentEvents([]);
      await screen.findByText('Recent 0');
      expect(screen.queryByText('Old 0')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
  });
});
