import type { Match } from '../match.js';
import { computeRatingHistory, splitIntoSessions, type RatingPeriodResult } from '../glicko.js';
import { resolveWindow, toRateValue } from './horizon.js';
import { MARK_BOUND_HEAT_CELLS, MARK_BOUND_LINE_POINTS } from './markBounds.js';
import { calendarBucketBounds, type CalendarGrain } from './periodSeries.js';
import { SUGGESTION_MIN_GAMES, TREND_MIN_RECENT_GAMES } from './policy.js';
import type { HorizonKey, InsightWindow, RateValue } from './types.js';

/**
 * Plan 39.1-34 (owner decision 2026-09-25, D-13, UI-SPEC §11 + §12.1): the
 * career timeline's engine. ONE pure function bins everything the Trends
 * career timeline draws — the close-of-period rating line (session → week →
 * month → quarter → year, the finest grain whose close count fits the line
 * bound) and the two month-resolution strips (rate vs the account's own
 * baseline, games) — so the chart layer never bins (UI-SPEC §11). Calendar
 * buckets come from `calendarBucketBounds`, the ONE UTC calendar rule
 * `buildPeriodSeries` also keys by.
 */

/** Below this many games the timeline is the named locked state — the removed chart.js Rating Curve's own unlock threshold (`RATING_CURVE_UNLOCK_THRESHOLD`). */
export const CAREER_TIMELINE_MIN_GAMES = 5;

/** Sketch 002's "the year grid appears after 6 months": fewer distinct months with games than this is the thin state (no strips, a per-session line). */
export const CAREER_TIMELINE_MIN_STRIP_MONTHS = 6;

/** UI-SPEC §12.1 "below a 520px plot the strips re-grain to quarters": the narrow strip cell bound, `MARK_BOUND_HEAT_CELLS` / 3 (108 / 3 — quarters instead of months). */
export const CAREER_TIMELINE_NARROW_STRIP_CELLS = 36;

/** Sketch 002's `stepFor` / UI-SPEC §12.1: the rate strip's step edges, in points of win rate away from the account's own baseline (steps 1..4 per arm). */
export const CAREER_TIMELINE_RATE_STEP_EDGES = [1, 3, 6, 10] as const;

/** UI-SPEC §12.1: the games strip's sequential steps (5-step blue by the square root of n). */
export const CAREER_TIMELINE_GAMES_STEPS = 5;

/** The rating line's ladder, finest first. */
export type CareerRatingGrain = 'session' | CalendarGrain;

/** The strips' ladder grains. */
export type CareerStripGrain = 'month' | 'quarter' | 'year';

export type CareerTimelineState = 'full' | 'thin' | 'locked';

/** Why a rate cell's step is not the raw step its delta earns — `null` when it is. */
export type CareerRateStepReason = 'belowFloor' | 'capped' | null;

const RATING_LADDER: readonly CareerRatingGrain[] = ['session', 'week', 'month', 'quarter', 'year'];
const WIDE_STRIP_LADDER: readonly CareerStripGrain[] = ['month', 'quarter', 'year'];
const NARROW_STRIP_LADDER: readonly CareerStripGrain[] = ['quarter', 'year'];

/** One close on the rating line. */
export interface CareerRatingPoint {
  /** `session:<firstGameMs>` at session grain, else the calendar bucket's period key (e.g. `quarter:2024-Q3`). */
  key: string;
  /** Locale-independent — an ISO date at session grain, the bucket label (`2024-Q3`) otherwise. The UI renders it. */
  label: string;
  /** The period's own span: a session's first game (inclusive) to its last game + 1, or the calendar bucket's `[start, end)`. */
  startMs: number;
  endMs: number;
  /** When the closing session ended (its last game) — the point's x on the time axis. */
  closeMs: number;
  /** The rating / RD at the close of the LAST session ending inside the period. */
  rating: number;
  rd: number;
  /** The period's games by game time — exactly the games with `time` in `[startMs, endMs)`. */
  wins: number;
  losses: number;
  total: number;
  /** True when at least one whole calendar period with no games separates this point from the previous one — the line breaks there. */
  gapBefore: boolean;
}

