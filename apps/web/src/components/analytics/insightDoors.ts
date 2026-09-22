import {
  type Insight,
  type InsightDoor,
  type InsightDoorKind,
  type Match,
} from '@smash-tracker/shared';
import {
  buildDrillDownSearch,
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_VS_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_TO_PARAM,
  DRILL_DOWN_CLAIM_PARAM,
  type DrillDownAxes,
} from '@/lib/drillDownParams';

/**
 * Plan 39.1-19 — the ONE place this phase builds an `Insight`'s doors and
 * resolves its `claim=` axis (DD-09). "One contract, one terminus": every
 * href below is built through `buildDrillDownSearch` (Phase 38's ONE search
 * builder — no second URL-building helper exists in this file or anywhere
 * else), and the counted-games door is a real link, never an `onClick` that
 * mutates page state.
 *
 * ## Task 1's decision (recorded in full in 39.1-19-SUMMARY.md)
 *
 * UI-SPEC §13.13a's checkpoint — whether `claim=<Insight.id>` joins Phase
 * 38's drill-down contract — was ACCEPTED by the owner (Option A) before any
 * source file in this plan was touched. `DD09_CLAIM_AXIS_ACCEPTED` below
 * records that decision.
 *
 * ## Plan 39.1-22 (gap closure, orchestrator Finding 8): all 17, not 10
 *
 * `windowExpressible` USED to be read here off the registry to decide "in
 * scope" for the counted-games door — plan 39.1-19 gave only the 11 (later
 * 10, per CR-A05) `windowExpressible: true` templates an exact door, because
 * reconstructing a game set from `[window.fromMs, window.toMs]` + identity
 * axes cannot express a non-contiguous selection (post-streak spots,
 * in-session buckets, high-volume months, a pooled pocket group, a
 * main-vs-secondary pairing, one opponent's share of losses, an
 * online/offline split).
 *
 * Plan 39.1-22 closes that gap at the SOURCE instead of at this consumer:
 * every template now records `Insight.countedMatchIds` — the exact ids of
 * the games it counted — at the site it already iterates them
 * (`packages/shared/src/insight/templates/*.ts`). This module no longer
 * needs `windowExpressible`, `matchesDrillDown`, or a window/axis
 * reconstruction at all: `buildInsightDoors` emits the games door whenever
 * `countedMatchIds.length > 0`, and `resolveInsightClaim` is a plain id-set
 * lookup. Exactness is a property of CONSTRUCTION (proven once, per
 * template, by `countedGames.test.ts`) rather than of RECONSTRUCTION (proven
 * per-consumer, with a timestamp-tie trim as a defensive patch) — so the
 * tied-timestamp edge case UI-SPEC §13.13 named no longer needs a trim step:
 * the recorded id set was never ambiguous about which side of a tie it
 * meant.
 */

/** Task 1's decision (see the module doc comment above). */
export const DD09_CLAIM_AXIS_ACCEPTED = true;

export interface InsightDoorDescriptor {
  kind: InsightDoorKind;
  href: string;
  count: number;
}

/**
 * `InsightDoor.axes` (the engine's own record) is keyed by the SAME literal
 * URL param names `drillDownParams.ts` exports (`fighter`, `vs`, `stage`,
 * `event`) — this is the one, narrow conversion into `DrillDownAxes`'s
 * camelCase shape, so every href in this file still funnels through the
 * ONE search builder rather than a second one.
 */
function doorAxesToDrillDownAxes(axes: InsightDoor['axes']): Partial<DrillDownAxes> {
  const result: Partial<DrillDownAxes> = {};
  const fighter = axes[DRILL_DOWN_FIGHTER_PARAM];
  if (typeof fighter === 'number') {
    result.fighterId = fighter;
  }
  const vs = axes[DRILL_DOWN_VS_PARAM];
  if (typeof vs === 'number') {
    result.vsFighterId = vs;
  }
  const stage = axes[DRILL_DOWN_STAGE_PARAM];
  if (typeof stage === 'number') {
    result.stageId = stage;
  }
  const event = axes[DRILL_DOWN_EVENT_PARAM];
  if (typeof event === 'string') {
    result.eventKey = event;
  }
  const from = axes[DRILL_DOWN_FROM_PARAM];
  if (typeof from === 'number') {
    result.from = from;
  }
  const to = axes[DRILL_DOWN_TO_PARAM];
  if (typeof to === 'number') {
    result.to = to;
  }
  return result;
}

