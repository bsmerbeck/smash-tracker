import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ActiveSubjectSync } from '@/routes/ActiveSubjectSync';
import { OpponentHubPage } from '@/pages/Opponents/OpponentHubPage';
import { MatchupsPage } from '@/pages/Matchups/MatchupsPage';
import { StageDetailPage } from '@/pages/Stages/StageDetailPage';
import { getActiveSubjectHeader, setActiveSubject } from '@/lib/subjectQueryKey';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 39.2-10 (UI-SPEC G11, T-39.2-41): the three Track toggles render with
 * IDENTICAL structure under the own-account route, `/coach/:clientId/*` and
 * `/workspace/:tenantId/*`, and a coach's toggle reads and writes the CLIENT's
 * list, never the coach's own. Copies `opponentHubCoachParity.test.tsx`'s shape:
 * one element per host mounted under every route family with the same mocked
 * data, never a prop passed to the component.
 *
 * The `@/lib/api` mock records `getActiveSubjectHeader()` at CALL time. That is
 * the very function the real `apiRequest` reads to build `X-Active-Subject`, and
 * `ActiveSubjectSync` (mounted as at the real router root) is what sets it, so
 * the recorded value is what the wire would carry.
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
const getMe = vi.fn();
const getFighters = vi.fn();
const watchlistCalls: { op: 'list' | 'track' | 'untrack'; header: string; arg?: unknown }[] = [];

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: () => Promise.resolve({ uid: 'test-uid', email: 'test@example.com' }),
      getMe: (...args: unknown[]) => getMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: { list: (...args: unknown[]) => listMatches(...args), remove: vi.fn() },
    tournaments: { list: () => Promise.resolve([]) },
    opponents: {
      aliases: { list: () => Promise.resolve({}), upsert: vi.fn(), remove: vi.fn() },
      notes: { list: () => Promise.resolve({}), upsert: vi.fn(), remove: vi.fn() },
    },
    watchlist: {
      list: () => {
        watchlistCalls.push({ op: 'list', header: getActiveSubjectHeader() });
        return Promise.resolve({ items: [] });
      },
      track: (input: unknown) => {
        watchlistCalls.push({ op: 'track', header: getActiveSubjectHeader(), arg: input });
        return Promise.resolve({ itemKey: 'x', item: {} });
      },
      untrack: (itemKey: unknown) => {
        watchlistCalls.push({ op: 'untrack', header: getActiveSubjectHeader(), arg: itemKey });
        return Promise.resolve({ itemKey });
      },
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(id: string, time: number) {
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
  };
}

interface Host {
  name: string;
  /** The path under each family prefix. */
  path: string;
  /** The toggle's accessible name (identical in every family). */
  toggleName: string;
  /** What a track press must send. */
  expectedTrack: unknown;
}

const HOSTS: Host[] = [
  {
    name: 'opponent hub',
    path: '/opponents/rival',
    toggleName: 'Track rival',
    expectedTrack: { kind: 'opponent', ref: 'rival' },
  },
  {
    name: 'Matchups pairing header',
    path: '/matchups',
    toggleName: 'Track Mario vs Luigi',
    expectedTrack: { kind: 'matchup', ref: { fighterId: mario.id, vsFighterId: luigi.id } },
  },
  {
    name: 'stage detail header',
    path: '/stages/1',
    toggleName: 'Track Battlefield',
    expectedTrack: { kind: 'stage', ref: 1 },
  },
];

