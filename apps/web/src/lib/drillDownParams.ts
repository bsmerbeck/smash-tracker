import { UNKNOWN_STAGE_ID, type Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';

/**
 * Phase 38 (D-05/D-07): the ONE module declaring every drill-down URL param
 * this milestone uses, and the ONE tolerant reader for them. Every drill-down
 * producer (`MatchupMatrix`, `MatchupChart`, `CounterpickAdvisor`, the hub
 * page in plan 38-05, the stage page in plan 38-06) writes through
 * `buildDrillDownSearch`; every terminus (`FilteredMatchList`) narrows
 * through `matchesDrillDown` fed by `readDrillDownParams`. A sibling of
 * `analyzeOpponent.ts` rather than an extension of it — that module carries
 * OPPONENT IDENTITY (who), these params carry drill-down FILTER axes (which
 * games), and the filter axes apply with no opponent at all (e.g. a bare
 * stage narrowing on the Matchups page).
 *
 * The six params, in one place so the contract is readable without hunting
 * across every producer:
 *
 * - `fighter` — the user's own character (numeric SpriteList id, matching
 *   `Match.fighter_id`).
 * - `vs` — the opposing character (numeric SpriteList id, matching
 *   `Match.opponent_id`).
 * - `stage` — the stage id (numeric, matching `Match.map.id`; `0` means "no
 *   selection" and is a valid, matchable id like any other).
 * - `event` — an opaque event anchor key. The match record itself carries no
 *   stable event id, so this module never derives one — callers pass an
 *   `eventKeyForMatch` resolver to `matchesDrillDown` that maps THEIR own
 *   engine anchoring onto a match, and the same string a producer writes here
 *   must be what that resolver returns for the games it names.
 * - `from` / `to` — an INCLUSIVE date window in epoch milliseconds, matching
 *   `Match.time`. A window whose `from` equals its `to` selects every game
 *   recorded at that exact instant, deliberately — a single match id is NOT
 *   a drill-down axis (D-07 enumerates opponent, character, opposing
 *   character, stage, event and date window; a match id is not among them),
 *   so two games sharing one timestamp both appear where a match-id param
 *   would have shown only one.
 * - `claim` — plan 39.1-19 (DD-09, UI-SPEC §10.3): a stable `Insight.id`
 *   (`${templateId}:${scopeKey}:${horizon}`) naming an insight card's own
 *   counted-games door. This axis is read here EXACTLY like `event` —
 *   shape-validated only, never resolved against anything — because
 *   resolving it back to a game set requires the insight engine, which this
 *   module deliberately never imports (a sibling concern, not a drill-down
 *   filter it can express). Resolution happens at the ONE consumer,
 *   `FilteredMatchList`'s optional `resolveClaim` host-supplied prop
 *   (`apps/web/src/components/analytics/insightDoors.ts`'s
 *   `resolveInsightClaim`), applied IN ADDITION to this module's six
 *   existing axes, never inside `matchesDrillDown` itself.
 *
 * Deliberately NOT params here: range and source. Both live in the global
 * subject-scoped analytics filter (`AnalyticsFilterContext`) — carrying them
 * in a drill-down URL would mean a URL-seeded arrival could mutate that
 * persisted global filter on landing, which is exactly what D-05 forbids
 * (see the prohibition below).
 *
 * Reading these params must NEVER trigger a persisting setter — this module
 * touches no `localStorage`/`sessionStorage`, and neither does
 * `FilteredMatchList`, which owns no URL and no persisted state. Only an
 * EXPLICIT picker interaction (never a URL-seeded read) may persist a
 * selection — see `MatchupsPage.tsx`'s picker handlers for the asymmetric
 * contract this module's read side stays out of entirely.
 */

export const DRILL_DOWN_FIGHTER_PARAM = 'fighter';
export const DRILL_DOWN_VS_PARAM = 'vs';
export const DRILL_DOWN_STAGE_PARAM = 'stage';
export const DRILL_DOWN_EVENT_PARAM = 'event';
export const DRILL_DOWN_FROM_PARAM = 'from';
export const DRILL_DOWN_TO_PARAM = 'to';
export const DRILL_DOWN_CLAIM_PARAM = 'claim';

/** Resolved, validated drill-down axes — every field is either a trusted value or absent. */
export interface DrillDownAxes {
  fighterId?: number;
  vsFighterId?: number;
  stageId?: number;
  eventKey?: string;
  from?: number;
  to?: number;
  /** Plan 39.1-19 (DD-09): an `Insight.id`, shape-validated only — see this module's doc comment. */
  claimId?: string;
}

/**
 * `Insight.id` is `${templateId}:${scopeKey}:${horizon}` (camelCase template
 * ids, `scopeKey`s composed of ascii identifiers, colons and an arbitrary
 * opponent TAG for player scope — which may carry Unicode letters/digits,
 * spaces, apostrophes and a handful of separator characters, per real
 * start.gg/parry.gg tags). This is a SHAPE check only (length + character
 * class) — never a membership check against a real `Insight[]`, which lives
 * outside this module entirely (see the module doc comment's `claim` row).
 * An empty string, anything over the length cap, or any character outside
 * this allowlist resolves to "axis absent", matching every other axis's
 * tolerance rule.
 */
const CLAIM_ID_MAX_LENGTH = 300;
const CLAIM_ID_SHAPE = /^[\p{L}\p{N}_:.#@' -]+$/u;

function parseClaimAxis(raw: string | null): string | undefined {
  if (raw == null || raw === '' || raw.length > CLAIM_ID_MAX_LENGTH) {
    return undefined;
  }
  return CLAIM_ID_SHAPE.test(raw) ? raw : undefined;
}

/**
 * Base-10 parses `raw`, then applies an integer-and-finite guard, then
 * rejects any value `Number.parseInt` would have silently truncated (e.g.
 * `"3.5"` -> `3`) by re-parsing the FULL string as a `Number` and requiring
 * the two parses to agree. `null`/non-numeric/fractional/out-of-safe-range
 * input all resolve to `undefined` — never a throw, never a coerced
 * fallback. This is the ONE numeric-axis parser every axis below shares.
 */
function parseIntegerAxis(raw: string | null): number | undefined {
  if (raw == null || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return undefined;
  }
  const asNumber = Number(raw);
  if (!Number.isFinite(asNumber) || asNumber !== parsed) {
    // Fractional ("3.5"), or a string parseInt only partially consumed
    // ("3abc") — Number(raw) is NaN or disagrees with the integer parse.
    return undefined;
  }
  return parsed;
}

/**
 * Reads every drill-down axis from `searchParams`, tolerantly. A numeric
 * axis is parsed via `parseIntegerAxis` and then MEMBERSHIP-CHECKED before
 * being accepted: a character id must resolve through `getFighterById` (the
 * same lookup every fighter picker in this app already uses), and a stage id
 * must be a member of the caller-supplied `stageIds` set. An axis that fails
 * either check is simply absent from the result — never a throw, never an
 * out-of-range lookup — so a crafted or stale URL degrades to "no filter on
 * this axis" rather than a crash or a wrong-data render.
 */
export function readDrillDownParams(
  searchParams: URLSearchParams,
  { stageIds }: { stageIds: ReadonlySet<number> },
): DrillDownAxes {
  const axes: DrillDownAxes = {};

  const fighterId = parseIntegerAxis(searchParams.get(DRILL_DOWN_FIGHTER_PARAM));
  if (fighterId != null && getFighterById(fighterId) != null) {
    axes.fighterId = fighterId;
  }

  const vsFighterId = parseIntegerAxis(searchParams.get(DRILL_DOWN_VS_PARAM));
  if (vsFighterId != null && getFighterById(vsFighterId) != null) {
    axes.vsFighterId = vsFighterId;
  }

  // WR-01 (38-REVIEW-FIX): `stageId === UNKNOWN_STAGE_ID` (0) must be
  // accepted even though it is never a member of `stageIds` (the caller's
  // real-stage set — `stagesById` deliberately excludes the sentinel, per
  // this module's own doc comment above). This is the cross-tab's own
  // unknown-stage column (D-09/D-10): clicking it writes `stage=0` to narrow
  // THIS page's `FilteredMatchList` terminus to the unknown-stage subset —
  // a list-filter axis, never a `/stages/0` route (that page stays
  // unaddressable; `StageDetailPage.tsx`'s own path-segment reader,
  // `isKnownStageSegment`, already carries this exact allowance separately).
  const stageId = parseIntegerAxis(searchParams.get(DRILL_DOWN_STAGE_PARAM));
  if (stageId != null && (stageId === UNKNOWN_STAGE_ID || stageIds.has(stageId))) {
    axes.stageId = stageId;
  }

  const eventKey = searchParams.get(DRILL_DOWN_EVENT_PARAM);
  if (eventKey) {
    axes.eventKey = eventKey;
  }

  const from = parseIntegerAxis(searchParams.get(DRILL_DOWN_FROM_PARAM));
  if (from != null) {
    axes.from = from;
  }

  const to = parseIntegerAxis(searchParams.get(DRILL_DOWN_TO_PARAM));
  if (to != null) {
    axes.to = to;
  }

  const claimId = parseClaimAxis(searchParams.get(DRILL_DOWN_CLAIM_PARAM));
  if (claimId != null) {
    axes.claimId = claimId;
  }

  return axes;
}

/**
 * Builds a `URLSearchParams` from a partial axis object, omitting undefined
 * axes — the ONE place every drill-down producer writes the URL, so no two
 * producers can spell the same axis two different ways.
 */
export function buildDrillDownSearch(axes: Partial<DrillDownAxes>): URLSearchParams {
  const params = new URLSearchParams();
  if (axes.fighterId != null) {
    params.set(DRILL_DOWN_FIGHTER_PARAM, String(axes.fighterId));
  }
  if (axes.vsFighterId != null) {
    params.set(DRILL_DOWN_VS_PARAM, String(axes.vsFighterId));
  }
  if (axes.stageId != null) {
    params.set(DRILL_DOWN_STAGE_PARAM, String(axes.stageId));
  }
  if (axes.eventKey != null) {
    params.set(DRILL_DOWN_EVENT_PARAM, axes.eventKey);
  }
  if (axes.from != null) {
    params.set(DRILL_DOWN_FROM_PARAM, String(axes.from));
  }
  if (axes.to != null) {
    params.set(DRILL_DOWN_TO_PARAM, String(axes.to));
  }
  if (axes.claimId != null) {
    params.set(DRILL_DOWN_CLAIM_PARAM, axes.claimId);
  }
  return params;
}

/**
 * The drill-down predicate: `true` when `match` satisfies every axis
 * present in `axes` (an axis that is `undefined` matches everything). Stage
 * comparison uses the numeric bucket id (`match.map?.id ?? 0`) so an unknown
 * stage compares consistently with the engine's own "0 = no selection"
 * convention. The window is INCLUSIVE at both ends. `eventKeyForMatch` is an
 * optional per-match resolver the HOST supplies — this module never derives
 * an event key itself, since the match record carries no stable event id.
 */
export function matchesDrillDown(
  match: Match,
  axes: DrillDownAxes,
  eventKeyForMatch?: (match: Match) => string | undefined,
): boolean {
  if (axes.fighterId != null && match.fighter_id !== axes.fighterId) {
    return false;
  }
  if (axes.vsFighterId != null && match.opponent_id !== axes.vsFighterId) {
    return false;
  }
  if (axes.stageId != null && (match.map?.id ?? 0) !== axes.stageId) {
    return false;
  }
  if (axes.eventKey != null) {
    const key = eventKeyForMatch ? eventKeyForMatch(match) : undefined;
    if (key !== axes.eventKey) {
      return false;
    }
  }
  if (axes.from != null && match.time < axes.from) {
    return false;
  }
  if (axes.to != null && match.time > axes.to) {
    return false;
  }
  return true;
}

/**
 * The single newest-first ordering every drill-down terminus assumes: sorted
 * by descending `time`, with an ASCENDING `id` tiebreak for equal
 * timestamps. This is NEW behaviour authored here, not an inherited
 * property — `MatchupTable.tsx`'s pre-Phase-38 sort (`b.time - a.time`) had
 * no tiebreak at all, so equal timestamps merely kept whatever order the
 * input array happened to already be in (V8's stable sort), which is not
 * reproducible across a differently-ordered source array. Every host that
 * feeds `FilteredMatchList` calls this ONE helper before handing its array
 * over, so there is exactly one place a regression in the tiebreak can be
 * introduced. Returns a new array; never mutates `matches`.
 */
export function sortMatchesNewestFirst(matches: Match[]): Match[] {
  return [...matches].sort((a, b) => {
    if (b.time !== a.time) {
      return b.time - a.time;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