export interface CareerRatingSeries {
  grain: CareerRatingGrain;
  points: CareerRatingPoint[];
  current: { rating: number; rd: number } | null;
  peakIndex: number | null;
  lowIndex: number | null;
  lastIndex: number | null;
  /** Rated sessions (Glicko rating periods) the line summarises. */
  sessionCount: number;
  /** The next-finer grain's point count that exceeded the line bound (the caption's "a monthly line would draw N points"), `null` at session grain. */
  finerGrainPointCount: number | null;
}

/** The rating line's close in force at a strip cell. */
export interface CareerRatingAtClose {
  key: string;
  label: string;
  rating: number;
  rd: number;
}

export interface CareerStripCell {
  key: string;
  label: string;
  startMs: number;
  /** Exclusive. */
  endMs: number;
  wins: number;
  losses: number;
  total: number;
  rate: number;
  /** `round((rate - baseline) x 1000) / 10` — points vs the account's own baseline, one decimal. */
  deltaPoints: number;
  /** -4..4 (sign = above / below the baseline). */
  rateStep: number;
  rateStepReason: CareerRateStepReason;
  /** 1..5. */
  gamesStep: number;
  ratingAtClose: CareerRatingAtClose | null;
}

export interface CareerStripSet {
  grain: CareerStripGrain;
  cells: CareerStripCell[];
  maxTotal: number;
}

export interface CareerTimeline {
  state: CareerTimelineState;
  /** First game to last game — `null` without games. */
  domain: { startMs: number; endMs: number } | null;
  baseline: RateValue;
  rating: CareerRatingSeries;
  /** Both strip ladders — the kit only picks by measured plot width. `null` unless `state` is `'full'`. */
  strips: { wide: CareerStripSet; narrow: CareerStripSet } | null;
  /** The active horizon's recent window (the band on the plot) — the SAME `InsightWindow` `resolveWindow` returns. */
  recentWindow: InsightWindow | null;
  /** Games still needed before the timeline unlocks (0 once it has). */
  gamesNeeded: number;
}

export interface BuildCareerTimelineOptions {
  matches: Match[];
  horizon: HorizonKey;
  nowMs: number;
}

/**
 * Sketch 002's `stepFor`: the rate cell's diverging step. A cell under
 * `TREND_MIN_RECENT_GAMES` (the medium confidence tier, 8) is neutral with no
 * step ('belowFloor'); a cell under `SUGGESTION_MIN_GAMES` (the high tier, 20)
 * is capped at step 2 ('capped') — colour asserts a direction, so it borrows
 * the insight engine's confidence tiers, never new thresholds.
 */
export function careerRateStep(input: { deltaPoints: number; total: number }): {
  step: number;
  reason: CareerRateStepReason;
} {
  const { deltaPoints, total } = input;
  if (total < TREND_MIN_RECENT_GAMES) {
    return { step: 0, reason: 'belowFloor' };
  }
  const magnitude = Math.abs(deltaPoints);
  let step = 0;
  for (const edge of CAREER_TIMELINE_RATE_STEP_EDGES) {
    if (magnitude >= edge) step += 1;
  }
  let reason: CareerRateStepReason = null;
  if (total < SUGGESTION_MIN_GAMES && step > 2) {
    step = 2;
    reason = 'capped';
  }
  return { step: deltaPoints < 0 && step > 0 ? -step : step, reason };
}

/** Floating-point slack so a cell at exactly 1/25, 4/25, … of the busiest total lands on its own step, not the next. */
const GAMES_STEP_EPSILON = 1e-9;

/** UI-SPEC §12.1: the games cell's sequential step, 1..5 by the square root of its share of the busiest cell. */
export function careerGamesStep(input: { total: number; maxTotal: number }): number {
  const { total, maxTotal } = input;
  if (maxTotal <= 0) return 1;
  const raw = CAREER_TIMELINE_GAMES_STEPS * Math.sqrt(total / maxTotal);
  return Math.min(CAREER_TIMELINE_GAMES_STEPS, Math.max(1, Math.ceil(raw - GAMES_STEP_EPSILON)));
}

