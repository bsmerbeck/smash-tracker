import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Match } from '@smash-tracker/shared';
import { generateSyntheticMatches } from '@smash-tracker/shared/testUtils';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DashboardPage } from './Dashboard/DashboardPage';
import { FighterAnalysisPage } from './FighterAnalysis/FighterAnalysisPage';
import { MatchupsPage } from './Matchups/MatchupsPage';
import { MatchDataPage } from './MatchData/MatchDataPage';
import { OpponentsPage } from './Opponents/OpponentsPage';
import { OpponentHubPage } from './Opponents/OpponentHubPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import {
  analyticsSelectionStorageKey,
  persistSelection,
  readStoredSelection,
} from '@/lib/analyticsSelection';
import {
  insightDismissalsStorageKey,
  readStoredDismissals,
  writeStoredDismissals,
} from '@/lib/insightDismissals';

/**
 * Plan 39.1-21 Task 1 (INS-06, UI-SPEC §16/§13.12): the whole-phase coach
 * parity oracle. Copies `apps/web/src/pages/Matchups/matchupsCoachParity.test.tsx`'s
 * established harness — a `MemoryRouter` declaring the own-account, coach
 * AND owned-workspace route for each surface, all pointing at the SAME page
 * element, with the SAME fixture matches supplied through the subject-scoped
 * hooks (`useFilteredMatches`, `useFighters`, `useOpponentAliases`, ...) —
 * NEVER as a component prop. Every one of the five coach-mounted surfaces
 * UI-SPEC §16 names (Dashboard hero, Fighter Analysis, Matchups, Match Data,
 * the Opponents rail and hub cards) is covered by its own describe block
 * below, sharing the generic comparison helpers at the top of the file.
 *
 * Trends, Tournaments and Scout are deliberately NOT covered — 38 D-04/
 * UI-SPEC §16 name them own-account only; the non-vacuity canary at the
 * bottom of this file asserts the surface list is exactly the five named
 * ones and that those three page names never appear in it.
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

// Union of every `api.*` call site reached by the five coach-mounted
// surfaces plus their card-level dependencies (SelfDataCoveragePanel,
// DashboardPrepActionSlot, RosterUsage/StageBreakdown, OpponentHubPage's
// alias/note/tournament reads). One shared mock module for the whole file —
// `vi.mock` is hoisted and file-scoped, so a per-describe mock is not an
// option here.
const getFighters = vi.fn();
const listMatches = vi.fn();
const listOpponents = vi.fn();
const listTournaments = vi.fn();
const listAliases = vi.fn();
const upsertAlias = vi.fn();
const removeAlias = vi.fn();
const listNotes = vi.fn();
const upsertNote = vi.fn();
const removeNote = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();
const coverage = vi.fn();
const getOnboardingProgress = vi.fn();
const listCoachingClients = vi.fn();
const updateMatch = vi.fn();
const deleteMatch = vi.fn();
const clearVod = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();
const deleteNote = vi.fn();
const getStageFavorites = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });

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
      update: (...args: unknown[]) => updateMatch(...args),
      remove: (...args: unknown[]) => deleteMatch(...args),
      clearVod: (...args: unknown[]) => clearVod(...args),
      createNote: (...args: unknown[]) => createNote(...args),
      updateNote: (...args: unknown[]) => updateNote(...args),
      deleteNote: (...args: unknown[]) => deleteNote(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
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
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
    onboarding: {
      getProgress: (...args: unknown[]) => getOnboardingProgress(...args),
    },
    coaching: {
      clients: {
        list: (...args: unknown[]) => listCoachingClients(...args),
      },
    },
    stageFavorites: {
      get: (...args: unknown[]) => getStageFavorites(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

/**
 * A realistically-sized fixture (400 rows, well above every template's
 * countable-games floor and the D-07 abstention floor) built from the
 * shared package's own deterministic synthetic generator
 * (`packages/shared/src/testUtils/syntheticMatches.ts` — the SAME generator
 * `evidence.bench.ts`/`computeBudget.budget.test.ts` use for their 8k/50k
 * scale fixtures), restricted to one fighter (Mario) so the FighterAnalysis
 * page opens on it deterministically, but left with GENUINE opponent-
 * character and opponent-tag DIVERSITY (a handful of characters, a handful
 * of rival tags, real recency skew from the generator's own session/RNG
 * shape) — `characterMovers`/`rivalMovers` (`FighterInsightRail`'s two
 * "regular"-card templates) need more than one opponent character/rival to
 * compare against; an account collapsed onto a single opponent tag/character
 * (as an early draft of this fixture did) starves both templates and the
 * rail renders only the locked `unlocksNext` card. `opponentCount`/
 * `opponentFighterIds` below are narrowed just enough (not to one) to give
 * each comparison group real game volume at this row count.
 */