/**
 * Ported, not imported, from `insight/horizon.ts`'s private `eventKeyOf` /
 * `lastEventRecap.ts`'s identically-ported copy — `eventName` takes
 * priority, `tournamentName` is the fallback, an empty/whitespace name reads
 * as "no event". `matchesDrillDown`'s `eventKey` axis is inert without an
 * `eventKeyForMatch` resolver (it defaults to "never matches" — the same
 * tolerant-absence behavior every other unresolved axis gets), so
 * `resolveInsightClaim` supplies this ONE resolver for every window-
 * expressible template's `event=` axis (today, only `lastEventRecap`'s).
 */
export function eventKeyOf(match: Match): string | undefined {
  const raw = match.eventName ?? match.tournamentName;
  if (raw == null) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The counted-games door's href: same-route, query-only (`?claim=...#games`,
 * UI-SPEC §10.3) — never routed through `subjectPath`, which requires an
 * ABSOLUTE personal path as input. A query-only string handed to
 * `subjectPath` would be misread as a pathless path and get a subject
 * prefix PREPENDED to it, navigating away from the current route entirely
 * (the opposite of "the same route with axes + #games").
 *
 * Plan 39.1-24 (gap closure, Task 2): `anchor` defaults to `'#games'` (every
 * existing caller's behaviour, unchanged) but a host whose terminus lives
 * under a differently-named scroll anchor (Matchups' `#matchup-table` —
 * Phase 38's own drill-down tests reference that id, so it is never
 * renamed) can override it. The anchor is purely a same-page scroll target;
 * it never changes which games the resolver returns.
 *
 * Plan 39.1-26 (gap closure): `carry` is the host's own context — the params
 * the host's insight input was computed over (a Matchups pairing, the hub's
 * `context`/`source`/`vs` chips) — never a filter axis. This is what makes
 * the door survive being followed from a URL-seeded state: since this href
 * is a plain relative `?...` string (never routed through `setSearchParams`,
 * which merges), a bare `<Link to="?claim=...#anchor">` REPLACES the entire
 * search string on navigation, dropping anything not carried forward. The
 * five drill-down FILTER params (stage/event/from/to/claim) are always
 * dropped from `carry` — a door must never smuggle a stale filter axis or a
 * foreign claim id through — and the claim is always THIS insight's own id.
 */
