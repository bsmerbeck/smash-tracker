import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import {
  computeSynthesisJobRefetchInterval,
  practicePlanQueryKey,
  synthesisJobQueryKey,
  useSubmitSynthesis,
  useSynthesisJob,
  usePracticePlan,
} from './usePostEventSynthesis';

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

const DIRECT_ORIGIN = 'https://direct.example.com';
const ORDINARY_ORIGIN = 'https://ordinary.example.com';

// `vi.mock` factories are hoisted above the rest of the module, so the mock
// `ApiError` class is declared INSIDE the factory (a top-level const/class
// referenced from a hoisted factory throws `ReferenceError` — the exact
// TDZ pitfall `vi.mock`'s own docs call out).
vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    ApiError: MockApiError,
    getApiBaseUrl: () => 'https://ordinary.example.com',
    getDirectApiBaseUrl: () => 'https://direct.example.com',
    api: { users: { upsertMe: (...args: unknown[]) => upsertMe(...args) } },
  };
});

function mockFetchOnce(response: { ok: boolean; status: number; body?: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: '',
    text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
  });
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('usePostEventSynthesis', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('useSynthesisJob', () => {
    it('is disabled without an entryKey, even when signed in', () => {
      setMockUser(makeMockUser());
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { job: null } });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useSynthesisJob(undefined), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is disabled with no signed-in user, even with an entryKey', () => {
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { job: null } });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useSynthesisJob('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GETs /api/reports/synthesis?entryKey= on the ORDINARY origin and parses {job:null}', async () => {
      setMockUser(makeMockUser());
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { job: null } });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useSynthesisJob('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ job: null });

      const [url] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(`${ORDINARY_ORIGIN}/api/reports/synthesis?entryKey=entry-1`);
    });

    it('parses a non-null job payload', async () => {
      setMockUser(makeMockUser());
      const job = { jobId: 'job-1', status: 'queued', updatedAt: 1 };
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { job } });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useSynthesisJob('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ job });
    });
  });

  describe('computeSynthesisJobRefetchInterval', () => {
    it('is falsy when there is no job at all (undefined or null)', () => {
      expect(computeSynthesisJobRefetchInterval(undefined)).toBe(false);
      expect(computeSynthesisJobRefetchInterval(null)).toBe(false);
    });

    it('is falsy for a succeeded job', () => {
      expect(
        computeSynthesisJobRefetchInterval({ jobId: 'j1', status: 'succeeded', updatedAt: 1 }),
      ).toBe(false);
    });

    it('is falsy for a refunded job', () => {
      expect(
        computeSynthesisJobRefetchInterval({ jobId: 'j1', status: 'refunded', updatedAt: 1 }),
      ).toBe(false);
    });

    it('is a positive number for a queued job', () => {
      const interval = computeSynthesisJobRefetchInterval({
        jobId: 'j1',
        status: 'queued',
        updatedAt: 1,
      });
      expect(interval).not.toBe(false);
      expect(interval as number).toBeGreaterThan(0);
    });

    it('is a positive number for a running job', () => {
      expect(
        computeSynthesisJobRefetchInterval({ jobId: 'j1', status: 'running', updatedAt: 1 }),
      ).not.toBe(false);
    });

    it('is a positive number for a failed (not-yet-refunded) job — it resolves to refunded', () => {
      expect(
        computeSynthesisJobRefetchInterval({ jobId: 'j1', status: 'failed', updatedAt: 1 }),
      ).not.toBe(false);
    });
  });

  describe('usePracticePlan', () => {
    it('is idle without a resultRef', () => {
      setMockUser(makeMockUser());
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: {} });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => usePracticePlan(undefined), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GETs /api/reports/practice-plans/:planId on the ORDINARY origin when given a resultRef', async () => {
      setMockUser(makeMockUser());
      const plan = {
        entryKey: 'entry-1',
        createdAt: 1,
        summary: 'Overview',
        focusAreas: [],
      };
      const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { plan } });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => usePracticePlan('plan-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.plan.summary).toBe('Overview');

      const [url] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(`${ORDINARY_ORIGIN}/api/reports/practice-plans/plan-1`);
    });
  });

  describe('useSubmitSynthesis', () => {
    it('POSTs {reason:"post_event_synthesis", entryKey} to the DIRECT origin and invalidates the synthesis job query on success', async () => {
      setMockUser(makeMockUser());
      const fetchMock = mockFetchOnce({ ok: true, status: 202, body: { jobId: 'job-1' } });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useSubmitSynthesis('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync();

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(`${DIRECT_ORIGIN}/api/reports`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        reason: 'post_event_synthesis',
        entryKey: 'entry-1',
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: synthesisJobQueryKey('entry-1') });
    });

    it('a 402 rejection surfaces distinguishably from other errors', async () => {
      setMockUser(makeMockUser());
      const fetchMock = mockFetchOnce({
        ok: false,
        status: 402,
        body: { error: 'PaymentRequired', message: 'Insufficient credits', statusCode: 402 },
      });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useSubmitSynthesis('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await expect(result.current.mutateAsync()).rejects.toMatchObject({ status: 402 });
    });

    it('a non-402 failure still invalidates the synthesis job query (onSettled, not onSuccess)', async () => {
      setMockUser(makeMockUser());
      const fetchMock = mockFetchOnce({
        ok: false,
        status: 409,
        body: { error: 'Conflict', message: 'outstanding job', statusCode: 409 },
      });
      vi.stubGlobal('fetch', fetchMock);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useSubmitSynthesis('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await expect(result.current.mutateAsync()).rejects.toMatchObject({ status: 409 });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: synthesisJobQueryKey('entry-1') });
    });
  });

  describe('query keys', () => {
    it('are stable and keyed by their id', () => {
      expect(synthesisJobQueryKey('entry-1')).toEqual(['postEventSynthesisJob', 'entry-1']);
      expect(practicePlanQueryKey('plan-1')).toEqual(['postEventPracticePlan', 'plan-1']);
    });
  });
});