interface SessionClose {
  firstMs: number;
  lastMs: number;
  games: Match[];
  period: RatingPeriodResult;
}

function recordOf(games: Match[]): { wins: number; losses: number; total: number } {
  const wins = games.filter((m) => m.win).length;
  return { wins, losses: games.length - wins, total: games.length };
}

function sessionPoints(closes: SessionClose[]): CareerRatingPoint[] {
  return closes.map((close) => ({
    key: `session:${close.firstMs}`,
    label: new Date(close.firstMs).toISOString(),
    startMs: close.firstMs,
    endMs: close.lastMs + 1,
    closeMs: close.lastMs,
    rating: close.period.rating,
    rd: close.period.rd,
    ...recordOf(close.games),
    gapBefore: false,
  }));
}

/** Calendar grain: the close of the LAST session ending in each bucket; the W-L of the bucket's games by game time. */
function calendarPoints(
  grain: CalendarGrain,
  closes: SessionClose[],
  matches: Match[],
): CareerRatingPoint[] {
  const lastCloseByKey = new Map<string, SessionClose>();
  for (const close of closes) {
    lastCloseByKey.set(calendarBucketBounds(grain, close.lastMs).key, close);
  }
  const recordByKey = new Map<string, { wins: number; losses: number }>();
  for (const match of matches) {
    const key = calendarBucketBounds(grain, match.time).key;
    const record = recordByKey.get(key) ?? { wins: 0, losses: 0 };
    if (match.win) record.wins += 1;
    else record.losses += 1;
    recordByKey.set(key, record);
  }
  const points: CareerRatingPoint[] = [];
  for (const close of lastCloseByKey.values()) {
    const bounds = calendarBucketBounds(grain, close.lastMs);
    const record = recordByKey.get(bounds.key) ?? { wins: 0, losses: 0 };
    points.push({
      key: bounds.key,
      label: bounds.label,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      closeMs: close.lastMs,
      rating: close.period.rating,
      rd: close.period.rd,
      wins: record.wins,
      losses: record.losses,
      total: record.wins + record.losses,
      gapBefore: false,
    });
  }
  return points.sort((a, b) => a.startMs - b.startMs);
}

function pointsForGrain(
  grain: CareerRatingGrain,
  closes: SessionClose[],
  matches: Match[],
): CareerRatingPoint[] {
  return grain === 'session' ? sessionPoints(closes) : calendarPoints(grain, closes, matches);
}

function buildRatingSeries(matches: Match[]): CareerRatingSeries {
  const history = computeRatingHistory(matches);
  // `computeRatingHistory` maps sessions 1:1 onto rating periods through the
  // same `splitIntoSessions` rule (3h gap), so the two zip by index.
  const sessions = splitIntoSessions(matches);
  const closes: SessionClose[] = sessions.map((games, i) => ({
    firstMs: games[0]!.time,
    lastMs: games[games.length - 1]!.time,
    games,
    period: history.periods[i]!,
  }));

  let grain: CareerRatingGrain = RATING_LADDER[0]!;
  let points: CareerRatingPoint[] = [];
  for (const candidate of RATING_LADDER) {
    grain = candidate;
    points = pointsForGrain(candidate, closes, matches);
    if (points.length <= MARK_BOUND_LINE_POINTS) break;
  }

  let peakIndex: number | null = null;
  let lowIndex: number | null = null;
  points.forEach((point, i) => {
    if (peakIndex === null || point.rating > points[peakIndex]!.rating) peakIndex = i;
    if (lowIndex === null || point.rating < points[lowIndex]!.rating) lowIndex = i;
  });

  return {
    grain,
    points,
    current: history.current ? { rating: history.current.rating, rd: history.current.rd } : null,
    peakIndex,
    lowIndex,
    lastIndex: points.length > 0 ? points.length - 1 : null,
    sessionCount: sessions.length,
    finerGrainPointCount: null,
  };
}

