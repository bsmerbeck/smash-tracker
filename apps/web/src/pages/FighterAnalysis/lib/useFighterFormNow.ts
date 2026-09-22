import { useMemo, useState } from 'react';
import type { HorizonKey, Insight, InsightScope, Match } from '@smash-tracker/shared';
import { INSIGHT_TEMPLATES } from '@smash-tracker/shared';

/**
 * VIZ-03/INS-05: the `formNow` template registered in the closed insight
 * registry, looked up by id rather than imported directly — mirrors
 * `MatchupChart.tsx`'s `useMatchupFormNow` (`formNow` at character scope,
 * distinct from its account-scope default; `registry.ts`'s own doc comment
 * states a caller may invoke `build` with any `InsightScope` its own logic
 * can interpret). Resolved once at module scope: the registry is a static,
 * closed array.
 */
const FORM_NOW_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'formNow')!;

/**
 * Builds the character-scoped `InsightScope` for this one fighter (D-09's
 * "axis identity supplied at the boundary" discipline) — `filter` is the
 * identity function because `fighterMatches` is already fighter-filtered by
 * the host before it reaches this hook.
 */
function buildFighterScope(fighterId: number): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches: Match[]) => matches,
  };
}

export interface UseFighterFormNowInput {
  /** `undefined` before a fighter is resolved on the host page — resolves to a null insight, never a throw. */
  fighterId: number | undefined;
  fighterMatches: Match[];
  horizon: HorizonKey;
}

export interface UseFighterFormNowResult {
  insight: Insight | null;
  nowMs: number;
}

/**
 * Plan 39.1-25 (gap closure, SC4/INS-04, D-12): the ONE `formNow` computation
 * this page shares between the hero (verdict, strip recent-window highlight,
 * trend emphasis band, the counted-games door) and the page's own terminus
 * (`resolveClaim`/`claimSummary`) — a host page calls this ONCE, above every
 * early return, and hands the result down; `FighterHero` no longer builds
 * its own `formNow` insight or owns its own clock. Mirrors
 * `useMatchupFormNow`'s shape (`MatchupChart.tsx`). Lives in a non-component
 * `.ts` module on purpose, so it adds no `react-refresh/only-export-components`
 * warning (unlike a hook exported from a component file).
 */
export function useFighterFormNow({
  fighterId,
  fighterMatches,
  horizon,
}: UseFighterFormNowInput): UseFighterFormNowResult {
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  const scope = useMemo(
    () => (fighterId != null ? buildFighterScope(fighterId) : null),
    [fighterId],
  );

  const insight = useMemo(() => {
    if (scope == null || fighterMatches.length === 0) {
      return null;
    }
    const built = FORM_NOW_TEMPLATE.build({ matches: fighterMatches, scope, horizon, nowMs });
    return built[0] ?? null;
  }, [fighterMatches, scope, horizon, nowMs]);

  return { insight, nowMs };
}