function analyticsFixture(): Match[] {
  return generateSyntheticMatches({
    seed: 20_260_921,
    count: 400,
    mainFighterIds: [mario.id],
    mainFighterShare: 1,
    opponentFighterIds: [luigi.id, 8, 15, 23, 25],
    opponentCount: 15,
    stageIds: [1, 83],
  });
}

/** The opponent tag with the most rows in `matches` — used to drive the Opponents-rail / Opponent-Hub `/opponents/<tag>` route against a real, non-empty identity rather than a hardcoded tag that might not appear in a regenerated fixture. */
function mostFrequentOpponentTag(matches: Match[]): string {
  const counts = new Map<string, number>();
  for (const match of matches) {
    if (!match.opponent) continue;
    counts.set(match.opponent, (counts.get(match.opponent) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

const FIXTURE_MATCHES = analyticsFixture();
const TOP_OPPONENT_TAG = mostFrequentOpponentTag(FIXTURE_MATCHES);

/**
 * `syntheticMatches.ts` anchors every generated match to a FIXED reference
 * date (2023-11-14, never `Date.now()` — see that module's own doc comment)
 * so a given seed is byte-identical no matter when the suite runs. But the
 * app's engine call sites (`FighterHero.tsx`, `FighterInsightRail.tsx`, the
 * `evidencePacket.ts` "Generated" line) all read the REAL wall clock
 * (`Date.now()`) for `nowMs`/`generatedAt`. Left unmocked, two consequences
 * surface as this suite runs further from 2023-11: (1) `evidencePacket.ts`'s
 * "Generated <timestamp>" line captures a different real-clock instant on
 * each of the personal/coach/workspace mounts, so a byte-for-byte parity
 * comparison spuriously fails on that one line; (2) D-15's scoped 12-month
 * recency window (`horizon.ts`'s `withinScopedRecency`) intersects EVERY
 * candidate's recent window against a `nowMs` that is now years past the
 * fixture's last game, so `characterMovers`/`rivalMovers` can never see a
 * non-empty recent window and stay permanently `locked` — starving the
 * store-isolation dismiss case of any dismissable card regardless of which
 * horizon the test selects. Freezing `Date` (never `setTimeout`/`setInterval`
 * — `waitFor`/`userEvent` still need real timers) to the fixture's OWN last
 * match timestamp reproduces the byte-identical "as of last game" instant
 * every run, for every mount, fixing both.
 */
const FIXTURE_NOW_MS = Math.max(...FIXTURE_MATCHES.map((match) => match.time));

/** Phase 30.3 (Gate 6): the always-present `GET /api/users/me` profile shape — `onboardingIntent: null` so `DashboardNextBestAction` resolves the SAME subject-blind "choose intent" branch on every route, never a coach-conditional one. */
function defaultProfile() {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
  };
}

/** Collapses whitespace so layout-only differences (line wraps) never register as a content divergence — the same helper `matchupsCoachParity.test.tsx`/`stageDetailCoachParity.test.tsx` use. */
function normalisedText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Strips a leading `/coach/:id` or `/workspace/:id` segment so an href built by `useSubjectPath` compares equal across the three route families. */
function stripSubjectPrefix(href: string): string {
  return href.replace(/^\/(coach|workspace)\/[^/]+/, '');
}

/**
 * A deep, order-sensitive structural fingerprint: every element in DOM
 * order, tagged by its tag name, ARIA role and `data-slot` (the three
 * attributes this codebase's analytics components use to carry identity —
 * see `InsightCard.tsx`/`InsightRail.tsx`), plus its `href` with the
 * subject prefix stripped. Two containers with an identical fingerprint
 * array have an identical DOM STRUCTURE — same elements, same order, same
 * identity markers, same destinations once the subject prefix is ignored.
 */
function domSignature(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('*')).map((el) => {
    const role = el.getAttribute('role') ?? '';
    const dataSlot = el.getAttribute('data-slot') ?? '';
    const href = el.getAttribute('href');
    const hrefPart = href ? `href=${stripSubjectPrefix(href)}` : '';
    return `${el.tagName}|role=${role}|data-slot=${dataSlot}|${hrefPart}`;
  });
}

/** Every rendered insight verdict string on the page — the three `data-slot` verdict markers this phase's components use (`InsightCard`'s own, `MatchupChart`'s `renderFormNowHead`, `OpponentHubPage`'s `renderOpponentFormNowHead`), sorted so render order never matters for this specific comparison (order is asserted separately by `railCardOrder`/list-row order below). */
function insightVerdictTexts(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(
      '[data-slot="insight-card-verdict"], [data-slot="matchup-form-now-verdict"], [data-slot="opponent-form-now-verdict"]',
    ),
  )
    .map((el) => (el.textContent ?? '').trim())
    .sort();
}

/** The ordered list of `InsightRail` card verdicts, in DOM (i.e. rail) order — for surfaces that render an `InsightRail` (Fighter Analysis, Match Data). */
function railCardVerdictOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="insight-rail-card"]')).map((card) =>
    (card.querySelector('[data-slot="insight-card-verdict"]')?.textContent ?? '').trim(),
  );
}

