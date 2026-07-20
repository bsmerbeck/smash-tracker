import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useScoutPlayer } from './useScoutPlayer';
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

import { AuthProvider } from '@/context/AuthContext';

const rawReport = {
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  sampledSets: 3,
  sampledGames: 6,
  characters: [{ fighterId: 67, games: 6, wins: 4 }],
  stages: [{ stageId: 1, games: 6, wins: 4 }],
  recentEvents: [{ eventName: 'Ultimate Singles', lastSetAt: 1_700_000_000_000 }],
  commonOpponents: [{ gamerTag: 'PowPow', sets: 2 }],
};

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function ScoutProbe() {
  const scout = useScoutPlayer();
  return (
    <div>
      <button onClick={() => scout.mutate({ query: 'user/07dc2239' })}>go</button>
      {scout.isPending && <div>pending</div>}
      {scout.isSuccess && <div>gamerTag: {scout.data.player.gamerTag}</div>}
      {scout.isError && <div>errored</div>}
    </div>
  );
}

describe('useScoutPlayer', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the query with a Bearer auth header and resolves the parsed report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(rawReport),
      }),
    );

    render(
      <Wrapper>
        <ScoutProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('go'));

    await waitFor(() => expect(screen.getByText('gamerTag: Pandem1c')).toBeInTheDocument());

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) {
      throw new Error('expected fetch to have been called');
    }
    const [url, init] = call;
    expect(String(url)).toContain('/api/scout');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer mock-id-token');
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'user/07dc2239' });
  });

  it('surfaces an error state on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () =>
          JSON.stringify({
            error: 'Not Found',
            message: 'No start.gg player found for that query',
            statusCode: 404,
          }),
      }),
    );

    render(
      <Wrapper>
        <ScoutProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('go'));

    await waitFor(() => expect(screen.getByText('errored')).toBeInTheDocument());
  });
});
