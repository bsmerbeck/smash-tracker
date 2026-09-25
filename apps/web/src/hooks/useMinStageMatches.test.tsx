import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { useMinStageMatches } from './useMinStageMatches';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';

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

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
  },
}));

function Probe({ testId = 'value' }: { testId?: string }) {
  const [value, setValue] = useMinStageMatches();
  return (
    <div>
      <div data-testid={testId}>{value}</div>
      <button onClick={() => setValue(5)}>set-5</button>
    </div>
  );
}

function TwoProbes() {
  return (
    <div>
      <Probe testId="value-a" />
      <Probe testId="value-b" />
    </div>
  );
}

function renderAt(path: string, element = <Probe />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/matchups" element={element} />
            <Route path="/coach/:clientId/matchups" element={element} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('useMinStageMatches', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('reports the default of 3 when nothing is stored, and writes nothing', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderAt('/matchups');

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('3'));
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('persists a set value under this subject key and reports it on a fresh mount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt('/matchups');

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('3'));
    await user.click(screen.getByText('set-5'));
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('5'));
    unmount();

    expect(
      JSON.parse(
        window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', null)) ?? '{}',
      ),
    ).toMatchObject({ minStageMatches: 5 });

    renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('5'));
  });

  it('keeps two consumers under the same subject in step after one of them sets the value, without a remount', async () => {
    const user = userEvent.setup();
    renderAt('/matchups', <TwoProbes />);

    await waitFor(() => expect(screen.getByTestId('value-a')).toHaveTextContent('3'));
    expect(screen.getByTestId('value-b')).toHaveTextContent('3');

    // Click the button inside probe A only — probe B must observe the new
    // value without being remounted itself.
    const buttons = screen.getAllByText('set-5');
    await user.click(buttons[0]!);

    await waitFor(() => expect(screen.getByTestId('value-a')).toHaveTextContent('5'));
    expect(screen.getByTestId('value-b')).toHaveTextContent('5');
  });

  it('falls back to the default for a stored value outside the option list', async () => {
    window.localStorage.setItem(
      analyticsSelectionStorageKey('test-uid', null),
      JSON.stringify({ minStageMatches: 4 }),
    );

    renderAt('/matchups');

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('3'));
  });

  it('falls back to the default for a non-integer stored value', async () => {
    window.localStorage.setItem(
      analyticsSelectionStorageKey('test-uid', null),
      JSON.stringify({ minStageMatches: 3.5 }),
    );

    renderAt('/matchups');

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('3'));
  });

  it('reports an independent value under a different subject', async () => {
    window.localStorage.setItem(
      analyticsSelectionStorageKey('test-uid', null),
      JSON.stringify({ minStageMatches: 5 }),
    );
    window.localStorage.setItem(
      analyticsSelectionStorageKey('test-uid', 'client-a'),
      JSON.stringify({ minStageMatches: 10 }),
    );

    const { unmount } = renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('5'));
    unmount();

    renderAt('/coach/client-a/matchups');
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('10'));
  });
});
