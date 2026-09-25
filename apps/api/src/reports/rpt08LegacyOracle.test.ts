import { describe, expect, it } from 'vitest';
import {
  CLAIM_SCHEMA_VERSION,
  EVIDENCE_POLICY_VERSION,
  extractCitationTokens,
  legacyCitationOnlyVerdict,
  serializeCitationToken,
  vodEvidenceId,
  type CohortComposition,
  type EvidenceRow,
  type EvidenceSnapshot,
  type GeneratedPracticePlan,
  type SampleMeta,
} from '@smash-tracker/shared';
import { validatePracticePlanCitations } from '../test-support/retiredCitationRule.js';

/**
 * Review C1-H3 (RPT-08 / D-09, phase 39 plan 01, wave 1): the wave-1
 * failing direction must be a property of SHIPPED code, not of a module
 * authored beside its own fixture. This file proves the shipped
 * `validatePracticePlanCitations` accepts a wrong number behind a real
 * citation — and that the shared package's frozen `legacyCitationOnlyVerdict`
 * agrees with it, so the shared corpus's fail-first result
 * (`rpt08Oracle.test.ts`) is a property of shipped code, not of a module
 * authored beside its own fixture.
 *
 * Plan 39-08 retired that rule from production (its rule is now rule R1 of
 * the shared validator). It is imported from
 * `test-support/retiredCitationRule.ts`, whose body is BYTE-IDENTICAL to the
 * one that shipped in `reports/synthesis.ts` up to commit `885aa919` — so
 * this binding still speaks about the rule that shipped. The migration
 * battery in `routes/reportsSynthesis.test.ts` proves the replacement is at
 * least as strict, including on this exact wrong-number case.
 */

const STUB_SAMPLE: SampleMeta = {
  rawSampleSize: 0,
  eligibleDenominator: 0,
  knownFieldCoverage: 0,
  dateRange: null,
  refreshedAt: 1_700_000_000_000,
  evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
  recencyTreatment: 'unweighted',
  confidenceTier: null,
};

const STUB_COHORT: CohortComposition = {
  online: 0,
  offline: 0,
  unspecified: 0,
  manual: 0,
  startgg: 0,
  parrygg: 0,
  mixedContext: false,
  minorityShare: 0,
  minorityLabel: null,
  majorityLabel: null,
};

/** Builds a snapshot whose `vod_annotation` rows are keyed by `vodEvidenceId(matchId, seconds)` for every allowed pair — the translation `apps/api`'s `allowedPairs: Set<string>` universe maps onto. */
function snapshotFromAllowedPairs(
  pairs: ReadonlyArray<{ matchId: string; seconds: number }>,
): EvidenceSnapshot {
  const rows: Record<string, EvidenceRow> = {};
  for (const { matchId, seconds } of pairs) {
    rows[vodEvidenceId(matchId, seconds)] = {
      predicate: 'vod_annotation',
      subject: { myFighterId: null, opponentFighterId: null, stageId: null, opponentTag: null },
      value: { kind: 'count', count: 1 },
      sample: STUB_SAMPLE,
    };
  }
  return {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    refreshedAt: STUB_SAMPLE.refreshedAt,
    cohort: STUB_COHORT,
    rows,
    matchIdDigest: { count: pairs.length, hash: 'rpt08-legacy-oracle-battery-hash' },
  };
}

/** Translates a focus area's embedded `{{cite:...}}` tokens into the evidence-id shape `legacyCitationOnlyVerdict` takes, through `vodEvidenceId` — the same translation `snapshotFromAllowedPairs` uses for the snapshot side. */
function focusAreaToLegacyClaim(claimId: string, evidenceText: string) {
  const tokens = extractCitationTokens(evidenceText);
  return {
    claimId,
    evidenceIds: tokens.map((token) => vodEvidenceId(token.sourceVodRef, token.seconds)),
    assertedValue: { kind: 'count' as const, count: 1 },
  };
}

