import type { ReactNode } from 'react';
import { StretchedCardFixture } from '@/components/analytics/guardFixtures/StretchedCardFixture';
import { PeriodAxisTicksFixture } from '@/components/analytics/guardFixtures/PeriodAxisTicksFixture';
import { DashboardPage } from '@/pages/Dashboard/DashboardPage';
import { FighterAnalysisPage } from '@/pages/FighterAnalysis/FighterAnalysisPage';
import { MatchupsPage } from '@/pages/Matchups/MatchupsPage';
import { MatchDataPage } from '@/pages/MatchData/MatchDataPage';
import { TrendsPage } from '@/pages/Trends/TrendsPage';
import { OpponentsPage } from '@/pages/Opponents/OpponentsPage';
import { OpponentHubPage } from '@/pages/Opponents/OpponentHubPage';
import { StageDetailPage } from '@/pages/Stages/StageDetailPage';
import { GspPage } from '@/pages/Gsp/GspPage';
import { ScoutPage } from '@/pages/Scout/ScoutPage';

/**
 * The layout-oracle harness's route table (Phase 39.1 Plan 09, review
 * finding C1-H4). `src/guardHarness/main.tsx` mounts exactly ONE entry per
 * request, chosen by an `id` query param, inside a `MemoryRouter` at that
 * entry's declared `path` — the SAME recipe the shipped perf harness uses
 * for its single hard-coded page (`apps/web/src/perfHarness/main.tsx`),
 * generalised into a TABLE so `guardLayout.mjs`'s `LAYOUT_ORACLE_ROUTES`
 * array (which mirrors this table's `id`s) can measure more than one route.
 *
 * In THIS plan the table holds exactly one entry: the layout oracle's own
 * deliberately-broken fixture route. Plan 39.1-20 adds one entry per real
 * analytics route, mounting each page component at the REAL path pattern
 * read from `apps/web/src/routes/subjectAnalyticsRoutes.tsx` (with a
 * concrete path parameter in `initialEntry` for the routes that take one),
 * so every `useLocation()`-based subject hook resolves exactly as it does
 * in the app.
 *
 * `loadedMarker` is a CONTRACT, not a description: it is the exact selector
 * of that route's page-loaded marker — an element that exists only once
 * that page's data has settled, never a skeleton block. Plan 39.1-20 Task
 * 3's `ROUTE_TABLE_OK` verify greps this file's source text for the exact
 * substring `loadedMarker:` against the entry count, so this field must stay
 * named exactly `loadedMarker`, declared as a single-quoted string literal
 * (this repo's Prettier `singleQuote: true` convention).
 */
export interface GuardHarnessRouteEntry {
  /** Stable id, read from the `id` query param by `main.tsx` and mirrored by `guardLayout.mjs`'s `LAYOUT_ORACLE_ROUTES`. */
  id: string;
  /** The route path declared on the harness's own `<Route>` — a real analytics path pattern in plan 39.1-20, an arbitrary harness path here. */
  path: string;
  /** The `MemoryRouter` `initialEntries[0]` — a concrete URL, with a real path-parameter value substituted for routes that take one. */
  initialEntry: string;
  /** The element mounted at `path`. */
  element: ReactNode;
  /** The page-loaded-marker CSS selector — see the contract note above. Never a skeleton block. */
  loadedMarker: string;
  /**
   * Plan 39.1-30 (T-39.1-30-01): opts this route into the harness's
   * MainLayout-geometry wrapper (`GuardAppShell.tsx`) so its content is
   * measured at production content widths, not the harness's default raw
   * viewport width. Omitted (mounts unwrapped, today's behaviour) for every
   * route except `matchups`, (plan 39.1-34) `trends-career`, (plan 39.1-35)
   * `trends-casual`, (plan 39.1-39) `dashboard-app`, `stage-detail-recent` and the
   * capture-only `gsp`, (plan 39.1-51) the three `*-games` drill routes and
   * (plan 39.1-41) `matchups-sketch-deep` / `matchups-sketch-thin`.
   */
  shell?: 'app';
}

