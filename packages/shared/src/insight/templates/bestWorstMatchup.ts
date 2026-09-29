import type { Match } from '../../match.js';
import { getFighterById } from '../../fighterData.js';
import { isUnknownCharacter } from '../../evidence/predicate.js';
import { ABSTENTION_FLOOR_GAMES } from '../../evidence/policy.js';
import { wilsonLowerBound } from '../../evidence/rank.js';
import { toRateValue, matchDateRange, buildRateClaim, countedMatchIdsOf } from '../horizon.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

/** Review finding CR-A03: mirrors `secondaryPayoff.ts`/`rosterCore.ts`'s identical helper (duplicated locally per this codebase's small-helper-duplication convention) — resolves a fighter id to its display name before it ever reaches `copy.values`, never a raw numeric id. */
function fighterNameFor(id: number): string {
  return getFighterById(id)?.name ?? String(id);
}

/** Groups a scope's matches by opponent CHARACTER, excluding `isUnknownCharacter` rows — mirrors `characterMovers.ts`'s identical helper (no shared file between the two; both templates duplicate this small grouping loop independently per this plan's own action text). */
function groupByOpponentCharacter(matches: Match[]): Map<number, Match[]> {
  const groups = new Map<number, Match[]>();
  for (const match of matches) {
    if (isUnknownCharacter(match)) {
      continue;
    }
    const existing = groups.get(match.opponent_id);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.opponent_id, [match]);
    }
  }
  return groups;
}

interface MatchupCandidate {
  opponentFighterId: number;
  matches: Match[];
  rate: RateValue;
}

function buildCandidates(scopedMatches: Match[]): MatchupCandidate[] {
  const groups = groupByOpponentCharacter(scopedMatches);
  const candidates: MatchupCandidate[] = [];
  for (const [opponentFighterId, groupMatches] of groups) {
    candidates.push({ opponentFighterId, matches: groupMatches, rate: toRateValue(groupMatches) });
  }
  return candidates;
}

function byOpponentFighterIdAsc(a: MatchupCandidate, b: MatchupCandidate): number {
  return a.opponentFighterId - b.opponentFighterId;
}

type BackfillTemplateId = 'bestMatchup' | 'worstMatchup';

/** Best: rank by the wins-side Wilson lower bound. Worst: rank by the losses-side Wilson lower bound (its complement) — so a lucky small sample never outranks a proven large one on EITHER side. */
function rankEligible(eligible: MatchupCandidate[], rankWinsSide: boolean): MatchupCandidate {
  const ranked = [...eligible].sort((a, b) => {
    const scoreOf = (c: MatchupCandidate): number =>
      rankWinsSide
        ? wilsonLowerBound(c.rate.wins, c.rate.total)
        : wilsonLowerBound(c.rate.losses, c.rate.total);
    const diff = scoreOf(b) - scoreOf(a);
    return diff !== 0 ? diff : byOpponentFighterIdAsc(a, b);
  });
  return ranked[0]!;
}

