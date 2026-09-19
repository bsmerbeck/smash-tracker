import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as shared from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
} from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';
import { OpponentHubPage } from './OpponentHubPage';
import { OpponentsPage } from './OpponentsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 38-05 Task 3 (D-15/pitfall 7): the no-persisted-write oracle plus the
 * D-16 lazy-computation oracle.
 *
 * SCOPE (stated in both directions, per the plan's own requirement): this
 * harness renders the hub page directly and never mounts the authenticated
 * shell (`MainLayout`) — so `useAutoWidenEmptyRange`'s shipped once-per-
 * session write (Phase 35 D-02), mounted from `MainLayout.tsx:79` on every
 * authenticated route, is OUTSIDE this oracle's scope. What this oracle DOES
 * prove: the hub PAGE itself writes neither the persisted-selection key nor
 * the analytics-filter key on a URL-seeded arrival or a filter-chip/select
 * interaction — `persistSelection` (`usePersistedSelection.ts:193`/`:198`,
 * its only two real call sites) is never called because this page never
 * calls `usePersistedSelection` at all, and both `window.localStorage` and
 * `window.sessionStorage`'s own `setItem` are spied directly so the oracle
 * sees every write, not just the one it expects.
 */

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
const listNotes = vi.fn();

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
        upsert: vi.fn(),
        remove: vi.fn(),
      },
      notes: {
        list: (...args: unknown[]) => listNotes(...args),
        upsert: vi.fn(),
        remove: vi.fn(),
      },
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

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

function renderHub(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/opponents/:opponentTag" element={<OpponentHubPage />} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Scopes into the `ScoutingHeader` card — the head-to-head record can also appear elsewhere (a matrix cell, the printable packet), so an unscoped query is ambiguous. */
function headerCard(): HTMLElement {
  const title = document.querySelector('[data-slot="card-title"]');
  const card = title?.closest('[data-slot="card"]');
  if (!card) {
    throw new Error('ScoutingHeader card not found');
  }
  return card as HTMLElement;
}

function renderList(initialEntry = '/opponents') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/opponents" element={<OpponentsPage />} />
                <Route path="/opponents/:opponentTag" element={<div>Hub stub</div>} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Opponent hub: zero persisted writes on URL-seeded arrival (D-15)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
    listTournaments.mockResolvedValue([]);
    listAliases.mockResolvedValue({});
    listNotes.mockResolvedValue({});
    setMockUser(makeMockUser());
  });

  it('writes no persisted-selection or analytics-filter storage key on a URL-seeded arrival carrying every drill-down axis', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
    ]);

    const selectionKey = analyticsSelectionStorageKey('test-uid', null);
    const filterKey = ANALYTICS_FILTER_STORAGE_KEY;
    const beforeSelection = window.localStorage.getItem(selectionKey);
    const beforeFilter = window.localStorage.getItem(filterKey);

    const localStorageSpy = vi.spyOn(window.localStorage, 'setItem');
    const sessionStorageSpy = vi.spyOn(window.sessionStorage, 'setItem');

    renderHub(`/opponents/rival?fighter=${mario.id}&vs=${luigi.id}&stage=1`);

    await waitFor(() => expect(within(headerCard()).getByText('2-0')).toBeInTheDocument());

    const writtenKeys = [...localStorageSpy.mock.calls, ...sessionStorageSpy.mock.calls].map(
      (call) => call[0],
    );
    expect(writtenKeys).not.toContain(selectionKey);
    expect(
      writtenKeys.some((key) => typeof key === 'string' && key.includes('analyticsFilter')),
    ).toBe(false);
    expect(window.localStorage.getItem(selectionKey)).toBe(beforeSelection);
    expect(window.localStorage.getItem(filterKey)).toBe(beforeFilter);

    localStorageSpy.mockRestore();
    sessionStorageSpy.mockRestore();
  });

  it('writes no persisted-selection or analytics-filter storage key when interacting with a filter select', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false, map: { id: 3, name: 'Final Destination' } }),
    ]);

    const selectionKey = analyticsSelectionStorageKey('test-uid', null);
    const filterKey = ANALYTICS_FILTER_STORAGE_KEY;

    const localStorageSpy = vi.spyOn(window.localStorage, 'setItem');
    const sessionStorageSpy = vi.spyOn(window.sessionStorage, 'setItem');
    const user = userEvent.setup();

    renderHub('/opponents/rival');
    await waitFor(() => expect(within(headerCard()).getByText('1-1')).toBeInTheDocument());

    await user.click(screen.getAllByRole('combobox', { name: 'Stage' })[0]!);
    await user.click(screen.getByRole('option', { name: 'Battlefield' }));

    await waitFor(() => {
      const list = document.getElementById('opponent-hub-list') as HTMLElement;
      expect(within(list).getByText(/1 game/)).toBeInTheDocument();
    });

    const writtenKeys = [...localStorageSpy.mock.calls, ...sessionStorageSpy.mock.calls].map(
      (call) => call[0],
    );
    expect(writtenKeys).not.toContain(selectionKey);
    expect(writtenKeys).not.toContain(filterKey);

    localStorageSpy.mockRestore();
    sessionStorageSpy.mockRestore();
  });

  it('the opponents LIST route does not call the engine cross-tab or event-series builders', async () => {
    const crossTabSpy = vi.spyOn(shared, 'buildOpponentCrossTab');
    const eventSeriesSpy = vi.spyOn(shared, 'buildOpponentEventSeries');

    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false, opponent: 'zeta' }),
    ]);

    renderList();

    await waitFor(() => expect(screen.getByText('2 opponents faced')).toBeInTheDocument());

    expect(crossTabSpy).not.toHaveBeenCalled();
    expect(eventSeriesSpy).not.toHaveBeenCalled();

    crossTabSpy.mockRestore();
    eventSeriesSpy.mockRestore();
  });
});
