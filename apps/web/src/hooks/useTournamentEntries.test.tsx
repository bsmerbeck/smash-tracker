import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTournamentEntries } from './useTournamentEntries';
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

const rawEntry = {
  eventId: 987,
  eventName: 'Ultimate Singles',
  tournamentName: 'Test Weekly 42',
  numEntrants: 512,
  seed: 408,
  placement: 257,
  firstSetAt: 1_700_000_000_000,
  lastSetAt: 1_700_000_500_000,
  setsPlayed: 5,
};

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function EntriesProbe() {
  const { data, isSuccess } = useTournamentEntries();
  if (!isSuccess) {
    return <div>loading</div>;
  }
  return <div>entries: {data.length}</div>;
}

describe('useTournamentEntries', () => {
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
        text: async () => JSON.stringify([rawEntry]),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches tournament entries with a Bearer auth header and validates against the shared schema', async () => {
    render(
      <Wrapper>
        <EntriesProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('entries: 1')).toBeInTheDocument());

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) {
      throw new Error('expected fetch to have been called');
    }
    const [url, init] = call;
    expect(String(url)).toContain('/api/tournaments');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer mock-id-token');
  });
});
