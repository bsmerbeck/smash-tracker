import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { useCreateNote } from './useVodNotes';
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

function CreateNoteProbe() {
  const create = useCreateNote();
  return (
    <button
      onClick={() => create.mutate({ matchId: 'match-1', input: { seconds: 10, note: 'punish' } })}
    >
      Add note
    </button>
  );
}

/**
 * Quick 260726-r8: regression coverage for the `useVodNotes` mutation hooks
 * (`useCreateNote`/`useUpdateNote`/`useDeleteNote`/`useClearVodAndNotes`),
 * exercised here via `useCreateNote` as the representative case — all four
 * hooks share the exact same subject-derivation line, converted together.
 */
describe('useCreateNote — mutation cache scope (quick 260726-r8)', () => {
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
        text: async () => JSON.stringify({ id: 'note-1', seconds: 10, note: 'punish' }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates the CLIENT-scoped matches key inside a claimed workspace (/workspace/:tenantId)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/workspace/tenant-1/vods']}>
        <CreateNoteProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Add note' }).click();

    const workspaceMatchesKey = matchesQueryKey({ mode: 'personal', clientId: 'tenant-1' });
    expect(workspaceMatchesKey).toEqual(['client', 'tenant-1', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceMatchesKey });
    });

    const personalMatchesKey = matchesQueryKey({ mode: 'personal', clientId: null });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: personalMatchesKey });
  });

  it('invalidates the PERSONAL-scoped matches key on a personal route (unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/vod']}>
        <CreateNoteProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Add note' }).click();

    const personalMatchesKey = matchesQueryKey({ mode: 'personal', clientId: null });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: personalMatchesKey });
    });
  });

  it('invalidates the CLIENT-scoped matches key inside a coach client workspace (/coach/:clientId, unchanged behavior)', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient} initialEntries={['/coach/client-9/vods']}>
        <CreateNoteProbe />
      </Wrapper>,
    );

    screen.getByRole('button', { name: 'Add note' }).click();

    const coachMatchesKey = matchesQueryKey({ mode: 'coaching', clientId: 'client-9' });
    expect(coachMatchesKey).toEqual(['client', 'client-9', 'matches']);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: coachMatchesKey });
    });
  });
});