function stripCellsForGrain(
  grain: CareerStripGrain,
  matches: Match[],
  baselineRate: number,
): CareerStripSet {
  const byKey = new Map<
    string,
    { key: string; label: string; startMs: number; endMs: number; wins: number; losses: number }
  >();
  for (const match of matches) {
    const bounds = calendarBucketBounds(grain, match.time);
    const cell = byKey.get(bounds.key) ?? { ...bounds, wins: 0, losses: 0 };
    if (match.win) cell.wins += 1;
    else cell.losses += 1;
    byKey.set(bounds.key, cell);
  }
  const raw = [...byKey.values()].sort((a, b) => a.startMs - b.startMs);
  const maxTotal = raw.reduce((max, cell) => Math.max(max, cell.wins + cell.losses), 0);
  const cells: CareerStripCell[] = raw.map((cell) => {
    const total = cell.wins + cell.losses;
    const rate = total > 0 ? cell.wins / total : 0;
    const deltaPoints = Math.round((rate - baselineRate) * 1000) / 10;
    const { step, reason } = careerRateStep({ deltaPoints, total });
    return {
      key: cell.key,
      label: cell.label,
      startMs: cell.startMs,
      endMs: cell.endMs,
      wins: cell.wins,
      losses: cell.losses,
      total,
      rate,
      deltaPoints,
      rateStep: step,
      rateStepReason: reason,
      gamesStep: careerGamesStep({ total, maxTotal }),
      ratingAtClose: null,
    };
  });
  return { grain, cells, maxTotal };
}

function stripSetFromLadder(
  ladder: readonly CareerStripGrain[],
  bound: number,
  matches: Match[],
  baselineRate: number,
): CareerStripSet {
  let set = stripCellsForGrain(ladder[0]!, matches, baselineRate);
  for (const grain of ladder) {
    set = stripCellsForGrain(grain, matches, baselineRate);
    if (set.cells.length <= bound) break;
  }
  return set;
}

/**
 * VIZ-01 / UI-SPEC §12.1: bins an account's games into the career timeline
 * — the chart never bins. Pure over `matches` (never mutated); memoise at the
 * call site by the matches array reference.
 */
export function buildCareerTimeline(options: BuildCareerTimelineOptions): CareerTimeline {
  const { matches, horizon, nowMs } = options;
  const baseline = toRateValue(matches);
  const gamesNeeded = Math.max(0, CAREER_TIMELINE_MIN_GAMES - matches.length);

  if (matches.length < CAREER_TIMELINE_MIN_GAMES) {
    return {
      state: 'locked',
      domain:
        matches.length > 0
          ? {
              startMs: Math.min(...matches.map((m) => m.time)),
              endMs: Math.max(...matches.map((m) => m.time)),
            }
          : null,
      baseline,
      rating: {
        grain: 'session',
        points: [],
        current: null,
        peakIndex: null,
        lowIndex: null,
        lastIndex: null,
        sessionCount: 0,
        finerGrainPointCount: null,
      },
      strips: null,
      recentWindow: null,
      gamesNeeded,
    };
  }

  let startMs = matches[0]!.time;
  let endMs = matches[0]!.time;
  const months = new Set<string>();
  for (const match of matches) {
    if (match.time < startMs) startMs = match.time;
    if (match.time > endMs) endMs = match.time;
    months.add(calendarBucketBounds('month', match.time).key);
  }
  const state: CareerTimelineState =
    months.size < CAREER_TIMELINE_MIN_STRIP_MONTHS ? 'thin' : 'full';

  const rating = buildRatingSeries(matches);
  const strips =
    state === 'full'
      ? {
          wide: stripSetFromLadder(
            WIDE_STRIP_LADDER,
            MARK_BOUND_HEAT_CELLS,
            matches,
            baseline.rate,
          ),
          narrow: stripSetFromLadder(
            NARROW_STRIP_LADDER,
            CAREER_TIMELINE_NARROW_STRIP_CELLS,
            matches,
            baseline.rate,
          ),
        }
      : null;

  const { window } = resolveWindow({ matches, horizon, scoped: false, nowMs });

  return {
    state,
    domain: { startMs, endMs },
    baseline,
    rating,
    strips,
    recentWindow: window.games > 0 ? window : null,
    gamesNeeded,
  };
}