function buildGamesDoorHref(insight: Insight, anchor = '#games', carry?: URLSearchParams): string {
  const params = new URLSearchParams(carry ?? undefined);
  params.delete(DRILL_DOWN_STAGE_PARAM);
  params.delete(DRILL_DOWN_EVENT_PARAM);
  params.delete(DRILL_DOWN_FROM_PARAM);
  params.delete(DRILL_DOWN_TO_PARAM);
  params.delete(DRILL_DOWN_CLAIM_PARAM);
  for (const [key, value] of buildDrillDownSearch({ claimId: insight.id }).entries()) {
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}${anchor}` : anchor;
}

const FALLBACK_ROUTE_BY_KIND: Partial<Record<InsightDoorKind, string>> = {
  matchup: '/matchups',
  opponent: '/matchups',
};

function buildFallbackDoor(
  door: InsightDoor,
  subjectPath: (personalPath: string) => string,
): InsightDoorDescriptor | null {
  const route = FALLBACK_ROUTE_BY_KIND[door.kind];
  if (route == null) {
    return null;
  }
  const search = buildDrillDownSearch(doorAxesToDrillDownAxes(door.axes)).toString();
  const href = subjectPath(search ? `${route}?${search}` : route);
  return { kind: door.kind, href, count: door.count };
}

/**
 * Returns the ordered door list for one insight card (UI-SPEC §7.8's DOORS
 * row): the counted-games door (`claim=`) whenever the insight actually
 * counted at least one game (plan 39.1-22: `countedMatchIds.length > 0` —
 * never `windowExpressible`, which no longer gates anything here), followed
 * by whatever named fallback door(s) the template's OWN engine output also
 * carries (a `matchup` door for `secondaryPayoff`, an `opponent` door for
 * `matchupOrPlayer` — both stay useful alongside the exact games door now
 * that every template can have one). Never mutates persisted state — every
 * entry is a plain href a caller renders as a real `<Link>`.
 */
export function buildInsightDoors(input: {
  insight: Insight;
  subjectPath: (personalPath: string) => string;
  /** Plan 39.1-24 (gap closure, Task 2): overrides the games door's scroll anchor (default `'#games'`) — see `buildGamesDoorHref`'s doc comment. */
  anchor?: string;
  /** Plan 39.1-26 (gap closure): the host's own context to carry onto the games door — see `buildGamesDoorHref`'s doc comment. */
  carry?: URLSearchParams;
}): InsightDoorDescriptor[] {
  const { insight, subjectPath, anchor, carry } = input;

  const fallbackDoors = insight.doors
    .map((door) => buildFallbackDoor(door, subjectPath))
    .filter((descriptor): descriptor is InsightDoorDescriptor => descriptor !== null);

  if (insight.countedMatchIds.length === 0) {
    return fallbackDoors;
  }

  const gamesDoor: InsightDoorDescriptor = {
    kind: 'games',
    href: buildGamesDoorHref(insight, anchor, carry),
    count: insight.countedMatchIds.length,
  };
  return [gamesDoor, ...fallbackDoors];
}

/**
 * Resolves a `claim=<Insight.id>` axis back to the exact games the insight
 * counted — the consumer-side half of DD-09 (this module never imports
 * anything from `drillDownParams.ts` beyond its own exports; this function
 * is what a host closes over `insights`/hands to `FilteredMatchList`'s
 * `resolveClaim` prop as
 * `(claimId, matches) => resolveInsightClaim({ claimId, insights, matches })`).
 *
 * Plan 39.1-22: a plain id-set lookup against `insight.countedMatchIds` — no
 * axis reconstruction, no window bound, no timestamp-tie trim. Exactness is
 * a property of how the template BUILT `countedMatchIds` (proven once, per
 * template, by `packages/shared`'s `countedGames.test.ts`), not of how this
 * consumer reconstructs a candidate set from `matches`. Returns the counted
 * matches in `countedMatchIds`' own recorded (newest-first) order — a plain
 * `matches.filter(...)` would instead follow `matches`' OWN order, which a
 * caller is never required to have pre-sorted.
 *
 * Returns `undefined` (never throws) for an unknown id or an insight with an
 * empty `countedMatchIds` (nothing to resolve to) — `matchesDrillDown`'s own
 * "tolerant absence" rule, applied one layer up. An id present in
 * `countedMatchIds` but absent from the caller's own `matches` array (a
 * stale/partial load) is silently skipped, never a throw and never a
 * fabricated `Match`.
 */
export function resolveInsightClaim(input: {
  claimId: string;
  insights: Insight[];
  matches: Match[];
}): Match[] | undefined {
  const { claimId, insights, matches } = input;
  const insight = insights.find((candidate) => candidate.id === claimId);
  if (!insight || insight.countedMatchIds.length === 0) {
    return undefined;
  }

  const byId = new Map(matches.map((match) => [match.id, match] as const));
  const resolved: Match[] = [];
  for (const id of insight.countedMatchIds) {
    const match = byId.get(id);
    if (match) {
      resolved.push(match);
    }
  }
  return resolved;
}
