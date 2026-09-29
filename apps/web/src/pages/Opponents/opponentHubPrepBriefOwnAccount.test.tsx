import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { OpponentHubPage } from './OpponentHubPage';
import { HubPrepBriefCard } from './components/HubPrepBriefCard';

/**
 * Plan 39-12 (PREP-05, D-10, review C2-M4): the INVERSE of
 * `opponentHubCoachParity.test.tsx`. That file proves the hub's existing
 * content is identical under the personal, coach and workspace route
 * families; this one proves the new prep-brief card is present on the
 * personal route and ABSENT — not disabled, absent — under the other two,
 * that nothing else on the page changes with it, and that under a coach or
 * workspace route the card issues NO prep-brief and NO tournament-entries
 * request at all (the property the thin-gate structure buys over a guard
 * clause: "renders nothing" alone would pass even if the inner hooks ran).
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
    // Plan 39.2-10: every Track host reads the subject's watchlist.
    watchlist: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      track: vi.fn(),
      untrack: vi.fn(),
    },
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
const fox = SpriteList.find((s) => s.id === 15)!;
const DAY_MS = 24 * 60 * 60 * 1000;

const PERSONAL = '/opponents/rival';
const COACH = '/coach/test-client/opponents/rival';
const WORKSPACE = '/workspace/test-tenant/opponents/rival';

/** Mirrors the parity test's fixture: the third game differs by opposing character AND stage, so "2-1" is the head-to-head record only. */
function makeMatch(
  id: string,
  time: number,
  win: boolean,
  opponentId = luigi.id,
  map = { id: 1, name: 'Battlefield' },
) {
  return {
    id,
    fighter_id: mario.id,
    opponent_id: opponentId,
    time,
    map,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win,
  };
}

function withProviders(initialEntry: string, element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/opponents/:opponentTag" element={element} />
                <Route path="/coach/:clientId/opponents/:opponentTag" element={element} />
                <Route path="/workspace/:tenantId/opponents/:opponentTag" element={element} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderHubAt(initialEntry: string) {
  return withProviders(initialEntry, <OpponentHubPage />);
}

function renderCardAloneAt(initialEntry: string) {
  return withProviders(
    initialEntry,
    <HubPrepBriefCard
      opponentIdentity="rival"
      opponentTag="rival"
      resolveOpponent={({ opponent }) => opponent}
      tournamentBlocks={[]}
    />,
  );
}

/** The hub's text with the prep-brief card's subtree removed, whitespace collapsed and the packet's render-time stamp masked (the parity test's own normaliser). */
function textWithoutCard(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-testid="hub-prep-brief-card"]').forEach((node) => node.remove());
  return (clone.textContent ?? '')
    .replace(/Generated [^D]*Date range:/, 'Generated <TIME> Date range:')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lets every pending mocked read and the re-renders it triggers flush. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('Opponent hub prep-brief card is own-account only (D-10, PREP-05)', () => {
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
    // One upcoming entry, so the personal route has a real brief to read.
    listTournaments.mockResolvedValue([
      {
        entryKey: 'up1',
        eventName: 'Genesis',
        firstSetAt: Date.now() + 3 * DAY_MS,
        lastSetAt: Date.now() + 3 * DAY_MS,
        setsPlayed: 0,
        source: 'manual',
      },
    ]);
    getPrep.mockResolvedValue({ activated: false });
    listAliases.mockResolvedValue({});
    listNotes.mockResolvedValue({});
    listMatches.mockResolvedValue([
      makeMatch('m1', 1, true),
      makeMatch('m2', 2, true),
      makeMatch('m3', 3, false, fox.id, { id: 3, name: 'Final Destination' }),
    ]);
    setMockUser(makeMockUser());
  });

  it('renders the card title on /opponents/:tag and nothing at all under the coach and workspace routes', async () => {
    const personal = renderHubAt(PERSONAL);
    expect(await screen.findByText('Prep brief')).toBeInTheDocument();
    expect(screen.getByTestId('hub-prep-brief-card')).toBeInTheDocument();
    personal.unmount();

    for (const route of [COACH, WORKSPACE]) {
      const view = renderHubAt(route);
      await waitFor(() => expect(screen.getByText('2-1')).toBeInTheDocument());
      await flush();
      expect(screen.queryByText('Prep brief')).toBeNull();
      expect(screen.queryByTestId('hub-prep-brief-card')).toBeNull();
      view.unmount();
    }
  });

  it('nothing else on the hub disappears with it — the rest of the page is identical across the three families', async () => {
    const personal = renderHubAt(PERSONAL);
    await screen.findByTestId('hub-prep-brief-card');
    const personalText = textWithoutCard(personal.container);
    personal.unmount();

    for (const route of [COACH, WORKSPACE]) {
      const view = renderHubAt(route);
      await waitFor(() => expect(screen.getByText('2-1')).toBeInTheDocument());
      await flush();
      expect(textWithoutCard(view.container)).toBe(personalText);
      view.unmount();
    }
  });

  it('the hub issues NO prep-brief request under the coach and workspace routes (control: it does on the personal route)', async () => {
    const personal = renderHubAt(PERSONAL);
    await screen.findByTestId('hub-prep-brief-card');
    expect(getPrep).toHaveBeenCalledWith('up1');
    personal.unmount();

    for (const route of [COACH, WORKSPACE]) {
      getPrep.mockClear();
      const view = renderHubAt(route);
      await waitFor(() => expect(screen.getByText('2-1')).toBeInTheDocument());
      await flush();
      expect(getPrep).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('the card itself issues NO tournament-entries and NO prep-brief request under the coach and workspace routes (control: it does on the personal route)', async () => {
    const personal = renderCardAloneAt(PERSONAL);
    await screen.findByTestId('hub-prep-brief-card');
    expect(listTournaments).toHaveBeenCalled();
    expect(getPrep).toHaveBeenCalledWith('up1');
    personal.unmount();

    for (const route of [COACH, WORKSPACE]) {
      listTournaments.mockClear();
      getPrep.mockClear();
      const view = renderCardAloneAt(route);
      await flush();
      expect(view.container).toBeEmptyDOMElement();
      expect(listTournaments).not.toHaveBeenCalled();
      expect(getPrep).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});
