import type { ActiveSubject } from '@/hooks/useActiveSubject';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-04): structural
 * cache isolation. Prefixes every subject-bound TanStack Query key so
 * Personal, Client A, and Client B occupy distinct cache namespaces — a
 * missing subject dimension in the key SHAPE is what caused this codebase's
 * own Phase 9 account-switch cache-bleed incident; this is the proactive,
 * structural fix (a `queryClient.clear()`/`invalidateQueries()` on
 * mode/client transition is still worthwhile belt-and-suspenders insurance,
 * applied at mutation call sites, but the key shape is the primary fix).
 */
export function subjectScope({ mode, clientId }: ActiveSubject): readonly unknown[] {
  return mode === 'coaching' && clientId
    ? (['client', clientId] as const)
    : (['personal'] as const);
}

/**
 * Module-level active-subject store. `apps/web/src/lib/api.ts`'s shared
 * `apiRequest` reads the current subject via `getActiveSubjectHeader()` so
 * every existing `api.*` call site stays unchanged — the alternative
 * (threading the subject through every call site) would touch every route
 * method in `api.ts`. `setActiveSubject` is called by the AppRouter/layout
 * on every route change (wired in a later Phase 11 plan).
 */
let activeSubject: ActiveSubject = { mode: 'personal', clientId: null };

export function setActiveSubject(subject: ActiveSubject): void {
  activeSubject = subject;
}

/** The `X-Active-Subject` header value matching the API's resolver contract. */
export function getActiveSubjectHeader(): string {
  return activeSubject.mode === 'coaching' && activeSubject.clientId
    ? `client:${activeSubject.clientId}`
    : 'personal';
}