/**
 * The eight real analytics routes (plan 39.1-20, Task 3). Each `path` is the
 * REAL path pattern read from `apps/web/src/routes/subjectAnalyticsRoutes.tsx`
 * / `AppRouter.tsx` for the PERSONAL subject family (the family the harness's
 * fake auth context represents — `GUARD_HARNESS_UID`, never a coach/workspace
 * subject). `initialEntry` substitutes a concrete value for the two routes
 * that carry a path parameter (`/opponents/synthopp15`, `/stages/1`), chosen
 * to exist in `guardLayoutFixturePlugin.mjs`'s `realistic` fixture (see that
 * file's own doc comment for the exact measured counts).
 *
 * `loadedMarker` provenance (review finding C2-M1 — plan 39.1-20 records
 * which plan's SUMMARY handed it each selector, and which it chose itself):
 *   - fighter-analysis: `[data-slot="fighter-hero-body"]`, plan 39.1-14's SUMMARY.
 *   - match-data: `[data-slot="match-data-rail"]`, plan 39.1-16's SUMMARY.
 *   - opponents-hub, stages: `[data-slot="opponent-hub-body"]` /
 *     `[data-slot="stage-detail-body"]`, plan 39.1-18's SUMMARY.
 *   - dashboard, opponents: `[data-slot="dashboard-body"]` /
 *     `[data-slot="opponents-body"]` — no prior SUMMARY recorded one for
 *     these two pages, so plan 39.1-20 added the marker itself (Task 1) and
 *     chose it here.
 *   - matchups: `[data-slot="matchup-chart-body"]` — an EXISTING marker on
 *     `MatchupChart.tsx` (plan 39.1-13), reused as-is; it renders
 *     unconditionally once the page reaches its populated return branch.
 *   - trends: `[data-slot="trends-hero-body"]` — an EXISTING marker on
 *     `TrendsHero.tsx` (plan 39.1-15), reused as-is for the same reason.
 */
