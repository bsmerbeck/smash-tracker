import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useDataCoverage } from './useDataCoverage';

const coverage = vi.fn();
const useResearchSubject = vi.fn();

/** Mirrors `ApiError`'s shape (`.status`) — see `usePrepPaidReports.test.tsx`'s established convention. */
const { FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { FakeApiError };
});

vi.mock('@/lib/api', () => ({
  api: {
    research: {
      coverage: (...args: unknown[]) => coverage(...args),
    },
  },
  ApiError: FakeApiError,
}));

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
}));

/**
 * `useDataCoverage` derives its tenant id from the route via
 * `useEffectiveSubject` (the REAL hook, unmocked) — every test exercises
 * that through an actual matched route, mirroring
 * `useResearchSubject.test.tsx`'s own wrapper.
 */
function makeWrapper(queryClient: QueryClient, path: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/coach/:clientId/*" element={<>{children}</>} />
            <Route path="/workspace/:tenantId/*" element={<>{children}</>} />
            <Route path="*" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const RESEARCH_SUBJECT_RESEARCH = {
  isResearch: true,
  isPending: false,
  isError: false,
  retry: vi.fn(),
};
const RESEARCH_SUBJECT_ORDINARY = {
  isResearch: false,
  isPending: false,
  isError: false,
  retry: vi.fn(),
};
const RESEARCH_SUBJECT_PENDING = {
  isResearch: false,
  isPending: true,
  isError: false,
  retry: vi.fn(),
};
const RESEARCH_SUBJECT_ERRORED = {
  isResearch: false,
  isPending: false,
  isError: true,
  retry: vi.fn(),
};

const COVERAGE_RESPONSE = {
  coverage: {
    asOfMs: 1_770_000_000_000,
    players: {
      mkleo: {
        playerId: 'mkleo',
        runId: 'run-1',
        runCompletedAtMs: 1_770_000_000_000,
        asOfMs: 1_770_000_000_000,
        counters: {
          discoveredAllGames: 10,
          discoveredEligible: 9,
          imported: 8,
          skipped: 1,
          unresolved: 0,
          corrected: 0,
        },
        namedGaps: {},
        dateCoverage: { earliestSetAtMs: 1_700_000_000_000, latestSetAtMs: 1_770_000_000_000 },
        classificationCounts: {},
        uniqueCounters: {
          discoveredAllGames: 10,
          discoveredEligible: 9,
          imported: 8,
          skipped: 1,
          unresolved: 0,
          corrected: 0,
        },
        uniqueNamedGaps: {},
        uniqueClassificationCounts: {},
      },
    },
    totals: {
      counters: {
        discoveredAllGames: 10,
        discoveredEligible: 9,
        imported: 8,
        skipped: 1,
        unresolved: 0,
        corrected: 0,
      },
      namedGaps: {},
      dateCoverage: { earliestSetAtMs: 1_700_000_000_000, latestSetAtMs: 1_770_000_000_000 },
      classificationCounts: {},
    },
  },
  confirmedPlayerIds: ['mkleo', 'sparg0'],
  confirmedPlayerIdCount: 2,
  unresolvedCandidateCount: 3,
  activeRun: {
    runId: 'run-2',
    status: 'running',
    playerId: 'sparg0',
    startedAtMs: 1_770_000_001_000,
    cursorPage: 2,
    totalPages: 5,
  },
};

describe('useDataCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues no request when there is no active client id', () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_ORDINARY);
    const { result } = renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/dashboard'),
    });

    expect(coverage).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ isResearch: false, isPending: false, isError: false });
  });

  it('issues no request when the active workspace resolves as ordinary', () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_ORDINARY);
    renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    expect(coverage).not.toHaveBeenCalled();
  });

  it('issues no request while the workspace kind is still pending', () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_PENDING);
    renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    expect(coverage).not.toHaveBeenCalled();
  });

  it('issues no request when the workspace kind lookup errored', () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_ERRORED);
    renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    expect(coverage).not.toHaveBeenCalled();
  });

  it('on a research workspace with a successful response reports the snapshot, confirmed ids, unresolved count, and active run', async () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_RESEARCH);
    coverage.mockResolvedValue(COVERAGE_RESPONSE);

    const { result } = renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(coverage).toHaveBeenCalledWith('tetra');
    expect(result.current.hasCompletedRun).toBe(true);
    expect(result.current.data?.coverage?.players.mkleo).toBeDefined();
    expect(result.current.data?.coverage?.totals).toBeDefined();
    expect(result.current.data?.confirmedPlayerIds).toEqual(['mkleo', 'sparg0']);
    expect(result.current.data?.confirmedPlayerIdCount).toBe(2);
    expect(result.current.data?.unresolvedCandidateCount).toBe(3);
    expect(result.current.data?.activeRun?.playerId).toBe('sparg0');
  });

  it('on a 404 reports isForbidden: true with isError: false', async () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_RESEARCH);
    coverage.mockRejectedValue(new FakeApiError(404, 'Not found'));

    const { result } = renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isForbidden).toBe(true));
    expect(result.current.isError).toBe(false);
  });

  it('on a 500 reports isError: true and isForbidden: false', async () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_RESEARCH);
    coverage.mockRejectedValue(new FakeApiError(500, 'Internal error'));

    const { result } = renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(false);
  });

  it('on a research workspace whose response has a null coverage member reports hasCompletedRun: false with no counts', async () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_RESEARCH);
    coverage.mockResolvedValue({
      coverage: null,
      confirmedPlayerIds: ['mkleo'],
      confirmedPlayerIdCount: 1,
      unresolvedCandidateCount: 0,
      activeRun: null,
    });

    const { result } = renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.hasCompletedRun).toBe(false);
    expect(result.current.data?.coverage).toBeNull();
  });

  it('returns a value whose identity is stable across renders when the underlying state is unchanged', async () => {
    useResearchSubject.mockReturnValue(RESEARCH_SUBJECT_RESEARCH);
    coverage.mockResolvedValue(COVERAGE_RESPONSE);

    const { result, rerender } = renderHook(() => useDataCoverage(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
