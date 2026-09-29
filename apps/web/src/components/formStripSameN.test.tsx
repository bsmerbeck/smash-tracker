import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useProfile } from '@/hooks/useProfile';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import type { TrendLineProps } from '@/components/charts/TrendLine';
import { MatchupsPage } from '@/pages/Matchups/MatchupsPage';
import { FighterAnalysisPage } from '@/pages/FighterAnalysis/FighterAnalysisPage';
import { OpponentHubPage } from '@/pages/Opponents/OpponentHubPage';
import { TrendsPage } from '@/pages/Trends/TrendsPage';

/**
 * Plan 39.1-42 Task 1 — the cross-host same-n oracle for the form strip
 * (owner decision [HUMAN] 2026-09-25: a manual play session is ONE set;
 * PD-42-4). On EVERY FormStrip host — Matchups, the Fighter Analysis hero,
 * the opponent hub and Trends' thin career timeline — clicking a set renders
 * a results list whose game count equals that set's tick count, for a
 * manual SESSION set and for a start.gg set; and a legacy `event=game:<id>`
 * URL (a link shared before this plan) still lists exactly its one game.
 *
 * The pages, their strip builders, their URL writers and `FilteredMatchList`
 * are the REAL implementations; only the Recharts trend (no geometry in
 * jsdom) is a stub and the API is mocked.
 */

vi.mock('@/components/charts/TrendLine', async () => {
  const actual = await vi.importActual<typeof import('@/components/charts/TrendLine')>(
    '@/components/charts/TrendLine',
  );
  return {
    ...actual,
    TrendLine: (props: TrendLineProps) => (
      <div data-testid="trend-line-stub" data-points={props.points.length} />
    ),
  };
});

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
const getFighters = vi.fn();
const getMe = vi.fn();
const upsertMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    tournaments: { list: vi.fn().mockResolvedValue([]) },
    opponents: {
      aliases: {
        list: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      notes: {
        list: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({ updatedAt: 1 }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

const MARIO_ID = 1;
const LUIGI_ID = 10;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function game(id: string, time: number, win: boolean, extra: Record<string, unknown> = {}) {
  return {
    id,
    fighter_id: MARIO_ID,
    opponent_id: LUIGI_ID,
    time,
    win,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    ...extra,
  };
}

/**
 * Nine games vs "rival": a 2-game manual session, a 3-game start.gg set at
 * Genesis 9 / Ultimate Singles, and a 4-game manual session. Every set
 * has a distinct tick count, so a set is found by its ticks alone, and no
 * set's count equals the 9 games in scope (a list that ignored the key
 * would print 9).
 */
function fixture() {
  const t0 = Date.now() - 20 * DAY_MS;
  return [
    game('sa0', t0, true),
    game('sa1', t0 + 12 * MINUTE_MS, false),
    ...[0, 1, 2].map((g) =>
      game(`gen${g}`, t0 + 2 * DAY_MS + g * 8 * MINUTE_MS, g !== 1, {
        externalId: `sgg:gen9-set1:g${g + 1}`,
        tournamentName: 'Genesis 9',
        eventName: 'Ultimate Singles',
      }),
    ),
    ...[0, 1, 2, 3].map((g) => game(`sb${g}`, t0 + 4 * DAY_MS + g * 10 * MINUTE_MS, g % 2 === 0)),
  ];
}

const SESSION_TICKS = 4;
const STARTGG_TICKS = 3;
const LEGACY_GAME_ID = 'sb1';

function ShellProfileSubscription() {
  useProfile();
  return null;
}

interface Host {
  name: string;
  path: string;
  entry: string;
  element: ReactNode;
}

const HOSTS: Host[] = [
  {
    name: 'Matchups',
    path: '/matchups',
    entry: `/matchups?fighter=${MARIO_ID}&vs=${LUIGI_ID}`,
    element: <MatchupsPage />,
  },
  {
    name: 'Fighter Analysis',
    path: '/fighter-analysis',
    entry: `/fighter-analysis?fighter=${MARIO_ID}`,
    element: <FighterAnalysisPage />,
  },
  {
    name: 'opponent hub',
    path: '/opponents/:opponentTag',
    entry: '/opponents/rival',
    element: <OpponentHubPage />,
  },
  {
    name: 'Trends (thin career timeline)',
    path: '/trends',
    entry: '/trends',
    element: <TrendsPage />,
  },
];

function withEvent(entry: string, eventKey: string): string {
  return `${entry}${entry.includes('?') ? '&' : '?'}event=${encodeURIComponent(eventKey)}`;
}

function renderHost(host: Host, entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <ShellProfileSubscription />
              <Routes>
                <Route path={host.path} element={host.element} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function stripSets(): Promise<HTMLElement[]> {
  return waitFor(() => {
    const sets = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="form-strip-set"]'));
    expect(sets.length).toBeGreaterThan(0);
    return sets;
  });
}

function tickCount(set: HTMLElement): number {
  return set.querySelectorAll('[data-slot="form-strip-tick"]').length;
}

async function listedGames(): Promise<number> {
  return waitFor(() => {
    const list = document.querySelector('[data-total-rows]');
    expect(list, 'the results list').not.toBeNull();
    return Number(list!.getAttribute('data-total-rows'));
  });
}

async function clickSetWithTicks(ticks: number): Promise<void> {
  const sets = await stripSets();
  const target = sets.find((set) => tickCount(set) === ticks);
  expect(
    target,
    `a strip set drawing ${ticks} ticks (drawn: ${sets.map(tickCount).join(',')})`,
  ).toBeDefined();
  fireEvent.click(target!);
}

describe('strip-same-n (plan 39.1-42): a strip set drills to exactly its own games on every host', () => {
  beforeEach(() => {
    cleanup();
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [MARIO_ID], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
    getFighters.mockResolvedValue({ primary: [MARIO_ID], secondary: [] });
    listMatches.mockResolvedValue(fixture());
    setMockUser(makeMockUser());
  });

  describe.each(HOSTS)('$name', (host) => {
    it(`strip-same-n: ${host.name} — a manual session set lists exactly the session's games`, async () => {
      renderHost(host, host.entry);
      await clickSetWithTicks(SESSION_TICKS);
      expect(await listedGames()).toBe(SESSION_TICKS);
    });

    it(`strip-same-n: ${host.name} — a start.gg set lists exactly the set's games`, async () => {
      renderHost(host, host.entry);
      await clickSetWithTicks(STARTGG_TICKS);
      expect(await listedGames()).toBe(STARTGG_TICKS);
    });

    it(`strip-same-n: ${host.name} — a legacy event=game:<id> URL lists exactly that one game`, async () => {
      renderHost(host, withEvent(host.entry, `game:${LEGACY_GAME_ID}`));
      expect(await listedGames()).toBe(1);
    });
  });
});
