import { useLocation } from 'react-router';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-07): the current
 * request "subject" — whose data the page is reading/writing — derived
 * purely from the route, never hidden global state. Mirrors the API's own
 * `X-Active-Subject` contract (`apps/api/src/coaching/subject.ts`).
 *
 * `mode` is CHROME state (which segmented-control value should read active,
 * which nested pages render) and is `'coaching'` for ANY route under
 * `/coach` — including the hub (`/coach`) itself, which has no client
 * selected yet. `clientId` is the API-SUBJECT-determining field: non-null
 * only inside `/coach/:clientId/...`. These are deliberately split (walkthrough
 * fix FB-1) — every consumer that derives the `X-Active-Subject` header or a
 * subject-scoped query key MUST branch on `clientId != null`, never on
 * `mode === 'coaching'` alone, or hub reads would incorrectly scope to a
 * "current" client that doesn't exist.
 *
 * - Any route under `/coach` (`/coach` itself or `/coach/...`) — `mode: 'coaching'`.
 * - Every other route — `mode: 'personal'`.
 * - `clientId` — the route param inside `/coach/:clientId/...`, else `null`.
 *
 * Named `Coaching`/`Subject`/`Client`, never a bare CamelCase `Coach`-prefixed
 * identifier — this codebase already has an unrelated Phase 8 "coach"
 * concept (`CoachAttribution`/`coachNotes.ts`, an anonymous share-link
 * reviewer's note attribution). See the phase RESEARCH.md naming-collision
 * finding for the full rationale.
 *
 * Phase 29 Plan 12 (RTEN-04, T-29-12 — found by the browser composite
 * integration test): deliberately does NOT use `useParams()`. Every one of
 * this hook's ROUTER-ROOT consumers (`ActiveSubjectSync`, `RouteAnalytics`,
 * `ResearchTelemetrySuppression` — all mounted as SIBLINGS of `<Routes>` in
 * `AppRouter.tsx`, never as its descendants) sits OUTSIDE the `RouteContext`
 * a matched `<Route>` element provides, so `useParams()` called from any of
 * them always resolves to `{}` regardless of the active URL — confirmed via
 * `react-router`'s own `useParams` implementation, which reads
 * `RouteContext.matches`, a context only `<Routes>`'s own rendered
 * subtree receives. That silently defeated `ResearchTelemetrySuppression`'s
 * entire fail-closed contract (RTEN-04): its own `useResearchSubject()` call
 * always saw `clientId: null`, so it could never detect a research or
 * pending workspace and never disabled analytics collection — the exact
 * GA4-leak class plan 29-09 believed it had closed. Parsing `clientId`
 * directly from `useLocation().pathname` instead works identically for
 * BOTH router-root siblings AND components nested inside the matched Route
 * (e.g. `ClientWorkspaceLayout`), since it never depends on tree position —
 * `useActiveSubject.test.tsx`'s pre-existing assertions (all of which render
 * a route-nested `Probe`) are unchanged by this fix.
 */
export interface ActiveSubject {
  mode: 'personal' | 'coaching';
  clientId: string | null;
}

const COACH_CLIENT_ID_PATTERN = /^\/coach\/([^/]+)/;

export function useActiveSubject(): ActiveSubject {
  const location = useLocation();
  const isCoaching = location.pathname === '/coach' || location.pathname.startsWith('/coach/');
  const match = COACH_CLIENT_ID_PATTERN.exec(location.pathname);
  const clientId = isCoaching && match ? decodeURIComponent(match[1]!) : null;
  return {
    mode: isCoaching ? 'coaching' : 'personal',
    clientId,
  };
}
