import type { Match } from '../match.js';
import { isCountableGame } from '../evidence/predicate.js';
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
 * Rule B1/B2) — Task 2 below PORTS (never imports) the ~15-line
 * tournament-block anchor logic `evidence/eventSeries.ts` already implements.
 *
 * Task 1 lands the `game`/`quarter`/`month`/`year` tiers end to end; Task 2
 * lands the `set`/`eventSession`/`week` tiers.
 */

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

/**
 * Task 1 placeholder for the `set`/`eventSession`/`week` tiers: one point
 * per countable game, stamped with the requested grain name. This keeps
 * `buildPointsForGrain` exhaustive (and the ladder's game/quarter/month/year
 * path fully correct and tracer-provable) while Task 2 replaces this with
 * real set/tournament/session/week grouping. A placeholder tier's point
 * count is never smaller than the real grouped count would be, so it can
 * only ever make the ladder skip PAST it (never falsely select it) —
 * `buildPeriodSeries` never under-counts a placeholder tier into a false
 * "grain reached" result.
 */
function buildUngroupedPlaceholderPoints(matches: Match[], grain: PeriodGrain): PeriodPoint[] {
  return matches.map((match) =>
    toPeriodPoint({
      grain,
      key: `${grain}:${match.id}`,
      label: new Date(match.time).toISOString(),
      matches: [match],
    }),
  );
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
      return buildUngroupedPlaceholderPoints(matches, 'set');
    case 'eventSession':
      return buildUngroupedPlaceholderPoints(matches, 'eventSession');
    case 'week':
      return buildUngroupedPlaceholderPoints(matches, 'week');
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
