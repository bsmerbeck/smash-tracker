import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
  analyticsFilterStorageKey,
} from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TournamentsPage } from './TournamentsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const DAY_MS = 24 * 60 * 60 * 1000;

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

function seedRange(range: string) {
  window.localStorage.setItem(
    ANALYTICS_FILTER_STORAGE_KEY,
    JSON.stringify({ source: 'all', range }),
  );
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  const eventId = (overrides.eventId as number | undefined) ?? 1;
  return {
    eventId,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 5, 1),
    lastSetAt: Date.UTC(2021, 5, 3),
    setsPlayed: 2,
    // GET /api/tournaments always fills entryKey from the RTDB child key on read.
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

function renderPage(initialEntry = '/tournaments') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/tournaments" element={<TournamentsPage />} />
                <Route path="/tournaments/:eventId" element={<div>Tournament detail page</div>} />
                <Route path="/dashboard" element={<div>Dashboard page</div>} />
                <Route path="/settings/integrations" element={<div>Integrations page</div>} />
              </Routes>
            </TooltipProvider>
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
    listMatches.mockResolvedValue([]);
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
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        tournamentName: 'The Big House 9',
        firstSetAt: Date.UTC(2024, 5, 10),
        lastSetAt: Date.UTC(2024, 5, 10),
        setsPlayed: 5,
        origin: 'admin-imported',
        provider: 'startgg',
      }),
    ]);

    renderPage();

    expect(await screen.findByRole('link', { name: 'The Big House 9' })).toHaveAttribute(
      'href',
      '/tournaments/42',
    );
    // T-08: the per-row badge is gone; the one footnote line says it once.
    expect(screen.queryByText('Imported')).not.toBeInTheDocument();
    expect(
      screen.getByText(/"Imported" rows are snapshots of public tournament data/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'No tournaments yet — sync your start.gg or parry.gg matches and check back here!',
      ),
    ).not.toBeInTheDocument();
  });

  it('shows the resync hint when there are matches but no tournament entries', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: Date.UTC(2021, 5, 2), win: true })]);
    listTournaments.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(/Tournament entries attach on your next start\.gg sync/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('renders a row per entry with a scoped record, linking to the detail page', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, tournamentName: 'The Big House 9' }),
    ]);
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        time: Date.UTC(2021, 5, 2),
        win: true,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      }),
    ]);
    renderPage();

    expect(await screen.findByRole('link', { name: 'The Big House 9' })).toHaveAttribute(
      'href',
      '/tournaments/42',
    );
    expect(screen.getByText('Ultimate Singles')).toBeInTheDocument();
    expect(screen.getByText('1–0')).toBeInTheDocument();
    expect(
      screen.queryByText(/Tournament entries attach on your next start\.gg sync/),
    ).not.toBeInTheDocument();
  });

  it('marks the page loaded only once data has settled (never on the skeleton)', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, tournamentName: 'Big House' })]);
    const { container } = renderPage();

    expect(container.querySelector('[data-slot="tournaments-body"]')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();

    await screen.findByRole('link', { name: 'Big House' });
    expect(container.querySelectorAll('[data-slot="tournaments-body"]')).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the error branch when the registry fails to load, never a table', async () => {
    listTournaments.mockRejectedValue(new Error('boom'));
    const { container } = renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Tournaments couldn't be loaded. The data is safe — try again.",
    );
    expect(container.querySelector('[data-slot="tournaments-body"]')).toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  describe('TIER-02 tracer: /tournaments?tier=supermajor', () => {
    function sparg0Shaped() {
      return [
        makeEntry({
          eventId: 1,
          tournamentName: 'Supernova 2026',
          eventName: 'Ultimate Singles',
          firstSetAt: Date.UTC(2026, 7, 8),
          lastSetAt: Date.UTC(2026, 7, 9),
          numEntrants: 2048,
          placement: 3,
          seed: 8,
          isOnline: false,
          slug: 'tournament/supernova-2026',
        }),
        makeEntry({
          eventId: 2,
          tournamentName: 'The Cashbox #33',
          firstSetAt: Date.UTC(2026, 6, 1),
          lastSetAt: Date.UTC(2026, 6, 1),
          numEntrants: 96,
          placement: 9,
          seed: 7,
          isOnline: true,
        }),
        makeEntry({
          eventId: 3,
          tournamentName: 'Pre S Factor X3',
          eventName: 'Squad Strike',
          firstSetAt: Date.UTC(2026, 4, 20),
          lastSetAt: Date.UTC(2026, 4, 20),
          isOnline: false,
        }),
      ];
    }

    it('shows every event with no filter, tier and provenance on each', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage();

      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(screen.getByRole('link', { name: 'The Cashbox #33' })).toBeInTheDocument();
      // T-06: with no `side` param the table SHOWS side events, with their badge.
      expect(screen.getByRole('link', { name: 'Pre S Factor X3' })).toBeInTheDocument();
      expect(screen.getByText('Side event')).toBeInTheDocument();
    });

    it('with ?tier=supermajor only Supernova renders, with its badge, provenance, 3rd / 2,048, seed delta and record', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: Date.UTC(2026, 7, 8, 12),
          win: true,
          eventName: 'Ultimate Singles',
          tournamentName: 'Supernova 2026',
        }),
        makeMatch({
          id: 'm2',
          time: Date.UTC(2026, 7, 8, 13),
          win: false,
          eventName: 'Ultimate Singles',
          tournamentName: 'Supernova 2026',
        }),
      ]);
      renderPage('/tournaments?tier=supermajor');

      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(screen.queryByRole('link', { name: 'The Cashbox #33' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Pre S Factor X3' })).not.toBeInTheDocument();

      const row = screen.getByRole('link', { name: 'Supernova 2026' }).closest('tr') as HTMLElement;
      expect(within(row).getByText('Supermajor')).toBeInTheDocument();
      expect(within(row).getByText('Estimated from 2,048 entrants')).toBeInTheDocument();
      expect(within(row).getByText('3rd / 2,048')).toBeInTheDocument();
      expect(within(row).getByText('+5')).toBeInTheDocument();
      expect(within(row).getByText('1–1')).toBeInTheDocument();
    });

    it('side=hide removes side events from the table', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage('/tournaments?side=hide');

      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(screen.queryByRole('link', { name: 'Pre S Factor X3' })).not.toBeInTheDocument();
      expect(screen.queryByText('Side event')).not.toBeInTheDocument();
    });

    it('setting=online keeps only the online event', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage('/tournaments?setting=online');

      await screen.findByRole('link', { name: 'The Cashbox #33' });
      expect(screen.queryByRole('link', { name: 'Supernova 2026' })).not.toBeInTheDocument();
    });

    it('an unknown tier word reads as the filter being absent', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage('/tournaments?tier=foo&setting=x&side=y');

      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(screen.getByRole('link', { name: 'The Cashbox #33' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Pre S Factor X3' })).toBeInTheDocument();
    });

    it('filters that leave zero rows show the filter-empty line, never an empty table body', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      const { container } = renderPage('/tournaments?tier=regional');

      expect(await screen.findByText('No events match these filters.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(container.querySelector('tbody')).toBeNull();
    });

    it('Clear filters on the empty line restores the full list', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage('/tournaments?tier=regional');

      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Clear filters' }));
      expect(await screen.findByRole('link', { name: 'Supernova 2026' })).toBeInTheDocument();
    });

    it('never writes a filter to device-local storage', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage('/tournaments?tier=supermajor&setting=offline&side=hide');
      await screen.findByRole('link', { name: 'Supernova 2026' });

      const stored = Object.keys(window.localStorage).map((key) =>
        window.localStorage.getItem(key),
      );
      expect(stored.join('|')).not.toMatch(/supermajor|offline|hide/);
    });
  });

  /** Phase 30.3 (Gate 4): admin-imported historical rows. */
  describe('admin-imported rows', () => {
    const imported = { origin: 'admin-imported', provider: 'startgg' };

    it('renders em-dash record cells — not a fabricated 0–0 — when no local matches link', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42, ...imported })]);
      renderPage();

      await screen.findByRole('link', { name: 'Ultimate Singles' });
      expect(screen.queryByText('0–0')).not.toBeInTheDocument();
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('still derives a real record from the same matchesForEntry dataset when matches exist', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42, ...imported })]);
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: Date.UTC(2021, 5, 2),
          win: true,
          eventName: 'Ultimate Singles',
        }),
        makeMatch({
          id: 'm2',
          time: Date.UTC(2021, 5, 2),
          win: false,
          eventName: 'Ultimate Singles',
        }),
      ]);
      renderPage();

      await screen.findByRole('link', { name: 'Ultimate Singles' });
      expect(screen.getByText('1–1')).toBeInTheDocument();
      // Two games is under the abstention floor: the record and n render, the rate does not.
      expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    });

    it('does not render the footnote without imported rows', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
      renderPage();

      await screen.findByRole('link', { name: 'Ultimate Singles' });
      expect(
        screen.queryByText(/"Imported" rows are snapshots of public tournament data/),
      ).not.toBeInTheDocument();
    });
  });

  /** Quick 260902-bm9: the registry rows filter by the global time range. */
  describe('range filtering (quick 260902-bm9)', () => {
    const recent = (eventId: number, name: string, daysAgo: number) =>
      makeEntry({
        eventId,
        tournamentName: name,
        firstSetAt: Date.now() - daysAgo * DAY_MS,
        lastSetAt: Date.now() - daysAgo * DAY_MS,
      });

    it('hides an out-of-range entry and keeps an in-range one (D-01)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        recent(1, 'Old Regional', 400),
        recent(2, 'Recent Regional', 10),
      ]);
      renderPage();

      await screen.findByRole('link', { name: 'Recent Regional' });
      expect(screen.queryByRole('link', { name: 'Old Regional' })).not.toBeInTheDocument();
    });

    it("renders everything and shows no notice for 'all' (D-03)", async () => {
      seedRange('all');
      listTournaments.mockResolvedValue([
        recent(1, 'Old Regional', 400),
        recent(2, 'Recent Regional', 10),
      ]);
      renderPage();

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
      renderPage();

      await screen.findByRole('link', { name: 'Undated Open' });
      expect(screen.getByText('No date')).toBeInTheDocument();
    });

    it('shows a singular footer count when exactly one tournament is hidden (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        recent(1, 'In Range', 10),
        recent(2, 'Out Of Range', 400),
      ]);
      renderPage();

      await screen.findByRole('link', { name: 'In Range' });
      expect(screen.getByText('1 tournament outside the last 12m.')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Tier' })).toBeInTheDocument();
    });

    it('shows a plural footer count when more than one tournament is hidden (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        recent(1, 'In Range', 10),
        recent(2, 'Out Of Range A', 400),
        recent(3, 'Out Of Range B', 500),
      ]);
      renderPage();

      await screen.findByRole('link', { name: 'In Range' });
      expect(screen.getByText('2 tournaments outside the last 12m.')).toBeInTheDocument();
    });

    it('replaces the table with the notice when the range hides every entry, and never falls back to the resync hint (D-03)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        recent(1, 'Out Of Range A', 400),
        recent(2, 'Out Of Range B', 500),
      ]);
      renderPage();

      await screen.findByText('2 tournaments outside the last 12m.');
      expect(
        screen.queryByText(/Tournament entries attach on your next start\.gg sync/),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('widens to all time and reveals hidden rows when Show all time is clicked, persisting the range (D-03, D-07)', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        recent(1, 'Old Regional', 400),
        recent(2, 'Even Older Regional', 500),
      ]);
      renderPage();

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
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: Date.now() - DAY_MS, win: true }),
      ]);
      listTournaments.mockResolvedValue([]);
      renderPage();

      expect(
        await screen.findByText(/Tournament entries attach on your next start\.gg sync/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/outside the last/)).not.toBeInTheDocument();
    });
  });
});
