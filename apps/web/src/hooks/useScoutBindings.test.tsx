import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import {
  prepBindingCandidatesQueryKey,
  useClearScoutBinding,
  useConfirmScoutBinding,
  usePrepBindingCandidates,
} from './useScoutBindings';

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

const upsertMe = vi.fn();
const bindingCandidates = vi.fn();
const confirmBinding = vi.fn();
const clearBinding = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    prep: {
      bindingCandidates: (...args: unknown[]) => bindingCandidates(...args),
      confirmBinding: (...args: unknown[]) => confirmBinding(...args),
      clearBinding: (...args: unknown[]) => clearBinding(...args),
    },
  },
}));

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

const BRIEF_RESPONSE = {
  brief: {
    eventDate: 1,
    activatedAt: 1,
    lastOpenedAt: 1,
    checklist: {},
    likelyOpponents: { Rival: true },
    scoutBindings: {},
  },
};

describe('useScoutBindings', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  });

  describe('usePrepBindingCandidates', () => {
    it('stays disabled by default even when signed in with an entryKey and a name', () => {
      setMockUser(makeMockUser());
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => usePrepBindingCandidates('entry-1', 'Rival'), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(bindingCandidates).not.toHaveBeenCalled();
    });

    it('fetches once explicitly enabled (a confirmation flow is open)', async () => {
      setMockUser(makeMockUser());
      bindingCandidates.mockResolvedValue({ candidates: [] });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(
        () => usePrepBindingCandidates('entry-1', 'Rival', { enabled: true }),
        { wrapper: makeWrapper(queryClient) },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(bindingCandidates).toHaveBeenCalledWith('entry-1', 'Rival');
    });

    it('keys its cache entry by both entryKey and name', () => {
      expect(prepBindingCandidatesQueryKey('entry-1', 'Rival')).toEqual([
        'prepBindingCandidates',
        'entry-1',
        'Rival',
      ]);
    });
  });

  describe('useConfirmScoutBinding', () => {
    it('invalidates exactly the ["prep", entryKey] cache entry on success', async () => {
      setMockUser(makeMockUser());
      confirmBinding.mockResolvedValue(BRIEF_RESPONSE);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useConfirmScoutBinding('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({
        name: 'Rival',
        input: { startgg: { query: 'user/07dc2239' } },
      });

      expect(confirmBinding).toHaveBeenCalledWith('entry-1', 'Rival', {
        startgg: { query: 'user/07dc2239' },
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep', 'entry-1'] });
    });
  });

  describe('useClearScoutBinding', () => {
    it('invalidates exactly the ["prep", entryKey] cache entry on success', async () => {
      setMockUser(makeMockUser());
      clearBinding.mockResolvedValue(BRIEF_RESPONSE);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useClearScoutBinding('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync('Rival');

      expect(clearBinding).toHaveBeenCalledWith('entry-1', 'Rival');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep', 'entry-1'] });
    });
  });
});
