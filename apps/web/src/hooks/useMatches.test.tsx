import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { useMatches, matchesQueryKey } from './useMatches';
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

// @/lib/api (exercised for real by this test) calls getFirebaseAuth() from
// @/lib/firebase; mock that module boundary so it never tries to read real
// Vite env vars or call the real firebase/app initializeApp.
vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

// useAuth (used by useMatches to gate `enabled`) reads from AuthContext, so
// wrap with the real AuthProvider — mocked firebase/auth above drives it.
import { AuthProvider } from '@/context/AuthContext';

const rawMatch = {
  id: 'match-1',
  fighter_id: 1,
  opponent_id: 2,
  time: 1700000000000,
  map: { id: 3, name: 'Battlefield' },
  opponent: 'rival',
  notes: 'close game',
  matchType: 'quickplay',
  win: true,
};

function Wrapper({
  children,
  queryClient,
  initialEntries = ['/dashboard'],
}: {
  children: ReactNode;
  queryClient: QueryClient;
  initialEntries?: string[];
}) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId/*" element={children} />
            <Route path="*" element={children} />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function MatchesProbe() {
  const { data, isSuccess } = useMatches();
  if (!isSuccess) {
    return <div>loading</div>;
  }
  return <div>matches: {data.length}</div>;
}

describe('useMatches', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([rawMatch]),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches matches with a Bearer auth header and validates the response against the shared schema', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Wrapper queryClient={queryClient}>
        <MatchesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('matches: 1')).toBeInTheDocument());

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) {
      throw new Error('expected fetch to have been called');
    }
    const [url, init] = call;
    expect(String(url)).toContain('/api/matches');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer mock-id-token');
  });

  it('caches under the personal-scoped key on a non-coaching route (TEN-04)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Wrapper queryClient={queryClient} initialEntries={['/dashboard']}>
        <MatchesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('matches: 1')).toBeInTheDocument());

    const key = matchesQueryKey({ mode: 'personal', clientId: null });
    expect(key).toEqual(['personal', 'matches']);
    expect(queryClient.getQueryData(key)).toBeDefined();
  });

  it('caches under the client-scoped key on a /coach/:clientId route (TEN-04)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Wrapper queryClient={queryClient} initialEntries={['/coach/tenant-1/vods']}>
        <MatchesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('matches: 1')).toBeInTheDocument());

    const key = matchesQueryKey({ mode: 'coaching', clientId: 'tenant-1' });
    expect(key).toEqual(['client', 'tenant-1', 'matches']);
    expect(queryClient.getQueryData(key)).toBeDefined();
    // The personal-scoped key must stay empty — no cross-subject bleed.
    expect(
      queryClient.getQueryData(matchesQueryKey({ mode: 'personal', clientId: null })),
    ).toBeUndefined();
  });
});
