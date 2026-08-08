import { useEffect } from 'react';
import { useResearchSubject } from '@/hooks/useResearchSubject';
import { setAnalyticsCollectionEnabled } from '@/lib/firebase';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-04, D-06,
 * review finding 29-08 HIGH): a render-nothing route-observer component,
 * mounted ONCE at the router root, IMMEDIATELY BEFORE `RouteAnalytics` (see
 * `AppRouter.tsx`'s ordering comment). Its single job is keeping
 * `lib/firebase.ts`'s synchronous collection flag in sync with
 * `useResearchSubject()` — the same authoritative browser-side subject
 * signal plan 29-08 built, consumed here, never re-derived.
 *
 * Disables collection when the active workspace is a research tenant, OR
 * the kind lookup is still pending, OR it errored — fail-closed: an
 * operator must never see telemetry leak while the app doesn't yet (or
 * can't) know what kind of workspace this is. Re-enables collection the
 * moment none of those hold, including on leaving the workspace entirely
 * (`useResearchSubject` returns `{ isResearch: false, isPending: false,
 * isError: false }` outside any client workspace route).
 *
 * Lives at the ROUTER ROOT rather than inside `ClientWorkspaceLayout`
 * (which already gates its own outlet on this same signal, per plan 29-08)
 * deliberately: that layout unmounts the instant the session navigates OUT
 * of the workspace, and an unmounting component cannot run cleanup that
 * flips a flag back on for the surface it's leaving — mirrors
 * `ActiveSubjectSync`'s own doc comment on the same structural point.
 *
 * The effect is keyed on the three PRIMITIVE flags, never on a fresh object
 * identity (`useResearchSubject`'s return value is itself memoized, but this
 * still follows the codebase's established discipline of depending on
 * primitives in a router-root effect — see `ActiveSubjectSync`).
 */
export function ResearchTelemetrySuppression() {
  const { isResearch, isPending, isError } = useResearchSubject();
  useEffect(() => {
    setAnalyticsCollectionEnabled(!(isResearch || isPending || isError));
  }, [isResearch, isPending, isError]);
  return null;
}
