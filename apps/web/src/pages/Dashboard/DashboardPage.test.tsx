import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { DashboardPage } from './DashboardPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

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

const getFighters = vi.fn();
const listMatches = vi.fn();
const createMatch = vi.fn();
const listOpponents = vi.fn().mockResolvedValue([]);
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();
const getOnboardingProgress = vi.fn();
const listCoachingClients = vi.fn();
// Phase 30.1 Plan 05 (WKSP-01A): DashboardPage now transitively calls
// `api.users.coverage()` via `useSelfDataCoverage` (mounted through
// `<SelfDataCoveragePanel />`) — mocked here so every existing Dashboard
// test keeps passing with the benign empty default.
const coverage = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
      getMe: (...args: unknown[]) => getMe(...args),
      coverage: (...args: unknown[]) => coverage(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      create: (...args: unknown[]) => createMatch(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
    },
    onboarding: {
      getProgress: (...args: unknown[]) => getOnboardingProgress(...args),
    },
    coaching: {
      clients: {
        list: (...args: unknown[]) => listCoachingClients(...args),
      },
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;

/** Phase 13 (ONBD-03): the always-present `GET /api/users/me` profile shape. */
function defaultProfile(overrides: { onboardingIntent?: OnboardingIntent | null } = {}) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: overrides.onboardingIntent ?? null,
  };
}