// ---------------------------------------------------------------------------
// Per-surface render helpers — three routes each (personal, coach, workspace),
// mirroring `subjectAnalyticsRoutes.tsx` / `AppRouter.tsx`'s real mount
// paths, with the union of that surface's own `api.*` mocks resolved to a
// benign default in `beforeEach` below. Fixture data always flows through
// the mocked `@/lib/api` module (read by the subject-scoped hooks) — never
// as a prop on the page element, which every route below mounts bare
// (`<XPage />`, no attributes), verified by the source-scan test at the
// bottom of this file.
// ---------------------------------------------------------------------------

function renderDashboardAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/coach/:clientId/dashboard" element={<DashboardPage />} />
                <Route path="/workspace/:tenantId/dashboard" element={<DashboardPage />} />
                <Route path="/choose-primary" element={<div>Choose primary page</div>} />
                <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
                <Route path="/welcome" element={<div>Welcome page</div>} />
                <Route path="/coach" element={<div>Client Hub page</div>} />
                <Route path="/fighter-analysis" element={<div>Fighter Analysis page</div>} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderFighterAnalysisAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
                <Route path="/coach/:clientId/fighter-analysis" element={<FighterAnalysisPage />} />
                <Route
                  path="/workspace/:tenantId/fighter-analysis"
                  element={<FighterAnalysisPage />}
                />
                <Route path="/choose-primary" element={<div>Choose primary page</div>} />
                <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
                <Route path="/dashboard" element={<div>Dashboard page</div>} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderMatchupsAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/matchups" element={<MatchupsPage />} />
                <Route path="/coach/:clientId/matchups" element={<MatchupsPage />} />
                <Route path="/workspace/:tenantId/matchups" element={<MatchupsPage />} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderMatchDataAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/match-data" element={<MatchDataPage />} />
                <Route path="/coach/:clientId/match-data" element={<MatchDataPage />} />
                <Route path="/workspace/:tenantId/match-data" element={<MatchDataPage />} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderOpponentsAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/opponents" element={<OpponentsPage />} />
                <Route path="/coach/:clientId/opponents" element={<OpponentsPage />} />
                <Route path="/workspace/:tenantId/opponents" element={<OpponentsPage />} />
                <Route path="/dashboard" element={<div>Dashboard page</div>} />
                <Route path="/settings/integrations" element={<div>Integrations page</div>} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderOpponentHubAt(initialEntry: string) {
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
 * The non-vacuity canary's own list (Task 1's own requirement): EXACTLY the
 * five named coach-mounted surfaces, never a subset — a surface quietly
 * dropped from this array would make every `it.each`-style suite below
 * silently stop covering it while the file still reports green.
 */
