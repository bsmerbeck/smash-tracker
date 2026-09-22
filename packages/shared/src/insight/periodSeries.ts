import type { Match } from '../match.js';
import { isCountableGame } from '../evidence/predicate.js';
import { splitIntoSessions } from '../glicko.js';
import { buildSetTimeline } from '../tournamentAggregation.js';
import { ABSTENTION_FLOOR_GAMES } from './policy.js';
import { MARK_BOUND_LINE_POINTS } from './markBounds.js';

/**
 * VIZ-01 (UI-SPEC §11, §7.13): the period-series grain ladder. `The chart
 * layer never bins` — every binning decision, sub-floor flag and grain name
 * is produced here, and the chosen grain's points are final by the time a
 * component reads them (`TrendLine mode="period"` reads `PeriodSeries`
 * verbatim). Pure function over `Match[]`, memoised by array reference —
 * same discipline as `packages/shared/src/evidence/eventSeries.ts`'s
 * `buildEventSeries`. This module imports individual, stable `evidence/*`
 * modules (`predicate.ts`) directly but never `evidence/eventSeries.ts` or
 * the `evidence/index.ts` barrel (Track B isolation, `39.1-PARALLELISM.md`
 * Rule B1/B2): the `eventSession` tier PORTS (never imports) the ~15-line
 * tournament-block anchor logic `evidence/eventSeries.ts` already implements
 * for its own opponent-/stage-scoped series — see
 * `EVENT_SESSION_PROXIMITY_MS` below for the ported constant and the reason
 * it is declared here rather than in `insight/policy.ts`.
 */

/**
 * Ported (NOT imported) from `packages/shared/src/evidence/eventSeries.ts`'s
 * `EVENT_ANCHOR_PROXIMITY_MS` — kept in sync by naming that file as the
 * source of the value, never by importing it: `evidence/eventSeries.ts` is a
 * Phase-38-owned file, and the whole `insight/` engine stays inside its own
 * directory (Track B isolation, `39.1-PARALLELISM.md` Rule B1/B2). This is
 * the ported tournament-block PROXIMITY GEOMETRY this one builder needs —
 * not a notability threshold — declared here as local ported geometry
 * exactly as plan 39.1-04 declares its session geometry at the top of
 * `sessionFatigue.ts` and plan 39.1-03 declares
 * `MATCHUP_OR_PLAYER_MIN_DISTINCT_OPPONENTS` at the top of
 * `matchupOrPlayer.ts`. `packages/shared/src/insight/policy.ts` (owned by
 * plan 39.1-01) is NOT edited by this plan at all (review finding C2-M4).
 */
const EVENT_SESSION_PROXIMITY_MS = 4 * 24 * 60 * 60 * 1000;

/** The grain ladder, finest first — the order `buildPeriodSeries` walks looking for the first grain at or under its target. */
export type PeriodGrain = 'game' | 'set' | 'eventSession' | 'week' | 'month' | 'quarter' | 'year';

const PERIOD_GRAIN_LADDER: readonly PeriodGrain[] = [
  'game',
  'set',
  'eventSession',
  'week',
  'month',
  'quarter',
  'year',
];

/**
 * One bucket of countable games at one grain. `label` is a grain-appropriate,
 * LOCALE-INDEPENDENT key (e.g. `2024-Q3`, an ISO week key, an event name) —
 * the engine never localises (mirrors `Insight.copy`'s "engine never
 * localises" discipline, UI-SPEC §9.2 rule 6); the UI decides how to render
 * it. `subFloor` is true when `total < ABSTENTION_FLOOR_GAMES` — the point is
 * still emitted with its real counts, never dropped and never interpolated
 * across (UI-SPEC §11, §7.13).
 */
export interface PeriodPoint {
  grain: PeriodGrain;
  /** A stable, content-derived key — never an array index — used both to identify the point across re-renders and to break a `startMs` tie deterministically. */
  key: string;
  label: string;
  startMs: number;
  endMs: number;
  wins: number;
  losses: number;
  total: number;
  rate: number;
  subFloor: boolean;
  /**
   * CR-02 (39.1-REVIEW): the ids of exactly the countable games this point
   * counts (`total === matchIds.length`). A point's `[startMs, endMs]` is NOT
   * its identity: `eventSession`/`set` groups are not contiguous in time (an
   * interleaved Redemption bracket, an online session between pools and top
   * 8), and `game` points tie on a shared timestamp — so a drill names a
   * point by `key` and the terminus resolves membership through these ids
   * (`periodPointKeyByMatchId`), never by reconstructing a time window.
   */
  matchIds: string[];
}

