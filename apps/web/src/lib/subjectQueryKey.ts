import { activeSubjectFromPathname, type ActiveSubject } from '@/hooks/useActiveSubject';
import { ownedWorkspaceTenantIdFromPathname } from '@/hooks/useOwnedWorkspaceSubject';

/**
 * Phase 35-03 (Task 3, NEW-L3): this file was type-only before this import
 * (`import type { ActiveSubject }` erases at build) — `lib/api.ts:121,243`
 * depends on this module for `getActiveSubjectHeader()`, so pulling in two
 * `react-router`-consuming hooks here makes `lib/api.ts`'s module graph
 * depend on `react-router` at RUNTIME for the first time. There is no
 * cycle (neither hook imports this module) and `react-router` is already in
 * the SPA bundle, so this is a recorded consequence, not a defect — do NOT
 * "fix" it by copying `COACH_CLIENT_ID_PATTERN`/`WORKSPACE_TENANT_ID_PATTERN`
 * into this file instead; that reintroduces the two-copies-of-the-route-
 * grammar drift class `useActiveSubject.ts`'s own doc comment warns about.
 */

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

/**
 * Phase 35-03 (Task 3, H-3): change-notification listeners for the
 * pathname-derived readers below. The module store is no longer the VALUE
 * source for those readers — only the signal for WHEN to re-read
 * `window.location.pathname`. Gated on the STORE-derived segment (not the
 * pathname-derived one): `ActiveSubjectSync` passes a fresh `ActiveSubject`
 * object on every navigation, so notifying unconditionally would re-render
 * every subscriber on every route change, and every real subject transition
 * already calls `setActiveSubject` with a changed `clientId` (verified at
 * all three call sites: `ActiveSubjectSync.tsx`, `ClientOwnedWorkspaceLayout.tsx`,
 * `ClientWorkspaceLayout.tsx`), so gating here does not lose reactivity.
 */
const listeners = new Set<() => void>();

export function subscribeActiveSubject(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setActiveSubject(subject: ActiveSubject): void {
  const previousSegment = subjectSegment(activeSubject.clientId);
  activeSubject = subject;
  const nextSegment = subjectSegment(activeSubject.clientId);
  if (nextSegment !== previousSegment) {
    for (const listener of listeners) {
      listener();
    }
  }
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
 * FB-1) — see `subjectScope` above for the same rationale. Deliberately left
 * deriving from the module store alone (planner decision 5): this value
 * feeds every API request header and changing its boot-time behavior is an
 * API-facing blast radius this phase does not take. See
 * `getActiveSubjectClientId`'s comment below for the reader that DOES derive
 * from the pathname, and why the two deliberately diverge.
 */
export function getActiveSubjectHeader(): string {
  return subjectSegment(activeSubject.clientId);
}

/**
 * Phase 35-03 (Task 3, H-3): composes the two extracted route parsers in
 * `useEffectiveSubject`'s own precedence — the owned-workspace tenantId
 * wins, otherwise the coach subject's `clientId`, otherwise `null`. Neither
 * route regex is re-declared here (planner decision 6) — both are imported
 * from their single owning hook file.
 */
export function subjectClientIdFromPathname(pathname: string): string | null {
  const tenantId = ownedWorkspaceTenantIdFromPathname(pathname);
  if (tenantId) {
    return tenantId;
  }
  return activeSubjectFromPathname(pathname).clientId;
}

export function subjectSegmentFromPathname(pathname: string): string {
  return subjectSegment(subjectClientIdFromPathname(pathname));
}

/**
 * Phase 35-03 (Task 3, H-3/NEW-H2): the subject reader for consumers mounted
 * OUTSIDE the router (`AnalyticsFilterProvider`, Task 4) — derives from
 * `window.location.pathname` on EVERY call, unconditionally, never from the
 * module store above. This is deliberately different from
 * `getActiveSubjectHeader()`: a store-authoritative reader would report the
 * module DEFAULT (`personal`) on the first render of a hard load or deep
 * link into a client route, and — worse — the `/workspace/:tenantId/*` boot
 * sequence writes the store to `{personal, null}` (`ActiveSubjectSync`'s
 * `/coach`-only read) BEFORE correcting it to `{personal, tenantId}`
 * (`ClientOwnedWorkspaceLayout`), so a store-authoritative reader's
 * correctness there would rest on React coalescing two
 * `useSyncExternalStore` notifications inside one passive-effect flush — an
 * unproven implementation detail for the client-owned workspace family this
 * milestone exists to deliver. Deriving from the pathname removes the
 * question rather than betting on the answer. `BrowserRouter`
 * (`AppRouter.tsx`) is what makes `window.location.pathname` authoritative
 * here; this is the function that would need to change if this app ever
 * adopted hash routing. The `typeof window` guard exists for SSR/test
 * environments where `window` may be undefined at import time.
 *
 * The VALUE source (this function) and the NOTIFICATION source
 * (`subscribeActiveSubject`, gated on `setActiveSubject`) are deliberately
 * different — do not "unify" them by making this read the module store.
 */
export function getActiveSubjectClientId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return subjectClientIdFromPathname(window.location.pathname);
}

export function getActiveSubjectSegment(): string {
  return subjectSegment(getActiveSubjectClientId());
}
