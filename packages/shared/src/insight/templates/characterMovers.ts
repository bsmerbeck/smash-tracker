import type { Match } from '../../match.js';
import { SpriteList } from '../../fighterData.js';
import { isUnknownCharacter } from '../../evidence/predicate.js';
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

const TEMPLATE_ID = 'characterMovers' as const;
/** UI-SPEC §7.8: a card's inline MARK holds at most this many dumbbell rows. */
const MAX_MARK_ROWS = 4;

/** A `const` Map built once from static roster data — an immutable derived constant, not a cache (mirrors `evidence/predicate.ts`'s `KNOWN_FIGHTER_IDS`). */
const FIGHTER_NAME_BY_ID = new Map<number, string>(
  SpriteList.map((fighter) => [fighter.id, fighter.name]),
);

function fighterNameFor(id: number): string {
  return FIGHTER_NAME_BY_ID.get(id) ?? String(id);
}

interface CharacterMoverMarkRow {
  opponentFighterId: number;
  fighter: string;
  recentRecord: string;
  baselineRecord: string;
  chip: 'up' | 'down' | 'steady' | 'thin' | 'locked';
}

interface CharacterCandidate {
  opponentFighterId: number;
  matches: Match[];
  recentRate: RateValue;
  baselineRate: RateValue;
  window: InsightWindow;
  state: InsightState;
  kind: Insight['kind'];
  deltaPoints: number | null;
}

/** Groups a scope's matches by opponent CHARACTER (`opponent_id`), excluding `isUnknownCharacter` rows — the same D-09/EVID-11 exclusion `evidence/matchupEvidence.ts` applies before grouping. */
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

function buildCandidates(
  scopedMatches: Match[],
  horizon: HorizonKey,
  nowMs: number,
): CharacterCandidate[] {
  const groups = groupByOpponentCharacter(scopedMatches);
  const candidates: CharacterCandidate[] = [];
  for (const [opponentFighterId, groupMatches] of groups) {
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
      // Neither characterMovers nor rivalMovers carries an actionable suggestion
      // (UI-SPEC §9.4 lists only up/down/steady/thinRecent/locked) — never `suggestion`.
      hasAction: false,
    });
    candidates.push({
      opponentFighterId,
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

function moverSortKey(candidate: CharacterCandidate): number {
  if (candidate.deltaPoints !== null) {
    return Math.abs(candidate.deltaPoints);
  }
  return Math.abs(Math.round((candidate.recentRate.rate - candidate.baselineRate.rate) * 100));
}

function chipFor(state: InsightState, deltaPoints: number | null): CharacterMoverMarkRow['chip'] {
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

function toMarkRow(candidate: CharacterCandidate): CharacterMoverMarkRow {
  return {
    opponentFighterId: candidate.opponentFighterId,
    fighter: fighterNameFor(candidate.opponentFighterId),
    recentRecord: `${candidate.recentRate.wins}–${candidate.recentRate.losses}`,
    baselineRecord: `${candidate.baselineRate.wins}–${candidate.baselineRate.losses}`,
    chip: chipFor(candidate.state, candidate.deltaPoints),
  };
}

function byOpponentFighterIdAsc(a: CharacterCandidate, b: CharacterCandidate): number {
  return a.opponentFighterId - b.opponentFighterId;
}

function buildCharacterMoversInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  if (scope.kind !== 'character') {
    // This template answers "vs which opponent characters is ONE of the subject's own
    // fighters moving" — it only makes sense scoped to a specific fighter. `INSIGHT_TEMPLATES`
    // is a closed registry every caller iterates at whatever scope it's invoking (account,
    // character, player, stage — engine.ts's own doc comment); declining every scope kind
    // this template doesn't apply to keeps it inert (never fabricating a cross-fighter
    // "opponent character" read) at account/player/stage scope, exactly like `formNowTemplate`
    // is inert-by-construction at scopes its own logic can't interpret.
    return null;
  }
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    // No games in this scope at all -> no card (mirrors formNow's "never an invented tick" discipline).
    return null;
  }

  const candidates = buildCandidates(scopedMatches, horizon, nowMs);
  if (candidates.length === 0) {
    return null;
  }

  const asserting = candidates.filter((c) => c.state === 'trend' || c.state === 'suggestion');
  const nonLocked = candidates.filter((c) => c.state !== 'locked');

  let headline: CharacterCandidate;
  let state: InsightState;
  let kind: Insight['kind'];
  let deltaPoints: number | null;
  let extraCopyValues: Record<string, string | number> = {};

  if (asserting.length > 0) {
    headline = [...asserting].sort((a, b) => {
      const diff = Math.abs(b.deltaPoints ?? 0) - Math.abs(a.deltaPoints ?? 0);
      return diff !== 0 ? diff : byOpponentFighterIdAsc(a, b);
    })[0]!;
    state = headline.state;
    kind = headline.kind;
    deltaPoints = headline.deltaPoints;
  } else if (nonLocked.length === 0) {
    headline = [...candidates].sort(
      (a, b) => b.recentRate.total - a.recentRate.total || byOpponentFighterIdAsc(a, b),
    )[0]!;
    state = 'locked';
    kind = 'fact';
    deltaPoints = null;
  } else {
    headline = [...nonLocked].sort(
      (a, b) => b.recentRate.total - a.recentRate.total || byOpponentFighterIdAsc(a, b),
    )[0]!;
    if (headline.state === 'thinRecent' || headline.state === 'thin') {
      // D-15: the strongest available candidate's scoped window is under the medium tier.
      state = 'thinRecent';
    } else {
      // `steady` and `collapsed` both fold into the aggregate `steady` line (D-14): a direction-free
      // fact either way, and the closed non-assertive set (`insights.characterMovers.<state>`,
      // §9.4) has no `collapsed` variant for this card.
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
    .sort((a, b) => moverSortKey(b) - moverSortKey(a) || byOpponentFighterIdAsc(a, b))
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
        fighter: fighterNameFor(headline.opponentFighterId),
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
        count: headline.recentRate.total,
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
        axes: { ...(scope.axes ?? {}), vs: headline.opponentFighterId },
        count: headline.window.games,
      },
    ],
    ...(mark !== undefined ? { mark } : {}),
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };

  return insight;
}

/**
 * "vs which characters is form moving" (owner note 12, D-12, D-15). One
 * `Insight` per scope, headlined by the single strongest asserting mover (if
 * any), carrying up to `MAX_MARK_ROWS` dumbbell rows for the rest.
 * `windowExpressible: true`: the headline's games are a contiguous
 * per-character scoped window, reproducible from the existing drill-down axes
 * (UI-SPEC §13.13a).
 */
export const characterMoversTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'character',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildCharacterMoversInsight(input);
    return insight === null ? [] : [insight];
  },
};
