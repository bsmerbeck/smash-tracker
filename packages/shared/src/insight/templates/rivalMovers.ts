import type { Match } from '../../match.js';
import { resolveOpponentIdentities } from '../../evidence/opponentEvidence.js';
import { ABSTENTION_FLOOR_GAMES, CONFIDENCE_TIER_BOUNDS } from '../../evidence/policy.js';
import { resolveWindow, toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import { classify } from '../ladder.js';
import type {
  HorizonKey,
  Insight,
  InsightMark,
  InsightScope,
  InsightState,
  InsightWindow,
  RateValue,
} from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'rivalMovers' as const;
/** UI-SPEC §7.8: a card's inline MARK holds at most this many dumbbell rows. */
const MAX_MARK_ROWS = 4;

interface RivalMoverMarkRow {
  identity: string;
  displayTag: string;
  recentRecord: string;
  baselineRecord: string;
  chip: 'up' | 'down' | 'steady' | 'thin' | 'locked';
}

interface RivalCandidate {
  identity: string;
  displayTag: string;
  matches: Match[];
  recentRate: RateValue;
  baselineRate: RateValue;
  window: InsightWindow;
  state: InsightState;
  kind: Insight['kind'];
  deltaPoints: number | null;
}

/**
 * Groups a scope's matches by RESOLVED opponent identity (`resolveOpponentIdentities`,
 * declared in `evidence/opponentEvidence.ts` — never `identity.ts`, which holds only the
 * alias-chain walker and `normalizeOpponentTag`, T-39.1-03-02) rather than the raw tag, so
 * two tags bound to the same start.gg/parry.gg id collapse into one rival. `InsightTemplate.build`
 * carries no `aliasMap` parameter in this wave (declared in plan 39.1-01's `registry.ts`, which
 * this plan does not edit) — every call resolves through an EMPTY alias map. This still runs the
 * real resolver (canonicalisation + slug/parry-id binding still apply, satisfying the mitigation);
 * only a user's own manually-configured merges are unavailable until a later wiring plan threads a
 * real map through `computeInsights`. Machine-key identities (`sgg:`/`pgg:` with no bound tag, and
 * the bare `'unknown'` identity) have no human display tag and are excluded — the same `unnamed`-
 * bucket treatment `evidence/opponentEvidence.ts`'s `buildOpponentEvidence` gives them.
 */
function groupByOpponentIdentity(matches: Match[]): Map<string, Match[]> {
  const resolve = resolveOpponentIdentities(matches, {});
  const groups = new Map<string, Match[]>();
  for (const match of matches) {
    const identity = resolve(match);
    if (identity === 'unknown' || identity.startsWith('sgg:') || identity.startsWith('pgg:')) {
      continue;
    }
    const existing = groups.get(identity);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(identity, [match]);
    }
  }
  return groups;
}

/** A simple, deterministic display tag: the first non-empty stored `opponent` tag among the group's matches, falling back to the identity itself. Not a byte-for-byte port of `opponentEvidence.ts`'s private `pickDisplayTag` (not exported) — engine copy display is not a tested cross-file invariant. */
function pickDisplayTag(identity: string, matches: Match[]): string {
  for (const match of matches) {
    if (match.opponent) {
      return match.opponent;
    }
  }
  return identity;
}

function buildCandidates(
  scopedMatches: Match[],
  horizon: HorizonKey,
  nowMs: number,
): RivalCandidate[] {
  const groups = groupByOpponentIdentity(scopedMatches);
  const candidates: RivalCandidate[] = [];
  for (const [identity, groupMatches] of groups) {
    const baselineRate = toRateValue(groupMatches);
    // D-15: the recent window is scoped — bounded to the last 12 months BEFORE the last-30 slice.
    const { window, matches: recentMatches } = resolveWindow({
      matches: groupMatches,
      horizon,
      scoped: true,
      nowMs,
    });
    const recentRate = toRateValue(recentMatches);
    const { state, kind, deltaPoints } = classify({
      recent: recentRate,
      baseline: baselineRate,
      scoped: true,
      hasAction: false,
    });
    candidates.push({
      identity,
      displayTag: pickDisplayTag(identity, groupMatches),
      matches: groupMatches,
      recentRate,
      baselineRate,
      window,
      state,
      kind,
      deltaPoints,
    });
  }
  return candidates;
}

function moverSortKey(candidate: RivalCandidate): number {
  if (candidate.deltaPoints !== null) {
    return Math.abs(candidate.deltaPoints);
  }
  return Math.abs(Math.round((candidate.recentRate.rate - candidate.baselineRate.rate) * 100));
}

function chipFor(state: InsightState, deltaPoints: number | null): RivalMoverMarkRow['chip'] {
  if (state === 'trend' || state === 'suggestion') {
    return deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  }
  if (state === 'locked') {
    return 'locked';
  }
  if (state === 'thin' || state === 'thinRecent') {
    return 'thin';
  }
  return 'steady';
}

