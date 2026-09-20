import type { ReactNode } from 'react';
import { StretchedCardFixture } from '@/components/analytics/guardFixtures/StretchedCardFixture';

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
}

export const GUARD_HARNESS_ROUTES: GuardHarnessRouteEntry[] = [
  {
    id: 'stretched-card-fixture',
    path: '/guard-harness/stretched-card-fixture',
    initialEntry: '/guard-harness/stretched-card-fixture',
    element: <StretchedCardFixture />,
    loadedMarker: '[data-guard-loaded="stretched-card-fixture"]',
  },
];

/** Looks up a route table entry by `id`, or `undefined` if none matches. */
export function findGuardHarnessRoute(id: string | null): GuardHarnessRouteEntry | undefined {
  return GUARD_HARNESS_ROUTES.find((route) => route.id === id);
}