const COACH_MOUNTED_SURFACES = [
  'Dashboard hero',
  'Fighter Analysis',
  'Matchups',
  'Match Data',
  'Opponents rail and hub cards',
] as const;

const OWN_ACCOUNT_ONLY_PAGES = ['Trends', 'Tournaments', 'Scout'] as const;

beforeEach(() => {
  resetAuthMock();
  vi.clearAllMocks();
  window.localStorage.clear();
  // Freeze `Date` only (never `setTimeout`/`setInterval`) to the fixture's own
  // last match timestamp — see `FIXTURE_NOW_MS`'s doc comment above. `waitFor`
  // and `userEvent` both poll on REAL timers, so leaving them un-faked keeps
  // every existing await in this file working unmodified.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW_MS);
  upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  getMe.mockResolvedValue(defaultProfile());
  getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
  listMatches.mockResolvedValue(analyticsFixture());
  listOpponents.mockResolvedValue([]);
  listTournaments.mockResolvedValue([]);
  listAliases.mockResolvedValue({});
  upsertAlias.mockResolvedValue({});
  removeAlias.mockResolvedValue(undefined);
  listNotes.mockResolvedValue({});
  upsertNote.mockResolvedValue({ updatedAt: 1 });
  removeNote.mockResolvedValue(undefined);
  coverage.mockResolvedValue({ coverage: null });
  getOnboardingProgress.mockResolvedValue({});
  listCoachingClients.mockResolvedValue([]);
  getStageFavorites.mockResolvedValue({ stageIds: [], updatedAt: 0 });
  setMockUser(makeMockUser());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Coach-mounted surface list (non-vacuity canary, T-39.1-21-03)', () => {
  it('is exactly the five named coach-mounted surfaces', () => {
    expect(COACH_MOUNTED_SURFACES).toHaveLength(5);
    expect([...COACH_MOUNTED_SURFACES]).toEqual([
      'Dashboard hero',
      'Fighter Analysis',
      'Matchups',
      'Match Data',
      'Opponents rail and hub cards',
    ]);
  });

  it('never includes an own-account-only page (Trends, Tournaments, Scout — 38 D-04)', () => {
    for (const ownAccountOnly of OWN_ACCOUNT_ONLY_PAGES) {
      expect((COACH_MOUNTED_SURFACES as readonly string[]).includes(ownAccountOnly)).toBe(false);
    }
  });
});

describe('Dashboard hero coach parity', () => {
  it('renders structurally identical content under /dashboard, /coach/:clientId/dashboard AND /workspace/:tenantId/dashboard', async () => {
    const { container: personalContainer, unmount: unmountPersonal } =
      renderDashboardAt('/dashboard');
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="dashboard-body"]')).not.toBeNull(),
    );
    const personalText = normalisedText(personalContainer);
    const personalSignature = domSignature(personalContainer);
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderDashboardAt(
      '/coach/test-client/dashboard',
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="dashboard-body"]')).not.toBeNull(),
    );
    const coachText = normalisedText(coachContainer);
    expect(domSignature(coachContainer)).toEqual(personalSignature);
    expect(coachText).toBe(personalText);
    unmountCoach();

    const { container: workspaceContainer } = renderDashboardAt('/workspace/test-tenant/dashboard');
    await waitFor(() =>
      expect(workspaceContainer.querySelector('[data-slot="dashboard-body"]')).not.toBeNull(),
    );
    expect(domSignature(workspaceContainer)).toEqual(personalSignature);
    expect(normalisedText(workspaceContainer)).toBe(personalText);
  });

  it('a coach-mounted Dashboard with zero client matches renders the same empty branch as the own-account route', async () => {
    listMatches.mockResolvedValue([]);

    const { container: personalContainer, unmount: unmountPersonal } =
      renderDashboardAt('/dashboard');
    await waitFor(() => expect(screen.getAllByText(/dashboard/i).length).toBeGreaterThan(0));
    const personalText = normalisedText(personalContainer);
    unmountPersonal();

    const { container: coachContainer } = renderDashboardAt('/coach/test-client/dashboard');
    await waitFor(() => expect(normalisedText(coachContainer).length).toBeGreaterThan(0));
    expect(normalisedText(coachContainer)).toBe(personalText);
  });
});