/** The chosen grain's full bucketed output, plus the inputs that produced it. */
export interface PeriodSeries {
  grain: PeriodGrain;
  points: PeriodPoint[];
  target: number;
  totalGames: number;
  /**
   * True once some grain's point count reached `target`. False only when
   * even the coarsest grain (`year`) still exceeds it — a case that cannot
   * occur on any realistic account (UI-SPEC §11) but must be reported
   * truthfully (T-39.1-02-02) rather than silently over-drawing.
   */
  boundReached: boolean;
}

export interface BuildPeriodSeriesOptions {
  matches: Match[];
  /**
   * Optional caller-supplied label for the domain being plotted (e.g. an
   * `InsightScope`'s `key`/label pair from plan 39.1-01) — carried for the
   * CALLER's own bookkeeping only. `buildPeriodSeries` never uses it to
   * filter or scope `matches`: scoping a `Match[]` down to one subject stays
   * the caller's job (mirrors `InsightScope`'s "axis identity supplied at
   * the boundary" discipline). `PeriodSeries` itself carries no domain
   * field — the ladder returns the identical series shape regardless of
   * what a caller names its domain.
   */
  domain?: { label: string };
  /** Defaults to `MARK_BOUND_LINE_POINTS` — the default line-chart bound. Pass `NARROW_PLOT_TARGET` (or call `regrainFor`) for the narrow-plot path. */
  target?: number;
  /** Reserved for API-shape parity with `computeInsights(matches, horizon, nowMs)`; the ladder needs no "now" reference — a period is defined entirely by its own games' timestamps. */
  nowMs?: number;
}

function toPeriodPoint(input: {
  grain: PeriodGrain;
  key: string;
  label: string;
  matches: Match[];
}): PeriodPoint {
  const { grain, key, label, matches } = input;
  const times = matches.map((m) => m.time);
  const startMs = Math.min(...times);
  const endMs = Math.max(...times);
  const wins = matches.filter((m) => m.win).length;
  const total = matches.length;
  const losses = total - wins;
  const rate = total > 0 ? wins / total : 0;
  return {
    grain,
    key,
    label,
    startMs,
    endMs,
    wins,
    losses,
    total,
    rate,
    subFloor: total < ABSTENTION_FLOOR_GAMES,
    matchIds: matches.map((m) => m.id),
  };
}

/** One point per countable game — the finest possible grain, and the pass-through tier for a small account. */
function buildGamePoints(matches: Match[]): PeriodPoint[] {
  return matches.map((match) =>
    toPeriodPoint({
      grain: 'game',
      key: `game:${match.id}`,
      label: new Date(match.time).toISOString(),
      matches: [match],
    }),
  );
}

