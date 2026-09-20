import type { Match } from '../../match.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'volumeForm' as const;

/**
 * Cohort GEOMETRY, not notability policy — declared locally (never in
 * `insight/policy.ts`, plan 39.1-01's file). `VOLUME_HIGH_MONTH_THRESHOLD_MODE`
 * documents HOW the split point below is derived: the subject's OWN median
 * monthly volume, not a hardcoded games-per-month number, so the read means
 * the same thing for a 40-game account and an 8,400-game account (a fixed
 * absolute threshold would either never fire for a small account or always
 * fire for a huge one).
 */
export const VOLUME_HIGH_MONTH_THRESHOLD_MODE = 'subject-median-monthly-volume' as const;
export const VOLUME_MIN_MONTHS = 6;

/** A calendar-month key in UTC, matching `periodSeries.ts`'s own `monthKey` shape (`YYYY-MM`) — declared locally rather than imported, since that function is not exported from `periodSeries.ts`. */
function monthKeyOf(timeMs: number): string {
  const d = new Date(timeMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function bucketByMonth(matches: Match[]): Map<string, Match[]> {
  const map = new Map<string, Match[]>();
  for (const match of matches) {
    const key = monthKeyOf(match.time);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(match);
    } else {
      map.set(key, [match]);
    }
  }
  return map;
}

/** The middle value of a sorted numeric list (average of the two middles for an even-length list). */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

interface VolumeCohorts {
  monthCount: number;
  threshold: number;
  high: Match[];
  low: Match[];
}

/**
 * Splits a monthly bucketing at the subject's own median monthly volume:
 * every month whose game count is strictly greater than the median pools
 * into the "high" cohort, everything else into "low" — a genuinely
 * data-derived split point, never a hardcoded games-per-month number.
 */
function splitVolumeCohorts(matches: Match[]): VolumeCohorts {
  const monthly = bucketByMonth(matches);
  const counts = [...monthly.values()].map((bucket) => bucket.length);
  const threshold = medianOf(counts);

  const high: Match[] = [];
  const low: Match[] = [];
  for (const bucket of monthly.values()) {
    if (bucket.length > threshold) {
      high.push(...bucket);
    } else {
      low.push(...bucket);
    }
  }

  return { monthCount: monthly.size, threshold, high, low };
}

function buildVolumeFormInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return null;
  }

  const { monthCount, threshold, high, low } = splitVolumeCohorts(scopedMatches);

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;
  const dateRange = matchDateRange(scopedMatches);

  if (monthCount < VOLUME_MIN_MONTHS) {
    const gamesNeeded = VOLUME_MIN_MONTHS - monthCount;
    const highRate = toRateValue(high);
    const lowRate = toRateValue(low);
    return {
      id,
      templateId: TEMPLATE_ID,
      scopeKey,
      horizon,
      kind: 'fact',
      state: 'locked',
      recent: buildRateClaim({ rate: highRate, refreshedAt: nowMs, dateRange }),
      baseline: buildRateClaim({ rate: lowRate, refreshedAt: nowMs, dateRange }),
      deltaPoints: null,
      window: {
        horizon,
        fromMs: dateRange.fromMs,
        toMs: dateRange.toMs,
        games: high.length + low.length,
        scoped: false,
      },
      salience: 0,
      copy: {
        key: `insights.${TEMPLATE_ID}.locked`,
        values: { count: gamesNeeded, monthsNeeded: gamesNeeded, monthCount },
      },
      doors: [],
      gamesNeeded,
    };
  }

  const highRate = toRateValue(high);
  const lowRate = toRateValue(low);

  let state: Insight['state'];
  let kind: Insight['kind'];
  let deltaPoints: number | null = null;

  if (
    isNotableCohortGap(
      { wins: highRate.wins, total: highRate.total },
      { wins: lowRate.wins, total: lowRate.total },
    )
  ) {
    deltaPoints = Math.round((highRate.rate - lowRate.rate) * 100);
    state = 'trend';
    kind = 'inference';
  } else {
    state = 'steady';
    kind = 'fact';
  }

  const direction = deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  const key =
    state === 'trend' ? `insights.${TEMPLATE_ID}.${direction}` : `insights.${TEMPLATE_ID}.${state}`;

  const insight: Insight = {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind,
    state,
    recent: buildRateClaim({ rate: highRate, refreshedAt: nowMs, dateRange: matchDateRange(high) }),
    baseline: buildRateClaim({ rate: lowRate, refreshedAt: nowMs, dateRange: matchDateRange(low) }),
    deltaPoints,
    window: {
      horizon,
      fromMs: dateRange.fromMs,
      toMs: dateRange.toMs,
      games: high.length + low.length,
      scoped: false,
    },
    salience: 0,
    copy: {
      key,
      values: {
        threshold: Math.round(threshold),
        highRate: `${Math.round(highRate.rate * 100)}%`,
        lowRate: `${Math.round(lowRate.rate * 100)}%`,
        highRecord: `${highRate.wins}–${highRate.losses}`,
        lowRecord: `${lowRate.wins}–${lowRate.losses}`,
        monthCount,
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
      },
    },
    doors: [],
  };

  return insight;
}

/**
 * `VolumeForm` (TRND-02, DD-12, DD-10/DD-15's Match-type mix card): compares
 * high-volume months (above the subject's own median monthly game count)
 * against the rest. `VOLUME_HIGH_MONTH_THRESHOLD_MODE` documents the
 * data-derived (not hardcoded) split; `VOLUME_MIN_MONTHS` is this plan's
 * engineering choice, not a notability threshold. `windowExpressible:
 * false` — a high-volume month's games are a non-contiguous pooled subset
 * the existing drill-down window axes cannot reproduce (UI-SPEC §13.13a).
 */
export const volumeFormTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: false,
  build(input): Insight[] {
    const insight = buildVolumeFormInsight(input);
    return insight === null ? [] : [insight];
  },
};
