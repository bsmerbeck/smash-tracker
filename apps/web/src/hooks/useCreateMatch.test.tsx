import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import type { CreateMatchInput } from '@smash-tracker/shared';
import { useCreateMatch } from './useCreateMatch';
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

// @/lib/api (exercised for real by this test) calls getFirebaseAuth() from
// @/lib/firebase; mock that module boundary so it never tries to read real
// Vite env vars or call the real firebase/app initializeApp.
vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

import { AuthProvider } from '@/context/AuthContext';

const createInput: CreateMatchInput = {
  fighter_id: 1,
  opponent_id: 2,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'rival',
  notes: '',
  matchType: 'quickplay',
  win: true,
};

const createdMatch = {
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

function CreateMatchProbe() {
  const create = useCreateMatch();
  return (
    <button onClick={() => create.mutate(createInput)} disabled={create.isPending}>
      Create
    </button>
  );
}

/**
 * Quick 260726-r8: regression coverage for the reported production bug — a
 * match created inside a claimed `/workspace/:tenantId/*` route must
 * invalidate that workspace's `['client', tenantId, ...]` cache namespace,
 * not `['personal']` (the old `useActiveSubject()`-derived key). Asserts the
 * exact invalidated `queryKey`, not merely that `invalidateQueries` was
 * called — a call-count-only assertion would not have caught this bug (the
 * hook DID call `invalidateQueries` before this fix, just with the wrong key).
 */
describe('useCreateMatch — mutation cache scope (quick 260726-r8)', () => {
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
        text: async () => JSON.stringify(createdMatch),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates the CLIENT-scoped key inside a claimed workspace (/workspace/:tenantId) — the reported bug', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/workspace/tenant-1/match-data']}>
        <CreateMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Create' }).click();

    const workspaceSubject = { mode: 'personal' as const, clientId: 'tenant-1' };
    const workspaceMatchesKey = matchesQueryKey(workspaceSubject);
    expect(workspaceMatchesKey).toEqual(['client', 'tenant-1', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceMatchesKey });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: opponentsQueryKey(workspaceSubject),
    });

    // Never touches the personal namespace — no cross-subject bleed.
    const personalMatchesKey = matchesQueryKey({ mode: 'personal', clientId: null });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: personalMatchesKey });
  });

  it('invalidates the PERSONAL-scoped key on a personal route (unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/dashboard']}>
        <CreateMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Create' }).click();

    const personalSubject = { mode: 'personal' as const, clientId: null };
    const personalMatchesKey = matchesQueryKey(personalSubject);
    expect(personalMatchesKey).toEqual(['personal', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: personalMatchesKey });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: opponentsQueryKey(personalSubject) });
  });

  it('invalidates the CLIENT-scoped key inside a coach client workspace (/coach/:clientId, unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/coach/client-9/match-data']}>
        <CreateMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Create' }).click();

    const coachSubject = { mode: 'coaching' as const, clientId: 'client-9' };
    const coachMatchesKey = matchesQueryKey(coachSubject);
    expect(coachMatchesKey).toEqual(['client', 'client-9', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: coachMatchesKey });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: opponentsQueryKey(coachSubject) });
  });
});
