import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMatches } from './useMatches';
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

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
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
    render(
      <Wrapper>
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
});
