import {
  INSIGHT_TEMPLATES,
  type HorizonKey,
  type Insight,
  type InsightScope,
  type Match,
  type TierSplitStats,
} from '@smash-tracker/shared';

/** Looked up once by id from the closed registry, like every page-level template consumer. */
const TIER_GAP_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'tierGap')!;

/** `tierGap` is not a windowed read, so the horizon only completes its stable id. */
const TIER_GAP_HORIZON: HorizonKey = 'last30';

/**
 * The scope key names the side-event flag (T-39.2-38): a `side=include` claim
 * id differs from the excluded one, so a claim from one cohort can never
 * resolve against the other.
 */
export function tierScopeKey(includeSideEvents: boolean): string {
  return includeSideEvents ? 'tier:side-included' : 'tier:side-excluded';
}

/**
 * The Tournaments page's tier scope: the two cohorts `buildTierSplitStats`
 * resolved, as pure data, with a `filter` that admits exactly those games out
 * of the matches it is handed. `tierGap` reads nothing else, and it is called
 * directly, never through `computeInsights` (which would run every template
 * over this scope).
 */
export function buildTierScope(input: {
  stats: TierSplitStats;
  includeSideEvents: boolean;
}): InsightScope {
  const { stats, includeSideEvents } = input;
  const cohortIds = new Set([...stats.cohorts.a, ...stats.cohorts.b].map((match) => match.id));
  return {
    kind: 'account',
    key: tierScopeKey(includeSideEvents),
    axes: {},
    filter: (matches: Match[]) => matches.filter((match) => cohortIds.has(match.id)),
    tierCohorts: {
      a: stats.cohorts.a,
      b: stats.cohorts.b,
      aEvents: stats.cohorts.aEvents,
      bEvents: stats.cohorts.bEvents,
      estimatedEvents: stats.cohorts.estimatedEvents,
      knownEvents: stats.coverage.known,
    },
  };
}

/**
 * The page's ONE `tierGap` computation (its card and its `#games` terminus
 * share it). A template failure must not take the page down: it is logged with
 * the closed template id only (no identifiers) and the card is simply absent.
 */
export function buildTierGapInsight(input: {
  stats: TierSplitStats;
  matches: Match[];
  includeSideEvents: boolean;
  nowMs: number;
}): Insight | null {
  const { stats, matches, includeSideEvents, nowMs } = input;
  try {
    const [insight] = TIER_GAP_TEMPLATE.build({
      matches,
      scope: buildTierScope({ stats, includeSideEvents }),
      horizon: TIER_GAP_HORIZON,
      nowMs,
    });
    return insight ?? null;
  } catch {
    console.error('[tier-insight] template failed', TIER_GAP_TEMPLATE.id);
    return null;
  }
}