describe('Fighter Analysis coach parity', () => {
  it('renders structurally identical content and rail order under /fighter-analysis, /coach/:clientId/fighter-analysis AND /workspace/:tenantId/fighter-analysis', async () => {
    const { container: personalContainer, unmount: unmountPersonal } =
      renderFighterAnalysisAt('/fighter-analysis');
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="fighter-hero-body"]')).not.toBeNull(),
    );
    const personalText = normalisedText(personalContainer);
    const personalSignature = domSignature(personalContainer);
    const personalVerdicts = insightVerdictTexts(personalContainer);
    const personalRailOrder = railCardVerdictOrder(personalContainer);
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderFighterAnalysisAt(
      '/coach/test-client/fighter-analysis',
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="fighter-hero-body"]')).not.toBeNull(),
    );
    expect(domSignature(coachContainer)).toEqual(personalSignature);
    expect(normalisedText(coachContainer)).toBe(personalText);
    expect(insightVerdictTexts(coachContainer)).toEqual(personalVerdicts);
    expect(railCardVerdictOrder(coachContainer)).toEqual(personalRailOrder);
    unmountCoach();

    const { container: workspaceContainer } = renderFighterAnalysisAt(
      '/workspace/test-tenant/fighter-analysis',
    );
    await waitFor(() =>
      expect(workspaceContainer.querySelector('[data-slot="fighter-hero-body"]')).not.toBeNull(),
    );
    expect(domSignature(workspaceContainer)).toEqual(personalSignature);
    expect(normalisedText(workspaceContainer)).toBe(personalText);
    expect(railCardVerdictOrder(workspaceContainer)).toEqual(personalRailOrder);
  });

  it('a coach-mounted Fighter Analysis with zero client matches renders the same empty branch as the own-account route', async () => {
    listMatches.mockResolvedValue([]);

    const { container: personalContainer, unmount: unmountPersonal } =
      renderFighterAnalysisAt('/fighter-analysis');
    await waitFor(() =>
      expect(screen.getByText("You haven't reported any matches!")).toBeInTheDocument(),
    );
    const personalText = normalisedText(personalContainer);
    unmountPersonal();

    const { container: coachContainer } = renderFighterAnalysisAt(
      '/coach/test-client/fighter-analysis',
    );
    await waitFor(() =>
      expect(
        within(coachContainer).getByText("You haven't reported any matches!"),
      ).toBeInTheDocument(),
    );
    expect(normalisedText(coachContainer)).toBe(personalText);
  });
});

describe('Matchups coach parity', () => {
  it('renders structurally identical content under /matchups, /coach/:clientId/matchups AND /workspace/:tenantId/matchups', async () => {
    const { container: personalContainer, unmount: unmountPersonal } =
      renderMatchupsAt('/matchups');
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="matchup-chart-body"]')).not.toBeNull(),
    );
    const personalText = normalisedText(personalContainer);
    const personalSignature = domSignature(personalContainer);
    const personalVerdicts = insightVerdictTexts(personalContainer);
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderMatchupsAt(
      '/coach/test-client/matchups',
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="matchup-chart-body"]')).not.toBeNull(),
    );
    expect(domSignature(coachContainer)).toEqual(personalSignature);
    expect(normalisedText(coachContainer)).toBe(personalText);
    expect(insightVerdictTexts(coachContainer)).toEqual(personalVerdicts);
    unmountCoach();

    const { container: workspaceContainer } = renderMatchupsAt('/workspace/test-tenant/matchups');
    await waitFor(() =>
      expect(workspaceContainer.querySelector('[data-slot="matchup-chart-body"]')).not.toBeNull(),
    );
    expect(domSignature(workspaceContainer)).toEqual(personalSignature);
    expect(normalisedText(workspaceContainer)).toBe(personalText);
  });

  it('a coach-mounted Matchups with zero client matches renders the same empty branch as the own-account route', async () => {
    listMatches.mockResolvedValue([]);

    const { container: personalContainer, unmount: unmountPersonal } =
      renderMatchupsAt('/matchups');
    await waitFor(() => expect(normalisedText(personalContainer).length).toBeGreaterThan(0));
    const personalText = normalisedText(personalContainer);
    unmountPersonal();

    const { container: coachContainer } = renderMatchupsAt('/coach/test-client/matchups');
    await waitFor(() => expect(normalisedText(coachContainer).length).toBeGreaterThan(0));
    expect(normalisedText(coachContainer)).toBe(personalText);
  });
});

