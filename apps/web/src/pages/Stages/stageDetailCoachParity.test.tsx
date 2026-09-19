import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { StageDetailPage } from './StageDetailPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 38-06 Task 3 (DRL-04): copies `opponentHubCoachParity.test.tsx`'s
 * shape (plan 38-05's output) — a `MemoryRouter` declaring the personal,
 * coach AND owned-/workspace stage routes from the start, all pointing at
 * the SAME `StageDetailPage` element with the SAME mocked data supplied
 * through the subject-scoped hooks — never a prop passed directly to the
 * component. A two-family test passes while the workspace family is
 * broken, which is exactly what this phase's own review cycle flagged for
 * an earlier parity test in this phase (C2-*); this file declares all
 * three families from the start.
 *
 * **Deliberate failing-direction probe (executed, observed red, reverted):**
 * `StageDetailPage.tsx`'s "By Character" `<Card>` was temporarily wrapped in
 * `{!location.pathname.startsWith('/coach/') && (...)}` (a `useLocation()`
 * import added for the probe only) and this test re-run. It failed at the
 * `coachText`/`personalText` equality assertion — before even reaching the
 * heading-set assertion — with this transcript:
 *
 * ```
 * AssertionError: expected 'BattlefieldBy OpponentOpponentRecordW…' to be 'BattlefieldBy OpponentOpponentRecordW…' // Object.is equality
 *
 * Expected: "BattlefieldBy OpponentOpponentRecordWin Raterival2-0100%second0-10%By CharacterMy characterTheir characterRecordWin RateMarioLuigi2-167%3 games · low confidenceOver TimeGames..."
 * Received: "BattlefieldBy OpponentOpponentRecordWin Raterival2-0100%second0-10%Over TimeGames..."
 * ```
 *
 * The `Received` string is missing the entire "By Character…" segment the
 * `Expected` string carries — exactly the suppressed region, naming it by
 * its absence. The probe was then reverted (`StageDetailPage.tsx` restored
 * byte-for-byte, confirmed via `diff`) and this suite re-run green before
 * committing.
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

const listMatches = vi.fn();
const listTournaments = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();
const listAliases = vi.fn();
const upsertAlias = vi.fn();
const removeAlias = vi.fn();
const listNotes = vi.fn();
const upsertNote = vi.fn();
const removeNote = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
    opponents: {
      aliases: {
        list: (...args: unknown[]) => listAliases(...args),
        upsert: (...args: unknown[]) => upsertAlias(...args),
        remove: (...args: unknown[]) => removeAlias(...args),
      },
      notes: {
        list: (...args: unknown[]) => listNotes(...args),
        upsert: (...args: unknown[]) => upsertNote(...args),
        remove: (...args: unknown[]) => removeNote(...args),
      },
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

function renderStageAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/stages/:stageId" element={<StageDetailPage />} />
              <Route path="/coach/:clientId/stages/:stageId" element={<StageDetailPage />} />
              <Route path="/workspace/:tenantId/stages/:stageId" element={<StageDetailPage />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Collapses whitespace so layout-only differences never register as a content divergence. */
function normalisedText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Every `[data-slot="card-title"]` text — the section-heading set for the structural half of the parity assertion. */
function headingSet(): string[] {
  return [...document.querySelectorAll('[data-slot="card-title"]')]
    .map((el) => el.textContent ?? '')
    .sort();
}

describe('Stage detail coach/workspace parity (DRL-04, plan 38-06 Task 3)', () => {
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
    listTournaments.mockResolvedValue([]);
    listAliases.mockResolvedValue({});
    listNotes.mockResolvedValue({});
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: false, opponent: 'second' }),
    ]);
    setMockUser(makeMockUser());
  });

  it('renders structurally identical stage content — by-opponent, by-character, trend and terminus — under /stages/:id, /coach/:clientId/stages/:id AND /workspace/:tenantId/stages/:id', async () => {
    const { container: personalContainer, unmount: unmountPersonal } = renderStageAt('/stages/1');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="card-title"]')).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
    const personalText = normalisedText(personalContainer);
    const personalHeadings = headingSet();
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderStageAt(
      '/coach/test-client/stages/1',
    );
    await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
    const coachText = normalisedText(coachContainer);
    const coachHeadings = headingSet();
    unmountCoach();

    const { container: workspaceContainer } = renderStageAt('/workspace/test-tenant/stages/1');
    await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
    const workspaceText = normalisedText(workspaceContainer);
    const workspaceHeadings = headingSet();

    expect(coachText).toBe(personalText);
    expect(workspaceText).toBe(personalText);
    expect(coachHeadings).toEqual(personalHeadings);
    expect(workspaceHeadings).toEqual(personalHeadings);
  });
});
