import type { Match } from '../match.js';
import {
  ABSTENTION_FLOOR_GAMES,
  confidenceTierFor,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
} from '../evidence/policy.js';
import type { EvidenceClaim, SampleMeta } from '../evidence/types.js';
import { RECENT_GAME_WINDOW, RECENT_DAY_WINDOW, SCOPED_RECENCY_MONTHS } from './policy.js';
import type { HorizonKey, InsightWindow, RateValue } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Average month length used for the D-15 12-month scoped bound — a fixed 30-day month keeps the arithmetic simple and avoids calendar-boundary edge cases; a day either way at 12 months has no product-visible effect. */
const MS_PER_SCOPED_MONTH = 30 * MS_PER_DAY;

/**
 * Review finding WR-A04: ties break on the match's own stable `id` (never
 * caller-supplied array order), mirroring `periodSeries.ts`'s `sortPoints`
 * discipline — so a reordered-but-otherwise-identical `Match[]` (a realistic
 * case for bulk-logged manual entries or a start.gg set whose games share
 * one API timestamp) always resolves to the SAME `last30`/window slice.
 */
function byTimeAsc(a: Match, b: Match): number {
  if (a.time !== b.time) {
    return a.time - b.time;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The real first/last game timestamp in `matches`, or `{ fromMs: null, toMs: null }` for an empty window — never a synthesised or `Date.now()` fallback. */
export function matchDateRange(matches: Match[]): { fromMs: number | null; toMs: number | null } {
  if (matches.length === 0) {
    return { fromMs: null, toMs: null };
  }
  let fromMs = matches[0]!.time;
  let toMs = matches[0]!.time;
  for (const match of matches) {
    if (match.time < fromMs) fromMs = match.time;
    if (match.time > toMs) toMs = match.time;
  }
  return { fromMs, toMs };
}

/**
 * Ported, not imported, from `evidence/eventSeries.ts`'s `trimmedEventKey` —
 * kept isolated inside this new module so `insight/` never depends on
 * `evidence/eventSeries.ts` (39.1-PATTERNS.md §1's "ported, not imported"
 * convention, applied here to keep the whole insight engine self-contained
 * in its own directory). `eventName` takes priority, `tournamentName` is the
 * fallback; an empty/whitespace name reads as "no event".
 */
function eventKeyOf(match: Match): string | null {
  const raw = match.eventName ?? match.tournamentName;
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The games belonging to whichever named event key has the most recent game in `matches` — the `lastEvent` horizon. A history with no named event anywhere (manual-only) yields `[]`, never a fabricated event. */
function lastEventGames(matches: Match[]): Match[] {
  let latestKey: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const match of matches) {
    const key = eventKeyOf(match);
    if (key === null) {
      continue;
    }
    if (match.time > latestTime) {
      latestTime = match.time;
      latestKey = key;
    }
  }
  if (latestKey === null) {
    return [];
  }
  return matches.filter((match) => eventKeyOf(match) === latestKey);
}

/** D-15: intersects `matches` with the last `SCOPED_RECENCY_MONTHS` months relative to `nowMs`. */
function withinScopedRecency(matches: Match[], nowMs: number): Match[] {
  const floorMs = nowMs - SCOPED_RECENCY_MONTHS * MS_PER_SCOPED_MONTH;
  return matches.filter((match) => match.time >= floorMs);
}

/**
 * Resolves one `HorizonKey` window over `matches` (D-06). `last30` = the
 * most recent `RECENT_GAME_WINDOW` countable games in scope; `lastEvent` =
 * the games of the most recent tournament event key in scope; `last90` =
 * games inside `RECENT_DAY_WINDOW` days of `nowMs`. When `scoped` is true,
 * the last `SCOPED_RECENCY_MONTHS` months are intersected FIRST (D-15),
 * before any horizon-specific slicing. `matches` need not already be sorted
 * by time — this function sorts its own working copy.
 */
export function resolveWindow(input: {
  matches: Match[];
  horizon: HorizonKey;
  scoped: boolean;
  nowMs: number;
}): { window: InsightWindow; matches: Match[] } {
  const { horizon, scoped, nowMs } = input;
  const sorted = [...input.matches].sort(byTimeAsc);
  const base = scoped ? withinScopedRecency(sorted, nowMs) : sorted;

  let windowed: Match[];
  if (horizon === 'last30') {
    windowed = base.slice(-RECENT_GAME_WINDOW);
  } else if (horizon === 'lastEvent') {
    windowed = lastEventGames(base);
  } else {
    const floorMs = nowMs - RECENT_DAY_WINDOW * MS_PER_DAY;
    windowed = base.filter((match) => match.time >= floorMs);
  }

  const { fromMs, toMs } = matchDateRange(windowed);
  const window: InsightWindow = { horizon, fromMs, toMs, games: windowed.length, scoped };
  return { window, matches: windowed };
}

/** A pure win/loss/total/rate aggregate over `matches` — `rate` is `0` for an empty input, never `NaN`. */
export function toRateValue(matches: Match[]): RateValue {
  let wins = 0;
  let losses = 0;
  for (const match of matches) {
    if (match.win) {
      wins += 1;
    } else {
      losses += 1;
    }
  }
  const total = wins + losses;
  return { wins, losses, total, rate: total > 0 ? wins / total : 0 };
}

/**
 * Wraps a `RateValue` in the `EvidenceClaim<RateValue>` shape every
 * `Insight.recent`/`Insight.baseline` field carries (D-11) — `abstained`
 * below `ABSTENTION_FLOOR_GAMES`, `evidenced` otherwise. `claimType` is
 * always `'fact'`: a recent/baseline win-loss record is the raw count
 * itself, unranked (D-11) — ranking/direction lives in `Insight.kind`, set
 * separately by `ladder.ts`'s `classify`.
 */
export function buildRateClaim(input: {
  rate: RateValue;
  refreshedAt: number;
  dateRange: { fromMs: number | null; toMs: number | null };
}): EvidenceClaim<RateValue> {
  const { rate, refreshedAt, dateRange } = input;
  const sample: SampleMeta = {
    rawSampleSize: rate.total,
    eligibleDenominator: rate.total,
    knownFieldCoverage: rate.total > 0 ? 1 : 0,
    dateRange:
      dateRange.fromMs !== null && dateRange.toMs !== null
        ? { firstMs: dateRange.fromMs, lastMs: dateRange.toMs }
        : null,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(rate.total),
  };
  if (rate.total < ABSTENTION_FLOOR_GAMES) {
    return {
      kind: 'abstained',
      claimType: 'fact',
      reason: 'insufficient-sample',
      sample,
      gamesNeeded: Math.max(0, ABSTENTION_FLOOR_GAMES - rate.total),
    };
  }
  return { kind: 'evidenced', claimType: 'fact', value: rate, sample };
}
