import { useLocation, useParams } from 'react-router';

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
 */
export interface ActiveSubject {
  mode: 'personal' | 'coaching';
  clientId: string | null;
}

export function useActiveSubject(): ActiveSubject {
  const location = useLocation();
  const { clientId } = useParams<{ clientId?: string }>();
  const isCoaching = location.pathname === '/coach' || location.pathname.startsWith('/coach/');
  return {
    mode: isCoaching ? 'coaching' : 'personal',
    clientId: isCoaching && clientId ? clientId : null,
  };
}
