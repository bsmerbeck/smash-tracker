import type { Match } from '../match.js';
import {
  effectiveFloor,
  confidenceTierFor,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
} from './policy.js';
import { gateBySampleSize } from './gate.js';
import { rankByWilson } from './rank.js';
import { getStageRecords, type StageRecord } from './records.js';
import type { EvidenceClaim, SampleMeta, UnknownBucket } from './types.js';

/**
 * `buildStageEvidence` and `rankStagesByEvidence` take NO `aliasMap`
 * parameter (R1-BLOCKER-2). Their grouping key is `match.map?.id ?? 0` and
 * neither ever reads `match.opponent`, so rewriting an opponent tag before
 * grouping cannot move a single row — a decorative alias parameter here
 * would read as enforcement while enforcing nothing. See
 * `opponentEvidence.ts` for the axis where the alias map IS load-bearing.
 * Do not "fix" the missing parameter back in.
 */

export interface BestWorstStages {
  best: StageRecord | null;
  worst: StageRecord | null;
}

/**
 * Best and worst stage among the given matches, considering only stages
 * with at least `minMatches` recorded matches (raised to the abstention
 * floor via `effectiveFloor` — D-24, R1-HIGH-1). The unknown-stage sentinel
 * (`map.id` 0) never qualifies — it isn't an actionable recommendation.
 * Best = highest win rate, worst = lowest; ties broken by larger sample
 * size. When exactly one stage qualifies it is reported as `best` only — a
 * single stage can't be both the recommendation and the warning.
 */
export function getBestWorstStages(matches: Match[], minMatches = 3): BestWorstStages {
  const floor = effectiveFloor(minMatches);
  const qualifying = getStageRecords(matches).filter(
    (record) => record.stageId !== 0 && record.total >= floor,
  );
  if (qualifying.length === 0) {
    return { best: null, worst: null };
  }

  const sorted = [...qualifying].sort((a, b) =>
    b.winRate === a.winRate ? b.total - a.total : b.winRate - a.winRate,
  );
  const best = sorted[0] ?? null;
  const worst = sorted.length > 1 ? (sorted[sorted.length - 1] ?? null) : null;
  return { best, worst };
}

export interface RankedStage extends StageRecord {
  /** Wilson lower bound (0-1) for this stage's win rate. */
  wilson: number;
}

/**
 * Stage records ranked by Wilson lower bound (best first), gated at
 * `effectiveFloor(minMatches)` — an explicitly passed sub-floor threshold
 * cannot reopen a below-floor row (D-07, R1-HIGH-1). The unknown-stage
 * sentinel (id 0) is excluded before gating, same as before promotion.
 */
export function rankStagesByEvidence(matches: Match[], minMatches?: number): RankedStage[] {
  const floor = effectiveFloor(minMatches);
  const known = getStageRecords(matches).filter((record) => record.stageId !== 0);
  const { evidenced } = gateBySampleSize(known, (record) => record.total, floor);
  return rankByWilson(
    evidenced,
    (record) => record.wins,
    (record) => record.total,
    (record) => record.stageId,
  );
}

export interface StageEvidenceResult {
  claim: EvidenceClaim<RankedStage[]>;
  unknown: UnknownBucket | null;
}

/**
 * The one shared stage-evidence claim (EVID-10): a Wilson-ranked stage list
 * for the given pairing/scope, gated at the abstention floor, with an
 * explicit unknown-stage bucket (D-09, EVID-11) instead of a silently
 * dropped or silently pooled count. Consumed by the web Counterpick Advisor
 * via `apps/web/src/lib/stats.ts`'s re-export shim and by the API's report
 * payload assembly directly — the same function, not two implementations.
 */
export function buildStageEvidence(input: {
  matches: Match[];
  refreshedAt: number;
  minMatches?: number;
}): StageEvidenceResult {
  const { matches, refreshedAt, minMatches } = input;
  const floor = effectiveFloor(minMatches);

  const rawSampleSize = matches.length;
  const knownStageMatches = matches.filter((m) => (m.map?.id ?? 0) !== 0);
  const eligibleDenominator = knownStageMatches.length;
  const unknownMatches = matches.filter((m) => (m.map?.id ?? 0) === 0);

  const times = knownStageMatches.map((m) => m.time);
  const dateRange =
    times.length > 0 ? { firstMs: Math.min(...times), lastMs: Math.max(...times) } : null;

  const sample: SampleMeta = {
    rawSampleSize,
    eligibleDenominator,
    knownFieldCoverage: rawSampleSize > 0 ? eligibleDenominator / rawSampleSize : 0,
    dateRange,
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: RECENCY_TREATMENT,
    confidenceTier: confidenceTierFor(eligibleDenominator),
  };

  const unknown: UnknownBucket | null =
    unknownMatches.length > 0
      ? {
          games: unknownMatches.length,
          wins: unknownMatches.filter((m) => m.win).length,
          losses: unknownMatches.filter((m) => !m.win).length,
        }
      : null;

  const ranked = rankStagesByEvidence(matches, floor);

  if (ranked.length === 0) {
    return {
      claim: {
        kind: 'abstained',
        claimType: 'inference',
        reason: 'insufficient-sample',
        sample,
        gamesNeeded: Math.max(0, floor - eligibleDenominator),
      },
      unknown,
    };
  }

  return {
    claim: { kind: 'evidenced', claimType: 'inference', value: ranked, sample },
    unknown,
  };
}
