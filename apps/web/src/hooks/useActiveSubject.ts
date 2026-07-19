import { useLocation, useParams } from 'react-router';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-07): the current
 * request "subject" — whose data the page is reading/writing — derived
 * purely from the route, never hidden global state. Mirrors the API's own
 * `X-Active-Subject` contract (`apps/api/src/coaching/subject.ts`).
 *
 * - Any route under `/coach/:clientId/...` — `{ mode: 'coaching', clientId }`.
 * - Every other route — `{ mode: 'personal', clientId: null }`.
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
  const isCoaching = location.pathname.startsWith('/coach');
  return isCoaching && clientId
    ? { mode: 'coaching', clientId }
    : { mode: 'personal', clientId: null };
}