describe('Match Data coach parity', () => {
  it('renders structurally identical content and rail order under /match-data, /coach/:clientId/match-data AND /workspace/:tenantId/match-data', async () => {
    const { container: personalContainer, unmount: unmountPersonal } =
      renderMatchDataAt('/match-data');
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="match-data-rail"]')).not.toBeNull(),
    );
    const personalText = normalisedText(personalContainer);
    const personalSignature = domSignature(personalContainer);
    const personalRailOrder = railCardVerdictOrder(personalContainer);
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderMatchDataAt(
      '/coach/test-client/match-data',
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="match-data-rail"]')).not.toBeNull(),
    );
    expect(domSignature(coachContainer)).toEqual(personalSignature);
    expect(normalisedText(coachContainer)).toBe(personalText);
    expect(railCardVerdictOrder(coachContainer)).toEqual(personalRailOrder);
    unmountCoach();

    const { container: workspaceContainer } = renderMatchDataAt(
      '/workspace/test-tenant/match-data',
    );
    await waitFor(() =>
      expect(workspaceContainer.querySelector('[data-slot="match-data-rail"]')).not.toBeNull(),
    );
    expect(domSignature(workspaceContainer)).toEqual(personalSignature);
    expect(normalisedText(workspaceContainer)).toBe(personalText);
    expect(railCardVerdictOrder(workspaceContainer)).toEqual(personalRailOrder);
  });

  it('a coach-mounted Match Data with zero client matches renders the same empty branch as the own-account route', async () => {
    listMatches.mockResolvedValue([]);

    const { container: personalContainer, unmount: unmountPersonal } =
      renderMatchDataAt('/match-data');
    await waitFor(() => expect(normalisedText(personalContainer).length).toBeGreaterThan(0));
    const personalText = normalisedText(personalContainer);
    unmountPersonal();

    const { container: coachContainer } = renderMatchDataAt('/coach/test-client/match-data');
    await waitFor(() => expect(normalisedText(coachContainer).length).toBeGreaterThan(0));
    expect(normalisedText(coachContainer)).toBe(personalText);
  });
});

