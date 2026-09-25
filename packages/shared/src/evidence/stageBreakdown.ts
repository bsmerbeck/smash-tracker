import type { Match } from '../match.js';
import { groupMatchesByKey } from './opponentCrossTab.js';
import { resolveOpponentIdentities, type UnnamedBucket } from './opponentEvidence.js';
import { isCountableGame, stageBucketId } from './predicate.js';
import {
  confidenceTierFor,
  effectiveFloor,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
} from './policy.js';
import { gateBySampleSize } from './gate.js';
import { rankByWilson } from './rank.js';
import { describeCohort, type CohortComposition } from './cohort.js';
import type { ConfidenceTier, SampleMeta } from './types.js';

/**
 * DRL-01/D-09/D-16: one per-stage breakdown, grouping the SAME "group by
 * key, count a `WinLossRecord`, attach a `SampleMeta`" shape
 * `opponentCrossTab.ts` (Task 1) already factored into `groupMatchesByKey` —
 * imported here, not restated. Groups on `stageBucketId(match)` and is
 * alias-map-independent except for its by-opponent rows, where the one
 * identity hop (`resolveOpponentIdentities`, `opponentEvidence.ts`) applies.
 * This module's grouping key is deliberately NOT the same as
 * `stageEvidence.ts`'s: that family groups a whole match set BY stage to
 * rank stages against each other; this module groups the games ALREADY
 * scoped to ONE stage id by opponent identity and by character pairing.
 *
 * Best/worst claims are gated (`gateBySampleSize`) BEFORE they are ranked
 * (`rankByWilson`) — never the reverse (36 D-12, 38-RESEARCH.md pitfall 3).
 * The "over time" region of the stage detail page is NOT a fourth return
 * field here: it calls `buildStageEventSeries` (`eventSeries.ts`, Task 2)
 * directly, so there is exactly one event-anchoring implementation.
 */

export interface StageOpponentGroup {
  identity: string;
  displayTag: string;
  wins: number;
  losses: number;
  total: number;
  confidenceTier: ConfidenceTier | null;
  sample: SampleMeta;
}

export interface StageCharacterGroup {
  /** `${myFighterId}:${theirFighterId}` — numeric ids joined by a colon. */
  key: string;
  myFighterId: number;
  theirFighterId: number;
  wins: number;
  losses: number;
  total: number;
  confidenceTier: ConfidenceTier | null;
  sample: SampleMeta;
}

export interface StageBreakdown {
  /** Ungated inventory — every resolved-identity group, including those below the floor (null tier, never omitted). */
  byOpponent: StageOpponentGroup[];
  /** `gateBySampleSize` then `rankByWilson` over `byOpponent` — the only ranked view. */
  rankedByOpponent: (StageOpponentGroup & { wilson: number })[];
  /** Ungated inventory — every character-pair group. */
  byCharacter: StageCharacterGroup[];
  /** `gateBySampleSize` then `rankByWilson` over `byCharacter`. */
  rankedByCharacter: (StageCharacterGroup & { wilson: number })[];
  /** Countable match ids for this stage, newest first. */
  matchIds: string[];
  /** Games whose opponent resolves to the engine's unnamed/machine-key identity — disclosed, never a ranked row. */
  unnamed: UnnamedBucket | null;
  cohort: CohortComposition;
  sample: SampleMeta;
}

function buildSample(matches: Match[], refreshedAt: number, floor: number): SampleMeta {
  const total = matches.length;
  const times = matches.map((m) => m.time);
  const dateRange =
    times.length > 0 ? { firstMs: Math.min(...times), lastMs: Math.max(...times) } : null;
  return {
    rawSampleSize: total,
    eligibleDenominator: total,
    knownFieldCoverage: total > 0 ? 1 : 0,
    dateRange,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: total < floor ? null : confidenceTierFor(total),
  };
}

/**
 * One stage's countable games, broken down by resolved opponent identity and
 * by character pairing — each group carrying its own `WinLossRecord`,
 * `SampleMeta` and tier (null below the floor, never omitted).
 */
export function buildStageBreakdown(input: {
  matches: Match[];
  aliasMap: Record<string, string>;
  stageId: number;
  refreshedAt: number;
  minMatches?: number;
}): StageBreakdown {
  const { matches, aliasMap, stageId, refreshedAt, minMatches } = input;
  const floor = effectiveFloor(minMatches);

  const onStage = matches.filter((m) => stageBucketId(m) === stageId);
  const countable = onStage.filter(isCountableGame);

  const resolve = resolveOpponentIdentities(matches, aliasMap);

  const namedMatches: Match[] = [];
  let unnamedGames = 0;
  let unnamedWins = 0;
  let unnamedLosses = 0;
  const unnamedIdentities = new Set<string>();
  for (const match of countable) {
    const identity = resolve(match);
    const isMachineKey = identity.startsWith('sgg:') || identity.startsWith('pgg:');
    if (isMachineKey || identity === 'unknown') {
      unnamedIdentities.add(identity);
      unnamedGames += 1;
      if (match.win) {
        unnamedWins += 1;
      } else {
        unnamedLosses += 1;
      }
    } else {
      namedMatches.push(match);
    }
  }
  const unnamed: UnnamedBucket | null =
    unnamedGames > 0
      ? {
          games: unnamedGames,
          wins: unnamedWins,
          losses: unnamedLosses,
          distinctIdentities: unnamedIdentities.size,
        }
      : null;

  const opponentGroups = groupMatchesByKey(namedMatches, (m) => resolve(m));
  const byOpponent: StageOpponentGroup[] = [...opponentGroups.entries()].map(
    ([identity, { record, matches: groupMatches }]) => ({
      identity,
      displayTag: identity,
      wins: record.wins,
      losses: record.losses,
      total: record.total,
      confidenceTier: record.total < floor ? null : confidenceTierFor(record.total),
      sample: buildSample(groupMatches, refreshedAt, floor),
    }),
  );

  const characterGroups = groupMatchesByKey(countable, (m) => `${m.fighter_id}:${m.opponent_id}`);
  const byCharacter: StageCharacterGroup[] = [...characterGroups.entries()].map(
    ([key, { record, matches: groupMatches }]) => {
      const [myStr, theirStr] = key.split(':');
      return {
        key,
        myFighterId: Number(myStr),
        theirFighterId: Number(theirStr),
        wins: record.wins,
        losses: record.losses,
        total: record.total,
        confidenceTier: record.total < floor ? null : confidenceTierFor(record.total),
        sample: buildSample(groupMatches, refreshedAt, floor),
      };
    },
  );

  const { evidenced: evidencedOpponents } = gateBySampleSize(
    byOpponent,
    (group) => group.total,
    floor,
  );
  const rankedByOpponent = rankByWilson(
    evidencedOpponents,
    (group) => group.wins,
    (group) => group.total,
    (group) => group.identity,
  );

  const { evidenced: evidencedCharacters } = gateBySampleSize(
    byCharacter,
    (group) => group.total,
    floor,
  );
  const rankedByCharacter = rankByWilson(
    evidencedCharacters,
    (group) => group.wins,
    (group) => group.total,
    (group) => group.key,
  );

  const matchIds = [...countable].sort((a, b) => b.time - a.time).map((m) => m.id);

  return {
    byOpponent,
    rankedByOpponent,
    byCharacter,
    rankedByCharacter,
    matchIds,
    unnamed,
    cohort: describeCohort(countable),
    sample: buildSample(countable, refreshedAt, floor),
  };
}
