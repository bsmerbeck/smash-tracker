import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SelfDataCoveragePanel } from './SelfDataCoveragePanel';

/**
 * Phase 30.1 Plan 05 (WKSP-01A, review C2-H2): mocks `api.users.coverage`
 * (per the plan's action) rather than `useSelfDataCoverage` directly, so
 * the real hook + `DataCoveragePanelView` render path is exercised
 * end-to-end — the same integration surface the extended
 * `DashboardPage.test.tsx` fighterless case proves.
 */
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

const coverage = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      coverage: (...args: unknown[]) => coverage(...args),
    },
  },
}));

const TWENTY_TWENTY_SIX_MS = 1_770_000_000_000; // 2026-era

const POPULATED_RESPONSE = {
  coverage: {
    asOfMs: TWENTY_TWENTY_SIX_MS,
    players: {
      mkleo: {
        playerId: 'mkleo',
        runId: 'run-1',
        runCompletedAtMs: TWENTY_TWENTY_SIX_MS,
        asOfMs: TWENTY_TWENTY_SIX_MS,
        counters: {
          discoveredAllGames: 10,
          discoveredEligible: 9,
          imported: 5,
          skipped: 2,
          unresolved: 1,
          corrected: 0,
        },
        namedGaps: { unknownCharacter: 1 },
        dateCoverage: { earliestSetAtMs: 1_700_000_000_000, latestSetAtMs: TWENTY_TWENTY_SIX_MS },
        classificationCounts: {},
        uniqueCounters: {},
        uniqueNamedGaps: {},
        uniqueClassificationCounts: {},
      },
    },
    totals: {
      counters: {
        discoveredAllGames: 10,
        discoveredEligible: 9,
        imported: 5,
        skipped: 2,
        unresolved: 1,
        corrected: 0,
      },
      namedGaps: { unknownCharacter: 1 },
      dateCoverage: { earliestSetAtMs: 1_700_000_000_000, latestSetAtMs: TWENTY_TWENTY_SIX_MS },
      classificationCounts: { dq: 0, bye: 0, walkover: 0, 'no-game-detail': 0 },
    },
  },
  confirmedPlayerIds: ['mkleo'],
  confirmedPlayerIdCount: 1,
  unresolvedCandidateCount: 0,
  activeRun: null,
};

const EMPTY_RESPONSE = {
  coverage: null,
  confirmedPlayerIds: [],
  confirmedPlayerIdCount: 0,
  unresolvedCandidateCount: 0,
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SelfDataCoveragePanel />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('SelfDataCoveragePanel', () => {
  beforeEach(async () => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    await i18n.changeLanguage('en');
  });

  it('renders the counts/gaps/as-of for a seeded ResearchCoverageResponse', async () => {
    coverage.mockResolvedValue(POPULATED_RESPONSE);

    renderPanel();

    expect(await screen.findByTestId('data-coverage-panel')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-as-of')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-totals')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-count-imported')).toHaveTextContent('5');
    expect(screen.getByTestId('data-coverage-gaps')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-player-mkleo')).toBeInTheDocument();
  });

  it('renders nothing for a coverage: null response', async () => {
    coverage.mockResolvedValue(EMPTY_RESPONSE);

    renderPanel();

    await waitFor(() => expect(coverage).toHaveBeenCalled());
    expect(screen.queryByTestId('data-coverage-panel')).not.toBeInTheDocument();
  });

  it('renders nothing while the query is pending', () => {
    coverage.mockReturnValue(new Promise(() => {})); // never resolves

    renderPanel();

    expect(screen.queryByTestId('data-coverage-panel')).not.toBeInTheDocument();
  });
});
