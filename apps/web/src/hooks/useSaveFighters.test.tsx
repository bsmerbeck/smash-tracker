import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { useSaveFighters } from './useSaveFighters';
import { fightersQueryKey } from './useFighters';
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

function SaveFightersProbe() {
  const save = useSaveFighters();
  return <button onClick={() => save.mutate({ primary: [1], secondary: [2] })}>Save</button>;
}

/**
 * Quick 260726-r8: regression coverage — a fighters save inside a claimed
 * `/workspace/:tenantId/*` route must invalidate that workspace's
 * `['client', tenantId, ...]` namespace, not `['personal']`.
 */
describe('useSaveFighters — mutation cache scope (quick 260726-r8)', () => {
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
        text: async () => JSON.stringify({ primary: [1], secondary: [2] }),
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
      <Wrapper queryClient={queryClient} initialEntries={['/workspace/tenant-1/fighters']}>
        <SaveFightersProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Save' }).click();

    const workspaceFightersKey = fightersQueryKey({ mode: 'personal', clientId: 'tenant-1' });
    expect(workspaceFightersKey).toEqual(['client', 'tenant-1', 'fighters']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceFightersKey });
    });

    const personalFightersKey = fightersQueryKey({ mode: 'personal', clientId: null });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: personalFightersKey });
  });

  it('invalidates the PERSONAL-scoped key on a personal route (unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/choose-primary']}>
        <SaveFightersProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Save' }).click();

    const personalFightersKey = fightersQueryKey({ mode: 'personal', clientId: null });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: personalFightersKey });
    });
  });

  it('invalidates the CLIENT-scoped key inside a coach client workspace (/coach/:clientId, unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/coach/client-9/fighters']}>
        <SaveFightersProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Save' }).click();

    const coachFightersKey = fightersQueryKey({ mode: 'coaching', clientId: 'client-9' });
    expect(coachFightersKey).toEqual(['client', 'client-9', 'fighters']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: coachFightersKey });
    });
  });
});
