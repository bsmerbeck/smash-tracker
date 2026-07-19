import { useActiveSubject } from './useActiveSubject';

/**
 * Phase 11 fix round 3 (FB-6): the small, closed set of absolute PERSONAL
 * routes that are reachable from pages shared between Personal and a client
 * workspace (PAR-01/02/03 — Dashboard, FighterAnalysis, Matchups, MatchData,
 * VodManager all reuse the SAME components/routes in both modes), mapped to
 * their `/coach/:clientId/...` equivalent path segment.
 *
 * `/choose-primary`/`/choose-secondary` have no 1:1 client-workspace route —
 * the workspace's single Fighters page (`ClientFightersPage`,
 * `/coach/:clientId/fighters`) sets both primary AND secondary together via
 * the same `CharacterSelectScreen` the personal chooser pages use — so both
 * map to `/fighters`.
 */
const SUBJECT_ROUTE_MAP: Record<string, string> = {
  '/dashboard': '/dashboard',
  '/matchups': '/matchups',
  '/fighter-analysis': '/fighter-analysis',
  '/vod': '/vods',
  '/choose-primary': '/fighters',
  '/choose-secondary': '/fighters',
};

/**
 * Rewrites an absolute personal path (optionally with a `?query`) to its
 * `/coach/:clientId/...` equivalent when the active subject is a coaching
 * client — so a component reused inside a client workspace (e.g.
 * `MatchupSnapshot`'s "Open Matchup Lab" CTA, FB-6's originally-reported
 * bug) never navigates a coach out to their OWN personal data. Personal mode
 * (and the `/coach` hub, which has no `clientId`) returns the path
 * unchanged. Unmapped paths pass through unchanged too — callers should only
 * feed this paths present in `SUBJECT_ROUTE_MAP` above.
 */
export function useSubjectPath(): (personalPath: string) => string {
  const { clientId } = useActiveSubject();
  return (personalPath: string) => {
    if (clientId == null) {
      return personalPath;
    }
    const [pathname, search] = personalPath.split('?');
    const mapped = (pathname && SUBJECT_ROUTE_MAP[pathname]) || pathname || personalPath;
    return `/coach/${clientId}${mapped}${search ? `?${search}` : ''}`;
  };
}
