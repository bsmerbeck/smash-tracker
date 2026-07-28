import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import type { UpdateMatchInput } from '@smash-tracker/shared';
import { useUpdateMatch } from './useUpdateMatch';
import { matchesQueryKey } from './useMatches';
import { opponentsQueryKey } from './useOpponents';
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

const updateInput: UpdateMatchInput = {
  fighter_id: 1,
  opponent_id: 2,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'rival',
  notes: '',
  matchType: 'quickplay',
  win: true,
};

const updatedMatch = {
  id: 'match-1',
  fighter_id: 1,
  opponent_id: 2,
  time: 1700000000000,
  win: true,
};

function Wrapper({
  children,
  queryClient,
  initialEntries,
}: {
  children: ReactNode;
  queryClient: QueryClient;
  initialEntries: string[];
}) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId/*" element={children} />
            <Route path="/workspace/:tenantId/*" element={children} />
            <Route path="*" element={children} />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function UpdateMatchProbe() {
  const update = useUpdateMatch();
  return (
    <button onClick={() => update.mutate({ id: 'match-1', input: updateInput })}>Update</button>
  );
}

/**
 * Quick 260726-r8: regression coverage — an edit made inside a claimed
 * `/workspace/:tenantId/*` route must invalidate that workspace's
 * `['client', tenantId, ...]` namespace, not `['personal']`.
 */
describe('useUpdateMatch — mutation cache scope (quick 260726-r8)', () => {
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
        text: async () => JSON.stringify(updatedMatch),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates the CLIENT-scoped key inside a claimed workspace (/workspace/:tenantId)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/workspace/tenant-1/match-data']}>
        <UpdateMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Update' }).click();

    const workspaceSubject = { mode: 'personal' as const, clientId: 'tenant-1' };
    const workspaceMatchesKey = matchesQueryKey(workspaceSubject);
    expect(workspaceMatchesKey).toEqual(['client', 'tenant-1', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceMatchesKey });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: opponentsQueryKey(workspaceSubject),
    });

    const personalMatchesKey = matchesQueryKey({ mode: 'personal', clientId: null });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: personalMatchesKey });
  });

  it('invalidates the PERSONAL-scoped key on a personal route (unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/dashboard']}>
        <UpdateMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Update' }).click();

    const personalSubject = { mode: 'personal' as const, clientId: null };
    const personalMatchesKey = matchesQueryKey(personalSubject);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: personalMatchesKey });
    });
  });

  it('invalidates the CLIENT-scoped key inside a coach client workspace (/coach/:clientId, unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/coach/client-9/match-data']}>
        <UpdateMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Update' }).click();

    const coachSubject = { mode: 'coaching' as const, clientId: 'client-9' };
    const coachMatchesKey = matchesQueryKey(coachSubject);
    expect(coachMatchesKey).toEqual(['client', 'client-9', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: coachMatchesKey });
    });
  });
});
