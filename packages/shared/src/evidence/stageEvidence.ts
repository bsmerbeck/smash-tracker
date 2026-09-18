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
import { describeCohort, type CohortComposition } from './cohort.js';
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
 *
 * `legalStageIds` (plan 37-05, ADV-01/EVID-05) narrows the candidate set in
 * the SAME filter expression that drops the unknown-stage sentinel —
 * strictly BEFORE `gateBySampleSize` runs. This ordering is the whole
 * point: filtering after ranking, or post-filtering the ranked output, would
 * let an illegal-but-evidenced stage count toward what a caller believes
 * cleared the gate, silently reopening the floor guarantee above. `undefined`
 * means "no legality filter" (byte-identical to the pre-filter behaviour);
 * an EMPTY set means "nothing is legal" and yields an empty result — the two
 * are deliberately distinct, since conflating them would let an empty legal
 * set silently degrade to an unfiltered list.
 */
export function rankStagesByEvidence(
  matches: Match[],
  minMatches?: number,
  legalStageIds?: ReadonlySet<number>,
): RankedStage[] {
  const floor = effectiveFloor(minMatches);
  const known = getStageRecords(matches).filter(
    (record) =>
      record.stageId !== 0 && (legalStageIds === undefined || legalStageIds.has(record.stageId)),
  );
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
  /** The sample's session-type/provenance composition (D-10, EVID-02) — symmetry with `MatchupEvidenceResult.cohort`, computed once per query. */
  cohort: CohortComposition;
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
  /**
   * R1-HIGH-2/EVID-05 (plan 37-05): when supplied, narrows the SAMPLE to the
   * legal cohort, not just the ranking — see `types.ts`'s
   * `SampleMeta.eligibleDenominator`/`knownFieldCoverage` doc comments for
   * what this changes about their meaning. The unknown-stage bucket
   * (`map.id` 0) is UNCHANGED: unknown is not the same as illegal, and
   * folding one into the other would hide a data-quality signal behind a
   * rules decision. Omitted, this function is byte-identical to the
   * pre-filter behaviour — the only other caller, the API's report payload
   * assembly, passes no filter.
   */
  legalStageIds?: ReadonlySet<number>;
}): StageEvidenceResult {
  const { matches, refreshedAt, minMatches, legalStageIds } = input;
  const floor = effectiveFloor(minMatches);

  const rawSampleSize = matches.length;
  const knownStageMatches = matches.filter((m) => {
    const stageId = m.map?.id ?? 0;
    if (stageId === 0) return false;
    return legalStageIds === undefined || legalStageIds.has(stageId);
  });
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

  const cohort = describeCohort(matches);
  const ranked = rankStagesByEvidence(matches, floor, legalStageIds);

  if (ranked.length === 0) {
    // The abstention count must answer a question a user can act on. Below
    // the floor, that's "how many more games overall" (unchanged). At or
    // above the floor with nothing ranked, every countable game is spread
    // too thin across stages — the actionable answer is "how many more on
    // your best-covered (legal) stage", floored at 1: a reachable
    // `gamesNeeded: 0` is both untrue (the claim IS abstained) and
    // impossible to act on (see `MatchupInsights.test.tsx`'s WR-02 doc
    // comment, which already names this exact defect class in this
    // codebase's own words).
    const gamesNeeded =
      eligibleDenominator < floor
        ? floor - eligibleDenominator
        : Math.max(
            1,
            floor -
              getStageRecords(knownStageMatches).reduce(
                (max, record) => Math.max(max, record.total),
                0,
              ),
          );
    return {
      claim: {
        kind: 'abstained',
        claimType: 'inference',
        reason: 'insufficient-sample',
        sample,
        gamesNeeded,
      },
      unknown,
      cohort,
    };
  }

  return {
    claim: { kind: 'evidenced', claimType: 'inference', value: ranked, sample },
    unknown,
    cohort,
  };
}
