import { useActiveSubject } from './useActiveSubject';
import { useOwnedWorkspaceSubject } from './useOwnedWorkspaceSubject';

/**
 * Phase 11 fix round 3 (FB-6): the small, closed set of absolute PERSONAL
 * routes that are reachable from pages shared between Personal and a client
 * workspace (PAR-01/02/03 — Dashboard, FighterAnalysis, Matchups, MatchData,
 * VodManager all reuse the SAME components/routes in both modes), mapped to
 * their subject-prefixed equivalent path segment.
 *
 * `/choose-primary`/`/choose-secondary` have no 1:1 client-workspace route —
 * the workspace's single Fighters page (`ClientFightersPage`,
 * `/coach/:clientId/fighters`) sets both primary AND secondary together via
 * the same `CharacterSelectScreen` the personal chooser pages use — so both
 * map to `/fighters`.
 *
 * Plan 38-02 (D-03/OPP-04): `/opponents` is now mounted under both subject
 * families from the shared `subjectAnalyticsRoutes` list, so it gets a map
 * entry too — the leaf segment is identical in every family.
 */
const SUBJECT_ROUTE_MAP: Record<string, string> = {
  '/dashboard': '/dashboard',
  '/matchups': '/matchups',
  '/fighter-analysis': '/fighter-analysis',
  '/vod': '/vods',
  '/choose-primary': '/fighters',
  '/choose-secondary': '/fighters',
  '/opponents': '/opponents',
};

/**
 * Rewrites an absolute personal path (optionally with a `?query`) to its
 * subject-prefixed equivalent when a subject is active — so a component
 * reused inside a client workspace (e.g. `MatchupSnapshot`'s "Open Matchup
 * Lab" CTA, FB-6's originally-reported bug) never navigates a coach or an
 * owned-workspace viewer out to their OWN personal data. Personal mode (and
 * the `/coach` hub, which has no `clientId`) returns the path unchanged.
 *
 * Plan 38-02 (D-03): fixes a currently-shipping defect. This builder used to
 * derive its subject from `useActiveSubject()` alone (the coach-only hook),
 * so it silently returned the PERSONAL path on every `/workspace/:tenantId`
 * route — a link built on an owned-workspace page resolved to the viewer's
 * own personal path instead of staying inside their workspace. The builder
 * now composes BOTH family hooks directly — `useActiveSubject()` for the
 * coach client id and `useOwnedWorkspaceSubject()` for the tenant id —
 * rather than reaching for `useEffectiveSubject()`, which collapses the two
 * into one client id and loses which prefix family produced it. The two
 * prefixes differ (`/coach/:clientId/...` versus `/workspace/:tenantId/...`),
 * so the builder needs the family, not just the id. Precedence matches
 * `useEffectiveSubject`: an owned-workspace tenant id wins over a coach
 * client id when both somehow parse.
 *
 * Be precise about "pass-through": there are two distinct senses in this
 * function and conflating them silently drops a subject prefix. When a
 * SUBJECT is active (a tenant id or client id was found) but the pathname is
 * not a `SUBJECT_ROUTE_MAP` key, the result is PREFIX PLUS THE UNCHANGED
 * PATH — the prefix is still applied, only the map's rewrite is skipped
 * (this is what lets a param-bearing path like `/opponents/<tag>` or
 * `/stages/<id>` keep its subject prefix via the first-segment fallback
 * below). The OTHER sense — returning the input completely unchanged — only
 * happens in the NO-SUBJECT case (personal mode and the coach hub). A parity
 * test for a link built through this hook must declare all three families
 * (personal, coach, workspace): a two-family test passes while the
 * workspace family is broken.
 *
 * Handles param-bearing paths (e.g. `/opponents/<tag>`, `/stages/<id>`) via a
 * first-segment fallback: when the exact pathname isn't a map key, the FIRST
 * path segment is matched against the map and rewritten, leaving the
 * remaining segments intact — this is what makes a path with a trailing id
 * work without adding a second map entry per id.
 */
export function useSubjectPath(): (personalPath: string) => string {
  const { clientId } = useActiveSubject();
  const { tenantId } = useOwnedWorkspaceSubject();
  const prefix = tenantId ? `/workspace/${tenantId}` : clientId ? `/coach/${clientId}` : null;

  return (personalPath: string) => {
    if (prefix == null) {
      return personalPath;
    }
    const [pathname, search] = personalPath.split('?');
    if (!pathname) {
      return `${prefix}${personalPath}`;
    }
    const searchSuffix = search ? `?${search}` : '';
    const exactMatch = SUBJECT_ROUTE_MAP[pathname];
    if (exactMatch) {
      return `${prefix}${exactMatch}${searchSuffix}`;
    }
    const segments = pathname.split('/');
    const firstSegmentPath = `/${segments[1] ?? ''}`;
    const firstSegmentMapped = SUBJECT_ROUTE_MAP[firstSegmentPath];
    if (firstSegmentMapped) {
      const rest = segments.slice(2).join('/');
      const rewritten = rest ? `${firstSegmentMapped}/${rest}` : firstSegmentMapped;
      return `${prefix}${rewritten}${searchSuffix}`;
    }
    return `${prefix}${pathname}${searchSuffix}`;
  };
}
