import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import {
  stageFavoritesQueryKey,
  useStageFavorites,
  useUpdateStageFavorites,
} from './useStageFavorites';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

import { AuthProvider } from '@/context/AuthContext';

function Wrapper({
  children,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function FavoritesProbe() {
  const { data, isSuccess } = useStageFavorites();
  const update = useUpdateStageFavorites();
  if (!isSuccess) {
    return <div>loading</div>;
  }
  return (
    <div>
      <div>stageIds: {data.stageIds.join(',') || 'none'}</div>
      <button onClick={() => update.mutate({ stageIds: [113, 1] })}>Update</button>
    </div>
  );
}

describe('useStageFavorites', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches favorites with a Bearer auth header and validates against the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ stageIds: [113], updatedAt: 0 }),
      }),
    );

    render(
      <Wrapper>
        <FavoritesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('stageIds: 113')).toBeInTheDocument());

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) {
      throw new Error('expected fetch to have been called');
    }
    const [url, init] = call;
    expect(String(url)).toContain('/api/stage-favorites');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer mock-id-token');
  });

  it('PUTs the update and invalidates the favorites query', async () => {
    let stored: { stageIds: number[]; updatedAt: number } = { stageIds: [], updatedAt: 0 };
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        stored = { stageIds: [113, 1], updatedAt: 999 };
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(stored),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Wrapper>
        <FavoritesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('stageIds: none')).toBeInTheDocument());

    screen.getByRole('button', { name: 'Update' }).click();

    await waitFor(() => expect(screen.getByText('stageIds: 113,1')).toBeInTheDocument());

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      stageIds: [113, 1],
    });
  });

  it('applies the update optimistically while the PUT is in flight and reverts on failure', async () => {
    let rejectPut!: (error: Error) => void;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        // Hang until the test releases it, so the optimistic window is observable.
        return new Promise((_resolve, reject) => {
          rejectPut = reject;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ stageIds: [], updatedAt: 0 }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Wrapper>
        <FavoritesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('stageIds: none')).toBeInTheDocument());

    screen.getByRole('button', { name: 'Update' }).click();

    // Optimistic: the cache shows the new list before the PUT has resolved.
    await waitFor(() => expect(screen.getByText('stageIds: 113,1')).toBeInTheDocument());

    rejectPut(new Error('network down'));

    // Rolled back (and re-synced with server truth by the settle refetch).
    await waitFor(() => expect(screen.getByText('stageIds: none')).toBeInTheDocument());
  });

  it('caches under the personal-scoped key on a non-coaching route (TEN-04)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ stageIds: [113], updatedAt: 0 }),
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <Wrapper queryClient={queryClient}>
        <FavoritesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('stageIds: 113')).toBeInTheDocument());

    const key = stageFavoritesQueryKey({ mode: 'personal', clientId: null });
    expect(key).toEqual(['personal', 'stageFavorites']);
    expect(queryClient.getQueryData(key)).toBeDefined();
  });
});
