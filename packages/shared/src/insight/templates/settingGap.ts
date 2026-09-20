import type { Match } from '../../match.js';
import { isNotableCohortGap } from '../twoProportion.js';
import { toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import { COHORT_MIN_SIDE_GAMES } from '../policy.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'settingGap' as const;

interface SettingPartition {
  online: Match[];
  offline: Match[];
  unspecified: Match[];
}

/**
 * Mirrors `apps/web/src/lib/stats.ts`'s `getOnlineOfflineSplit` byte-for-byte
 * (ported, not imported — `apps/web` is out of reach from
 * `packages/shared`): `quickplay` and any `online*` type count as online,
 * any `offline*` type counts as offline, everything else (`none`, `''`,
 * absent) is unspecified.
 */
function partitionBySetting(matches: Match[]): SettingPartition {
  const online: Match[] = [];
  const offline: Match[] = [];
  const unspecified: Match[] = [];
  for (const match of matches) {
    const type = match.matchType ?? '';
    if (type === 'quickplay' || type.startsWith('online')) {
      online.push(match);
    } else if (type.startsWith('offline')) {
      offline.push(match);
    } else {
      unspecified.push(match);
    }
  }
  return { online, offline, unspecified };
}

function buildSettingGapInsight(input: {
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

  const { online, offline } = partitionBySetting(scopedMatches);
  const onlineRate = toRateValue(online);
  const offlineRate = toRateValue(offline);

  let state: Insight['state'];
  let kind: Insight['kind'] = 'fact';
  let deltaPoints: number | null = null;
  let gamesNeeded: number | undefined;

  if (online.length === 0 || offline.length === 0) {
    // Zero games on a side: the "thin window" branch — never a fabricated
    // 100%/0% split (T-39.1-04-02). Distinct from "some games but below the
    // notability floor" below.
    state = 'thin';
  } else if (online.length < COHORT_MIN_SIDE_GAMES || offline.length < COHORT_MIN_SIDE_GAMES) {
    state = 'locked';
    const shortCount = Math.min(online.length, offline.length);
    gamesNeeded = Math.max(0, COHORT_MIN_SIDE_GAMES - shortCount);
  } else if (
    isNotableCohortGap(
      { wins: onlineRate.wins, total: onlineRate.total },
      { wins: offlineRate.wins, total: offlineRate.total },
    )
  ) {
    deltaPoints = Math.round((onlineRate.rate - offlineRate.rate) * 100);
    state = 'trend';
    kind = 'inference';
  } else {
    state = 'steady';
  }

  // Cohort order is FIXED (online is always side A) — the values object is
  // always built with every online-prefixed key before every
  // offline-prefixed key, regardless of which side is actually ahead
  // (must_have: "independent of which side is ahead").
  const values: Record<string, string | number> = {};
  if (online.length > 0) {
    values.onlineRate = `${Math.round(onlineRate.rate * 100)}%`;
    values.onlineRecord = `${onlineRate.wins}–${onlineRate.losses}`;
  }
  values.onlineCount = onlineRate.total;
  if (offline.length > 0) {
    values.offlineRate = `${Math.round(offlineRate.rate * 100)}%`;
    values.offlineRecord = `${offlineRate.wins}–${offlineRate.losses}`;
  }
  values.offlineCount = offlineRate.total;
  values.shortSide = online.length <= offline.length ? 'online' : 'offline';
  values.points = deltaPoints !== null ? Math.abs(deltaPoints) : 0;
  if (gamesNeeded !== undefined) {
    values.count = gamesNeeded;
  }

  const direction = deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  const key =
    state === 'trend' ? `insights.${TEMPLATE_ID}.${direction}` : `insights.${TEMPLATE_ID}.${state}`;

  const dateRange = matchDateRange(scopedMatches);
  // Cohort A ("recent" slot) is always online, cohort B ("baseline" slot)
  // is always offline — same fixed order as `values` above.
  const recentClaim = buildRateClaim({ rate: onlineRate, refreshedAt: nowMs, dateRange });
  const baselineClaim = buildRateClaim({ rate: offlineRate, refreshedAt: nowMs, dateRange });

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  const insight: Insight = {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind,
    state,
    recent: recentClaim,
    baseline: baselineClaim,
    deltaPoints,
    window: {
      horizon,
      fromMs: dateRange.fromMs,
      toMs: dateRange.toMs,
      games: online.length + offline.length,
      scoped: false,
    },
    salience: 0,
    copy: { key, values },
    doors: [],
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };

  return insight;
}

/**
 * `SettingGap` (TRND-02, DD-12): online vs offline win rate, a two-proportion
 * cohort comparison — never the D-07 recency ladder. `windowExpressible:
 * true`: a setting cohort is a contiguous scoped window (the current horizon
 * intersected with a matchType filter) the existing drill-down axes express
 * (UI-SPEC §13.13a).
 */
export const settingGapTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildSettingGapInsight(input);
    return insight === null ? [] : [insight];
  },
};
