import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';
import { useHorizon } from './useHorizon';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

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
const aliasesList = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    matches: { list: (...args: unknown[]) => list(...args) },
    opponents: { aliases: { list: (...args: unknown[]) => aliasesList(...args) } },
  },
}));

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

/** A match with no `eventName`/`tournamentName` — never resolves the `lastEvent` window. */
function manualMatch(id: string, time: number): Match {
  return makeMatch({ id, time, win: true });
}

/** A match belonging to a named tournament event — resolves the `lastEvent` window. */
function tournamentMatch(id: string, time: number, eventName = 'Genesis 10'): Match {
  return makeMatch({ id, time, win: true, eventName, source: 'startgg' });
}

function seedHorizon(uid: string, clientId: string | null, horizon: unknown) {
  window.localStorage.setItem(
    analyticsSelectionStorageKey(uid, clientId),
    JSON.stringify({ horizon }),
  );
}

function readRawStored(uid: string, clientId: string | null): string | null {
  return window.localStorage.getItem(analyticsSelectionStorageKey(uid, clientId));
}

function Harness() {
  const { horizon, setHorizon, isLastEventAvailable, isLoading } = useHorizon();
  return (
    <div>
      <span data-testid="horizon">{horizon}</span>
      <span data-testid="isLoading">{String(isLoading)}</span>
      <span data-testid="isLastEventAvailable">{String(isLastEventAvailable)}</span>
      <button onClick={() => setHorizon('last90')}>set-last90</button>
      <button onClick={() => setHorizon('lastEvent')}>set-lastEvent</button>
    </div>
  );
}

function renderHarness(path = '/') {
  window.history.pushState({}, '', path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
}

describe('useHorizon', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    aliasesList.mockResolvedValue({});
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
  });

  /** Filters a `Storage.prototype` spy's calls down to the analyticsSelection key only — other providers (AnalyticsFilterProvider) legitimately read/write their own, unrelated keys during the same render. */
  function selectionCalls(spy: { mock: { calls: unknown[][] } }): unknown[][] {
    return spy.mock.calls.filter((call) => String(call[0]).includes('analyticsSelection'));
  }

  it('resolves to last30 with no stored value, and writes nothing', async () => {
    list.mockResolvedValue([manualMatch('m1', Date.now())]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('last30');
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('performs zero reads and zero writes while the match query is loading', async () => {
    seedHorizon('test-uid', null, 'last90');
    let resolveList: (value: Match[]) => void = () => {};
    list.mockReturnValue(new Promise<Match[]>((resolve) => (resolveList = resolve)));
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderHarness();

    expect(screen.getByTestId('isLoading')).toHaveTextContent('true');
    expect(selectionCalls(getItemSpy)).toHaveLength(0);
    expect(selectionCalls(setItemSpy)).toHaveLength(0);

    resolveList([manualMatch('m1', Date.now())]);
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('last90');
  });

  it('an unknown stored horizon value resolves to the default and performs no write', async () => {
    seedHorizon('test-uid', null, 'last10');
    list.mockResolvedValue([manualMatch('m1', Date.now())]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('last30');
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('corrupt JSON in the storage key resolves to the default and does not throw', async () => {
    window.localStorage.setItem(analyticsSelectionStorageKey('test-uid', null), '{not json');
    list.mockResolvedValue([manualMatch('m1', Date.now())]);

    expect(() => renderHarness()).not.toThrow();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('last30');
  });

  it('a throwing storage stub leaves the hook returning the default; setHorizon still updates the in-session value with no error surfaced', async () => {
    list.mockResolvedValue([manualMatch('m1', Date.now())]);
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('last30');

    const user = userEvent.setup();
    await expect(user.click(screen.getByText('set-last90'))).resolves.not.toThrow();

    expect(screen.getByTestId('horizon')).toHaveTextContent('last90');

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it('setHorizon is the only CALL SITE of persistSelection inside useHorizon.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/hooks/useHorizon.ts'), 'utf8');
    const nonCommentLines = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const callSiteCount = nonCommentLines.filter((line) =>
      line.includes('persistSelection('),
    ).length;
    expect(callSiteCount).toBe(1);
  });

  it('isLastEventAvailable is false with no tournament games; a stored lastEvent value resolves to the default with no write', async () => {
    seedHorizon('test-uid', null, 'lastEvent');
    list.mockResolvedValue([manualMatch('m1', Date.now())]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('isLastEventAvailable')).toHaveTextContent('false');
    expect(screen.getByTestId('horizon')).toHaveTextContent('last30');
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('isLastEventAvailable is true with a tournament game in scope; a stored lastEvent value resolves to lastEvent', async () => {
    seedHorizon('test-uid', null, 'lastEvent');
    list.mockResolvedValue([tournamentMatch('m1', Date.now())]);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('isLastEventAvailable')).toHaveTextContent('true');
    expect(screen.getByTestId('horizon')).toHaveTextContent('lastEvent');
  });

  it('explicitly setting a horizon persists it, in-session and to storage', async () => {
    list.mockResolvedValue([manualMatch('m1', Date.now())]);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));

    const user = userEvent.setup();
    await user.click(screen.getByText('set-last90'));

    expect(screen.getByTestId('horizon')).toHaveTextContent('last90');
    expect(JSON.parse(readRawStored('test-uid', null) ?? '{}')).toEqual({ horizon: 'last90' });
  });

  it('two different subject ids produce two different storage keys and do not read each other’s values', async () => {
    seedHorizon('test-uid', null, 'last90');
    seedHorizon('test-uid', 'client-a', 'lastEvent');
    list.mockResolvedValue([tournamentMatch('m1', Date.now())]);

    const { unmount } = renderHarness('/');
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('last90');
    unmount();

    renderHarness('/coach/client-a/matchups');
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('horizon')).toHaveTextContent('lastEvent');
  });

  // 39.1-REVIEW iteration 2 CR-01: every mounted call for the SAME subject is
  // one source of truth — a write through one call (the page's HorizonSwitch)
  // reaches the others (the page's own read) in the same session, with no
  // remount. A different subject's call is never touched.
  it('a setHorizon through one call reaches every other mounted call on the same subject, and no other subject', async () => {
    list.mockResolvedValue([manualMatch('m1', Date.now())]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Named({ name }: { name: string }) {
      const { horizon, setHorizon, isLoading } = useHorizon();
      return (
        <div>
          <span data-testid={`${name}-horizon`}>{isLoading ? 'loading' : horizon}</span>
          <button onClick={() => setHorizon('last90')}>{`${name}-set-last90`}</button>
        </div>
      );
    }
    function Tree({ path, children }: { path: string; children: ReactNode }) {
      return (
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <AnalyticsFilterProvider>{children}</AnalyticsFilterProvider>
          </AuthProvider>
        </MemoryRouter>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Tree path="/">
          <Named name="switch" />
          <Named name="page" />
        </Tree>
        <Tree path="/coach/client-a/matchups">
          <Named name="coach" />
        </Tree>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('switch-horizon')).toHaveTextContent('last30');
      expect(screen.getByTestId('page-horizon')).toHaveTextContent('last30');
      expect(screen.getByTestId('coach-horizon')).toHaveTextContent('last30');
    });

    await userEvent.setup().click(screen.getByText('switch-set-last90'));

    expect(screen.getByTestId('switch-horizon')).toHaveTextContent('last90');
    expect(screen.getByTestId('page-horizon')).toHaveTextContent('last90');
    expect(screen.getByTestId('coach-horizon')).toHaveTextContent('last30');
    expect(readRawStored('test-uid', 'client-a')).toBeNull();
  });
});