describe('RPT-08 fail-first proof: the SHIPPED validatePracticePlanCitations accepts a wrong number behind a real citation (review C1-H3)', () => {
  it('accepts a focus area citing a real (matchId, seconds) pair while asserting a record the evidence does not support', () => {
    const allowedPairs = new Set(['real-match-1:42']);
    const wrongNumberFocusArea: GeneratedPracticePlan['focusAreas'][number] = {
      title: 'Stage record vs this opponent',
      evidence: `Grounded in your own footage: ${serializeCitationToken({
        sourceVodRef: 'real-match-1',
        seconds: 42,
        label: 'stage win',
      })}. The record here is actually 18-2, a dominant showing.`,
      drills: ['Drill this stage matchup'],
    };
    const plan: GeneratedPracticePlan = {
      summary: 'Practice plan summary',
      focusAreas: [wrongNumberFocusArea],
    };

    // This green assertion IS the RPT-08 fail-first evidence: the rule
    // shipping today cannot see a wrong number. It only checks that the
    // cited (matchId, seconds) pair exists in `allowedPairs` — never that
    // the prose's claimed record (here, an invented "18-2") matches
    // anything the evidence actually shows. `droppedClaimCount` is 0 and
    // the focus area survives untouched — the function does NOT throw
    // `SynthesisValidationError`.
    const result = validatePracticePlanCitations(plan, allowedPairs);
    expect(result.droppedClaimCount).toBe(0);
    expect(result.plan.focusAreas).toEqual([wrongNumberFocusArea]);
  });
});

describe('the frozen legacyCitationOnlyVerdict agrees with the shipped validatePracticePlanCitations (review C1-H3)', () => {
  it('agrees per-claim across a battery of citation cases: all-tokens-resolve, one-token-unknown, zero-tokens, and a mix', () => {
    const allowedPairs = new Set(['match-a:10', 'match-b:20']);
    const knownPairs = [
      { matchId: 'match-a', seconds: 10 },
      { matchId: 'match-b', seconds: 20 },
    ];
    const snapshot = snapshotFromAllowedPairs(knownPairs);

    const allTokensResolve: GeneratedPracticePlan['focusAreas'][number] = {
      title: 'all-tokens-resolve',
      evidence: `${serializeCitationToken({ sourceVodRef: 'match-a', seconds: 10, label: 'a' })} and ${serializeCitationToken({ sourceVodRef: 'match-b', seconds: 20, label: 'b' })}`,
      drills: ['drill'],
    };
    const oneTokenUnknown: GeneratedPracticePlan['focusAreas'][number] = {
      title: 'one-token-unknown',
      evidence: `${serializeCitationToken({ sourceVodRef: 'match-a', seconds: 10, label: 'a' })} and ${serializeCitationToken({ sourceVodRef: 'match-unknown', seconds: 999, label: 'unknown' })}`,
      drills: ['drill'],
    };
    const zeroTokens: GeneratedPracticePlan['focusAreas'][number] = {
      title: 'zero-tokens',
      evidence: 'Just prose, no citation tokens embedded at all.',
      drills: ['drill'],
    };
    const mixThreeTokensOneBad: GeneratedPracticePlan['focusAreas'][number] = {
      title: 'a-mix',
      evidence: `${serializeCitationToken({ sourceVodRef: 'match-a', seconds: 10, label: 'a' })}, ${serializeCitationToken({ sourceVodRef: 'match-b', seconds: 20, label: 'b' })} and ${serializeCitationToken({ sourceVodRef: 'match-bad', seconds: 1, label: 'bad' })}`,
      drills: ['drill'],
    };

    const cases = [allTokensResolve, oneTokenUnknown, zeroTokens, mixThreeTokensOneBad];
    const plan: GeneratedPracticePlan = { summary: 'Battery plan', focusAreas: cases };

    // At least one focusArea survives (allTokensResolve), so the shipped
    // function does not throw SynthesisValidationError for the whole plan.
    const shippedResult = validatePracticePlanCitations(plan, allowedPairs);
    const survivingTitles = new Set(shippedResult.plan.focusAreas.map((area) => area.title));

    for (const focusArea of cases) {
      const shippedAccepted = survivingTitles.has(focusArea.title);
      const legacyClaim = focusAreaToLegacyClaim(focusArea.title, focusArea.evidence);
      const legacyVerdict = legacyCitationOnlyVerdict({
        snapshot,
        output: { claims: [legacyClaim] },
      });
      const legacyAccepted = legacyVerdict.accepted;

      expect(legacyAccepted).toBe(shippedAccepted);
    }

    // Pin the expected accept/reject shape of the battery itself, so a
    // future change to the cases above cannot silently stop exercising all
    // four named directions.
    expect(survivingTitles.has('all-tokens-resolve')).toBe(true);
    expect(survivingTitles.has('one-token-unknown')).toBe(false);
    expect(survivingTitles.has('zero-tokens')).toBe(false);
    expect(survivingTitles.has('a-mix')).toBe(false);
  });
});
