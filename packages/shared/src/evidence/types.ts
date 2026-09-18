/**
 * The Phase 36 evidence engine's core vocabulary (D-08, D-11, EVID-02,
 * EVID-06). Every ranking, gate and identity function under
 * `packages/shared/src/evidence/` composes these shapes so a web component
 * and the API's report payload assembly consume EXACTLY the same claim
 * object — one implementation, two consumers (EVID-10). See
 * `stageEvidence.ts`'s module doc comment for why an alias map is
 * deliberately absent from the stage/character-pair axes, and
 * `opponentEvidence.ts` for the axis where it is load-bearing.
 */

/**
 * How confident the engine is in a claim, purely a function of countable
 * sample size (see `policy.ts`'s `confidenceTierFor`). There is no tier
 * below the abstention floor — an abstained claim's `sample.confidenceTier`
 * is `null`, never a fourth "very low" tier.
 */
export type ConfidenceTier = 'low' | 'medium' | 'high';

/**
 * D-11: every claim states whether it is a raw recorded FACT (a win-loss
 * record — the count itself, unranked), a data-derived INFERENCE (a
 * ranking, a best/worst pick, a confidence tier), or a RECOMMENDATION (an
 * actionable suggestion like a Pick/Ban directive).
 */
export type ClaimKind = 'fact' | 'inference' | 'recommendation';

/**
 * D-08: every claim states its recency treatment so a future decay model is
 * a visible, versioned change rather than a silent one. This phase produces
 * only the literal `'unweighted'` — nothing here varies it yet.
 */
export type RecencyTreatment = 'unweighted';

/** The sampled data's earliest and latest match timestamps, epoch ms. */
export interface SampleDateRange {
  firstMs: number;
  lastMs: number;
}

/**
 * D-11: the fields every claim's evidence provenance carries, regardless of
 * whether the claim ultimately evidences or abstains.
 */
export interface SampleMeta {
  /** Total games in the raw input sample, before any known-field filtering. */
  rawSampleSize: number;
  /**
   * Games that cleared whatever known-field predicate this claim's builder
   * applies (e.g. a known stage id). Plan 37-05 (R2-MEDIUM-4): when
   * `buildStageEvidence` was given a stage-legality filter, this describes
   * the LEGAL cohort, not merely the known-stage one — a game on a known but
   * ILLEGAL stage sits in neither this denominator nor the unknown bucket
   * below, so for the first time `eligibleDenominator + unknown.games` can
   * be strictly less than `rawSampleSize`. Without a filter (every consumer
   * other than the advisor, including the API's report payload assembly,
   * which passes none) this is unchanged: known-field share, and the two
   * always sum to `rawSampleSize`.
   */
  eligibleDenominator: number;
  /**
   * `eligibleDenominator / rawSampleSize`, or `0` when `rawSampleSize` is `0`
   * — never `NaN`, never `undefined`. Inherits `eligibleDenominator`'s
   * filtered-cohort reading above: under a supplied stage-legality filter
   * this is a LEGAL share, not a known-field share.
   */
  knownFieldCoverage: number;
  /** Earliest/latest match time in the eligible sample, or `null` for an empty sample. */
  dateRange: SampleDateRange | null;
  /** Epoch ms this claim was computed. */
  refreshedAt: number;
  /** The policy version (`policy.ts`'s `EVIDENCE_POLICY_VERSION`) this claim was computed under. */
  evidencePolicyVersion: number;
  recencyTreatment: RecencyTreatment;
  /** Confidence tier for `eligibleDenominator` games, or `null` below the abstention floor. */
  confidenceTier: ConfidenceTier | null;
}

/**
 * A per-breakdown bucket of games the engine could not classify along one
 * axis (unknown stage, unknown character, unnamed opponent identity) —
 * reported explicitly, never silently merged into another bucket and never
 * silently dropped from a denominator (D-09).
 */
export interface UnknownBucket {
  games: number;
  wins: number;
  losses: number;
}

/**
 * The one claim shape every engine ranking/aggregate entry point returns.
 * `'evidenced'` carries the computed value; `'abstained'` carries how many
 * MORE countable games are needed to clear the abstention floor (D-05, D-07)
 * instead of a value — there is no partial/degraded value on this arm.
 */
export type EvidenceClaim<T> =
  | { kind: 'evidenced'; claimType: ClaimKind; value: T; sample: SampleMeta }
  | {
      kind: 'abstained';
      claimType: ClaimKind;
      reason: 'insufficient-sample';
      sample: SampleMeta;
      gamesNeeded: number;
    };