const FAMILIES = [
  { name: 'own account', prefix: '' },
  { name: 'coach client', prefix: '/coach/client-1' },
  { name: 'owned workspace', prefix: '/workspace/tenant-1' },
] as const;

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const routes = HOSTS.flatMap((host) => {
    const element =
      host.path === '/matchups' ? (
        <MatchupsPage />
      ) : host.path.startsWith('/stages') ? (
        <StageDetailPage />
      ) : (
        <OpponentHubPage />
      );
    const pattern = host.path
      .replace('/rival', '/:opponentTag')
      .replace('/stages/1', '/stages/:stageId');
    return FAMILIES.map((family) => (
      <Route
        key={`${family.name}-${host.path}`}
        path={`${family.prefix}${pattern}`}
        element={element}
      />
    ));
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <ActiveSubjectSync />
              <Routes>{routes}</Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

/** Everything about a toggle that must not depend on the route family. */
function signature(toggle: HTMLElement) {
  const parent = toggle.parentElement!;
  return {
    role: toggle.getAttribute('role') ?? toggle.tagName.toLowerCase(),
    slot: toggle.getAttribute('data-slot'),
    label: toggle.textContent,
    ariaLabel: toggle.getAttribute('aria-label'),
    pressed: toggle.getAttribute('aria-pressed'),
    disabled: (toggle as HTMLButtonElement).disabled,
    className: toggle.className,
    parentClass: parent.className,
    indexInParent: Array.from(parent.children).indexOf(toggle),
    siblingCount: parent.children.length,
    siblingTags: Array.from(parent.children).map((child) => child.tagName.toLowerCase()),
  };
}

describe('Track toggles: coach/workspace parity (G11, T-39.2-41)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    watchlistCalls.length = 0;
    setActiveSubject({ mode: 'personal', clientId: null });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch('m1', 1), makeMatch('m2', 2)]);
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    setActiveSubject({ mode: 'personal', clientId: null });
  });

  it.each(HOSTS)(
    '$name: the toggle has identical structure under own-account, /coach/:clientId and /workspace/:tenantId',
    async (host) => {
      const signatures = [];
      for (const family of FAMILIES) {
        const { unmount } = renderAt(`${family.prefix}${host.path}`);
        const toggle = await screen.findByRole('button', { name: host.toggleName });
        await waitFor(() => expect(toggle).toBeEnabled());
        signatures.push(signature(toggle));
        unmount();
      }
      const [own, coach, workspace] = signatures;
      expect(own).toBeDefined();
      expect(coach).toEqual(own);
      expect(workspace).toEqual(own);
      expect(own?.label).toBe('Track');
      expect(own?.pressed).toBe('false');
    },
  );

  it.each(HOSTS)(
    '$name: under /coach/:clientId the toggle reads and writes the CLIENT subject, never the coach own list',
    async (host) => {
      const user = userEvent.setup();
      const { queryClient } = renderAt(`/coach/client-1${host.path}`);
      const toggle = await screen.findByRole('button', { name: host.toggleName });
      await waitFor(() => expect(toggle).toBeEnabled());

      await user.click(toggle);

      await waitFor(() => expect(watchlistCalls.some((call) => call.op === 'track')).toBe(true));
      const track = watchlistCalls.find((call) => call.op === 'track');
      expect(track?.header).toBe('client:client-1');
      expect(track?.arg).toEqual(host.expectedTrack);
      const reads = watchlistCalls.filter((call) => call.op === 'list');
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.header).toBe('client:client-1');
      }
      expect(queryClient.getQueryData(['client', 'client-1', 'watchlist'])).toBeDefined();
      expect(queryClient.getQueryData(['personal', 'watchlist'])).toBeUndefined();
    },
  );

  it.each(HOSTS)(
    '$name: the own-account toggle writes the personal subject and never a client key',
    async (host) => {
      const user = userEvent.setup();
      const { queryClient } = renderAt(host.path);
      const toggle = await screen.findByRole('button', { name: host.toggleName });
      await waitFor(() => expect(toggle).toBeEnabled());

      await user.click(toggle);

      await waitFor(() => expect(watchlistCalls.some((call) => call.op === 'track')).toBe(true));
      expect(watchlistCalls.find((call) => call.op === 'track')?.header).toBe('personal');
      expect(queryClient.getQueryData(['personal', 'watchlist'])).toBeDefined();
      expect(queryClient.getQueryData(['client', 'client-1', 'watchlist'])).toBeUndefined();
    },
  );

  it.each(HOSTS)(
    '$name: under /workspace/:tenantId the list is cached under the tenant key, not the personal one',
    async (host) => {
      const { queryClient } = renderAt(`/workspace/tenant-1${host.path}`);
      const toggle = await screen.findByRole('button', { name: host.toggleName });
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(queryClient.getQueryData(['client', 'tenant-1', 'watchlist'])).toBeDefined();
      expect(queryClient.getQueryData(['personal', 'watchlist'])).toBeUndefined();
    },
  );
});
