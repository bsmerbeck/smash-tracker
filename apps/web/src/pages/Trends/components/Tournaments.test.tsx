import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
  analyticsFilterStorageKey,
} from '@/context/AnalyticsFilterContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { Tournaments, buildTournamentEntryRows } from './Tournaments';

const DAY_MS = 24 * 60 * 60 * 1000;

function seedRange(range: string) {
  window.localStorage.setItem(
    ANALYTICS_FILTER_STORAGE_KEY,
    JSON.stringify({ source: 'all', range }),
  );
}

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
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
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
    // Phase 7: GET /api/tournaments always fills entryKey from the RTDB
    // child key on read — defaulted to match the numeric eventId here so
    // existing fixtures keep routing the same way.
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
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/trends" element={<Tournaments matches={matches} />} />
              <Route path="/tournaments/:eventId" element={<div>Tournament detail page</div>} />
              <Route path="/settings/integrations" element={<div>Integrations page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Tournaments component', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
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

  /**
   * Quick 260901-tj7 (D-04): a NON-imported row scoped to zero matches (the
   * global analytics filter emptied it, not `admin-imported` origin) must
   * not render a fabricated `100%` — `getWinLossRecord` returns `winRate:
   * 100` for a 0-0 record. W-L and Games stay real zero counts; only the
   * Rate cell is keyed on `record.total === 0`.
   */
  it('renders em-dash Rate — not a fabricated 100% — for a non-imported row scoped to zero matches', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, tournamentName: 'The Big House 9' }),
    ]);
    renderTournaments([]);

    await screen.findByRole('link', { name: 'The Big House 9' });
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.getByText('0-0')).toBeInTheDocument();
    // Only the Rate cell is unknown; W-L and Games render real zero counts.
    expect(screen.getAllByText('—')).toHaveLength(1);
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

  it('links a parry.gg row on its entryKey, never a numeric eventId', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: undefined,
        entryKey: 'pgg-the-big-house-9',
        tournamentName: 'The Big House 9',
        source: 'parrygg',
      }),
    ]);
    renderTournaments([]);

    const link = await screen.findByRole('link', { name: 'The Big House 9' });
    expect(link).toHaveAttribute('href', '/tournaments/pgg-the-big-house-9');
    expect(screen.queryByRole('link', { name: 'View on start.gg' })).not.toBeInTheDocument();
  });

  /** Phase 30.3 (Gate 4): admin-imported historical rows. */
  describe('admin-imported rows', () => {
    function makeImportedEntry(overrides: Record<string, unknown> = {}): TournamentEntry {
      return makeEntry({
        origin: 'admin-imported',
        provider: 'startgg',
        ...overrides,
      } as Partial<TournamentEntry>);
    }

    it('badges imported rows and renders the public-data footnote', async () => {
      listTournaments.mockResolvedValue([
        makeImportedEntry({ eventId: 42, tournamentName: 'The Big House 9' }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'The Big House 9' });
      expect(screen.getByText('Imported')).toBeInTheDocument();
      expect(
        screen.getByText(/"Imported" rows are snapshots of public tournament data/),
      ).toBeInTheDocument();
    });

    it('does not badge manual/linked rows or render the footnote without imported rows', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'Ultimate Singles' });
      expect(screen.queryByText('Imported')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/"Imported" rows are snapshots of public tournament data/),
      ).not.toBeInTheDocument();
    });

    it("renders the import's own event dates when recorded", async () => {
      listTournaments.mockResolvedValue([
        makeImportedEntry({
          eventId: 42,
          startAtMs: Date.UTC(2024, 5, 10, 12),
          endAtMs: Date.UTC(2024, 5, 11, 12),
        }),
      ]);
      renderTournaments([]);

      expect(await screen.findByText('Jun 10, 2024 – Jun 11, 2024')).toBeInTheDocument();
    });

    it('renders em-dash record cells — not a fabricated 0-0 — when no local matches link', async () => {
      listTournaments.mockResolvedValue([makeImportedEntry({ eventId: 42 })]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'Ultimate Singles' });
      // W/L, Rate, and Games all render the missing marker.
      expect(screen.getAllByText('—')).toHaveLength(3);
      expect(screen.queryByText('0-0')).not.toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('still derives a real record from the same matchesForEntry dataset when matches exist', async () => {
      listTournaments.mockResolvedValue([makeImportedEntry({ eventId: 42 })]);
      const matches = [
        makeMatch({
          id: 'm1',
          time: Date.UTC(2021, 0, 2),
          win: true,
          eventName: 'Ultimate Singles',
        }),
        makeMatch({
          id: 'm2',
          time: Date.UTC(2021, 0, 2),
          win: false,
          eventName: 'Ultimate Singles',
        }),
      ];
      renderTournaments(matches);

      await screen.findByRole('link', { name: 'Ultimate Singles' });
      expect(screen.getByText('1-1')).toBeInTheDocument();
      expect(screen.getByText('50%')).toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });
  });

  /** Quick 260902-bm9: the registry rows now filter by the global time range. */
  describe('range filtering (quick 260902-bm9)', () => {
    it('hides an out-of-range entry and keeps an in-range one (D-01)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Old Regional',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'Recent Regional',
          firstSetAt: Date.now() - 10 * DAY_MS,
          lastSetAt: Date.now() - 10 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'Recent Regional' });
      expect(screen.queryByRole('link', { name: 'Old Regional' })).not.toBeInTheDocument();
    });

    it("renders everything and shows no notice for 'all' (D-03)", async () => {
      seedRange('all');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Old Regional',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'Recent Regional',
          firstSetAt: Date.now() - 10 * DAY_MS,
          lastSetAt: Date.now() - 10 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'Old Regional' });
      expect(screen.getByRole('link', { name: 'Recent Regional' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show all time' })).not.toBeInTheDocument();
      expect(screen.queryByText(/outside the last/)).not.toBeInTheDocument();
    });

    it('keeps an undated entry visible under a narrow range (D-01)', async () => {
      seedRange('3m');
      listTournaments.mockResolvedValue([
        makeEntry({ eventId: 1, tournamentName: 'Undated Open', firstSetAt: 0, lastSetAt: 0 }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'Undated Open' });
    });

    it('keeps an upcoming entry visible under a narrow range (D-01)', async () => {
      seedRange('3m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Next Month Major',
          firstSetAt: Date.now() + 20 * DAY_MS,
          lastSetAt: Date.now() + 20 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'Next Month Major' });
    });

    it('shows a singular footer count when exactly one tournament is hidden (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'In Range',
          firstSetAt: Date.now() - 10 * DAY_MS,
          lastSetAt: Date.now() - 10 * DAY_MS,
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'Out Of Range',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'In Range' });
      expect(screen.getByText('1 tournament outside the last 12m.')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Tournament' })).toBeInTheDocument();
    });

    it('shows a plural footer count when more than one tournament is hidden (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'In Range',
          firstSetAt: Date.now() - 10 * DAY_MS,
          lastSetAt: Date.now() - 10 * DAY_MS,
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'Out Of Range A',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
        makeEntry({
          eventId: 3,
          tournamentName: 'Out Of Range B',
          firstSetAt: Date.now() - 500 * DAY_MS,
          lastSetAt: Date.now() - 500 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByRole('link', { name: 'In Range' });
      expect(screen.getByText('2 tournaments outside the last 12m.')).toBeInTheDocument();
    });

    it('replaces the table with the notice when the range hides every entry, and never falls back to the resync hint (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Out Of Range A',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'Out Of Range B',
          firstSetAt: Date.now() - 500 * DAY_MS,
          lastSetAt: Date.now() - 500 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByText('2 tournaments outside the last 12m.');
      expect(
        screen.queryByText(/Tournament entries attach on your next start\.gg sync/),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Tournament' })).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('widens to all time and reveals hidden rows when Show all time is clicked, persisting the range (D-03, D-07)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Old Regional',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'Even Older Regional',
          firstSetAt: Date.now() - 500 * DAY_MS,
          lastSetAt: Date.now() - 500 * DAY_MS,
        }),
      ]);
      renderTournaments([]);

      await screen.findByText('2 tournaments outside the last 12m.');

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Show all time' }));

      await waitFor(() => {
        expect(screen.getByRole('link', { name: 'Old Regional' })).toBeInTheDocument();
      });
      expect(screen.queryByText(/outside the last/)).not.toBeInTheDocument();
      expect(
        JSON.parse(window.localStorage.getItem(analyticsFilterStorageKey('test-uid', null))!).range,
      ).toBe('all');
    });

    it('shows the resync hint (not a range notice) when the registry is genuinely empty (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([]);
      renderTournaments([]);

      expect(
        await screen.findByText(/Tournament entries attach on your next start\.gg sync/),
      ).toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'Integrations' });
      expect(link).toHaveAttribute('href', '/settings/integrations');
      expect(screen.queryByText(/outside the last/)).not.toBeInTheDocument();
    });
  });
});