function renderDashboard(initialEntry = '/dashboard') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/choose-primary" element={<div>Choose primary page</div>} />
              <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
              {/* Phase 11 fix round 3 (FB-9): the coaching-route mirror — the
                  Dashboard's Add Match must stay VOD-optional there too. */}
              <Route path="/coach/:clientId/dashboard" element={<DashboardPage />} />
              {/* Phase 13 (ONBD-03): next-best-action area link targets. */}
              <Route path="/welcome" element={<div>Welcome page</div>} />
              <Route path="/coach" element={<div>Client Hub page</div>} />
              <Route path="/fighter-analysis" element={<div>Fighter Analysis page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    listOpponents.mockResolvedValue([]);
    getMe.mockResolvedValue(defaultProfile());
    getOnboardingProgress.mockResolvedValue({
      analytics: false,
      vod: false,
      tournamentPrep: false,
      scout: false,
    });
    listCoachingClients.mockResolvedValue([]);
    coverage.mockResolvedValue({
      coverage: null,
      confirmedPlayerIds: [],
      confirmedPlayerIdCount: 0,
      unresolvedCandidateCount: 0,
    });
    setMockUser(makeMockUser());
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderDashboard();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose Primary Fighters' })).toHaveAttribute(
      'href',
      '/choose-primary',
    );
    expect(screen.getByRole('link', { name: 'Choose Secondary Fighters' })).toHaveAttribute(
      'href',
      '/choose-secondary',
    );
  });

  // Phase 30.1 Plan 05 (WKSP-01A, review C2-H2): a fresh, fighterless demo
  // account (Plan 01 asserts zero primary/secondary fighters for every
  // fresh account) always hits the no-fighters early-return branch above —
  // this proves the self coverage completeness report is reachable there
  // too, not only after fighter selection.
  it('C2-H2: shows the self coverage completeness report even with zero fighters selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);
    coverage.mockResolvedValue({
      coverage: {
        asOfMs: 1_770_000_000_000,
        players: {
          mkleo: {
            playerId: 'mkleo',
            runId: 'run-1',
            runCompletedAtMs: 1_770_000_000_000,
            asOfMs: 1_770_000_000_000,
            counters: { imported: 5, skipped: 2 },
            namedGaps: {},
            dateCoverage: {},
            classificationCounts: {},
            uniqueCounters: {},
            uniqueNamedGaps: {},
            uniqueClassificationCounts: {},
          },
        },
        totals: {
          counters: { imported: 5, skipped: 2 },
          namedGaps: {},
          dateCoverage: {},
          classificationCounts: {},
        },
      },
      confirmedPlayerIds: ['mkleo'],
      confirmedPlayerIdCount: 1,
      unresolvedCandidateCount: 0,
      activeRun: null,
    });

    renderDashboard();

    // Still fighterless — the no-fighters prompt renders alongside it.
    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
    expect(await screen.findByTestId('data-coverage-panel')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-totals')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-player-mkleo')).toBeInTheDocument();
  });

  it('renders the dashboard widgets once the user has selected fighters', async () => {
    getFighters.mockResolvedValue({ primary: [1], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderDashboard();

    expect(await screen.findAllByText('Overall Record')).not.toHaveLength(0);
    expect(screen.getByText('Form')).toBeInTheDocument();
    expect(screen.getByText('Casual vs Competitive')).toBeInTheDocument();
    expect(screen.getByText('Online vs Offline')).toBeInTheDocument();
    expect(screen.getByText('Previous Matches')).toBeInTheDocument();
    expect(screen.getByText('Form Curve')).toBeInTheDocument();
    expect(screen.getByText('Most-Played Stages')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Match' })).toBeEnabled();
  });

  it('shows a no-matches empty state for a new user with fighters but no matches yet', async () => {
    getFighters.mockResolvedValue({ primary: [1], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderDashboard();

    await waitFor(() => expect(screen.getAllByText('Overall Record')).not.toHaveLength(0));
    expect(screen.getAllByText('No match data to report yet.').length).toBeGreaterThan(0);
    expect(screen.getByText('No matches recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No stage data to report yet.')).toBeInTheDocument();
    expect(screen.getByText('No matches reported')).toBeInTheDocument();
  });

  // Phase 11 fix round 3 (FB-9): "adding a match normally" (the Match Data
  // surface, personal AND coaching) must NOT require a VOD link — only the
  // VOD Manager page's Add Match keeps that requirement (see
  // VodManagerPage.test.tsx's mirror of this test).
  it('FB-9: Add Match on the Dashboard does not require a VOD URL, in personal mode', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);
    createMatch.mockResolvedValue({ id: 'm1', fighter_id: mario.id, opponent_id: 10, time: 1 });

    renderDashboard('/dashboard');

    await user.click(await screen.findByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch.mock.calls[0]![0]).not.toHaveProperty('vodUrl');
  });

  it('FB-9: Add Match on the coaching Dashboard also does not require a VOD URL', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);
    createMatch.mockResolvedValue({ id: 'm1', fighter_id: mario.id, opponent_id: 10, time: 1 });

    renderDashboard('/coach/tetra/dashboard');

    await user.click(await screen.findByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch.mock.calls[0]![0]).not.toHaveProperty('vodUrl');
  });

  // Phase 13 (ONBD-03, D-01/D-04/D-08): the dashboard's ONE next-best-action
  // area — exactly one of three mutually-exclusive states.
  describe('next-best-action area (ONBD-03)', () => {
    it('shows the "choose what you\'re here to do" re-entry when no intent is saved', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([]);
      getMe.mockResolvedValue(defaultProfile({ onboardingIntent: null }));

      renderDashboard();

      expect(await screen.findByTestId('dashboard-next-best-action')).toHaveTextContent(
        'Not sure what to do first?',
      );
      expect(screen.getByRole('link', { name: "Choose what you're here to do" })).toHaveAttribute(
        'href',
        '/welcome',
      );
    });

    it('mirrors the current guided step for a saved, incomplete intent', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([]);
      getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'track_improvement' }));
      getOnboardingProgress.mockResolvedValue({
        analytics: false,
        vod: false,
        tournamentPrep: false,
        scout: false,
      });

      renderDashboard();

      // The card starts in the `chooseIntent` loading state (profile not
      // yet resolved) — `findByText` polls until it flips to the resolved
      // `currentStep` content, unlike `findByTestId` which would match the
      // testid on the very first (stale) render.
      expect(await screen.findByText('Pick up where you left off')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Track improvement' })).toHaveAttribute(
        'href',
        '/fighter-analysis',
      );
    });

    it('renders nothing once the saved intent is complete', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([]);
      getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'scout' }));
      getOnboardingProgress.mockResolvedValue({
        analytics: false,
        vod: false,
        tournamentPrep: false,
        scout: true,
      });

      renderDashboard();

      await screen.findAllByText('Overall Record');
      await waitFor(() =>
        expect(screen.queryByTestId('dashboard-next-best-action')).not.toBeInTheDocument(),
      );
    });

    it('D-08: shows "create your first client" when coach intent is saved but no client exists', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([]);
      getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'coach_clients' }));
      listCoachingClients.mockResolvedValue([]);

      renderDashboard();

      expect(await screen.findByText('Create your first client')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Create client' })).toHaveAttribute('href', '/coach');
    });

    it('D-08: renders nothing once the coach has created a client', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([]);
      getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'coach_clients' }));
      listCoachingClients.mockResolvedValue([{ clientId: 'c1', label: 'Client One' }]);

      renderDashboard();

      await screen.findAllByText('Overall Record');
      await waitFor(() =>
        expect(screen.queryByTestId('dashboard-next-best-action')).not.toBeInTheDocument(),
      );
    });

    // 260725-juj: a failed clients query is UNKNOWN, not zero — the next-
    // best-action area must show nothing rather than resurrecting
    // "create your first client" over a coach who may already have clients.
    it('260725-juj: shows no next-best-action when the coach intent is saved but the clients query rejects', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([]);
      getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'coach_clients' }));
      listCoachingClients.mockRejectedValue(new Error('network down'));

      renderDashboard();

      await screen.findAllByText('Overall Record');
      await waitFor(() => expect(listCoachingClients).toHaveBeenCalled());
      expect(screen.queryByTestId('dashboard-next-best-action')).not.toBeInTheDocument();
    });
  });
});
