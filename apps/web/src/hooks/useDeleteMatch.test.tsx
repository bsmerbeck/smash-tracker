import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { useDeleteMatch } from './useDeleteMatch';
import { matchesQueryKey } from './useMatches';
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

function DeleteMatchProbe() {
  const remove = useDeleteMatch();
  return <button onClick={() => remove.mutate('match-1')}>Delete</button>;
}

/**
 * Quick 260726-r8: `useDeleteMatch` shared the same `useActiveSubject()`
 * defect as `useCreateMatch`/`useUpdateMatch` — not called out by name in
 * the original bug report, but found during this quick's audit of every
 * mutation hook that keys/invalidates a subject-scoped query.
 */
describe('useDeleteMatch — mutation cache scope (quick 260726-r8)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        text: async () => '',
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
        <DeleteMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Delete' }).click();

    const workspaceMatchesKey = matchesQueryKey({ mode: 'personal', clientId: 'tenant-1' });
    expect(workspaceMatchesKey).toEqual(['client', 'tenant-1', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceMatchesKey });
    });

    const personalMatchesKey = matchesQueryKey({ mode: 'personal', clientId: null });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: personalMatchesKey });
  });

  it('invalidates the PERSONAL-scoped key on a personal route (unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/dashboard']}>
        <DeleteMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Delete' }).click();

    const personalMatchesKey = matchesQueryKey({ mode: 'personal', clientId: null });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: personalMatchesKey });
    });
  });

  it('invalidates the CLIENT-scoped key inside a coach client workspace (/coach/:clientId, unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/coach/client-9/match-data']}>
        <DeleteMatchProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Delete' }).click();

    const coachMatchesKey = matchesQueryKey({ mode: 'coaching', clientId: 'client-9' });
    expect(coachMatchesKey).toEqual(['client', 'client-9', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: coachMatchesKey });
    });
  });
});
