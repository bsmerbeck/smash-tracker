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
 *
 * Scoped by `clientId != null`, NEVER by `mode` alone (walkthrough fix
 * FB-1) — `mode: 'coaching'` is also true at the `/coach` hub, which has no
 * client selected; hub reads must stay in the `'personal'` cache namespace.
 */
export function subjectScope({ clientId }: ActiveSubject): readonly unknown[] {
  return clientId ? (['client', clientId] as const) : (['personal'] as const);
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

/**
 * Phase 35 (Player-True Defaults & Persistence, NEW-M2): the ONE place the
 * `client:` literal is spelled anywhere in the app. Every subject-scoped
 * storage key or header value composes through this function instead of
 * re-spelling the `clientId ? … : …` branch itself — `getActiveSubjectHeader`
 * below, `analyticsSelectionStorageKey` (`lib/analyticsSelection.ts`), and
 * 35-03's `analyticsFilterStorageKey`/`rangeAutoWidenSessionKey` all take a
 * raw `clientId: string | null` and derive their segment from here, so no
 * builder can drift from another's notion of "client:<id>".
 */
export function subjectSegment(clientId: string | null): string {
  return clientId ? `client:${clientId}` : 'personal';
}

/**
 * The `X-Active-Subject` header value matching the API's resolver contract.
 * Derived from `clientId != null`, NEVER from `mode` alone (walkthrough fix
 * FB-1) — see `subjectScope` above for the same rationale.
 */
export function getActiveSubjectHeader(): string {
  return subjectSegment(activeSubject.clientId);
}
