import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { OpponentHubPage } from './OpponentHubPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 38-05 Task 3 (DRL-04): copies `matchupsCoachParity.test.tsx`'s shape —
 * a `MemoryRouter` declaring the personal hub route, the coach hub route AND
 * (per the review finding this phase's own cycle carried forward) the
 * owned-workspace hub route, all pointing at the same `OpponentHubPage`
 * element with the SAME mocked data supplied through the subject-scoped
 * hooks — never a prop passed directly to the component. A two-family test
 * passes while the workspace family is broken, which is exactly what this
 * phase's own review cycle flagged for the Matchups parity test in plan
 * 38-04 (C2-* findings); this file declares the third family from the start.
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
const fox = SpriteList.find((s) => s.id === 15)!; // Fox

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

function renderHubAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/opponents/:opponentTag" element={<OpponentHubPage />} />
                <Route
                  path="/coach/:clientId/opponents/:opponentTag"
                  element={<OpponentHubPage />}
                />
                <Route
                  path="/workspace/:tenantId/opponents/:opponentTag"
                  element={<OpponentHubPage />}
                />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Collapses whitespace so layout-only differences (line wraps) never
 * register as a content divergence, and masks the ONE genuinely
 * render-time-varying value on this page — `PrintableEvidencePacket`'s
 * "Generated {{time}}" stamp (`Date.now()` at render) — which would
 * otherwise differ by a second or two between the personal/coach/workspace
 * renders in this same test and produce a false divergence unrelated to
 * subject-family correctness.
 */
function normalisedText(container: HTMLElement): string {
  return (container.textContent ?? '')
    .replace(/Generated [^D]*Date range:/, 'Generated <TIME> Date range:')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every `[data-slot="card-title"]` text — the section-heading set for the structural (headings-present) half of the parity assertion. */
function headingSet(): string[] {
  return [...document.querySelectorAll('[data-slot="card-title"]')]
    .map((el) => el.textContent ?? '')
    .sort();
}

describe('Opponent hub coach/workspace parity (DRL-04, plan 38-05 Task 3)', () => {
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
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      makeMatch({ id: 'm2', time: 2, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      makeMatch({
        id: 'm3',
        time: 3,
        win: false,
        fighter_id: mario.id,
        opponent_id: fox.id,
        map: { id: 3, name: 'Final Destination' },
      }),
    ]);
    setMockUser(makeMockUser());
  });

  it('renders structurally identical hub content — head-to-head record, matrix, trend and terminus — under /opponents/:tag, /coach/:clientId/opponents/:tag AND /workspace/:tenantId/opponents/:tag', async () => {
    const { container: personalContainer, unmount: unmountPersonal } =
      renderHubAt('/opponents/rival');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="card-title"]')).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByText('2-1')).toBeInTheDocument());
    const personalText = normalisedText(personalContainer);
    const personalHeadings = headingSet();
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderHubAt(
      '/coach/test-client/opponents/rival',
    );
    await waitFor(() => expect(screen.getByText('2-1')).toBeInTheDocument());
    const coachText = normalisedText(coachContainer);
    const coachHeadings = headingSet();
    unmountCoach();

    const { container: workspaceContainer } = renderHubAt('/workspace/test-tenant/opponents/rival');
    await waitFor(() => expect(screen.getByText('2-1')).toBeInTheDocument());
    const workspaceText = normalisedText(workspaceContainer);
    const workspaceHeadings = headingSet();

    expect(coachText).toBe(personalText);
    expect(workspaceText).toBe(personalText);
    expect(coachHeadings).toEqual(personalHeadings);
    expect(workspaceHeadings).toEqual(personalHeadings);
  });
});
