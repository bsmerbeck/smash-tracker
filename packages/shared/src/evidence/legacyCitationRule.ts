/**
 * FROZEN. RPT-08 / D-09 (phase 39 plan 01, wave 1): this module implements
 * EXACTLY today's shipped citation rule (`validatePracticePlanCitations`,
 * `apps/api/src/reports/synthesis.ts`) — the set-membership law "every
 * evidence id a claim cites is a key of the snapshot's rows" — generalized
 * from `(matchId, seconds)` pairs to evidence IDs, and NOTHING MORE. It
 * deliberately ignores `assertedValue`.
 *
 * This module exists so the INSUFFICIENCY of the shipped rule is a
 * machine-checked fact, not a claim: `rpt08Oracle.test.ts` proves this
 * function ACCEPTS a claim that cites a real, issued evidence id while
 * stating a value the snapshot contradicts (rule R2 — the named hard case).
 *
 * Do not "improve" this function. Improvements to what counts as a
 * supported claim belong in the validator plan 39-04 builds
 * (`validateReportOutput` or equivalent) — this module's whole reason to
 * exist is to stay exactly as weak as the rule shipping today, so its
 * acceptance of the wrong-number fixture stays a fact about PRODUCTION
 * code, not about a module authored beside its own fixture.
 *
 * `apps/api/src/reports/rpt08LegacyOracle.test.ts` (review C1-H3) proves
 * this generalization agrees with the SHIPPED `validatePracticePlanCitations`
 * on a battery of citation cases, so the "generalized" claim above is bound
 * to shipped code rather than merely asserted.
 */
import type { ClaimValue } from './claims.js';
import type { EvidenceSnapshot } from './snapshot.js';

/** One claim as a model output would present it to the legacy rule — the shape `legacyCitationOnlyVerdict` takes, mirroring a `GeneratedPracticePlan` focus area's citations generalized to evidence ids. */
export interface LegacyRuleClaim {
  claimId: string;
  evidenceIds: readonly string[];
  assertedValue: ClaimValue;
}

export interface LegacyRuleOutput {
  claims: readonly LegacyRuleClaim[];
}

export interface LegacyRuleVerdict {
  /** True iff every claim is accepted — assertedValue plays NO role in either direction. */
  accepted: boolean;
  rejectedClaimIds: readonly string[];
}

/**
 * A claim is accepted when it carries AT LEAST ONE evidence id and every one
 * of its evidence IDs is a key of `snapshot.rows`. This is the set-membership
 * law `validatePracticePlanCitations` applies to `(matchId, seconds)` pairs,
 * generalized to evidence IDs — it deliberately ignores `assertedValue`.
 *
 * The non-empty requirement mirrors the shipped function's OWN explicit
 * "a focusArea with zero citation tokens is dropped" special case
 * (`extractCitationTokens(...).length === 0` short-circuits to `false`
 * before the set-membership check ever runs) — without it, an empty
 * `evidenceIds` array would vacuously satisfy `.every(...)` and this
 * generalization would ACCEPT what the shipped rule REJECTS, breaking the
 * agreement battery `apps/api/src/reports/rpt08LegacyOracle.test.ts` proves
 * (review C1-H3).
 */
export function legacyCitationOnlyVerdict(input: {
  snapshot: EvidenceSnapshot;
  output: LegacyRuleOutput;
}): LegacyRuleVerdict {
  const { snapshot, output } = input;
  const rejectedClaimIds: string[] = [];

  for (const claim of output.claims) {
    const hasCitations = claim.evidenceIds.length > 0;
    const allKnown =
      hasCitations && claim.evidenceIds.every((evidenceId) => evidenceId in snapshot.rows);
    if (!allKnown) {
      rejectedClaimIds.push(claim.claimId);
    }
  }

  return { accepted: rejectedClaimIds.length === 0, rejectedClaimIds };
}