describe('Opponents rail and hub cards coach parity', () => {
  it('renders structurally identical opponents-rail content and list order under /opponents, /coach/:clientId/opponents AND /workspace/:tenantId/opponents', async () => {
    const { container: personalContainer, unmount: unmountPersonal } =
      renderOpponentsAt('/opponents');
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="opponents-body"]')).not.toBeNull(),
    );
    const personalText = normalisedText(personalContainer);
    const personalSignature = domSignature(personalContainer);
    const personalRowOrder = within(personalContainer)
      .getAllByRole('listitem')
      .map((li) => (li.textContent ?? '').trim());
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderOpponentsAt(
      '/coach/test-client/opponents',
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="opponents-body"]')).not.toBeNull(),
    );
    expect(domSignature(coachContainer)).toEqual(personalSignature);
    expect(normalisedText(coachContainer)).toBe(personalText);
    expect(
      within(coachContainer)
        .getAllByRole('listitem')
        .map((li) => (li.textContent ?? '').trim()),
    ).toEqual(personalRowOrder);
    unmountCoach();

    const { container: workspaceContainer } = renderOpponentsAt('/workspace/test-tenant/opponents');
    await waitFor(() =>
      expect(workspaceContainer.querySelector('[data-slot="opponents-body"]')).not.toBeNull(),
    );
    expect(domSignature(workspaceContainer)).toEqual(personalSignature);
    expect(normalisedText(workspaceContainer)).toBe(personalText);
  });

  it('renders structurally identical hub content under /opponents/:opponentTag, /coach/:clientId/opponents/:opponentTag AND /workspace/:tenantId/opponents/:opponentTag', async () => {
    // Uses `TOP_OPPONENT_TAG` (the fixture's own most-frequent opponent tag)
    // rather than a hardcoded literal — `analyticsFixture()` is the shared
    // package's seeded generator, and a hardcoded tag not actually present in
    // its output would 404 the hub instead of exercising it.
    const { container: personalContainer, unmount: unmountPersonal } = renderOpponentHubAt(
      `/opponents/${TOP_OPPONENT_TAG}`,
    );
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="opponent-hub-body"]')).not.toBeNull(),
    );
    const personalText = normalisedText(personalContainer);
    const personalSignature = domSignature(personalContainer);
    unmountPersonal();

    const { container: coachContainer, unmount: unmountCoach } = renderOpponentHubAt(
      `/coach/test-client/opponents/${TOP_OPPONENT_TAG}`,
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="opponent-hub-body"]')).not.toBeNull(),
    );
    expect(domSignature(coachContainer)).toEqual(personalSignature);
    expect(normalisedText(coachContainer)).toBe(personalText);
    unmountCoach();

    const { container: workspaceContainer } = renderOpponentHubAt(
      `/workspace/test-tenant/opponents/${TOP_OPPONENT_TAG}`,
    );
    await waitFor(() =>
      expect(workspaceContainer.querySelector('[data-slot="opponent-hub-body"]')).not.toBeNull(),
    );
    expect(domSignature(workspaceContainer)).toEqual(personalSignature);
    expect(normalisedText(workspaceContainer)).toBe(personalText);
  });

  it('a coach-mounted Opponents rail with zero client matches renders the same empty branch as the own-account route', async () => {
    listMatches.mockResolvedValue([]);

    const { container: personalContainer, unmount: unmountPersonal } =
      renderOpponentsAt('/opponents');
    await waitFor(() => expect(normalisedText(personalContainer).length).toBeGreaterThan(0));
    const personalText = normalisedText(personalContainer);
    unmountPersonal();

    const { container: coachContainer } = renderOpponentsAt('/coach/test-client/opponents');
    await waitFor(() => expect(normalisedText(coachContainer).length).toBeGreaterThan(0));
    expect(normalisedText(coachContainer)).toBe(personalText);
  });
});

