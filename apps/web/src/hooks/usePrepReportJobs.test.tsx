import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PrepReportJobStatusEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import {
  computePrepReportJobsRefetchInterval,
  mapPrepReportJobsByOpponentName,
  usePrepReportJobs,
} from './usePrepReportJobs';

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
const prepJobs = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    reports: {
      prepJobs: (...args: unknown[]) => prepJobs(...args),
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

function makeJob(overrides: Partial<PrepReportJobStatusEntry>): PrepReportJobStatusEntry {
  return {
    opponentName: 'Rival',
    jobId: 'job-1',
    status: 'queued',
    updatedAt: 1,
    ...overrides,
  };
}

describe('usePrepReportJobs', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  });

  it('stays disabled with no signed-in user, even with an entryKey', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePrepReportJobs('entry-1'), {
      wrapper: makeWrapper(queryClient),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(prepJobs).not.toHaveBeenCalled();
  });

  it('stays disabled with no entryKey, even when signed in', () => {
    setMockUser(makeMockUser());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePrepReportJobs(undefined), {
      wrapper: makeWrapper(queryClient),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(prepJobs).not.toHaveBeenCalled();
  });

  it('stays disabled when options.enabled is explicitly false, even when signed in with an entryKey', () => {
    setMockUser(makeMockUser());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePrepReportJobs('entry-1', { enabled: false }), {
      wrapper: makeWrapper(queryClient),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(prepJobs).not.toHaveBeenCalled();
  });

  it('fetches once signed in with a defined entryKey and options.enabled unset', async () => {
    setMockUser(makeMockUser());
    prepJobs.mockResolvedValue({ jobs: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePrepReportJobs('entry-1'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(prepJobs).toHaveBeenCalledWith('entry-1');
  });

  it('exposes a lookup from opponent name to that opponent job entry', async () => {
    setMockUser(makeMockUser());
    const rivalJob = makeJob({ opponentName: 'Rival', jobId: 'job-1', status: 'succeeded' });
    const nemesisJob = makeJob({ opponentName: 'Nemesis', jobId: 'job-2', status: 'running' });
    prepJobs.mockResolvedValue({ jobs: [rivalJob, nemesisJob] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePrepReportJobs('entry-1'), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.jobsByOpponentName).toEqual({
      Rival: rivalJob,
      Nemesis: nemesisJob,
    });
  });

  describe('mapPrepReportJobsByOpponentName', () => {
    it('keys each job by its opponentName', () => {
      const rivalJob = makeJob({ opponentName: 'Rival' });
      const nemesisJob = makeJob({ opponentName: 'Nemesis', jobId: 'job-2' });
      expect(mapPrepReportJobsByOpponentName([rivalJob, nemesisJob])).toEqual({
        Rival: rivalJob,
        Nemesis: nemesisJob,
      });
    });

    it('returns an empty record for an empty job list', () => {
      expect(mapPrepReportJobsByOpponentName([])).toEqual({});
    });
  });

  describe('computePrepReportJobsRefetchInterval', () => {
    it('is falsy for an all-terminal fixture (succeeded + refunded)', () => {
      const jobs = [
        makeJob({ opponentName: 'Rival', status: 'succeeded' }),
        makeJob({ opponentName: 'Nemesis', status: 'refunded' }),
      ];
      expect(computePrepReportJobsRefetchInterval(jobs)).toBe(false);
    });

    it('is falsy for an empty job list', () => {
      expect(computePrepReportJobsRefetchInterval([])).toBe(false);
    });

    it('is falsy for undefined data (query has not resolved yet)', () => {
      expect(computePrepReportJobsRefetchInterval(undefined)).toBe(false);
    });

    it('is a positive number for a fixture containing a queued job', () => {
      const jobs = [
        makeJob({ opponentName: 'Rival', status: 'queued' }),
        makeJob({ opponentName: 'Nemesis', status: 'succeeded' }),
      ];
      const interval = computePrepReportJobsRefetchInterval(jobs);
      expect(interval).not.toBe(false);
      expect(typeof interval).toBe('number');
      expect(interval as number).toBeGreaterThan(0);
    });

    it('is a positive number for a fixture containing a running job', () => {
      const jobs = [makeJob({ status: 'running' })];
      expect(computePrepReportJobsRefetchInterval(jobs)).not.toBe(false);
    });

    it('is a positive number for a fixture containing a failed (not-yet-refunded) job', () => {
      const jobs = [makeJob({ status: 'failed' })];
      expect(computePrepReportJobsRefetchInterval(jobs)).not.toBe(false);
    });
  });
});
