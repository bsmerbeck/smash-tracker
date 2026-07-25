import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useOwnedWorkspaceSubject } from './useOwnedWorkspaceSubject';

/**
 * Phase 24 cache-key fix (24-05-CACHEFIX): the subject every `subjectScope()`
 * consumer should actually key/fetch against, composed from BOTH route
 * families that can determine "whose data is this" — the coach side's own
 * `useActiveSubject()` (unmodified, `/coach/:clientId/*` only) and the
 * client-owned workspace family's `useOwnedWorkspaceSubject()` (Phase 24,
 * `/workspace/:tenantId/*` only). `/coach/*` and `/workspace/*` are mutually
 * exclusive route prefixes, so at most one of the two source hooks ever
 * reports a non-null id; the owned-workspace tenantId wins when present,
 * otherwise the coach subject passes through unchanged (identity for every
 * existing coach/personal route — this is why the existing `useActiveSubject`
 * subject/cache tests keep passing unmodified).
 *
 * Both source hooks derive purely from `useLocation`/`useParams` — no
 * context, no module-level store, no effect. That means this composition is
 * correct on the component's FIRST render: there is no "provider sets the
 * subject in an effect after children have already fetched with the wrong
 * key" ordering hazard the module-level `X-Active-Subject` store
 * (`apps/web/src/lib/subjectQueryKey.ts`) has to account for. This hook only
 * fixes the cache key SHAPE the 10 subject-scoped hooks compute; it does not
 * touch (and does not need to touch) that header store or its sync effects.
 */
export function useEffectiveSubject(): ActiveSubject {
  const coachSubject = useActiveSubject();
  const { tenantId } = useOwnedWorkspaceSubject();
  if (tenantId) {
    return { mode: 'personal', clientId: tenantId };
  }
  return coachSubject;
}