describe('Store isolation — horizon and dismissals (INS-06, T-39.1-21-02)', () => {
  it('setting a horizon on the own-account subject leaves a coach-mounted subject resolving to the default, with no read of the own-account key', async () => {
    // Simulate "the user set a horizon on the own-account route" directly
    // through the same store `useHorizon` itself writes through — the
    // acceptance property under test is the READ side on a DIFFERENT
    // subject, not the write mechanics (already covered by `useHorizon.test.tsx`).
    persistSelection('test-uid', null, { horizon: 'last90' });
    const personalKey = analyticsSelectionStorageKey('test-uid', null);
    const coachKey = analyticsSelectionStorageKey('test-uid', 'test-client');
    expect(personalKey).not.toBe(coachKey);

    const getItemSpy = vi.spyOn(window.localStorage.__proto__, 'getItem');

    const { container } = renderDashboardAt('/coach/test-client/dashboard');
    await waitFor(() =>
      expect(container.querySelector('[data-slot="horizon-switch"]')).not.toBeNull(),
    );

    const horizonSwitch = container.querySelector('[data-slot="horizon-switch"]');
    // The coach subject was never given a stored horizon — it resolves to
    // the default (`last30`), never the own-account subject's `last90`.
    expect(horizonSwitch?.getAttribute('data-horizon')).toBe('last30');

    const readKeys = getItemSpy.mock.calls.map((call) => call[0]);
    expect(readKeys).not.toContain(personalKey);
    expect(readKeys).toContain(coachKey);

    getItemSpy.mockRestore();
  });

  it('dismissing a card on a coach-mounted subject leaves it rendered for the own-account subject', async () => {
    const user = userEvent.setup();

    const { container: coachContainer, unmount: unmountCoach } = renderFighterAnalysisAt(
      '/coach/test-client/fighter-analysis',
    );
    await waitFor(() =>
      expect(coachContainer.querySelector('[data-slot="insight-rail-card"]')).not.toBeNull(),
    );
    const beforeDismiss = railCardVerdictOrder(coachContainer);
    expect(beforeDismiss.length).toBeGreaterThan(0);
    const dismissedVerdict = beforeDismiss[0]!;

    const dismissButtons = within(coachContainer).getAllByRole('button', { name: 'Dismiss' });
    await user.click(dismissButtons[0]!);

    await waitFor(() => {
      const afterDismiss = railCardVerdictOrder(coachContainer);
      expect(afterDismiss).not.toContain(dismissedVerdict);
    });
    unmountCoach();

    // A fresh mount of the OWN-ACCOUNT (personal) subject must still render
    // the card the coach subject just dismissed — dismissals are per (uid,
    // subject), never global.
    const { container: personalContainer } = renderFighterAnalysisAt('/fighter-analysis');
    await waitFor(() =>
      expect(personalContainer.querySelector('[data-slot="insight-rail-card"]')).not.toBeNull(),
    );
    expect(railCardVerdictOrder(personalContainer)).toContain(dismissedVerdict);
  });

  it('two subject identifiers differing only by the client-prefix segment compose to different storage keys and do not share a round trip (T-39.1-12-01 boundary)', () => {
    const clientA = 'client-a';
    const clientAExtended = 'client-a-extended';

    const selectionKeyA = analyticsSelectionStorageKey('test-uid', clientA);
    const selectionKeyAExtended = analyticsSelectionStorageKey('test-uid', clientAExtended);
    expect(selectionKeyA).not.toBe(selectionKeyAExtended);

    const dismissalsKeyA = insightDismissalsStorageKey('test-uid', clientA);
    const dismissalsKeyAExtended = insightDismissalsStorageKey('test-uid', clientAExtended);
    expect(dismissalsKeyA).not.toBe(dismissalsKeyAExtended);

    // Round trip: writing a horizon for client-a must not be visible when
    // reading client-a-extended, and vice versa.
    persistSelection('test-uid', clientA, { horizon: 'last90' });
    expect(readStoredSelection('test-uid', clientAExtended).horizon).toBeUndefined();
    expect(readStoredSelection('test-uid', clientA).horizon).toBe('last90');

    persistSelection('test-uid', clientAExtended, { horizon: 'lastEvent' });
    expect(readStoredSelection('test-uid', clientA).horizon).toBe('last90');
    expect(readStoredSelection('test-uid', clientAExtended).horizon).toBe('lastEvent');

    // Same round trip for dismissals.
    writeStoredDismissals('test-uid', clientA, ['formNow:account:last30']);
    expect(readStoredDismissals('test-uid', clientAExtended)).toEqual([]);
    expect(readStoredDismissals('test-uid', clientA)).toEqual(['formNow:account:last30']);
  });
});

describe('No fixture data reaches a page component as a prop (INS-06 source scan)', () => {
  it('every rendered page element in this file is self-closed with no attributes — fixture data flows through the mocked hooks only', () => {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const pageNames = [
      'DashboardPage',
      'FighterAnalysisPage',
      'MatchupsPage',
      'MatchDataPage',
      'OpponentsPage',
      'OpponentHubPage',
    ];
    for (const name of pageNames) {
      const occurrences = [...source.matchAll(new RegExp(`<${name}[^>]*>`, 'g'))].map((m) => m[0]);
      expect(occurrences.length).toBeGreaterThan(0);
      for (const occurrence of occurrences) {
        expect(occurrence, `${name} must be rendered bare (no props): "${occurrence}"`).toMatch(
          new RegExp(`^<${name}\\s*/>$`),
        );
      }
    }
  });
});
