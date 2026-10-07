import { extractCitationTokens, type GeneratedPracticePlan } from '@smash-tracker/shared';

/**
 * FROZEN — TEST SUPPORT ONLY. Phase 39 (plan 39-08 Task 2, D-02): 28-06's
 * shipped citation rule, `validatePracticePlanCitations` (plus the
 * `SynthesisValidationError` it throws), RETIRED from production by plan
 * 39-08 — its rule is now rule R1 of the one shared validator
 * (`validateReportOutput`), which `runSynthesisGeneration` runs over the
 * `vod_annotation` claim set.
 *
 * The class and function below are BYTE-IDENTICAL to the bodies that
 * shipped in `apps/api/src/reports/synthesis.ts` up to commit `885aa919`
 * (their doc comments included, so references such as "28-07's route" are
 * historical). They are kept, not deleted, for exactly two committed proofs
 * that must keep running against the rule that SHIPPED rather than a
 * paraphrase of it:
 * - `routes/reportsSynthesis.test.ts`'s migration battery (the shared
 *   validator is at least as strict on real synthesis evidence);
 * - `reports/rpt08LegacyOracle.test.ts` (the RPT-08 fail-first binding:
 *   this rule accepts a wrong number behind a real citation, and the shared
 *   package's frozen legacy verdict agrees with it).
 *
 * Never import this from production code: it would silently reinstate the
 * weaker rule the phase exists to replace. `src/test-support/**` is excluded
 * from the server build (`tsconfig.build.json`), and `synthesis.test.ts`
 * carries a committed gate asserting no production API file imports it.
 * Do not "improve" it — its value is that it is exactly as weak as shipped.
 */

/**
 * Thrown when citation validation drops EVERY focusArea — a summary alone
 * is never a shippable practice plan (owner invariant 2). The route maps
 * this to `failJob` (refund + `refunded` terminal), never to storing a
 * partial/empty "Ready" plan.
 */
export class SynthesisValidationError extends Error {
  readonly reason = 'uncitable' as const;

  constructor() {
    super(
      "Practice-plan synthesis produced no claim that could be grounded in the player's own stored evidence",
    );
    this.name = 'SynthesisValidationError';
  }
}

/**
 * Post-generation citation validator (owner invariant 1): resolves every
 * `{{cite:...}}` token embedded in a focusArea's `evidence` body by EXACT
 * set-membership against `allowedPairs` — the stable `(matchId, seconds)`
 * pair Phase 12 standardized, never the timestamp entry's `id` (dense-array
 * record ids are synthesized and non-durable, RESEARCH Pitfall 3) and never
 * display text (a token's `label` plays ZERO role in resolution).
 *
 * A focusArea SURVIVES iff it carries at least one extracted token AND
 * EVERY extracted token resolves — a conservative all-tokens-must-resolve
 * rule: one bad token taints the whole claim rather than partially trusting
 * it. `extractCitationTokens` already skips malformed tokens without
 * throwing (coachingReview.ts), so a body whose only tokens were malformed
 * simply extracts to zero tokens and is dropped as uncited, never crashes
 * this function.
 *
 * Zero survivors throws `SynthesisValidationError` (owner invariant 2) —
 * the caller (28-07's route) maps this to `failJob`, which refunds the
 * credit and writes the `refunded` terminal. Survivors keep their original
 * order; `summary` is untouched.
 */
export function validatePracticePlanCitations(
  plan: GeneratedPracticePlan,
  allowedPairs: ReadonlySet<string>,
): { plan: GeneratedPracticePlan; droppedClaimCount: number } {
  const survivors = plan.focusAreas.filter((focusArea) => {
    const tokens = extractCitationTokens(focusArea.evidence);
    if (tokens.length === 0) {
      return false;
    }
    return tokens.every((token) => allowedPairs.has(`${token.sourceVodRef}:${token.seconds}`));
  });

  if (survivors.length === 0) {
    throw new SynthesisValidationError();
  }

  const droppedClaimCount = plan.focusAreas.length - survivors.length;

  return {
    plan: { ...plan, focusAreas: survivors },
    droppedClaimCount,
  };
}
