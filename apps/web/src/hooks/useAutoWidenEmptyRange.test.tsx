import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import {
  AnalyticsFilterProvider,
  ANALYTICS_FILTER_STORAGE_KEY,
} from '@/context/AnalyticsFilterContext';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { useAutoWidenEmptyRange, RANGE_AUTO_WIDEN_SESSION_KEY } from './useAutoWidenEmptyRange';
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

function setPersistedFilter(state: { source: string; range: string }) {
  window.localStorage.setItem(ANALYTICS_FILTER_STORAGE_KEY, JSON.stringify(state));
}

function readPersistedFilter(): unknown {
  return JSON.parse(window.localStorage.getItem(ANALYTICS_FILTER_STORAGE_KEY) ?? '{}');
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

function renderHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
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
    setMockUser(makeMockUser());
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
      expect(window.sessionStorage.getItem(RANGE_AUTO_WIDEN_SESSION_KEY)).not.toBeNull(),
    );
  });
});