/** The one name-priority rule for a "tournament" match: `eventName` first, `tournamentName` as fallback — `null` for a non-tournament (manual/session) game. Ported alongside `EVENT_SESSION_PROXIMITY_MS` from `evidence/eventSeries.ts`'s `trimmedEventKey`. */
function tournamentEventName(match: Match): string | null {
  const raw = match.eventName ?? match.tournamentName;
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One session (from `splitIntoSessions`), resolved down to its own `PeriodPoint`. Sessions are disjoint, so no two share a first-game timestamp. */
function sessionToPoint(grain: PeriodGrain, group: Match[], label: string): PeriodPoint {
  const startMs = Math.min(...group.map((m) => m.time));
  return toPeriodPoint({ grain, key: `${grain}:session:${startMs}`, label, matches: group });
}

/**
 * One tournament block, resolved down to its own `PeriodPoint`. CR-02
 * (39.1-REVIEW): the key carries the event NAME as well as the block's
 * first-game timestamp — two differently named events whose first games tie
 * on one instant are two points, and a drill keyed on one must never also
 * match the other (the key used to be `eventSession:session:<startMs>` for
 * blocks too, which collided in exactly that case).
 */
function tournamentBlockToPoint(group: Match[], name: string): PeriodPoint {
  const startMs = Math.min(...group.map((m) => m.time));
  return toPeriodPoint({
    grain: 'eventSession',
    key: `eventSession:tournament:${name}:${startMs}`,
    label: name,
    matches: group,
  });
}

/**
 * Groups `matches` into sessions via the shared `glicko.ts` 3h-gap rule
 * (`splitIntoSessions`) and reduces each session to one point. Takes
 * `matches` exactly as given — the caller decides what belongs in the
 * bucket (the `set` tier's fallback passes every unparsable-externalId game;
 * the `eventSession` tier's fallback passes only the non-tournament
 * remainder), so this helper never re-derives tournament membership itself.
 */
function buildSessionPoints(matches: Match[], grain: PeriodGrain): PeriodPoint[] {
  return splitIntoSessions(matches)
    .filter((session) => session.length > 0)
    .map((session) =>
      sessionToPoint(
        grain,
        session,
        new Date(Math.min(...session.map((m) => m.time))).toISOString(),
      ),
    );
}

/**
 * `set` tier: one point per parsed `TournamentSet` (`tournamentAggregation.ts`'s
 * `buildSetTimeline`, keyed off `externalId`); games with no parsable
 * external id (`otherMatches`) fall through to the session bucket instead of
 * each becoming their own set (UI-SPEC's "an extra grouping step" caveat,
 * `39.1-RESEARCH.md` Pattern 3) — regardless of whether they also happen to
 * carry an event name; only a parseable `externalId` makes a game a "set"
 * here.
 */
function buildSetPoints(matches: Match[]): PeriodPoint[] {
  const { sets, otherMatches } = buildSetTimeline(matches);
  const setPoints = sets.map((set) =>
    toPeriodPoint({
      grain: 'set',
      key: `set:${set.setId}`,
      label: set.setId,
      matches: set.games.map((g) => g.match),
    }),
  );
  return [...setPoints, ...buildSessionPoints(otherMatches, 'set')];
}

/**
 * `eventSession` tier: games inside one tournament block (name-grouped, then
 * split wherever consecutive games exceed `EVENT_SESSION_PROXIMITY_MS`,
 * mirroring `evidence/eventSeries.ts`'s ported `splitTournamentBlocks`)
 * become one point labelled by the event key; every game carrying NO event
 * name splits into sessions by the shared session-gap rule.
 */
function buildEventSessionPoints(matches: Match[]): PeriodPoint[] {
  const byName = new Map<string, Match[]>();
  const nonTournament: Match[] = [];
  for (const match of matches) {
    const name = tournamentEventName(match);
    if (name === null) {
      nonTournament.push(match);
      continue;
    }
    const group = byName.get(name);
    if (group) {
      group.push(match);
    } else {
      byName.set(name, [match]);
    }
  }

  const blockPoints: PeriodPoint[] = [];
  for (const [name, group] of byName) {
    const sorted = [...group].sort((a, b) => a.time - b.time);
    let current: Match[] = [];
    for (const match of sorted) {
      const previous = current[current.length - 1];
      if (previous && match.time - previous.time > EVENT_SESSION_PROXIMITY_MS) {
        blockPoints.push(tournamentBlockToPoint(current, name));
        current = [match];
      } else {
        current.push(match);
      }
    }
    if (current.length > 0) {
      blockPoints.push(tournamentBlockToPoint(current, name));
    }
  }

  return [...blockPoints, ...buildSessionPoints(nonTournament, 'eventSession')];
}

/**
 * ISO 8601 week key (`YYYY-Www`), computed entirely in UTC so the key is
 * stable regardless of the reader's time zone — the standard "nearest
 * Thursday" algorithm: a week belongs to the ISO year of its Thursday.
 */
function isoWeekKey(ms: number): string {
  const date = new Date(ms);
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayNumber = utcDate.getUTCDay() || 7; // Monday=1 .. Sunday=7
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - isoDayNumber); // shift to this week's Thursday
  const isoYearStart = Date.UTC(utcDate.getUTCFullYear(), 0, 1);
  const weekNumber = Math.ceil(
    ((utcDate.getTime() - isoYearStart) / (24 * 60 * 60 * 1000) + 1) / 7,
  );
  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function quarterKey(ms: number): string {
  const d = new Date(ms);
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${quarter}`;
}

function yearKey(ms: number): string {
  return `${new Date(ms).getUTCFullYear()}`;
}

/** Groups `matches` by a UTC-derived key function into one `PeriodPoint` per distinct key. */
function buildKeyedPoints(
  matches: Match[],
  grain: PeriodGrain,
  keyOf: (ms: number) => string,
): PeriodPoint[] {
  const byKey = new Map<string, Match[]>();
  for (const match of matches) {
    const key = keyOf(match.time);
    const group = byKey.get(key);
    if (group) {
      group.push(match);
    } else {
      byKey.set(key, [match]);
    }
  }
  return [...byKey.entries()].map(([key, group]) =>
    toPeriodPoint({ grain, key: `${grain}:${key}`, label: key, matches: group }),
  );
}

function buildPointsForGrain(grain: PeriodGrain, matches: Match[]): PeriodPoint[] {
  switch (grain) {
    case 'game':
      return buildGamePoints(matches);
    case 'set':
      return buildSetPoints(matches);
    case 'eventSession':
      return buildEventSessionPoints(matches);
    case 'week':
      return buildKeyedPoints(matches, 'week', isoWeekKey);
    case 'month':
      return buildKeyedPoints(matches, 'month', monthKey);
    case 'quarter':
      return buildKeyedPoints(matches, 'quarter', quarterKey);
    case 'year':
      return buildKeyedPoints(matches, 'year', yearKey);
  }
}

/** Oldest first by `startMs`; ties break by `key` so the order is stable across runs (VIZ-01). */
function sortPoints(points: PeriodPoint[]): PeriodPoint[] {
  return [...points].sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * VIZ-01: picks the FINEST grain of `game → set → eventSession → week →
 * month → quarter → year` whose emitted point count is at or below `target`.
 * Only periods containing at least one countable game are ever emitted —
 * an empty period is absent, not zero-valued. Over zero matches, returns an
 * empty series at the finest grain (`game`) with `boundReached: true` — a
 * named grain and no synthetic period, never a throw.
 */
export function buildPeriodSeries(options: BuildPeriodSeriesOptions): PeriodSeries {
  const { matches, target = MARK_BOUND_LINE_POINTS } = options;
  void options.domain; // bookkeeping only — see `BuildPeriodSeriesOptions.domain`'s doc comment.
  void options.nowMs; // reserved for call-shape parity; unused by the ladder itself.

  const countable = matches.filter(isCountableGame);

  let chosenGrain: PeriodGrain = 'game';
  let chosenPoints: PeriodPoint[] = [];
  let boundReached = false;

  for (const grain of PERIOD_GRAIN_LADDER) {
    const points = sortPoints(buildPointsForGrain(grain, countable));
    chosenGrain = grain;
    chosenPoints = points;
    if (points.length <= target) {
      boundReached = true;
      break;
    }
  }

  return {
    grain: chosenGrain,
    points: chosenPoints,
    target,
    totalGames: countable.length,
    boundReached,
  };
}

/**
 * CR-02 (39.1-REVIEW): the ONE index from a game to the period point that
 * counts it — built from each point's own `matchIds`, never re-derived from
 * a grain rule, so a drill writing `event=<point.key>` resolves (via a
 * terminus's `eventKeyForMatch`) to exactly the `total` games that point
 * counted, on every grain. Points partition the countable games, so each id
 * maps to one key.
 */
export function periodPointKeyByMatchId(series: PeriodSeries): Map<string, string> {
  const index = new Map<string, string>();
  for (const point of series.points) {
    for (const id of point.matchIds) {
      index.set(id, point.key);
    }
  }
  return index;
}

/**
 * VIZ-01 / UI-SPEC §11 "narrow plots re-grain, they do not squeeze": a named
 * entry point for the narrow-plot path (typically called with
 * `target: NARROW_PLOT_TARGET`), so a caller reads an explicit re-grain
 * request rather than an unlabeled second call to `buildPeriodSeries`.
 * Delegates to the exact same ladder — there is only ONE binning algorithm
 * in this module, never a second, divergent one for the narrow-plot case.
 */
export function regrainFor(options: BuildPeriodSeriesOptions & { target: number }): PeriodSeries {
  return buildPeriodSeries(options);
}