export const GUARD_HARNESS_ROUTES: GuardHarnessRouteEntry[] = [
  {
    id: 'stretched-card-fixture',
    path: '/guard-harness/stretched-card-fixture',
    initialEntry: '/guard-harness/stretched-card-fixture',
    element: <StretchedCardFixture />,
    loadedMarker: '[data-guard-loaded="stretched-card-fixture"]',
  },
  {
    // CR-01 (39.1-REVIEW.md): the period axis's real-Chrome failing series
    // lengths, measured by guard:layout's `axis-ticks` family.
    id: 'period-axis-ticks-fixture',
    path: '/guard-harness/period-axis-ticks-fixture',
    initialEntry: '/guard-harness/period-axis-ticks-fixture',
    element: <PeriodAxisTicksFixture />,
    loadedMarker: '[data-guard-loaded="period-axis-ticks-fixture"]',
  },
  {
    id: 'dashboard',
    path: '/dashboard',
    initialEntry: '/dashboard',
    element: <DashboardPage />,
    loadedMarker: '[data-slot="dashboard-body"]',
  },
  {
    // Plan 39.1-39 (record-fit): the SAME Dashboard page at the SAME path,
    // measured inside the MainLayout-geometry shell (the `trends-career`
    // precedent) — production card widths, where 39.1-36's shelled capture
    // recorded the Casual vs Competitive / Online vs Offline overprint.
    id: 'dashboard-app',
    path: '/dashboard',
    initialEntry: '/dashboard',
    element: <DashboardPage />,
    loadedMarker: '[data-slot="dashboard-body"]',
    shell: 'app',
  },
  {
    id: 'fighter-analysis',
    path: '/fighter-analysis',
    initialEntry: '/fighter-analysis',
    element: <FighterAnalysisPage />,
    loadedMarker: '[data-slot="fighter-hero-body"]',
  },
  {
    id: 'matchups',
    path: '/matchups',
    initialEntry: '/matchups',
    element: <MatchupsPage />,
    loadedMarker: '[data-slot="matchup-chart-body"]',
    shell: 'app',
  },
  {
    // Plan 39.1-41 (sketch 003 tracer): the Matchups page on sketch 003's own
    // data (guardLayout / capture:matchups-fidelity send
    // `x-guard-layout-scale: sketch003`) — the deep pairing, Cloud vs
    // Pyra/Mythra (102 games) ...
    id: 'matchups-sketch-deep',
    path: '/matchups',
    initialEntry: '/matchups?fighter=65&vs=84',
    element: <MatchupsPage />,
    loadedMarker: '[data-slot="matchup-chart-body"]',
    shell: 'app',
  },
  {
    // ... and the thin pairing, Pikachu vs Joker (11 games).
    id: 'matchups-sketch-thin',
    path: '/matchups',
    initialEntry: '/matchups?fighter=9&vs=76',
    element: <MatchupsPage />,
    loadedMarker: '[data-slot="matchup-chart-body"]',
    shell: 'app',
  },
  {
    id: 'match-data',
    path: '/match-data',
    initialEntry: '/match-data',
    element: <MatchDataPage />,
    loadedMarker: '[data-slot="match-data-rail"]',
  },
  {
    id: 'trends',
    path: '/trends',
    initialEntry: '/trends',
    element: <TrendsPage />,
    loadedMarker: '[data-slot="trends-hero-body"]',
  },
  {
    // Plan 39.1-34: the career timeline's oracle route — the SAME Trends page
    // at the SAME path, fed the harness's sparg0-shaped `career` fixture
    // (guardLayout sends `x-guard-layout-scale: career` for this id) and
    // measured inside the MainLayout-geometry shell at production widths.
    id: 'trends-career',
    path: '/trends',
    initialEntry: '/trends',
    element: <TrendsPage />,
    loadedMarker: '[data-slot="trends-hero-body"]',
    shell: 'app',
  },
  {
    // Plan 39.1-35: the casual-account oracle route — the Trends page at the
    // SAME path, fed the harness's 41-game `casual` fixture (guardLayout sends
    // `x-guard-layout-scale: casual` for this id): the timeline's thin state.
    id: 'trends-casual',
    path: '/trends',
    initialEntry: '/trends',
    element: <TrendsPage />,
    loadedMarker: '[data-slot="trends-hero-body"]',
    shell: 'app',
  },
  {
    id: 'opponents',
    path: '/opponents',
    initialEntry: '/opponents',
    element: <OpponentsPage />,
    loadedMarker: '[data-slot="opponents-body"]',
  },
  {
    id: 'opponent-hub',
    path: '/opponents/:opponentTag',
    initialEntry: '/opponents/synthopp15',
    element: <OpponentHubPage />,
    loadedMarker: '[data-slot="opponent-hub-body"]',
  },
  {
    id: 'stage-detail',
    path: '/stages/:stageId',
    initialEntry: '/stages/1',
    element: <StageDetailPage />,
    loadedMarker: '[data-slot="stage-detail-body"]',
  },
  {
    // Plan 39.1-39 (deferred from 39.1-37): the SAME stage page on the
    // harness's `recent` scale (guardLayout sends `x-guard-layout-scale:
    // recent`), in the MainLayout-geometry shell — ~150 session anchors on
    // Battlefield, the mark-count family's over-the-bound account.
    id: 'stage-detail-recent',
    path: '/stages/:stageId',
    initialEntry: '/stages/1',
    element: <StageDetailPage />,
    loadedMarker: '[data-slot="stage-detail-body"]',
    shell: 'app',
  },
  // Plan 39.1-51 (OOS-8): the three hosts that mount the results list
  // (`FilteredMatchList`) only under a drill axis, drilled with `?from=1`
  // (every game), in the MainLayout-geometry shell — so guard:layout's
  // last-row-visible family measures them and capture:design shoots them.
  {
    id: 'fighter-analysis-games',
    path: '/fighter-analysis',
    initialEntry: '/fighter-analysis?from=1',
    element: <FighterAnalysisPage />,
    loadedMarker: '[data-slot="filtered-match-list"] [data-total-rows]',
    shell: 'app',
  },
  {
    id: 'match-data-games',
    path: '/match-data',
    initialEntry: '/match-data?from=1',
    element: <MatchDataPage />,
    loadedMarker: '[data-slot="filtered-match-list"] [data-total-rows]',
    shell: 'app',
  },
  {
    id: 'trends-games',
    path: '/trends',
    initialEntry: '/trends?from=1',
    element: <TrendsPage />,
    loadedMarker: '[data-slot="filtered-match-list"] [data-total-rows]',
    shell: 'app',
  },
  {
    // Plan 39.1-39 (OWNER DECISION 2026-09-25, DD-11 extended to GSP): a
    // CAPTURE-ONLY route — `captureDesignScreens.mjs` screenshots the GSP
    // page's three chart.js charts on its `gsp` fixture scale. It is never
    // one of guard:layout's `LAYOUT_ORACLE_ROUTES` (GSP stays chart.js until
    // Phase 41 and is not an analytics route).
    id: 'gsp',
    path: '/gsp',
    initialEntry: '/gsp',
    element: <GspPage />,
    loadedMarker: '[data-slot="gsp-body"]',
    shell: 'app',
  },
  {
    // Plan 39.1-49: the Scout page, unshelled like the other real routes.
    // Its report exists only after the search form's POST /api/scout (the
    // fixture plugin answers it), so guard:layout's `scout` route drives the
    // form and expands Full analysis before this marker appears.
    id: 'scout',
    path: '/scout',
    initialEntry: '/scout',
    element: <ScoutPage />,
    loadedMarker: '[data-slot="scout-full-analysis"][data-state="open"]',
  },
];

/** Looks up a route table entry by `id`, or `undefined` if none matches. */
export function findGuardHarnessRoute(id: string | null): GuardHarnessRouteEntry | undefined {
  return GUARD_HARNESS_ROUTES.find((route) => route.id === id);
}
