import {
  INSIGHT_TEMPLATES,
  type Insight,
  type InsightDoor,
  type InsightDoorKind,
  type Match,
} from '@smash-tracker/shared';
import {
  buildDrillDownSearch,
  matchesDrillDown,
  sortMatchesNewestFirst,
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_VS_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_TO_PARAM,
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
 * records that decision; only the ACCEPTED branch is implemented (the
 * REJECTED branch's window-widening mechanism is intentionally absent code,
 * per the plan's own "the executor changes Task 2's implementation branch...
 * nothing else").
 *
 * ## Which templates get the counted-games door (a documented plan
 * correction — see the SUMMARY's "Deviations from Plan")
 *
 * `windowExpressible` — read HERE off the registry, never a hand-written
 * template-id list — decides "in scope" for BOTH branches identically. This
 * differs from UI-SPEC §13.13a's ACCEPTED-branch prose ("the guard covers
 * every template — all 17"): the six non-window-expressible templates
 * (`tiltCost`, `sessionFatigue`, `volumeForm`, `secondaryPayoff`,
 * `pocketCost`, `matchupOrPlayer`) ALREADY ship, from plans 39.1-03/04/05,
 * with their own `insight.doors` hard-coded to the REJECTED-branch fallback
 * doors (a `matchup` door, an `opponent` door, or none) — see each file's
 * own doc comment (e.g. `tiltCost.ts`: "plan 39.1-19 gives this template a
 * fallback route door instead"). Reconstructing an EXACT game set for these
 * six from a `claim=` id would require duplicating each template's own
 * bespoke selection algorithm (a post-streak-spot walk, a session-bucket
 * split, a main-vs-secondary pairing, …) outside the engine module that owns
 * it — forbidden by this plan's own `files_modified` scope (no
 * `packages/shared` file is touched) and by this codebase's "no page
 * computes these outside the engine" convention. So: `claim=` IS accepted
 * into the contract (Tasks 2/3 below prove it resolves exactly for the
 * eleven window-expressible templates, including the tied-timestamp edge
 * case), but this plan does not — and, without touching the six templates'
 * own files, cannot — extend it to the six. `docs/adr` follow-up: a later
 * plan revisiting those six templates could export a companion
 * "which games" resolver per template and wire it in here.
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

function templateFor(insight: Insight) {
  return INSIGHT_TEMPLATES.find((candidate) => candidate.id === insight.templateId);
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
 */
function buildGamesDoorHref(insight: Insight): string {
  const axes: Partial<DrillDownAxes> = { claimId: insight.id };
  const query = buildDrillDownSearch(axes).toString();
  return query ? `?${query}#games` : '#games';
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
 * row): the counted-games door (`claim=`) when the template is
 * `windowExpressible`, otherwise whatever named fallback door(s) the
 * template's OWN engine output already carries (matchup for
 * `secondaryPayoff`, opponent for `matchupOrPlayer`, none for
 * `tiltCost`/`sessionFatigue`/`volumeForm`/`pocketCost`). Never mutates
 * persisted state — every entry is a plain href a caller renders as a real
 * `<Link>`.
 */
export function buildInsightDoors(input: {
  insight: Insight;
  subjectPath: (personalPath: string) => string;
}): InsightDoorDescriptor[] {
  const { insight, subjectPath } = input;
  const template = templateFor(insight);
  const inScope = template?.windowExpressible ?? false;

  if (inScope) {
    return [{ kind: 'games', href: buildGamesDoorHref(insight), count: insight.window.games }];
  }

  return insight.doors
    .map((door) => buildFallbackDoor(door, subjectPath))
    .filter((descriptor): descriptor is InsightDoorDescriptor => descriptor !== null);
}

/**
 * Resolves a `claim=<Insight.id>` axis back to the predicate the insight
 * actually counted — the consumer-side half of DD-09 (this module never
 * imports anything from `drillDownParams.ts` beyond its own exports; this
 * function is what a host closes over `insights`/hands to
 * `FilteredMatchList`'s `resolveClaim` prop as
 * `(claimId, matches) => resolveInsightClaim({ claimId, insights, matches })`).
 *
 * Reuses the SAME `door.axes` the template itself already computed (an
 * identity narrowing — `fighter=`, `vs=`, `event=` — that the engine's own
 * pre-39.1-19 door mechanism already relied on to be exact) and adds the
 * insight's own recorded `[window.fromMs, window.toMs]` bound whenever the
 * door doesn't already carry an explicit `from`/`to`. When the resulting
 * candidate set is LARGER than the door's own `count` (the timestamp-tie-
 * at-the-window-edge case named by UI-SPEC §13.13), it is trimmed to
 * exactly `count` using the SAME deterministic newest-first tiebreak every
 * other drill-down terminus uses (`sortMatchesNewestFirst`) — so the
 * rendered row count always equals the door's printed number, by
 * construction, regardless of which side of the tie the reconstruction
 * lands on.
 *
 * Returns `undefined` (never throws) for an unknown id, a non-window-
 * expressible template, or an insight with no games door — `matchesDrillDown`'s
 * own tolerance rule, applied one layer up.
 */
export function resolveInsightClaim(input: {
  claimId: string;
  insights: Insight[];
  matches: Match[];
}): Match[] | undefined {
  const { claimId, insights, matches } = input;
  const insight = insights.find((candidate) => candidate.id === claimId);
  if (!insight) {
    return undefined;
  }
  const template = templateFor(insight);
  if (!template?.windowExpressible) {
    return undefined;
  }

  const gamesDoor = insight.doors.find((door) => door.kind === 'games');
  const baseAxes = gamesDoor ? doorAxesToDrillDownAxes(gamesDoor.axes) : {};
  const axes: Partial<DrillDownAxes> = {
    ...baseAxes,
    ...(baseAxes.from == null && insight.window.fromMs != null
      ? { from: insight.window.fromMs }
      : {}),
    ...(baseAxes.to == null && insight.window.toMs != null ? { to: insight.window.toMs } : {}),
  };
  const expectedCount = gamesDoor?.count ?? insight.window.games;

  const candidates = matches.filter((match) => matchesDrillDown(match, axes, eventKeyOf));
  if (candidates.length <= expectedCount) {
    return candidates;
  }
  return sortMatchesNewestFirst(candidates).slice(0, expectedCount);
}
