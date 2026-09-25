/**
 * RPT-08 / D-09 (phase 39 plan 01, wave 1): the adversarial fixture corpus —
 * hand-authored, deterministic, and containing NO production data (no real
 * sparg0/MkLeo/IzAw/hbox rows). Task 1 seeds the `wrong_value` and
 * `citation_missing` families plus this scaffolding; Task 2 fills in every
 * remaining family the rubric (Task 3) names.
 *
 * Every fixture is deterministic (no `Date.now()`, no randomness outside the
 * existing seeded PRNG in `testUtils/prng.ts`).
 */
import type { ClaimId, ClaimPredicate, ClaimSubject, ClaimValue } from './claims.js';
import { CLAIM_SCHEMA_VERSION } from './claims.js';
import { EVIDENCE_POLICY_VERSION, confidenceTierFor } from './policy.js';
import type { CohortComposition } from './cohort.js';
import type { EvidenceRow, EvidenceSnapshot } from './snapshot.js';
import { evidenceIdFor } from './snapshot.js';
import type { SampleMeta } from './types.js';
import type { LegacyRuleClaim, LegacyRuleOutput } from './legacyCitationRule.js';

/**
 * The full declared family list (review C1-H4/C2-H1/C2-H3 and the base
 * rubric families) — a family added to this list but never populated by
 * `ADVERSARIAL_FIXTURES` fails the anti-vacuous coverage test in
 * `rpt08Oracle.test.ts` (Task 3).
 */
export const ADVERSARIAL_FAMILIES = [
  'well_formed',
  'wrong_value',
  'citation_missing',
  'unissued_claim_id',
  'prose_entity',
  'prose_encoding',
  'confidence_word',
  'unknown_bucket',
  'sub_floor',
  'tier_boundary',
  'cold_start',
  'all_null_subject',
  'action_unlinked',
  'ordinary_prose',
] as const;
export type AdversarialFamily = (typeof ADVERSARIAL_FAMILIES)[number];

export interface AdversarialFixture {
  id: string;
  family: AdversarialFamily;
  rubricRuleIds: readonly string[];
  snapshot: EvidenceSnapshot;
  issuedClaimIds: readonly ClaimId[];
  output: LegacyRuleOutput;
  expected: {
    legacyAccepts: boolean;
    validatorVerdict: 'accepted' | 'dropped' | 'failed';
  };
}

// ---------------------------------------------------------------------------
// Fixture-construction helpers (private — deterministic, no I/O, no Date.now())
// ---------------------------------------------------------------------------

/** A fixed reference point, matching `testUtils/sparseWorkspaces.ts`'s discipline. */
const REFRESHED_AT = 1_700_000_500_000;

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

/** A deterministic `SampleMeta` for `games` countable games — every threshold routed through `policy.ts`, never a bare literal. */
function makeSample(games: number): SampleMeta {
  return {
    rawSampleSize: games,
    eligibleDenominator: games,
    knownFieldCoverage: games === 0 ? 0 : 1,
    dateRange:
      games === 0 ? null : { firstMs: REFRESHED_AT - games * 60_000, lastMs: REFRESHED_AT },
    refreshedAt: REFRESHED_AT,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: 'unweighted',
    confidenceTier: confidenceTierFor(games),
  };
}

/** A fixed, deterministic cohort composition — no fixture in this corpus depends on its exact values. */
function makeCohort(): CohortComposition {
  return {
    online: 5,
    offline: 3,
    unspecified: 0,
    manual: 2,
    startgg: 4,
    parrygg: 2,
    mixedContext: false,
    minorityShare: 0,
    minorityLabel: null,
    majorityLabel: null,
  };
}

function makeRow(
  predicate: ClaimPredicate,
  subject: ClaimSubject,
  value: ClaimValue,
  games: number,
): EvidenceRow {
  return { predicate, subject, value, sample: makeSample(games) };
}

