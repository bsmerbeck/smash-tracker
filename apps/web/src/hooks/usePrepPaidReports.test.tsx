import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { creditsQueryKey } from './useBilling';
import { prepReportJobsQueryKey } from './usePrepReportJobs';
import {
  executeBundleChildren,
  useGeneratePrepReport,
  useStartPrepBundle,
} from './usePrepPaidReports';

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
const generatePrep = vi.fn();
const startPrepBundle = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    reports: {
      generatePrep: (...args: unknown[]) => generatePrep(...args),
      startPrepBundle: (...args: unknown[]) => startPrepBundle(...args),
    },
  },
}));

/** A distinguishable payment-required rejection, mirroring `ApiError`'s shape (`.status`). */
class FakePaymentRequiredError extends Error {
  status = 402;
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

describe('usePrepPaidReports', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  });

  describe('useGeneratePrepReport', () => {
    it('sends reason: prep_report, entryKey, opponentName, and an omitted jobId when not provided', async () => {
      generatePrep.mockResolvedValue({
        id: 'report-1',
        createdAt: 1,
        model: 'claude-test',
        player: { gamerTag: 'Rival' },
        report: {},
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useGeneratePrepReport('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({ opponentName: 'Rival' });

      expect(generatePrep).toHaveBeenCalledWith({
        reason: 'prep_report',
        entryKey: 'entry-1',
        opponentName: 'Rival',
      });
    });

    it('forwards a bundle child jobId when provided', async () => {
      generatePrep.mockResolvedValue({
        id: 'report-1',
        createdAt: 1,
        model: 'claude-test',
        player: { gamerTag: 'Rival' },
        report: {},
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useGeneratePrepReport('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({ opponentName: 'Rival', jobId: 'bundle-1:1' });

      expect(generatePrep).toHaveBeenCalledWith({
        reason: 'prep_report',
        entryKey: 'entry-1',
        opponentName: 'Rival',
        jobId: 'bundle-1:1',
      });
    });

    it('invalidates the credits query and the prep-jobs query on a SUCCESSFUL settle', async () => {
      generatePrep.mockResolvedValue({
        id: 'report-1',
        createdAt: 1,
        model: 'claude-test',
        player: { gamerTag: 'Rival' },
        report: {},
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useGeneratePrepReport('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({ opponentName: 'Rival' });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: creditsQueryKey });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: prepReportJobsQueryKey('entry-1') });
    });

    it('ALSO invalidates the credits query and the prep-jobs query on a FAILED settle (a failed job refunds)', async () => {
      generatePrep.mockRejectedValue(new Error('model call failed'));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useGeneratePrepReport('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await expect(result.current.mutateAsync({ opponentName: 'Rival' })).rejects.toThrow(
        'model call failed',
      );

      await waitFor(() =>
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: creditsQueryKey }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: prepReportJobsQueryKey('entry-1') });
    });

    it('surfaces a 402 rejection to the caller as a distinguishable payment-required error rather than swallowing it', async () => {
      generatePrep.mockRejectedValue(new FakePaymentRequiredError('Insufficient credits'));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useGeneratePrepReport('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await expect(result.current.mutateAsync({ opponentName: 'Rival' })).rejects.toMatchObject({
        status: 402,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect((result.current.error as FakePaymentRequiredError).status).toBe(402);
    });
  });

  describe('useStartPrepBundle', () => {
    const ACCEPTED_RESPONSE = {
      bundleId: 'bundle-1',
      jobs: [
        { opponentName: 'Rival', jobId: 'bundle-1:1', slot: 1 },
        { opponentName: 'Nemesis', jobId: 'bundle-1:2', slot: 2 },
        { opponentName: 'Foil', jobId: 'bundle-1:3', slot: 3 },
      ],
    };

    it('sends reason: prep_bundle with entryKey, bundleId, and opponentNames', async () => {
      startPrepBundle.mockResolvedValue(ACCEPTED_RESPONSE);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useStartPrepBundle('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({
        bundleId: 'bundle-1',
        opponentNames: ['Rival', 'Nemesis', 'Foil'],
      });

      expect(startPrepBundle).toHaveBeenCalledWith({
        reason: 'prep_bundle',
        entryKey: 'entry-1',
        bundleId: 'bundle-1',
        opponentNames: ['Rival', 'Nemesis', 'Foil'],
      });
    });

    it('returns the accepted child job list', async () => {
      startPrepBundle.mockResolvedValue(ACCEPTED_RESPONSE);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useStartPrepBundle('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      const accepted = await result.current.mutateAsync({
        bundleId: 'bundle-1',
        opponentNames: ['Rival', 'Nemesis', 'Foil'],
      });

      expect(accepted).toEqual(ACCEPTED_RESPONSE);
    });

    it('invalidates the credits query and the prep-jobs query on settle', async () => {
      startPrepBundle.mockResolvedValue(ACCEPTED_RESPONSE);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useStartPrepBundle('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await result.current.mutateAsync({
        bundleId: 'bundle-1',
        opponentNames: ['Rival', 'Nemesis', 'Foil'],
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: creditsQueryKey });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: prepReportJobsQueryKey('entry-1') });
    });

    it('surfaces a 402 rejection rather than swallowing it', async () => {
      startPrepBundle.mockRejectedValue(new FakePaymentRequiredError('Insufficient credits'));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => useStartPrepBundle('entry-1'), {
        wrapper: makeWrapper(queryClient),
      });

      await expect(
        result.current.mutateAsync({
          bundleId: 'bundle-1',
          opponentNames: ['Rival', 'Nemesis', 'Foil'],
        }),
      ).rejects.toMatchObject({ status: 402 });
    });
  });

  describe('executeBundleChildren', () => {
    it('fires all three children concurrently, one call per job', async () => {
      const generateChild = vi.fn().mockResolvedValue({ ok: true });
      const jobs = [
        { opponentName: 'Rival', jobId: 'bundle-1:1' },
        { opponentName: 'Nemesis', jobId: 'bundle-1:2' },
        { opponentName: 'Foil', jobId: 'bundle-1:3' },
      ];

      const results = await executeBundleChildren(generateChild, jobs);

      expect(generateChild).toHaveBeenCalledTimes(3);
      expect(generateChild).toHaveBeenCalledWith({ opponentName: 'Rival', jobId: 'bundle-1:1' });
      expect(generateChild).toHaveBeenCalledWith({ opponentName: 'Nemesis', jobId: 'bundle-1:2' });
      expect(generateChild).toHaveBeenCalledWith({ opponentName: 'Foil', jobId: 'bundle-1:3' });
      expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true);
    });

    it('does not let one child rejection short-circuit the other two', async () => {
      const generateChild = vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('child 2 failed, refunded server-side'))
        .mockResolvedValueOnce({ ok: true });
      const jobs = [
        { opponentName: 'Rival', jobId: 'bundle-1:1' },
        { opponentName: 'Nemesis', jobId: 'bundle-1:2' },
        { opponentName: 'Foil', jobId: 'bundle-1:3' },
      ];

      const results = await executeBundleChildren(generateChild, jobs);

      expect(generateChild).toHaveBeenCalledTimes(3);
      expect(results[0]?.status).toBe('fulfilled');
      expect(results[1]?.status).toBe('rejected');
      expect(results[2]?.status).toBe('fulfilled');
    });
  });
});