function toMarkRow(candidate: RivalCandidate): RivalMoverMarkRow {
  return {
    identity: candidate.identity,
    displayTag: candidate.displayTag,
    recentRecord: `${candidate.recentRate.wins}–${candidate.recentRate.losses}`,
    baselineRecord: `${candidate.baselineRate.wins}–${candidate.baselineRate.losses}`,
    chip: chipFor(candidate.state, candidate.deltaPoints),
  };
}

function byIdentityAsc(a: RivalCandidate, b: RivalCandidate): number {
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

function buildRivalMoversInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  if (scope.kind !== 'character') {
    // Mirrors characterMoversTemplate's guard: this card also runs on the Fighter-hero
    // rail, scoped to ONE of the subject's own fighters, grouping internally by opponent
    // PLAYER identity rather than opponent character.
    return null;
  }
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return null;
  }

  const candidates = buildCandidates(scopedMatches, horizon, nowMs);
  if (candidates.length === 0) {
    return null;
  }

  const asserting = candidates.filter((c) => c.state === 'trend' || c.state === 'suggestion');
  const nonLocked = candidates.filter((c) => c.state !== 'locked');

  let headline: RivalCandidate;
  let state: InsightState;
  let kind: Insight['kind'];
  let deltaPoints: number | null;
  let extraCopyValues: Record<string, string | number> = {};

  if (asserting.length > 0) {
    headline = [...asserting].sort((a, b) => {
      const diff = Math.abs(b.deltaPoints ?? 0) - Math.abs(a.deltaPoints ?? 0);
      return diff !== 0 ? diff : byIdentityAsc(a, b);
    })[0]!;
    state = headline.state;
    kind = headline.kind;
    deltaPoints = headline.deltaPoints;
  } else if (nonLocked.length === 0) {
    headline = [...candidates].sort(
      (a, b) => b.recentRate.total - a.recentRate.total || byIdentityAsc(a, b),
    )[0]!;
    state = 'locked';
    kind = 'fact';
    deltaPoints = null;
  } else {
    headline = [...nonLocked].sort(
      (a, b) => b.recentRate.total - a.recentRate.total || byIdentityAsc(a, b),
    )[0]!;
    if (headline.state === 'thinRecent' || headline.state === 'thin') {
      state = 'thinRecent';
    } else {
      state = 'steady';
      extraCopyValues = {
        count: nonLocked.filter((c) => c.recentRate.total >= CONFIDENCE_TIER_BOUNDS.medium).length,
      };
    }
    kind = 'fact';
    deltaPoints = null;
  }

  const recentClaim = buildRateClaim({
    rate: headline.recentRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: headline.window.fromMs, toMs: headline.window.toMs },
  });
  const baselineClaim = buildRateClaim({
    rate: headline.baselineRate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(headline.matches),
  });

  const gamesNeeded =
    state === 'locked'
      ? Math.max(0, ABSTENTION_FLOOR_GAMES - headline.recentRate.total)
      : undefined;

  const markSource = nonLocked.length > 0 ? nonLocked : candidates;
  const markCandidates = [...markSource]
    .sort((a, b) => moverSortKey(b) - moverSortKey(a) || byIdentityAsc(a, b))
    .slice(0, MAX_MARK_ROWS);
  const mark: InsightMark | undefined =
    markCandidates.length > 0
      ? { kind: 'dumbbell', data: markCandidates.map(toMarkRow) }
      : undefined;

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  const direction = deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  const copyKey =
    state === 'trend' || state === 'suggestion'
      ? `insights.${TEMPLATE_ID}.${direction}`
      : `insights.${TEMPLATE_ID}.${state}`;

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
    window: headline.window,
    salience: 0,
    copy: {
      key: copyKey,
      values: {
        opponent: headline.displayTag,
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
        // Review finding CR-A02: `insights.rivalMovers.locked_one/_other`
        // reads `{{count}}` as "how many MORE games are needed" — must be
        // `gamesNeeded`, never the games already played.
        count: state === 'locked' ? gamesNeeded! : headline.recentRate.total,
        recentRecord: `${headline.recentRate.wins}–${headline.recentRate.losses}`,
        baselineRate: `${Math.round(headline.baselineRate.rate * 100)}%`,
        baselineGames: headline.baselineRate.total,
        ...(headline.window.fromMs !== null
          ? { from: new Date(headline.window.fromMs).toISOString() }
          : {}),
        ...(headline.window.toMs !== null
          ? { to: new Date(headline.window.toMs).toISOString() }
          : {}),
        ...extraCopyValues,
      },
    },
    doors: [
      {
        kind: 'games',
        axes: { ...(scope.axes ?? {}), vs: headline.displayTag },
        count: headline.window.games,
      },
    ],
    ...(mark !== undefined ? { mark } : {}),
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };

  return insight;
}

/**
 * "vs which opponents is form moving" — the opponent-PLAYER sibling of
 * `characterMoversTemplate` (Task 2). `windowExpressible: true`: the
 * headline's games are a contiguous per-opponent scoped window.
 */
export const rivalMoversTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'character',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildRivalMoversInsight(input);
    return insight === null ? [] : [insight];
  },
};