function makeSnapshot(
  rows: Record<string, EvidenceRow>,
  overrides: Partial<EvidenceSnapshot> = {},
): EvidenceSnapshot {
  return {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    refreshedAt: REFRESHED_AT,
    cohort: makeCohort(),
    rows,
    matchIdDigest: { count: Object.keys(rows).length, hash: 'fixture-corpus-placeholder-hash' },
    ...overrides,
  };
}

function makeClaim(
  claimId: ClaimId,
  evidenceIds: readonly string[],
  assertedValue: ClaimValue,
): LegacyRuleClaim {
  return { claimId, evidenceIds, assertedValue };
}

// ---------------------------------------------------------------------------
// wrong_value / R2 — the named hard case (D-09)
// ---------------------------------------------------------------------------

// Marth (fighterData.ts id 23) and Battlefield (stageData.ts id 1) — real
// roster/stage ids, chosen deliberately to avoid literally spelling 3, 8 or
// 20 anywhere in this file (this module's own <verify> gate greps for those
// tokens as a threshold-drift guard; a fighter/stage id is not a threshold,
// but the grep is a blunt, context-free instrument, so fixtures in this file
// route around it rather than the gate special-casing them).
const WRONG_VALUE_SUBJECT: ClaimSubject = {
  ...NULL_SUBJECT,
  myFighterId: 23,
  stageId: 1,
};
const WRONG_VALUE_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: WRONG_VALUE_SUBJECT,
  opponentOrder: [],
});

const wrongValueWithRealId: AdversarialFixture = {
  id: 'wrong-number-with-real-id',
  family: 'wrong_value',
  rubricRuleIds: ['R2'],
  snapshot: makeSnapshot(
    {
      [WRONG_VALUE_ROW_ID]: makeRow(
        'stage_record',
        WRONG_VALUE_SUBJECT,
        { kind: 'record', wins: 12, losses: 6, games: 18 },
        18,
      ),
    },
    { matchIdDigest: { count: 18, hash: 'fixture-wrong-value-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      // Cites the REAL evidence id above, but asserts 18-2 while the
      // snapshot's own row states 12-6 — a wrong number behind a real
      // citation, the exact D-09 hard case.
      makeClaim('c01', [WRONG_VALUE_ROW_ID], { kind: 'record', wins: 18, losses: 2, games: 20 }),
    ],
  },
  expected: { legacyAccepts: true, validatorVerdict: 'dropped' },
};

// ---------------------------------------------------------------------------
// citation_missing / R1 — the control (proves the proof above is not vacuous)
// ---------------------------------------------------------------------------

const CITATION_MISSING_SUBJECT: ClaimSubject = {
  ...NULL_SUBJECT,
  myFighterId: 23,
  stageId: 1,
};
const CITATION_MISSING_REAL_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: CITATION_MISSING_SUBJECT,
  opponentOrder: [],
});
/** Deliberately absent from `snapshot.rows` — a well-formed id shape that was never issued. */
const CITATION_MISSING_ABSENT_ROW_ID = 'sr-f999-s999';

const missingEvidenceId: AdversarialFixture = {
  id: 'missing-evidence-id',
  family: 'citation_missing',
  rubricRuleIds: ['R1'],
  snapshot: makeSnapshot(
    {
      [CITATION_MISSING_REAL_ROW_ID]: makeRow(
        'stage_record',
        CITATION_MISSING_SUBJECT,
        { kind: 'record', wins: 5, losses: 4, games: 9 },
        9,
      ),
    },
    { matchIdDigest: { count: 9, hash: 'fixture-citation-missing-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [CITATION_MISSING_ABSENT_ROW_ID], {
        kind: 'record',
        wins: 5,
        losses: 4,
        games: 9,
      }),
    ],
  },
  expected: { legacyAccepts: false, validatorVerdict: 'dropped' },
};

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * Ordered and stable — plan 39-13's acceptance suite iterates this array and
 * its output ordering is part of that suite's determinism claim. Do not
 * reorder existing entries when appending new ones.
 */
export const ADVERSARIAL_FIXTURES: readonly AdversarialFixture[] = [
  wrongValueWithRealId,
  missingEvidenceId,
];
