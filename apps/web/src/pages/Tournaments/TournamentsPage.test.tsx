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
    // The By-tier card repeats the same record, so the row's own cell is scoped to the table.
    expect(within(screen.getByRole('table')).getByText('1–0')).toBeInTheDocument();
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

      const empty = await screen.findByText('No events match these filters.');
      expect(
        within(empty.closest('[data-slot="tournaments-filter-empty"]') as HTMLElement).getByRole(
          'button',
          { name: 'Clear filters' },
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(container.querySelector('tbody')).toBeNull();
    });

    it('Clear filters on the empty line restores the full list', async () => {
      listTournaments.mockResolvedValue(sparg0Shaped());
      renderPage('/tournaments?tier=regional');

      const user = userEvent.setup();
      const empty = (await screen.findByText('No events match these filters.')).closest(
        '[data-slot="tournaments-filter-empty"]',
      ) as HTMLElement;
      await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
      expect(await screen.findByRole('link', { name: 'Supernova 2026' })).toBeInTheDocument();
      expect(screen.queryByText('No events match these filters.')).not.toBeInTheDocument();
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

  describe('tier filter chips on the page (D-13, faceted counts)', () => {
    function mixed() {
      return [
        makeEntry({
          eventId: 1,
          tournamentName: 'Supernova 2026',
          numEntrants: 2048,
          isOnline: false,
        }),
        makeEntry({ eventId: 2, tournamentName: 'Genesis', numEntrants: 600, isOnline: false }),
        makeEntry({ eventId: 3, tournamentName: 'Big Local', numEntrants: 130, isOnline: false }),
        makeEntry({ eventId: 4, tournamentName: 'Weekly One', numEntrants: 40, isOnline: true }),
        makeEntry({ eventId: 5, tournamentName: 'Weekly Two', numEntrants: 44, isOnline: true }),
      ];
    }

    it('mounts the chips as the page filter row with a stable vocabulary and faceted counts', async () => {
      listTournaments.mockResolvedValue(mixed());
      renderPage();

      await screen.findByRole('link', { name: 'Supernova 2026' });
      const tiers = screen.getByRole('toolbar', { name: 'Tier' });
      expect(
        within(tiers)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([
        'Supermajor (1)',
        'Major (1)',
        'Minor (0)',
        'Regional (1)',
        'Local (0)',
        'Tier unknown (2)',
      ]);
      expect(screen.getByRole('button', { name: 'Minor (0)' })).toBeDisabled();
    });

    it('a tier count changes with the setting filter and NOT with the tier selection', async () => {
      listTournaments.mockResolvedValue(mixed());
      renderPage('/tournaments?setting=online');
      await screen.findByRole('link', { name: 'Weekly One' });
      // With setting=online only the two online events are counted; both are unknown.
      expect(screen.getByRole('button', { name: 'Tier unknown (2)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Supermajor (0)' })).toBeInTheDocument();
    });

    it('selecting a tier does not move any tier count', async () => {
      listTournaments.mockResolvedValue(mixed());
      renderPage('/tournaments?tier=supermajor');
      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(screen.getByRole('button', { name: 'Supermajor (1)' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Major (1)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Regional (1)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Tier unknown (2)' })).toBeInTheDocument();
      // The table is filtered, the counts are not.
      expect(screen.queryByRole('link', { name: 'Genesis' })).not.toBeInTheDocument();
    });

    it('a chip press filters the table through the URL and keeps a zero-count chip visible', async () => {
      listTournaments.mockResolvedValue(mixed());
      renderPage();
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Major (1)' }));
      expect(await screen.findByRole('link', { name: 'Genesis' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Supernova 2026' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Major (1)' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // The setting chips now count only major events: no online major exists, so
      // Online is disabled with its zero, and Offline says pressing it keeps one row.
      expect(screen.getByRole('button', { name: 'Online (0)' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Offline (1)' })).not.toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Major (1)' }));
      expect(await screen.findByRole('link', { name: 'Supernova 2026' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Online (2)' })).not.toBeDisabled();
    });

    it('cross-fades the results on a chip change and never under reduced motion', async () => {
      listTournaments.mockResolvedValue(mixed());
      const { container } = renderPage();
      await screen.findByRole('link', { name: 'Supernova 2026' });
      const results = container.querySelector('[data-slot="tournaments-results"]') as HTMLElement;
      expect(results.className).toMatch(/animate-in/);
      expect(results.className).toMatch(/duration-\[120ms\]/);
      expect(results.className).toMatch(/motion-reduce:animate-none/);
    });

    it('renders no chips when the range hides every event', async () => {
      seedRange('12m');
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Old',
          firstSetAt: Date.now() - 400 * DAY_MS,
          lastSetAt: Date.now() - 400 * DAY_MS,
        }),
      ]);
      renderPage();
      await screen.findByText('1 tournament outside the last 12m.');
      expect(screen.queryByRole('toolbar', { name: 'Tier' })).not.toBeInTheDocument();
    });
  });

  /** Phase 30.3 (Gate 4): admin-imported historical rows. */
  describe('By tier card (TIER-03, T-05, T-06, DD-12)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** `count` linked games for `name`: the first `wins` are wins. Inside the entry's window, matched by names. */
    function linked(
      name: string,
      day: number,
      wins: number,
      losses: number,
      extra: Partial<Match> = {},
    ): Match[] {
      return Array.from({ length: wins + losses }, (_, i) =>
        makeMatch({
          id: `${name}-${i}`,
          time: Date.UTC(2026, 0, 1) + day * DAY + i * 1000,
          win: i < wins,
          eventName: 'Ultimate Singles',
          tournamentName: name,
          matchType: 'offline-tourney',
          ...extra,
        }),
      );
    }

    function eventAt(id: number, name: string, day: number, extra: Record<string, unknown> = {}) {
      return makeEntry({
        eventId: id,
        tournamentName: name,
        firstSetAt: Date.UTC(2026, 0, 1) + day * DAY,
        lastSetAt: Date.UTC(2026, 0, 1) + day * DAY + 3600 * 1000,
        ...extra,
      });
    }

    /** 19 events: 7 with an estimated tier (1 supermajor, 1 minor, 2 regional, 3 local) and 12 online (unknown). */
    function sparg0Nineteen() {
      const entries = [
        eventAt(1, 'Supernova 2026', 0, { numEntrants: 2048, isOnline: false }),
        eventAt(2, 'Mid Minor', 10, { numEntrants: 300, isOnline: false }),
        eventAt(3, 'Regional A', 20, { numEntrants: 100, isOnline: false }),
        eventAt(4, 'Regional B', 30, { numEntrants: 90, isOnline: false }),
        eventAt(5, 'Local A', 40, { numEntrants: 20, isOnline: false }),
        eventAt(6, 'Local B', 50, { numEntrants: 22, isOnline: false }),
        eventAt(7, 'Local C', 60, { numEntrants: 24, isOnline: false }),
        ...Array.from({ length: 12 }, (_, i) =>
          eventAt(100 + i, `Weekly ${i}`, 70 + i * 7, { numEntrants: 40, isOnline: true }),
        ),
      ];
      const matches = [
        ...linked('Supernova 2026', 0, 26, 7),
        // One game: below the abstention floor, two more needed.
        ...linked('Mid Minor', 10, 1, 0),
        ...linked('Regional A', 20, 4, 1),
        ...linked('Local A', 40, 3, 1),
        ...linked('Weekly 0', 70, 6, 4, { matchType: 'online-tourney' }),
      ];
      return { entries, matches };
    }

    async function renderNineteen(initialEntry = '/tournaments') {
      const { entries, matches } = sparg0Nineteen();
      listTournaments.mockResolvedValue(entries);
      listMatches.mockResolvedValue(matches);
      const view = renderPage(initialEntry);
      await screen.findByRole('heading', { name: 'By tier' });
      return view;
    }

    function tierRow(container: HTMLElement, tier: string) {
      return container.querySelector<HTMLElement>(`[data-slot="by-tier-row"][data-tier="${tier}"]`);
    }

    it('sparg0-shaped data shows Supermajor 26–7 · 79%, a Minor that needs more games, Unknown excluded and the coverage line', async () => {
      const { container } = await renderNineteen();

      const supermajor = tierRow(container, 'supermajor')!;
      expect(supermajor.textContent).toContain('26–7');
      expect(supermajor.textContent).toContain('79%');
      expect(supermajor.querySelector('[data-slot="by-tier-bar"]')).not.toBeNull();

      const minor = tierRow(container, 'minor')!;
      expect(
        within(minor).getByText('Minor — 2 more games needed for a rate.'),
      ).toBeInTheDocument();
      expect(minor.querySelector('[data-slot="by-tier-bar"]')).toBeNull();

      const rows = Array.from(container.querySelectorAll('[data-slot="by-tier-row"]'));
      expect(rows.map((row) => row.getAttribute('data-tier'))).toEqual([
        'supermajor',
        'minor',
        'regional',
        'local',
        'unknown',
      ]);
      const unknown = rows[rows.length - 1] as HTMLElement;
      expect(within(unknown).getByText('excluded from the comparison')).toBeInTheDocument();
      expect(unknown.textContent).toContain('6–4');

      expect(container.querySelector('[data-slot="tier-coverage"]')?.textContent).toBe(
        'Tier known for 7 of 19 events · 0 recorded · 7 estimated · 12 unknown',
      );
    });

    it('sits above the events table as Row A, beside the tier insight (8 + 4)', async () => {
      const { container } = await renderNineteen();
      const card = container.querySelector('[data-slot="by-tier-card"]')!;
      const table = container.querySelector('table')!;
      expect(card.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const cardCell = card.closest('[data-span]')!;
      expect(cardCell.getAttribute('data-span')).toBe('8');
      expect(cardCell.className).toContain('xl:col-span-8');
      // 1024-1279: the card takes the whole row and the insight sits above it.
      expect(cardCell.className).toContain('lg:col-span-12');
    });

    it('a by-tier row is a filter door: it keeps setting and never lands a game list', async () => {
      const { container } = await renderNineteen('/tournaments?setting=offline');
      const link = tierRow(container, 'supermajor')!.querySelector('a')!;
      const params = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
      expect(params.get('tier')).toBe('supermajor');
      expect(params.get('setting')).toBe('offline');
      expect(container.querySelector('#games')).toBeNull();

      const user = userEvent.setup();
      await user.click(link);
      // Now filtered to the one tier: the card shows that row only, and still no game list.
      await waitFor(() =>
        expect(container.querySelectorAll('[data-slot="by-tier-row"]')).toHaveLength(1),
      );
      expect(container.querySelector('#games')).toBeNull();
      expect(container.querySelector('[data-slot="filtered-match-list"]')).toBeNull();
    });

    it('the card follows the URL filters: ?tier=local counts only local events', async () => {
      const { container } = await renderNineteen('/tournaments?tier=local');
      const rows = Array.from(container.querySelectorAll('[data-slot="by-tier-row"]'));
      expect(rows.map((row) => row.getAttribute('data-tier'))).toEqual(['local']);
      expect(container.querySelector('[data-slot="tier-coverage"]')?.textContent).toBe(
        'Tier known for 3 of 3 events · 0 recorded · 3 estimated · 0 unknown',
      );
    });

    it('renders no card when the filters leave zero rows, only the filter-empty line', async () => {
      listTournaments.mockResolvedValue(sparg0Nineteen().entries);
      const { container } = renderPage('/tournaments?tier=major');
      await screen.findByText('No events match these filters.');
      expect(container.querySelector('[data-slot="by-tier-card"]')).toBeNull();
    });

    it('renders no card when the registry is empty, only the resync hint', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: Date.UTC(2021, 5, 2), win: true }),
      ]);
      listTournaments.mockResolvedValue([]);
      const { container } = renderPage();
      await screen.findByText(/Tournament entries attach on your next start\.gg sync/);
      expect(container.querySelector('[data-slot="by-tier-card"]')).toBeNull();
    });

    it('an all-unknown account shows the Unknown row, the coverage line and the all-unknown sentence', async () => {
      listTournaments.mockResolvedValue([
        eventAt(1, 'Weekly One', 0, { numEntrants: 40, isOnline: true }),
        eventAt(2, 'Weekly Two', 7, { numEntrants: 44, isOnline: true }),
      ]);
      listMatches.mockResolvedValue(linked('Weekly One', 0, 2, 1, { matchType: 'online-tourney' }));
      const { container } = renderPage();
      await screen.findByRole('heading', { name: 'By tier' });
      expect(container.querySelectorAll('[data-slot="by-tier-row"]')).toHaveLength(1);
      expect(
        screen.getByText("No event has a known tier yet — set one from an event's page."),
      ).toBeInTheDocument();
      expect(container.querySelector('[data-slot="tier-coverage"]')?.textContent).toBe(
        'Tier known for 0 of 2 events · 0 recorded · 0 estimated · 2 unknown',
      );
    });

    describe('the tier insight (TIER-03, D-14, D-16)', () => {
      function insightCell(container: HTMLElement) {
        return container
          .querySelector('[data-slot="tier-insight-card"]')
          ?.closest('[data-span]') as HTMLElement | null;
      }

      it('renders the tier insight in a 4-column cell beside the card at 1280+, and above it below', async () => {
        const { container } = await renderNineteen();
        const cell = insightCell(container)!;
        expect(cell.getAttribute('data-span')).toBe('4');
        expect(cell.className).toContain('xl:col-span-4');
        // 1024-1279 the insight is its own 12-column row, first; from 1280 it is back in DOM order.
        expect(cell.className).toContain('lg:col-span-12');
        expect(cell.className).toContain('order-first');
        expect(cell.className).toContain('xl:order-none');
        expect(
          screen.getByText(
            'Majors and above — 79% vs 80% at smaller events over 43 games; no notable gap.',
          ),
        ).toBeInTheDocument();
      });

      it("the counted-games door lands on #games with exactly the insight's games", async () => {
        HTMLElement.prototype.scrollIntoView = vi.fn();
        const { container } = await renderNineteen();
        const door = within(insightCell(container)!).getByRole('link', {
          name: 'See the 43 games',
        });
        await userEvent.click(door);
        const terminus = await waitFor(() => {
          const el = container.querySelector('#games');
          if (!el) throw new Error('#games did not mount');
          return el as HTMLElement;
        });
        await waitFor(() =>
          expect(within(terminus).getByRole('table').getAttribute('data-total-rows')).toBe('43'),
        );
        // The list holds the cohorts' games and none of the 10 Unknown-tier weekly games.
        expect(terminus.querySelector('[data-slot="claim-not-applied"]')).toBeNull();
      });

      it('Show these events filters the table to majors and above without landing a game list', async () => {
        const { container } = await renderNineteen();
        await userEvent.click(
          within(insightCell(container)!).getByRole('link', { name: 'Show these events' }),
        );
        await waitFor(() =>
          expect(
            Array.from(container.querySelectorAll('[data-slot="by-tier-row"]')).map((row) =>
              row.getAttribute('data-tier'),
            ),
          ).toEqual(['supermajor']),
        );
        expect(container.querySelector('#games')).toBeNull();
      });

      it('dismissing the insight gives the By-tier card all 12 columns', async () => {
        const { container } = await renderNineteen();
        await userEvent.click(
          within(insightCell(container)!).getByRole('button', { name: 'Dismiss' }),
        );
        await waitFor(() =>
          expect(container.querySelector('[data-slot="tier-insight-card"]')).toBeNull(),
        );
        const cardCell = container
          .querySelector('[data-slot="by-tier-card"]')!
          .closest('[data-span]')!;
        expect(cardCell.getAttribute('data-span')).toBe('12');
      });

      it('an all-unknown account gets the noTiers Fact with no door', async () => {
        listTournaments.mockResolvedValue([
          eventAt(1, 'Weekly One', 0, { numEntrants: 40, isOnline: true }),
          eventAt(2, 'Weekly Two', 7, { numEntrants: 44, isOnline: true }),
        ]);
        listMatches.mockResolvedValue(
          linked('Weekly One', 0, 2, 1, { matchType: 'online-tourney' }),
        );
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'By tier' });
        const cell = insightCell(container)!;
        expect(within(cell).getByText('Tier — no event has a known tier yet.')).toBeInTheDocument();
        expect(within(cell).queryAllByRole('link')).toHaveLength(0);
      });

      it('an unresolvable claim id is announced, never silently the whole history', async () => {
        const { container } = await renderNineteen('/tournaments?claim=tierGap:other:last30#games');
        await waitFor(() =>
          expect(container.querySelector('[data-slot="claim-not-applied"]')).not.toBeNull(),
        );
      });

      it('a claim from the side-included cohort does not resolve on the side-excluded one (T-39.2-38)', async () => {
        const { container } = await renderNineteen(
          '/tournaments?claim=tierGap:tier:side-included:last30#games',
        );
        await waitFor(() =>
          expect(container.querySelector('[data-slot="claim-not-applied"]')).not.toBeNull(),
        );
      });

      it('side=include switches the scope key, so the door claim changes with the cohort', async () => {
        const entries = [
          eventAt(1, 'Supernova 2026', 0, { numEntrants: 2048, isOnline: false }),
          eventAt(2, 'Local Weekly', 10, { numEntrants: 20, isOnline: false }),
          eventAt(3, 'Side Bracket', 20, {
            eventName: 'Squad Strike',
            numEntrants: 300,
            isOnline: false,
            tierOverride: { contractVersion: 1, tier: 'supermajor', setAtMs: 1 },
          }),
        ];
        listTournaments.mockResolvedValue(entries);
        listMatches.mockResolvedValue([
          ...linked('Supernova 2026', 0, 12, 2),
          ...linked('Local Weekly', 10, 6, 6),
          ...linked('Side Bracket', 20, 4, 0, { eventName: 'Squad Strike' }),
        ]);
        const { container } = renderPage('/tournaments?side=include');
        await screen.findByRole('heading', { name: 'By tier' });
        const cell = insightCell(container)!;
        const door = within(cell).getByRole('link', { name: /^See the \d+ games$/ });
        expect(door.textContent).toBe('See the 30 games');
        const href = new URL(door.getAttribute('href')!, 'http://x/tournaments');
        expect(href.searchParams.get('claim')).toBe('tierGap:tier:side-included:last30');
        expect(href.searchParams.get('side')).toBe('include');
      });
    });

    describe('one resolution for the card and the table (39.2-08 open item)', () => {
      it('a filter that hides a same-named event never hands its games to the one that stays', async () => {
        // Two same-named events a day apart: the online one (Unknown tier) is filtered out by
        // ?tier=supermajor, and its games sit inside the supermajor event's padded window.
        const entries = [
          eventAt(1, 'Same Open', 0, { numEntrants: 2048, isOnline: false }),
          eventAt(2, 'Same Open', 1, { numEntrants: 40, isOnline: true }),
        ];
        listTournaments.mockResolvedValue(entries);
        listMatches.mockResolvedValue([
          // `linked` ids are name-based, so the second event's games are re-keyed.
          ...linked('Same Open', 0, 7, 3),
          ...linked('Same Open', 1, 6, 0, { matchType: 'online-tourney' }).map((game, i) => ({
            ...game,
            id: `online-${i}`,
          })),
        ]);
        const { container } = renderPage('/tournaments?tier=supermajor');
        await screen.findByRole('heading', { name: 'By tier' });
        const row = container.querySelector('[data-slot="by-tier-row"][data-tier="supermajor"]')!;
        expect(row.textContent).toContain('7–3');
        expect(row.textContent).not.toContain('13–3');
      });
    });

    describe('side events (T-06)', () => {
      function withSideEvent() {
        const entries = [
          eventAt(1, 'Supernova 2026', 0, { numEntrants: 2048, isOnline: false }),
          eventAt(2, 'Side Bracket', 10, {
            eventName: 'Squad Strike',
            numEntrants: 300,
            isOnline: false,
            // A hand-set tier is the one way a side event has a tier of its own.
            tierOverride: { contractVersion: 1, tier: 'minor', setAtMs: 1 },
          }),
        ];
        const matches = [
          ...linked('Supernova 2026', 0, 4, 1),
          ...linked('Side Bracket', 10, 3, 0, { eventName: 'Squad Strike' }),
        ];
        return { entries, matches };
      }

      it('excludes them by default, stating the count with an Include link', async () => {
        const { entries, matches } = withSideEvent();
        listTournaments.mockResolvedValue(entries);
        listMatches.mockResolvedValue(matches);
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'By tier' });

        expect(screen.getByText('1 side event excluded')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Include' })).toBeInTheDocument();
        expect(tierRow(container, 'minor')).toBeNull();
      });

      it('?side=include joins the side event games to its tier row and switches the header to the included form', async () => {
        const { entries, matches } = withSideEvent();
        listTournaments.mockResolvedValue(entries);
        listMatches.mockResolvedValue(matches);
        const { container } = renderPage('/tournaments?side=include');
        await screen.findByRole('heading', { name: 'By tier' });

        expect(screen.getByText('1 side event included')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Exclude' })).toBeInTheDocument();
        const minor = tierRow(container, 'minor')!;
        expect(minor).not.toBeNull();
        expect(minor.textContent).toContain('3–0');
      });

      it('an un-overridden side event joins the Unknown bucket when included, never a real tier', async () => {
        const entries = [
          eventAt(1, 'Supernova 2026', 0, { numEntrants: 2048, isOnline: false }),
          eventAt(2, 'Side Bracket', 10, {
            eventName: 'Squad Strike',
            numEntrants: 300,
            isOnline: false,
          }),
        ];
        listTournaments.mockResolvedValue(entries);
        listMatches.mockResolvedValue([
          ...linked('Supernova 2026', 0, 4, 1),
          ...linked('Side Bracket', 10, 2, 1, { eventName: 'Squad Strike' }),
        ]);
        const { container } = renderPage('/tournaments?side=include');
        await screen.findByRole('heading', { name: 'By tier' });
        expect(tierRow(container, 'unknown')!.textContent).toContain('2–1');
        expect(tierRow(container, 'supermajor')!.textContent).toContain('4–1');
      });

      it('the Include link turns the setting on through the URL', async () => {
        const { entries, matches } = withSideEvent();
        listTournaments.mockResolvedValue(entries);
        listMatches.mockResolvedValue(matches);
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'By tier' });
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Include' }));
        expect(await screen.findByText('1 side event included')).toBeInTheDocument();
        expect(tierRow(container, 'minor')).not.toBeNull();
      });
    });
  });

  describe('the #games terminus (39.1 §10.3, DD-12)', () => {
    function seedTerminus() {
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 1,
          tournamentName: 'Supernova 2026',
          firstSetAt: Date.UTC(2026, 7, 8),
          lastSetAt: Date.UTC(2026, 7, 9),
          numEntrants: 2048,
          isOnline: false,
        }),
      ]);
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'vs-two',
          time: Date.UTC(2026, 7, 8, 12),
          win: true,
          opponent_id: 2,
          opponent: 'AlphaTag',
          eventName: 'Ultimate Singles',
          tournamentName: 'Supernova 2026',
        }),
        makeMatch({
          id: 'vs-three',
          time: Date.UTC(2026, 7, 8, 13),
          win: false,
          opponent_id: 3,
          opponent: 'BetaTag',
          eventName: 'Ultimate Singles',
          tournamentName: 'Supernova 2026',
        }),
      ]);
    }

    it('renders no #games element when the URL carries no drill axis', async () => {
      seedTerminus();
      const { container } = renderPage();
      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(container.querySelector('#games')).toBeNull();
      expect(container.querySelector('[data-slot="filtered-match-list"]')).toBeNull();
    });

    it('a param that is not a drill axis (an unknown key) mounts nothing', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?opponent=AlphaTag&tier=supermajor');
      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(container.querySelector('#games')).toBeNull();
    });

    it('a drill axis mounts #games as the last row, narrowed to only the matching games', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?vs=2');
      await screen.findByRole('link', { name: 'Supernova 2026' });

      const games = container.querySelector('#games') as HTMLElement;
      expect(games).not.toBeNull();
      expect(within(games).getByText('AlphaTag')).toBeInTheDocument();
      expect(within(games).queryByText('BetaTag')).not.toBeInTheDocument();
      // Row order: the By-tier card, then the events table, then the terminus.
      const card = container.querySelector('[data-slot="by-tier-card"]')!;
      const table = container.querySelector('table[data-slot="tournaments-table"]')!;
      expect(card.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(table.compareDocumentPosition(games) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(games.closest('.col-span-12')).not.toBeNull();
    });

    it('the terminus follows the URL: a different axis value shows the other game', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?vs=3');
      await screen.findByRole('link', { name: 'Supernova 2026' });
      const games = container.querySelector('#games') as HTMLElement;
      expect(within(games).getByText('BetaTag')).toBeInTheDocument();
      expect(within(games).queryByText('AlphaTag')).not.toBeInTheDocument();
    });

    it('an unknown claim id is announced as not applied, never silently treated as a narrowing', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?claim=tierGap:account:last30');
      await screen.findByRole('link', { name: 'Supernova 2026' });

      const games = container.querySelector('#games') as HTMLElement;
      expect(games).not.toBeNull();
      const notice = games.querySelector('[data-slot="claim-not-applied"]');
      expect(notice).not.toBeNull();
      expect(notice?.textContent?.trim()).not.toBe('');
      // The summary line never describes the unresolved claim as if it had applied.
      expect(games.textContent).not.toContain('tierGap');
    });

    it('a claim id that fails the shape check reads as no axis at all', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?claim=%3Cscript%3E');
      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(container.querySelector('#games')).toBeNull();
    });

    it('Clear filters on the terminus drops the axes and unmounts it, keeping the tier filters', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?vs=2&tier=supermajor');
      await screen.findByRole('link', { name: 'Supernova 2026' });
      const user = userEvent.setup();
      const games = container.querySelector('#games') as HTMLElement;
      await user.click(within(games).getByRole('button', { name: 'Clear filters' }));
      await waitFor(() => expect(container.querySelector('#games')).toBeNull());
      // The tier filter is not a drill axis, so the table is still filtered to Supermajor.
      expect(screen.getByRole('link', { name: 'Supernova 2026' })).toBeInTheDocument();
    });

    it('never writes a drill axis to device-local storage', async () => {
      seedTerminus();
      const { container } = renderPage('/tournaments?vs=2&claim=tierGap:account:last30');
      await screen.findByRole('link', { name: 'Supernova 2026' });
      expect(container.querySelector('#games')).not.toBeNull();
      const stored = Object.keys(window.localStorage).map((key) =>
        window.localStorage.getItem(key),
      );
      expect(stored.join('|')).not.toMatch(/tierGap|"vs"|vs=2/);
    });
  });

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
      expect(within(screen.getByRole('table')).getByText('1–1')).toBeInTheDocument();
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
