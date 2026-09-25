import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  analyticsFilterStorageKey,
} from '@/context/AnalyticsFilterContext';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { useAutoWidenEmptyRange, rangeAutoWidenSessionKey } from './useAutoWidenEmptyRange';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

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

const list = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    matches: { list: (...args: unknown[]) => list(...args) },
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
/** Well outside every coarse range bucket (3m/6m/12m all use 30-day months). */
const WELL_OUTSIDE_12M_MS = 400 * DAY_MS;

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

function setPersistedFilter(
  state: { source: string; range: string },
  clientId: string | null = null,
) {
  window.localStorage.setItem(
    analyticsFilterStorageKey('test-uid', clientId),
    JSON.stringify(state),
  );
}

function readPersistedFilter(clientId: string | null = null): unknown {
  return JSON.parse(
    window.localStorage.getItem(analyticsFilterStorageKey('test-uid', clientId)) ?? '{}',
  );
}

function Harness() {
  useAutoWidenEmptyRange();
  const { range, setRange } = useAnalyticsFilter();
  return (
    <div>
      <span data-testid="range">{range}</span>
      <button onClick={() => setRange('6m')}>set-range-6m</button>
    </div>
  );
}

/**
 * Phase 35-03 (NEW-M1): under the pathname-derived provider/hook design,
 * `MemoryRouter` alone supplies the ROUTE (what `useEffectiveSubject`
 * resolves) but never touches `window.location` (what the out-of-router
 * provider resolves). Any non-root `path` must therefore ALSO push
 * `window.history` — that's the VALUE — while `initialEntries` and the
 * router itself supply what `useAutoWidenEmptyRange`'s own
 * `useEffectiveSubject()` call resolves.
 */
function renderHarness(path = '/') {
  window.history.pushState({}, '', path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Harness />
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

describe('useAutoWidenEmptyRange', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.pushState({}, '', '/');
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('widens a stale persisted range to all-time with an explanatory toast, and persists it', async () => {
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('range')).toHaveTextContent('all'));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith('No matches in the last 12m — showing all time.');
    expect(readPersistedFilter()).toEqual({ source: 'all', range: 'all' });
  });

  it('preserves the source filter — the widen touches range only, never source', async () => {
    setPersistedFilter({ source: 'startgg', range: '12m' });
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('range')).toHaveTextContent('all'));
    expect(readPersistedFilter()).toEqual({ source: 'startgg', range: 'all' });
  });

  it('does not fire when the persisted range is already all-time', async () => {
    setPersistedFilter({ source: 'all', range: 'all' });
    list.mockResolvedValue([]);

    renderHarness();

    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('does not fire when the account has no matches at all (empty library)', async () => {
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([]);

    renderHarness();

    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(screen.getByTestId('range')).toHaveTextContent('12m');
  });

  it('does not fire when the persisted range still yields matches', async () => {
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);

    renderHarness();

    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(screen.getByTestId('range')).toHaveTextContent('12m');
  });

  it('does not re-fire the toast on a later data refetch', async () => {
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    const { queryClient } = renderHarness();

    await waitFor(() => expect(screen.getByTestId('range')).toHaveTextContent('all'));
    expect(toastInfo).toHaveBeenCalledTimes(1);

    await queryClient.invalidateQueries({ queryKey: ['personal', 'matches'] });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('range')).toHaveTextContent('all');
  });

  it('never flips a range the user picks in-session after the widen settles', async () => {
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('range')).toHaveTextContent('all'));
    expect(toastInfo).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.click(screen.getByText('set-range-6m'));

    expect(screen.getByTestId('range')).toHaveTextContent('6m');
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('never flips an in-session pick across a MainLayout-style remount', async () => {
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    const { unmount } = renderHarness();

    await waitFor(() => expect(screen.getByTestId('range')).toHaveTextContent('all'));
    expect(toastInfo).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.click(screen.getByText('set-range-6m'));
    expect(screen.getByTestId('range')).toHaveTextContent('6m');

    unmount();

    // A fresh tree (MainLayout remounting on route change), same
    // sessionStorage, with the now-persisted 6m range.
    renderHarness();

    await screen.findByTestId('range');
    expect(screen.getByTestId('range')).toHaveTextContent('6m');
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('writes the session flag after the first evaluation', async () => {
    setPersistedFilter({ source: 'all', range: 'all' });
    list.mockResolvedValue([]);

    renderHarness();

    await waitFor(() =>
      expect(
        window.sessionStorage.getItem(rangeAutoWidenSessionKey('test-uid', null)),
      ).not.toBeNull(),
    );
  });

  it('M-2: a second subject in the same session gets its own independent evaluation, widen, and toast', async () => {
    // Personal's session flag is already spent.
    window.sessionStorage.setItem(rangeAutoWidenSessionKey('test-uid', null), '1');
    setPersistedFilter({ source: 'all', range: '12m' }, 'client-a');
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    renderHarness('/coach/client-a/matchups');

    await waitFor(() => expect(screen.getByTestId('range')).toHaveTextContent('all'));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(readPersistedFilter('client-a')).toEqual({ source: 'all', range: 'all' });
    // The personal flag is untouched — still exactly the pre-seeded value.
    expect(window.sessionStorage.getItem(rangeAutoWidenSessionKey('test-uid', null))).toBe('1');
  });

  it('NEW-H1: a commit whose filter state belongs to another subject calls no setter, writes no flag, and shows no toast', async () => {
    // Personal-scoped excluding range, but the ROUTE (not window.location)
    // says client-a — the deliberate mismatch this case exists to prove is
    // inert, not a harness mistake.
    setPersistedFilter({ source: 'all', range: '12m' });
    list.mockResolvedValue([
      makeMatch({ id: 'm1', time: Date.now() - WELL_OUTSIDE_12M_MS, win: true }),
    ]);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/coach/client-a/matchups']}>
          <AuthProvider>
            <AnalyticsFilterProvider>
              <Harness />
            </AnalyticsFilterProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setItemSpy.mock.calls.some((call) => String(call[0]).includes('analyticsFilter'))).toBe(
      false,
    );
    expect(window.sessionStorage.getItem(rangeAutoWidenSessionKey('test-uid', null))).toBeNull();
    expect(
      window.sessionStorage.getItem(rangeAutoWidenSessionKey('test-uid', 'client-a')),
    ).toBeNull();
    expect(toastInfo).not.toHaveBeenCalled();
    setItemSpy.mockRestore();

    // Now align the pathname with the route — the provider re-seeds against
    // client-a's own (never-seeded) key, which defaults to 'all', so the
    // hook returns before burning the shot. The observable proof of
    // "evaluation happened" here is the session flag, never an unqualified
    // widen/toast — the client-a key was never seeded with an excluding
    // range, so there is nothing to widen.
    window.history.pushState({}, '', '/coach/client-a/matchups');
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/coach/client-a/matchups']}>
          <AuthProvider>
            <AnalyticsFilterProvider>
              <Harness />
            </AnalyticsFilterProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        window.sessionStorage.getItem(rangeAutoWidenSessionKey('test-uid', 'client-a')),
      ).not.toBeNull(),
    );
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
