import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import {
  usePrepBrief,
  useActivatePrepBrief,
  useReopenPrepBrief,
  useTogglePrepChecklistItem,
  useToggleReviewChecklistItem,
  prepBriefQueryKey,
} from './usePrepBrief';

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
const prepGet = vi.fn();
const prepActivate = vi.fn();
const prepOpen = vi.fn();
const prepSetChecklistItem = vi.fn();
const prepSetReviewChecklistItem = vi.fn();
const prepAddLikelyOpponent = vi.fn();
const prepRemoveLikelyOpponent = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    prep: {
      get: (...args: unknown[]) => prepGet(...args),
      activate: (...args: unknown[]) => prepActivate(...args),
      open: (...args: unknown[]) => prepOpen(...args),
      setChecklistItem: (...args: unknown[]) => prepSetChecklistItem(...args),
      setReviewChecklistItem: (...args: unknown[]) => prepSetReviewChecklistItem(...args),
      addLikelyOpponent: (...args: unknown[]) => prepAddLikelyOpponent(...args),
      removeLikelyOpponent: (...args: unknown[]) => prepRemoveLikelyOpponent(...args),
    },
  },
}));

/** Builds a `renderHook` wrapper backed by a caller-supplied `QueryClient` so tests can spy on it. */
function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('usePrepBrief', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  });

  describe('usePrepBrief (query)', () => {
    it('stays disabled (never fetches) while there is no signed-in user, even with an entryKey', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => usePrepBrief('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(prepGet).not.toHaveBeenCalled();
    });

    it('stays disabled (never fetches) while entryKey is undefined, even when signed in', async () => {
      setMockUser(makeMockUser());
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => usePrepBrief(undefined), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(prepGet).not.toHaveBeenCalled();
    });

    it('fetches once signed in with a defined entryKey', async () => {
      setMockUser(makeMockUser());
      prepGet.mockResolvedValue({ activated: false });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => usePrepBrief('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(prepGet).toHaveBeenCalledWith('entry-1');
    });
  });

  describe('useTogglePrepChecklistItem', () => {
    it('invalidates exactly the ["prep", entryKey] cache entry on success', async () => {
      setMockUser(makeMockUser());
      prepSetChecklistItem.mockResolvedValue({
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useTogglePrepChecklistItem('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({ itemId: 'confirmRegistration', checked: true });

      expect(prepSetChecklistItem).toHaveBeenCalledWith('entry-1', 'confirmRegistration', {
        checked: true,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep', 'entry-1'] });
    });
  });

  describe('useToggleReviewChecklistItem', () => {
    it('calls api.prep.setReviewChecklistItem with entryKey, itemId, and { checked } — the PUT /prep/:entryKey/review-checklist/:itemId body', async () => {
      setMockUser(makeMockUser());
      prepSetReviewChecklistItem.mockResolvedValue({
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
          reviewChecklist: { attachVods: true },
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useToggleReviewChecklistItem('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({ itemId: 'attachVods', checked: true });

      expect(prepSetReviewChecklistItem).toHaveBeenCalledWith('entry-1', 'attachVods', {
        checked: true,
      });
    });

    it('optimistically updates the ["prep", entryKey] cache before the request resolves', async () => {
      setMockUser(makeMockUser());
      let resolveRequest: (value: unknown) => void = () => {};
      prepSetReviewChecklistItem.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      );
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(prepBriefQueryKey('entry-1'), {
        activated: true,
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
          reviewChecklist: {},
        },
      });

      const { result } = renderHook(() => useToggleReviewChecklistItem('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      const mutatePromise = result.current.mutateAsync({ itemId: 'attachVods', checked: true });

      await waitFor(() => {
        const cached = queryClient.getQueryData<{ brief: { reviewChecklist: object } }>(
          prepBriefQueryKey('entry-1'),
        );
        expect(cached?.brief.reviewChecklist).toEqual({ attachVods: true });
      });

      resolveRequest({
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
          reviewChecklist: { attachVods: true },
        },
      });
      await mutatePromise;
    });

    it('rolls back the ["prep", entryKey] cache to its pre-mutation snapshot when the request fails', async () => {
      setMockUser(makeMockUser());
      prepSetReviewChecklistItem.mockRejectedValue(new Error('network error'));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const initial = {
        activated: true,
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
          reviewChecklist: {},
        },
      };
      queryClient.setQueryData(prepBriefQueryKey('entry-1'), initial);

      const { result } = renderHook(() => useToggleReviewChecklistItem('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await expect(
        result.current.mutateAsync({ itemId: 'attachVods', checked: true }),
      ).rejects.toThrow('network error');

      expect(queryClient.getQueryData(prepBriefQueryKey('entry-1'))).toEqual(initial);
    });

    it('invalidates exactly the ["prep", entryKey] cache entry once the mutation settles', async () => {
      setMockUser(makeMockUser());
      prepSetReviewChecklistItem.mockResolvedValue({
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
          reviewChecklist: { attachVods: true },
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useToggleReviewChecklistItem('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({ itemId: 'attachVods', checked: true });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep', 'entry-1'] });
    });
  });

  describe('useReopenPrepBrief', () => {
    it('passes the caller-supplied openId straight through to api.prep.open', async () => {
      setMockUser(makeMockUser());
      prepOpen.mockResolvedValue({
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 2,
          checklist: {},
          likelyOpponents: {},
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useReopenPrepBrief('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync('stable-open-id-123');

      expect(prepOpen).toHaveBeenCalledWith('entry-1', { openId: 'stable-open-id-123' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep', 'entry-1'] });
    });
  });

  describe('useActivatePrepBrief', () => {
    it('invalidates exactly ["prep", entryKey] and never the tournaments list', async () => {
      setMockUser(makeMockUser());
      prepActivate.mockResolvedValue({
        justActivated: true,
        brief: {
          eventDate: 1,
          activatedAt: 1,
          lastOpenedAt: 1,
          checklist: {},
          likelyOpponents: {},
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useActivatePrepBrief('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync();

      expect(prepActivate).toHaveBeenCalledWith('entry-1');
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['prep', 'entry-1'] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['tournaments'] });
    });
  });
});
