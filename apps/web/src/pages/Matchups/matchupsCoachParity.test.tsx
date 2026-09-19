import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { MatchupsPage } from './MatchupsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * R1-HIGH-3 (plan 37-05): three plans assert Matchups coach parity in their
 * verification blocks and no task ever wrote the test — the cross-cutting
 * requirement the ROADMAP names for this phase is a build item, not
 * something a prose claim can close. Copies the shape of
 * `OpponentsPage.test.tsx`'s existing shipped coach-route harness: a
 * `MemoryRouter` declaring `/matchups`, `/coach/:clientId/matchups` AND (Phase
 * 38-04) `/workspace/:tenantId/matchups`, all pointing at the same
 * `MatchupsPage` element, with the same fixture matches supplied through the
 * subject-scoped `useFilteredMatches`/`useFighters` hooks in every case —
 * never a prop passed directly to a component. A two-family test passes
 * while the third (owned-workspace) family is broken, which is exactly what
 * this phase's own review cycle flagged.
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

const getFighters = vi.fn();
const listMatches = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderMatchupsAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/matchups" element={<MatchupsPage />} />
              <Route path="/coach/:clientId/matchups" element={<MatchupsPage />} />
              <Route path="/workspace/:tenantId/matchups" element={<MatchupsPage />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Collapses whitespace so layout-only differences (line wraps) never register as a content divergence. */
function normalisedText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('Matchups coach parity (R1-HIGH-3, cross-cutting coaching non-regression)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // Two stages, each clearing the D-07 abstention floor (>=3 countable
    // games), so the Counterpick Advisor actually evidences a Pick group —
    // an abstained claim would render the same sentence on both routes and
    // never exercise the group headings/bars the parity assertion covers.
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: true }),
      makeMatch({ id: 'm4', time: 4, win: true }),
      makeMatch({ id: 'm5', time: 5, win: true }),
      makeMatch({ id: 'm6', time: 6, win: false, map: { id: 83, name: 'Smashville' } }),
      makeMatch({ id: 'm7', time: 7, win: false, map: { id: 83, name: 'Smashville' } }),
      makeMatch({ id: 'm8', time: 8, win: true, map: { id: 83, name: 'Smashville' } }),
    ]);
    setMockUser(makeMockUser());
  });

  it('renders structurally identical Matchups content — stat tile, Counterpick Advisor with its two disclosure controls, and the trend frame — under /matchups, /coach/:clientId/matchups AND /workspace/:tenantId/matchups', async () => {
    // The "ready" signal is deliberately subject-blind (the Pick group
    // heading and the ruleset-control aria-label are fixed strings this
    // plan's own copy never varies by subject) — a probe that varies TITLE
    // text by subject must surface as a diff in the final comparison below,
    // not as a premature timeout on this wait condition.
    const { container: personalContainer, unmount: unmountPersonal } =
      renderMatchupsAt('/matchups');
    await waitFor(() => expect(screen.getByText('Pick these')).toBeInTheDocument());
    const personalText = normalisedText(personalContainer);
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderMatchupsAt(
      '/coach/test-client/matchups',
    );
    await waitFor(() => expect(within(coachContainer).getByText('Pick these')).toBeInTheDocument());
    const coachText = normalisedText(coachContainer);
    unmountCoach();

    const { container: workspaceContainer } = renderMatchupsAt('/workspace/test-tenant/matchups');
    await waitFor(() =>
      expect(within(workspaceContainer).getByText('Pick these')).toBeInTheDocument(),
    );
    const workspaceText = normalisedText(workspaceContainer);

    expect(coachText).toBe(personalText);
    expect(workspaceText).toBe(personalText);
  });
});