function buildLockedInsight(input: {
  templateId: BackfillTemplateId;
  candidates: MatchupCandidate[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight {
  const { templateId, candidates, scope, horizon, nowMs } = input;
  const best = [...candidates].sort(
    (a, b) => b.rate.total - a.rate.total || byOpponentFighterIdAsc(a, b),
  )[0];
  const bestTotal = best?.rate.total ?? 0;
  const gamesNeeded = Math.max(0, ABSTENTION_FLOOR_GAMES - bestTotal);
  const emptyRate: RateValue = { wins: 0, losses: 0, total: 0, rate: 0 };
  const claim = buildRateClaim({
    rate: emptyRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: null, toMs: null },
  });
  return {
    id: `${templateId}:${scope.key}:${horizon}`,
    templateId,
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state: 'locked',
    recent: claim,
    baseline: claim,
    deltaPoints: null,
    window: { horizon, fromMs: null, toMs: null, games: 0, scoped: false },
    salience: 0,
    copy: { key: `insights.${templateId}.locked`, values: {} },
    doors: [],
    countedMatchIds: [],
    gamesNeeded,
  };
}

function buildFactInsight(input: {
  templateId: BackfillTemplateId;
  winner: MatchupCandidate;
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight {
  const { templateId, winner, scope, horizon, nowMs } = input;
  const claim = buildRateClaim({
    rate: winner.rate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(winner.matches),
  });

  return {
    id: `${templateId}:${scope.key}:${horizon}`,
    templateId,
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state: 'fact',
    recent: claim,
    baseline: claim,
    deltaPoints: null,
    window: {
      horizon,
      fromMs: matchDateRange(winner.matches).fromMs,
      toMs: matchDateRange(winner.matches).toMs,
      games: winner.rate.total,
      scoped: false,
    },
    salience: 0,
    copy: {
      key: `insights.${templateId}.fact`,
      values: {
        vs: fighterNameFor(winner.opponentFighterId),
        record: `${winner.rate.wins}–${winner.rate.losses}`,
        count: winner.rate.total,
      },
    },
    doors: [
      {
        kind: 'games',
        axes: { ...(scope.axes ?? {}), vs: winner.opponentFighterId },
        count: winner.rate.total,
      },
    ],
    // Plan 39.1-22: this matchup's own games — the same set `winner.rate.total` counts.
    countedMatchIds: countedMatchIdsOf(winner.matches),
  };
}

/**
 * Plan 39.1-40 (D-14, INS-01, INS-04): the scope-agnostic Best / Toughest
 * record core — the wins-side / losses-side Wilson lower-bound ranking over
 * opponent characters with at least `ABSTENTION_FLOOR_GAMES` games
 * (fighter-id tie-break), a locked pair when nothing is eligible. The best
 * candidate is built once; the toughest is OMITTED when its winner is the
 * same opponent character as the best (a Best and a Toughest card never name
 * the same opponent on any rail). Returns `[]` for a scope with no games.
 * The Trends reads rail calls this at ACCOUNT_SCOPE (`trendsReads.ts`); the
 * two templates below keep their character-scope guard and delegate here.
 */
export function buildMatchupBackfillInsights(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight[] {
  const { matches, scope, horizon, nowMs } = input;
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return [];
  }
  const candidates = buildCandidates(scopedMatches);
  const eligible = candidates.filter((c) => c.rate.total >= ABSTENTION_FLOOR_GAMES);
  if (eligible.length === 0) {
    return (['bestMatchup', 'worstMatchup'] as const).map((templateId) =>
      buildLockedInsight({ templateId, candidates, scope, horizon, nowMs }),
    );
  }
  const best = rankEligible(eligible, true);
  const worst = rankEligible(eligible, false);
  const insights = [
    buildFactInsight({ templateId: 'bestMatchup', winner: best, scope, horizon, nowMs }),
  ];
  if (worst.opponentFighterId !== best.opponentFighterId) {
    insights.push(
      buildFactInsight({ templateId: 'worstMatchup', winner: worst, scope, horizon, nowMs }),
    );
  }
  return insights;
}

function buildTemplateEntry(input: {
  templateId: BackfillTemplateId;
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight[] {
  const { templateId, ...rest } = input;
  if (rest.scope.kind !== 'character') {
    return [];
  }
  return buildMatchupBackfillInsights(rest).filter((insight) => insight.templateId === templateId);
}

/**
 * D-14 back-fill fact: the best-record matchup by Wilson lower bound (never a raw rate, so a
 * lucky 5-0 can't outrank a proven 41-6). `assertsDirection: false`; `windowExpressible: true`
 * (its games are a contiguous per-character scoped set).
 */
export const bestMatchupTemplate: InsightTemplate = {
  id: 'bestMatchup',
  scopeKind: 'character',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    return buildTemplateEntry({ ...input, templateId: 'bestMatchup' });
  },
};

/** D-14 back-fill fact: the worst-record matchup by the losses-side Wilson lower bound — omitted when it would name the best record's opponent (plan 39.1-40). */
export const worstMatchupTemplate: InsightTemplate = {
  id: 'worstMatchup',
  scopeKind: 'character',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    return buildTemplateEntry({ ...input, templateId: 'worstMatchup' });
  },
};
