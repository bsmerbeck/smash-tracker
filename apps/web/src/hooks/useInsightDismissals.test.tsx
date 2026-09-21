import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { insightDismissalsStorageKey } from '@/lib/insightDismissals';
import { useInsightDismissals } from './useInsightDismissals';
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

function seedDismissals(uid: string, clientId: string | null, raw: unknown) {
  window.localStorage.setItem(
    insightDismissalsStorageKey(uid, clientId),
    typeof raw === 'string' ? raw : JSON.stringify(raw),
  );
}

function Harness() {
  const { dismissedIds, dismiss, restoreAll, isLoading } = useInsightDismissals();
  return (
    <div>
      <span data-testid="dismissedIds">{dismissedIds.join(',')}</span>
      <span data-testid="isLoading">{String(isLoading)}</span>
      <button onClick={() => dismiss('formNow:account:last30')}>dismiss-1</button>
      <button onClick={() => dismiss('rivalMovers:account:last30')}>dismiss-2</button>
      <button onClick={() => restoreAll()}>restore</button>
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

describe('useInsightDismissals', () => {
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

  function selectionCalls(spy: { mock: { calls: unknown[][] } }): unknown[][] {
    return spy.mock.calls.filter((call) => String(call[0]).includes('InsightDismissals'));
  }

  it('resolves to an empty list with no stored value', async () => {
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);

    renderHarness();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('');
  });

  it('a non-array stored value resolves to an empty list without throwing', async () => {
    seedDismissals('test-uid', null, { oops: true });
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);

    expect(() => renderHarness()).not.toThrow();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('');
  });

  it('corrupt JSON resolves to an empty list without throwing', async () => {
    seedDismissals('test-uid', null, '{not json');
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);

    expect(() => renderHarness()).not.toThrow();

    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('');
  });

  it('performs zero reads and zero writes while the match query is loading', async () => {
    seedDismissals('test-uid', null, ['formNow:account:last30']);
    let resolveList: (value: Match[]) => void = () => {};
    list.mockReturnValue(new Promise<Match[]>((resolve) => (resolveList = resolve)));
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderHarness();

    expect(screen.getByTestId('isLoading')).toHaveTextContent('true');
    expect(selectionCalls(getItemSpy)).toHaveLength(0);
    expect(selectionCalls(setItemSpy)).toHaveLength(0);

    resolveList([makeMatch({ id: 'm1', time: Date.now(), win: true })]);
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('formNow:account:last30');
  });

  it('dismiss appends an id and persists it; restoreAll clears and persists an empty list', async () => {
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);

    renderHarness();
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));

    const user = userEvent.setup();
    await user.click(screen.getByText('dismiss-1'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('formNow:account:last30');
    expect(
      JSON.parse(
        window.localStorage.getItem(insightDismissalsStorageKey('test-uid', null)) ?? '[]',
      ),
    ).toEqual(['formNow:account:last30']);

    await user.click(screen.getByText('dismiss-2'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent(
      'formNow:account:last30,rivalMovers:account:last30',
    );

    await user.click(screen.getByText('restore'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('');
    expect(
      JSON.parse(
        window.localStorage.getItem(insightDismissalsStorageKey('test-uid', null)) ?? '["x"]',
      ),
    ).toEqual([]);
  });

  it('a throwing storage stub leaves dismiss updating the in-session list with no error surfaced', async () => {
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    renderHarness();
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));

    const user = userEvent.setup();
    await expect(user.click(screen.getByText('dismiss-1'))).resolves.not.toThrow();
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('formNow:account:last30');

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it('two different subject ids keep separate dismissal lists', async () => {
    seedDismissals('test-uid', null, ['personal-id']);
    seedDismissals('test-uid', 'client-a', ['client-a-id']);
    list.mockResolvedValue([makeMatch({ id: 'm1', time: Date.now(), win: true })]);

    const { unmount } = renderHarness('/');
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('personal-id');
    unmount();

    renderHarness('/coach/client-a/matchups');
    await waitFor(() => expect(screen.getByTestId('isLoading')).toHaveTextContent('false'));
    expect(screen.getByTestId('dismissedIds')).toHaveTextContent('client-a-id');
  });

  it('dismiss and restoreAll are the only CALL SITES of the writer inside useInsightDismissals.ts', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/hooks/useInsightDismissals.ts'),
      'utf8',
    );
    const nonCommentLines = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const callSiteCount = nonCommentLines.filter((line) =>
      line.includes('writeStoredDismissals('),
    ).length;
    expect(callSiteCount).toBe(2);
  });
});
