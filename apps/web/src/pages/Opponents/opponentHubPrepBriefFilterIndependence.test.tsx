import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  analyticsFilterStorageKey,
} from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { OpponentHubPage } from './OpponentHubPage';

/**
 * Code review WEB-02: the hub's prep-brief card is a navigation affordance,
 * not an analytics figure, so its inputs (the shared-event list and the
 * identity resolver) must not depend on the Dashboard's global source/range
 * filter. A `manual` source filter removes a synced event's games from the
 * FILTERED match set; the card's debrief door for that event must survive it.
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
const getPrep = vi.fn();
const upsertMe = vi.fn();
const getMe = vi.fn();
const listAliases = vi.fn();
const listNotes = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: { list: (...args: unknown[]) => listMatches(...args) },
    tournaments: { list: (...args: unknown[]) => listTournaments(...args) },
    prep: { get: (...args: unknown[]) => getPrep(...args) },
    opponents: {
      aliases: { list: (...args: unknown[]) => listAliases(...args) },
      notes: { list: (...args: unknown[]) => listNotes(...args) },
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();
const SUMMIT_AT = NOW - 3 * DAY_MS;

function makeMatch(id: string, time: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...extra,
  };
}

function renderHub() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/opponents/rival']}>
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

async function cardState(): Promise<string | null> {
  await screen.findByTestId('hub-prep-brief-card');
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return screen.getByTestId('hub-prep-brief-card').getAttribute('data-state');
}

describe('Opponent hub prep-brief card ignores the global analytics filter (code review WEB-02)', () => {
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
    // One synced past event both players attended, whose server status is
    // inside the fourteen-day debrief window.
    listTournaments.mockResolvedValue([
      {
        entryKey: 'summit',
        eventName: 'Summit',
        firstSetAt: SUMMIT_AT - HOUR_MS,
        lastSetAt: SUMMIT_AT + HOUR_MS,
        setsPlayed: 2,
        source: 'startgg',
      },
    ]);
    getPrep.mockImplementation((entryKey: string) =>
      Promise.resolve(
        entryKey === 'summit' ? { activated: true, reviewAt: NOW - DAY_MS } : { activated: false },
      ),
    );
    listAliases.mockResolvedValue({});
    listNotes.mockResolvedValue({});
    listMatches.mockResolvedValue([
      // Manual games (kept by the `manual` source filter).
      makeMatch('m1', 1),
      makeMatch('m2', 2),
      // The synced Summit games (removed by the `manual` source filter).
      makeMatch('s1', SUMMIT_AT, { source: 'startgg', eventName: 'Summit' }),
      makeMatch('s2', SUMMIT_AT + 10 * 60 * 1000, { source: 'startgg', eventName: 'Summit' }),
    ]);
    setMockUser(makeMockUser());
  });

  it('control: with no filter active the shared synced event opens the debrief door', async () => {
    renderHub();
    expect(await cardState()).toBe('debrief');
    expect(screen.getByRole('link', { name: 'Review this event' })).toHaveAttribute(
      'href',
      '/tournaments/summit/prep',
    );
  });

  it('a manual source filter that hides the synced event leaves the debrief door unchanged', async () => {
    window.localStorage.setItem(
      analyticsFilterStorageKey('test-uid', null),
      JSON.stringify({ source: 'manual', range: 'all' }),
    );
    renderHub();
    expect(await cardState()).toBe('debrief');
    expect(screen.getByRole('link', { name: 'Review this event' })).toHaveAttribute(
      'href',
      '/tournaments/summit/prep',
    );
  });
});
