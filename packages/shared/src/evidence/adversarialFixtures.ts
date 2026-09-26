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
import type { ActionId, ClaimId, ClaimPredicate, ClaimSubject, ClaimValue } from './claims.js';
import { CLAIM_SCHEMA_VERSION } from './claims.js';
import {
  ABSTENTION_FLOOR_GAMES,
  CONFIDENCE_TIER_BOUNDS,
  EVIDENCE_POLICY_VERSION,
  confidenceTierFor,
} from './policy.js';
import type { CohortComposition } from './cohort.js';
import type { EvidenceRow, EvidenceSnapshot } from './snapshot.js';
import { evidenceIdFor } from './snapshot.js';
import type { SampleMeta } from './types.js';
import type { LegacyRuleClaim, LegacyRuleOutput } from './legacyCitationRule.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownCharacterOnlyWorkspace,
  unknownStageOnlyWorkspace,
} from '../testUtils/index.js';

/**
 * The eight rule ids `records/RPT-08-rubric.md`'s rule table declares
 * (Task 3). `rpt08Oracle.test.ts` parses the rubric markdown and asserts
 * the parsed set equals this list exactly, and that every id is named by
 * at least one fixture's `rubricRuleIds` — so the rubric and the corpus
 * cannot silently drift apart.
 */
export const RUBRIC_RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'] as const;

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

/**
 * One connective-prose SECTION and the claim ids licensed to license entities
 * within it — the D-04 prose lint's unit of scope (a licence in one section
 * never licenses an entity mention in another). Families exercising the R4
 * prose rule (`prose_entity`, `prose_encoding`, `ordinary_prose`) and the R5
 * confidence-word rule (`confidence_word`) carry one or more of these.
 */
export interface FixtureProseSection {
  prose: string;
  licensedClaimIds: readonly ClaimId[];
}

/** One of the three fixed D-12 recommended-action slots, `null` when empty. */
export interface FixtureActionSlot {
  actionId: ActionId;
  claimId: ClaimId | null;
}

export interface AdversarialFixture {
  id: string;
  family: AdversarialFamily;
  rubricRuleIds: readonly string[];
  snapshot: EvidenceSnapshot;
  issuedClaimIds: readonly ClaimId[];
  output: LegacyRuleOutput;
  /** Connective-prose sections this fixture exercises (R4/R5 families only — absent for pure citation/claim fixtures). */
  sections?: readonly FixtureProseSection[];
  /** The three fixed action slots (D-12) this fixture exercises — absent unless the fixture is specifically about action linking. */
  actions?: readonly [FixtureActionSlot | null, FixtureActionSlot | null, FixtureActionSlot | null];
  expected: {
    legacyAccepts: boolean;
    /**
     * What the validator must do with this fixture, observed on its outcome:
     * - `accepted` — nothing dropped, no prose withheld;
     * - `stripped` — no claim or action dropped, but at least one section's
     *   PROSE withheld (R4/R5, and R7's lexical half under D-22);
     * - `dropped` — at least one claim or action slot dropped;
     * - `failed` — nothing survives and the output fails (a cold start).
     */
    validatorVerdict: 'accepted' | 'stripped' | 'dropped' | 'failed';
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
    offline: 4, // not `CONFIDENCE_TIER_BOUNDS.low` — an arbitrary cohort count, unrelated to the evidence-tier thresholds
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
// well_formed — the CONTROL (D-09 Task 2). Without this, a suite of only-bad
// cases cannot prove the validator is not simply rejecting everything.
// ---------------------------------------------------------------------------

const WELL_FORMED_SUBJECT: ClaimSubject = {
  ...NULL_SUBJECT,
  myFighterId: 23,
  opponentFighterId: 59,
};
const WELL_FORMED_ROW_ID = evidenceIdFor({
  predicate: 'character_matchup_record',
  subject: WELL_FORMED_SUBJECT,
  opponentOrder: [],
});

const wellFormed: AdversarialFixture = {
  id: 'well-formed-control',
  family: 'well_formed',
  rubricRuleIds: ['R2'],
  snapshot: makeSnapshot(
    {
      [WELL_FORMED_ROW_ID]: makeRow(
        'character_matchup_record',
        WELL_FORMED_SUBJECT,
        { kind: 'record', wins: 7, losses: 4, games: 11 },
        11,
      ),
    },
    { matchIdDigest: { count: 11, hash: 'fixture-well-formed-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [WELL_FORMED_ROW_ID], { kind: 'record', wins: 7, losses: 4, games: 11 }),
    ],
  },
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

// ---------------------------------------------------------------------------
// unissued_claim_id / R1 — a claim id inside CLAIM_ID_VOCABULARY but not
// issued for THIS job (the model picks c31 when only c01/c02 were issued).
// The legacy rule ignores claim-id issuance entirely (it only checks
// evidence-id membership), so it still accepts this — only the FUTURE
// validator (plan 39-04) checks `claimId` against `issuedClaimIds`.
// ---------------------------------------------------------------------------

const UNISSUED_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const UNISSUED_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: UNISSUED_SUBJECT,
  opponentOrder: [],
});

const unissuedClaimId: AdversarialFixture = {
  id: 'unissued-claim-id',
  family: 'unissued_claim_id',
  rubricRuleIds: ['R1'],
  snapshot: makeSnapshot(
    {
      [UNISSUED_ROW_ID]: makeRow(
        'stage_record',
        UNISSUED_SUBJECT,
        { kind: 'record', wins: 9, losses: 5, games: 14 },
        14,
      ),
    },
    { matchIdDigest: { count: 14, hash: 'fixture-unissued-claim-id-hash' } },
  ),
  issuedClaimIds: ['c01', 'c02'],
  output: {
    claims: [
      makeClaim('c31', [UNISSUED_ROW_ID], { kind: 'record', wins: 9, losses: 5, games: 14 }),
    ],
  },
  expected: { legacyAccepts: true, validatorVerdict: 'dropped' },
};

// ---------------------------------------------------------------------------
// prose_entity / R4 — connective prose naming a fighter/stage/opponent tag/
// percentage no claim in the SAME section licenses. One instance is
// licensed only in a DIFFERENT section (must still fail — section-scoped).
// One instance (review C2-M6) is the stage-name single-source falsifier:
// the row's STORED name differs from `StageList`'s canonical spelling for
// the same id, and must be ACCEPTED (plan 39-06 resolves both the
// model-facing display name and the licensed set through the SAME
// resolver, so a legacy/renamed stage must never become a systematic false
// positive).
// ---------------------------------------------------------------------------

const PROSE_ENTITY_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const PROSE_ENTITY_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: PROSE_ENTITY_SUBJECT,
  opponentOrder: [],
});

function makeProseEntitySnapshot(): EvidenceSnapshot {
  return makeSnapshot(
    {
      [PROSE_ENTITY_ROW_ID]: makeRow(
        'stage_record',
        PROSE_ENTITY_SUBJECT,
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
    },
    { matchIdDigest: { count: 10, hash: 'fixture-prose-entity-hash' } },
  );
}

const proseEntityUnlicensedSameSection: AdversarialFixture = {
  id: 'prose-entity-unlicensed-same-section',
  family: 'prose_entity',
  rubricRuleIds: ['R4'],
  snapshot: makeProseEntitySnapshot(),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENTITY_ROW_ID], { kind: 'record', wins: 6, losses: 4, games: 10 }),
    ],
  },
  sections: [
    {
      // "Robin" and "62%" appear in prose but this section licenses NOTHING
      // (an empty licensedClaimIds) — an unlicensed entity mention.
      prose: 'Watch for a Robin pick — historically a 62% matchup in their favor on this stage.',
      licensedClaimIds: [],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

const proseEntityLicensedDifferentSection: AdversarialFixture = {
  id: 'prose-entity-licensed-different-section',
  family: 'prose_entity',
  rubricRuleIds: ['R4'],
  snapshot: makeProseEntitySnapshot(),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENTITY_ROW_ID], { kind: 'record', wins: 6, losses: 4, games: 10 }),
    ],
  },
  sections: [
    {
      // Section 1 states the stage record's own figures with NO licence of
      // its own. (Review SH-WR-07: this prose used to carry no digit, entity
      // or tag at all, so nothing lexically detectable was unlicensed and the
      // fixture was accepted under its 'dropped' label; it now names the
      // record's figures so the section-scoping contract is actually tested.)
      prose: 'On this stage your record is 6-4, historically in your favor.',
      licensedClaimIds: [],
    },
    {
      // Section 2 licenses c01 — but that licence does NOT reach section 1
      // (the D-04 rule is section-scoped), so section 1's mention still
      // fails even though the SAME claim is licensed elsewhere.
      prose: 'For reference, the stage record claim above is grounded in your own matches.',
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

const proseEntityStageNameMismatch: AdversarialFixture = {
  id: 'prose-entity-stage-name-mismatch',
  family: 'prose_entity',
  rubricRuleIds: ['R4'],
  snapshot: makeProseEntitySnapshot(),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENTITY_ROW_ID], { kind: 'record', wins: 6, losses: 4, games: 10 }),
    ],
  },
  sections: [
    {
      // "Battle Field" (the fixture's stand-in for a legacy/inconsistently
      // stored `match.map.name`) differs from `StageList`'s canonical
      // spelling for stage id 1 ("Battlefield") — this must NOT read as an
      // unlicensed entity once plan 39-06 resolves both sides through the
      // same single resolver.
      prose: 'Your record on Battle Field is grounded in the claim above.',
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

// ---------------------------------------------------------------------------
// prose_encoding / R4 — the encoding edge: a fullwidth digit, an NFD
// opponent tag licensed only in NFC form, and a ja-locale sentence.
// ---------------------------------------------------------------------------

const PROSE_ENCODING_FULLWIDTH_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, stageId: 1 };
const PROSE_ENCODING_FULLWIDTH_ROW_ID = evidenceIdFor({
  predicate: 'stage_pick_rate',
  subject: PROSE_ENCODING_FULLWIDTH_SUBJECT,
  opponentOrder: [],
});

const proseEncodingFullwidthDigit: AdversarialFixture = {
  id: 'prose-encoding-fullwidth-digit',
  family: 'prose_encoding',
  rubricRuleIds: ['R4'],
  snapshot: makeSnapshot(
    {
      [PROSE_ENCODING_FULLWIDTH_ROW_ID]: makeRow(
        'stage_pick_rate',
        PROSE_ENCODING_FULLWIDTH_SUBJECT,
        { kind: 'rate', numerator: 6, denominator: 10 },
        10,
      ),
    },
    { matchIdDigest: { count: 10, hash: 'fixture-prose-encoding-fullwidth-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENCODING_FULLWIDTH_ROW_ID], {
        kind: 'rate',
        numerator: 6,
        denominator: 10,
      }),
    ],
  },
  sections: [
    {
      // U+FF16/U+FF10 (fullwidth "6"/"0") — a fullwidth digit IS a digit;
      // the lint must not fail to recognize it as licensed by c01's 60%.
      prose: 'They picked this stage in roughly ６０% of games.',
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

const PROSE_ENCODING_OPPONENT_TAG_NFC = 'José'; // "José", NFC (single precomposed U+00E9)
const PROSE_ENCODING_OPPONENT_TAG_NFD = 'José'; // "e" + combining acute (U+0301), NFD
const PROSE_ENCODING_NFD_SUBJECT: ClaimSubject = {
  ...NULL_SUBJECT,
  opponentTag: PROSE_ENCODING_OPPONENT_TAG_NFC,
};
const PROSE_ENCODING_NFD_OPPONENT_ORDER = [PROSE_ENCODING_OPPONENT_TAG_NFC];
const PROSE_ENCODING_NFD_ROW_ID = evidenceIdFor({
  predicate: 'head_to_head_record',
  subject: PROSE_ENCODING_NFD_SUBJECT,
  opponentOrder: PROSE_ENCODING_NFD_OPPONENT_ORDER,
});

const proseEncodingNfdOpponentTag: AdversarialFixture = {
  id: 'prose-encoding-nfd-opponent-tag',
  family: 'prose_encoding',
  rubricRuleIds: ['R4'],
  snapshot: makeSnapshot(
    {
      [PROSE_ENCODING_NFD_ROW_ID]: makeRow(
        'head_to_head_record',
        PROSE_ENCODING_NFD_SUBJECT,
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
    },
    { matchIdDigest: { count: 10, hash: 'fixture-prose-encoding-nfd-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENCODING_NFD_ROW_ID], {
        kind: 'record',
        wins: 6,
        losses: 4,
        games: 10,
      }),
    ],
  },
  sections: [
    {
      // Licensed subject is stored in NFC ("José"); prose spells the same
      // name in NFD form. NFC-normalize before comparing (rubric R4).
      prose: `Your head-to-head record against ${PROSE_ENCODING_OPPONENT_TAG_NFD} favors you.`,
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

const PROSE_ENCODING_JA_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const PROSE_ENCODING_JA_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: PROSE_ENCODING_JA_SUBJECT,
  opponentOrder: [],
});

const proseEncodingJaLocale: AdversarialFixture = {
  id: 'prose-encoding-ja-locale',
  family: 'prose_encoding',
  rubricRuleIds: ['R4'],
  snapshot: makeSnapshot(
    {
      [PROSE_ENCODING_JA_ROW_ID]: makeRow(
        'stage_record',
        PROSE_ENCODING_JA_SUBJECT,
        { kind: 'record', wins: 12, losses: 4, games: 16 },
        16,
      ),
    },
    { matchIdDigest: { count: 16, hash: 'fixture-prose-encoding-ja-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENCODING_JA_ROW_ID], {
        kind: 'record',
        wins: 12,
        losses: 4,
        games: 16,
      }),
    ],
  },
  sections: [
    {
      prose: 'このステージでの成績は12勝4敗です。',
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

// ---------------------------------------------------------------------------
// confidence_word / R5 — a strength word on a low-tier claim, a hedge word
// on a high-tier claim, and a confidence word absent from the licensed
// table entirely.
// ---------------------------------------------------------------------------

function makeConfidenceWordFixture(input: {
  id: string;
  games: number;
  prose: string;
  validatorVerdict: AdversarialFixture['expected']['validatorVerdict'];
}): AdversarialFixture {
  const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
  const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
  const value: ClaimValue = {
    kind: 'record',
    wins: input.games - 1,
    losses: 1,
    games: input.games,
  };
  return {
    id: input.id,
    family: 'confidence_word',
    rubricRuleIds: ['R5'],
    snapshot: makeSnapshot(
      { [rowId]: makeRow('stage_record', subject, value, input.games) },
      { matchIdDigest: { count: input.games, hash: `fixture-${input.id}-hash` } },
    ),
    issuedClaimIds: ['c01'],
    output: { claims: [makeClaim('c01', [rowId], value)] },
    sections: [{ prose: input.prose, licensedClaimIds: ['c01'] }],
    expected: { legacyAccepts: true, validatorVerdict: input.validatorVerdict },
  };
}

const confidenceWordStrengthOnLowTier = makeConfidenceWordFixture({
  id: 'confidence-word-strength-on-low-tier',
  games: CONFIDENCE_TIER_BOUNDS.low, // low tier — a "dominant"/"guaranteed" strength word here overstates the evidence.
  prose: 'This is a guaranteed, dominant win on this stage.',
  validatorVerdict: 'stripped',
});

const confidenceWordHedgeOnHighTier = makeConfidenceWordFixture({
  id: 'confidence-word-hedge-on-high-tier',
  games: CONFIDENCE_TIER_BOUNDS.high, // high tier — a hedge word ("maybe") understates well-evidenced data.
  prose: 'This might possibly be a favorable stage, who knows.',
  // Review SH-WR-07: R5 does NOT implement a hedge-word rule — hedge words
  // ("might", "could", "likely") are ordinary recommendation English (see
  // `FORBIDDEN_CONFIDENCE_WORDS`' EXCLUDED note) — so this prose is accepted,
  // and the rubric's R5 statement no longer claims otherwise. Kept as the
  // honest record of that limit.
  validatorVerdict: 'accepted',
});

const confidenceWordUnlicensedWord = makeConfidenceWordFixture({
  id: 'confidence-word-unlicensed-word',
  games: CONFIDENCE_TIER_BOUNDS.medium,
  prose: 'This is a vibes-based lock, trust the process.',
  // Review SH-WR-07: the lint judges a CLOSED vocabulary (the forbidden
  // strength words and the tier words); a strength word outside it ("lock")
  // is not recognised, so this prose is accepted. Kept as the honest record
  // of that limit.
  validatorVerdict: 'accepted',
});

// ---------------------------------------------------------------------------
// unknown_bucket / R7 — prose naming the unknown bucket as if it were a real
// stage. Under owner decision D-22 a lexical hit WITHHOLDS THE SECTION'S
// PROSE ONLY and never drops a claim, so every fixture here is labelled
// `stripped` ("prose stripped, claim survives"). R7's claim-level conviction
// lives on the claim's own ids (a stage/fighter id 0 or off-roster claim is
// rejected — `validateReport.test.ts`'s structural R7 battery), and the
// denominator half (unknown games never folded into a known rate) is proven
// where denominators are computed: the API row builder's tests
// (`apps/api/src/reports/generate.test.ts`).
// ---------------------------------------------------------------------------

// Both fixtures below derive their unknown-bucket size from the EXISTING
// `unknownStageOnlyWorkspace`/`unknownCharacterOnlyWorkspace` builders'
// own output length — never a re-declared literal — mirroring the
// `cold_start` family's discipline below.
const UNKNOWN_BUCKET_DENOMINATOR_UNKNOWN_COUNT = unknownStageOnlyWorkspace().length;
const UNKNOWN_BUCKET_DENOMINATOR_KNOWN_COUNT = 9;
const UNKNOWN_BUCKET_DENOMINATOR_TOTAL =
  UNKNOWN_BUCKET_DENOMINATOR_UNKNOWN_COUNT + UNKNOWN_BUCKET_DENOMINATOR_KNOWN_COUNT;

const unknownBucketInDenominator: AdversarialFixture = {
  id: 'unknown-bucket-in-denominator',
  family: 'unknown_bucket',
  rubricRuleIds: ['R7'],
  snapshot: (() => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23 };
    const rowId = evidenceIdFor({ predicate: 'stage_pick_rate', subject, opponentOrder: [] });
    // The unknown-stage bucket is counted INSIDE the denominator below. The
    // snapshot row is trusted input to the validator (its own
    // `eligibleDenominator` agrees), so nothing claim-level can see the
    // poisoning — this fixture convicts only through its prose, which names
    // the unknown bucket (D-22: prose withheld, claim survives).
    return makeSnapshot(
      {
        [rowId]: makeRow(
          'stage_pick_rate',
          subject,
          {
            kind: 'rate',
            numerator: UNKNOWN_BUCKET_DENOMINATOR_UNKNOWN_COUNT,
            denominator: UNKNOWN_BUCKET_DENOMINATOR_TOTAL,
          },
          UNKNOWN_BUCKET_DENOMINATOR_TOTAL,
        ),
      },
      {
        matchIdDigest: {
          count: UNKNOWN_BUCKET_DENOMINATOR_TOTAL,
          hash: 'fixture-unknown-bucket-denominator-hash',
        },
      },
    );
  })(),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim(
        'c01',
        [
          evidenceIdFor({
            predicate: 'stage_pick_rate',
            subject: { ...NULL_SUBJECT, myFighterId: 23 },
            opponentOrder: [],
          }),
        ],
        {
          kind: 'rate',
          numerator: UNKNOWN_BUCKET_DENOMINATOR_UNKNOWN_COUNT,
          denominator: UNKNOWN_BUCKET_DENOMINATOR_TOTAL,
        },
      ),
    ],
  },
  sections: [
    {
      prose: `They picked an unknown stage in ${UNKNOWN_BUCKET_DENOMINATOR_UNKNOWN_COUNT} of their ${UNKNOWN_BUCKET_DENOMINATOR_TOTAL} recorded games.`,
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

const UNKNOWN_BUCKET_NAMED_LOSSES = 2;
const UNKNOWN_BUCKET_NAMED_WINS = unknownCharacterOnlyWorkspace().length - 1;
const UNKNOWN_BUCKET_NAMED_GAMES = UNKNOWN_BUCKET_NAMED_WINS + UNKNOWN_BUCKET_NAMED_LOSSES;

const unknownBucketNamedAsRealStage: AdversarialFixture = {
  id: 'unknown-bucket-named-as-real-stage',
  family: 'unknown_bucket',
  rubricRuleIds: ['R7'],
  snapshot: (() => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23 };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    return makeSnapshot(
      {
        [rowId]: makeRow(
          'stage_record',
          subject,
          {
            kind: 'record',
            wins: UNKNOWN_BUCKET_NAMED_WINS,
            losses: UNKNOWN_BUCKET_NAMED_LOSSES,
            games: UNKNOWN_BUCKET_NAMED_GAMES,
          },
          UNKNOWN_BUCKET_NAMED_GAMES,
        ),
      },
      {
        matchIdDigest: {
          count: UNKNOWN_BUCKET_NAMED_GAMES,
          hash: 'fixture-unknown-bucket-named-hash',
        },
      },
    );
  })(),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim(
        'c01',
        [
          evidenceIdFor({
            predicate: 'stage_record',
            subject: { ...NULL_SUBJECT, myFighterId: 23 },
            opponentOrder: [],
          }),
        ],
        {
          kind: 'record',
          wins: UNKNOWN_BUCKET_NAMED_WINS,
          losses: UNKNOWN_BUCKET_NAMED_LOSSES,
          games: UNKNOWN_BUCKET_NAMED_GAMES,
        },
      ),
    ],
  },
  sections: [
    {
      // "Unknown Stage" is the engine's own explicit bucket label, named
      // here as if it were a real, pickable stage — the prose is withheld,
      // the claim (judged on its own ids) survives — D-22.
      prose: `They are ${UNKNOWN_BUCKET_NAMED_WINS}-${UNKNOWN_BUCKET_NAMED_LOSSES} on Unknown Stage, a strong pick for them.`,
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

// SH-WR-08: the PLURAL naming ("Unknown Stages") — the validator's lexical
// pattern once lacked `s?`, so this prose shipped while the VAL-03 judge
// (which has always matched plurals) convicted it.
const unknownBucketNamedPlural: AdversarialFixture = {
  ...unknownBucketNamedAsRealStage,
  id: 'unknown-bucket-named-plural',
  sections: [
    {
      prose: `Their Unknown Stages record is ${UNKNOWN_BUCKET_NAMED_WINS}-${UNKNOWN_BUCKET_NAMED_LOSSES}.`,
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

// ---------------------------------------------------------------------------
// sub_floor / R6 — an assertion resting on fewer than ABSTENTION_FLOOR_GAMES
// countable games.
// ---------------------------------------------------------------------------

const SUB_FLOOR_GAMES = ABSTENTION_FLOOR_GAMES - 1;
const SUB_FLOOR_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const SUB_FLOOR_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: SUB_FLOOR_SUBJECT,
  opponentOrder: [],
});

const subFloor: AdversarialFixture = {
  id: 'sub-floor-assertion',
  family: 'sub_floor',
  rubricRuleIds: ['R6'],
  snapshot: makeSnapshot(
    {
      [SUB_FLOOR_ROW_ID]: makeRow(
        'stage_record',
        SUB_FLOOR_SUBJECT,
        { kind: 'record', wins: SUB_FLOOR_GAMES, losses: 0, games: SUB_FLOOR_GAMES },
        SUB_FLOOR_GAMES,
      ),
    },
    { matchIdDigest: { count: SUB_FLOOR_GAMES, hash: 'fixture-sub-floor-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [SUB_FLOOR_ROW_ID], {
        kind: 'record',
        wins: SUB_FLOOR_GAMES,
        losses: 0,
        games: SUB_FLOOR_GAMES,
      }),
    ],
  },
  expected: { legacyAccepts: true, validatorVerdict: 'dropped' },
};

// ---------------------------------------------------------------------------
// tier_boundary — six snapshots at exactly low-1, low, medium-1, medium,
// high-1 and high countable games, tiers derived from `confidenceTierFor`,
// never typed as a literal.
// ---------------------------------------------------------------------------

function makeTierBoundaryFixture(games: number): AdversarialFixture {
  const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
  const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
  const value: ClaimValue = { kind: 'record', wins: games, losses: 0, games };
  return {
    id: `tier-boundary-${games}-games`,
    family: 'tier_boundary',
    rubricRuleIds: ['R6'],
    snapshot: makeSnapshot(
      { [rowId]: makeRow('stage_record', subject, value, games) },
      { matchIdDigest: { count: games, hash: `fixture-tier-boundary-${games}-hash` } },
    ),
    issuedClaimIds: ['c01'],
    output: { claims: [makeClaim('c01', [rowId], value)] },
    // Review SH-WR-07: below the abstention floor an evidenced assertion is
    // dropped under R6; at or above it the claim is accepted.
    expected: {
      legacyAccepts: true,
      validatorVerdict: games < ABSTENTION_FLOOR_GAMES ? 'dropped' : 'accepted',
    },
  };
}

const tierBoundaryFixtures = [
  CONFIDENCE_TIER_BOUNDS.low - 1,
  CONFIDENCE_TIER_BOUNDS.low,
  CONFIDENCE_TIER_BOUNDS.medium - 1,
  CONFIDENCE_TIER_BOUNDS.medium,
  CONFIDENCE_TIER_BOUNDS.high - 1,
  CONFIDENCE_TIER_BOUNDS.high,
].map(makeTierBoundaryFixture);

// ---------------------------------------------------------------------------
// cold_start — built from the EXISTING sparse-workspace builders
// (`testUtils/sparseWorkspaces.ts`), never re-declared. Includes a
// literally EMPTY `rows: {}` snapshot (review C1-H5): RTDB deletes a node
// written as `{}`, so this is the case where the persisted shape can read
// back missing its own required field.
// ---------------------------------------------------------------------------

const coldStartEmptySnapshot: AdversarialFixture = {
  id: 'cold-start-empty-snapshot',
  family: 'cold_start',
  rubricRuleIds: ['R6'],
  snapshot: makeSnapshot(
    {},
    { matchIdDigest: { count: emptyWorkspace().length, hash: 'fixture-cold-start-empty-hash' } },
  ),
  issuedClaimIds: [],
  output: { claims: [] },
  expected: { legacyAccepts: true, validatorVerdict: 'failed' },
};

function makeSparseCountFixture(id: string, matchCount: number): AdversarialFixture {
  return {
    id,
    family: 'cold_start',
    rubricRuleIds: ['R6'],
    snapshot: makeSnapshot(
      {},
      { matchIdDigest: { count: matchCount, hash: `fixture-${id}-hash` } },
    ),
    issuedClaimIds: [],
    output: { claims: [] },
    expected: { legacyAccepts: true, validatorVerdict: 'failed' },
  };
}

// The match counts below are READ from the builders' own output length —
// never re-declared as a literal — so a change to the builders is reflected
// here automatically and `rpt08Oracle.test.ts` can assert the builders are
// the source.
const coldStartOneGame = makeSparseCountFixture('cold-start-one-game', oneGameWorkspace().length);
const coldStartTwoGame = makeSparseCountFixture('cold-start-two-game', twoGameWorkspace().length);

// ---------------------------------------------------------------------------
// all_null_subject (review C2-H1) — a NAMED family of its own: the state
// this phase's own builder emits on every normal account for `recent_form`/
// `cohort_disclosure`, and the one real RTDB deletes all four axis keys
// from, then deletes `subject` itself.
// ---------------------------------------------------------------------------

const ALL_NULL_SUBJECT_RECENT_FORM_ROW_ID = evidenceIdFor({
  predicate: 'recent_form',
  subject: NULL_SUBJECT,
  opponentOrder: [],
});
const ALL_NULL_SUBJECT_COHORT_ROW_ID = evidenceIdFor({
  predicate: 'cohort_disclosure',
  subject: NULL_SUBJECT,
  opponentOrder: [],
});
const ALL_NULL_SUBJECT_ORDINARY_SUBJECT: ClaimSubject = {
  ...NULL_SUBJECT,
  myFighterId: 23,
  stageId: 1,
};
const ALL_NULL_SUBJECT_ORDINARY_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: ALL_NULL_SUBJECT_ORDINARY_SUBJECT,
  opponentOrder: [],
});
const ALL_NULL_SUBJECT_MY_CHARACTER_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23 };
const ALL_NULL_SUBJECT_MY_CHARACTER_ROW_ID = evidenceIdFor({
  predicate: 'my_character_record',
  subject: ALL_NULL_SUBJECT_MY_CHARACTER_SUBJECT,
  opponentOrder: [],
});

const allNullSubject: AdversarialFixture = {
  id: 'all-null-subject',
  family: 'all_null_subject',
  rubricRuleIds: ['R3'],
  snapshot: makeSnapshot(
    {
      [ALL_NULL_SUBJECT_RECENT_FORM_ROW_ID]: makeRow(
        'recent_form',
        NULL_SUBJECT,
        { kind: 'record', wins: 16, losses: 9, games: 25 },
        25,
      ),
      [ALL_NULL_SUBJECT_COHORT_ROW_ID]: makeRow(
        'cohort_disclosure',
        NULL_SUBJECT,
        { kind: 'count', count: 25 },
        25,
      ),
      [ALL_NULL_SUBJECT_ORDINARY_ROW_ID]: makeRow(
        'stage_record',
        ALL_NULL_SUBJECT_ORDINARY_SUBJECT,
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
      [ALL_NULL_SUBJECT_MY_CHARACTER_ROW_ID]: makeRow(
        'my_character_record',
        ALL_NULL_SUBJECT_MY_CHARACTER_SUBJECT,
        { kind: 'record', wins: 16, losses: 9, games: 25 },
        25,
      ),
    },
    { matchIdDigest: { count: 25, hash: 'fixture-all-null-subject-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [ALL_NULL_SUBJECT_RECENT_FORM_ROW_ID], {
        kind: 'record',
        wins: 16,
        losses: 9,
        games: 25,
      }),
    ],
  },
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

// ---------------------------------------------------------------------------
// action_unlinked / R8 — a non-null action slot referencing a claim id that
// was dropped (absent from `issuedClaimIds`).
// ---------------------------------------------------------------------------

const ACTION_UNLINKED_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const ACTION_UNLINKED_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: ACTION_UNLINKED_SUBJECT,
  opponentOrder: [],
});

const actionUnlinked: AdversarialFixture = {
  id: 'action-unlinked',
  family: 'action_unlinked',
  rubricRuleIds: ['R8'],
  snapshot: makeSnapshot(
    {
      [ACTION_UNLINKED_ROW_ID]: makeRow(
        'stage_record',
        ACTION_UNLINKED_SUBJECT,
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
    },
    { matchIdDigest: { count: 10, hash: 'fixture-action-unlinked-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [ACTION_UNLINKED_ROW_ID], { kind: 'record', wins: 6, losses: 4, games: 10 }),
    ],
  },
  // action1 references c09 — a claim id that was never issued for this job
  // (and so was, definitionally, "dropped"): the action slot points at
  // nothing surviving.
  actions: [{ actionId: 'a01', claimId: 'c09' }, null, null],
  expected: { legacyAccepts: true, validatorVerdict: 'dropped' },
};

// ---------------------------------------------------------------------------
// ordinary_prose — the NEGATIVE corpus (review C1-H4): realistic
// multi-sentence coaching English making NO unlicensed factual claim,
// deliberately loaded with words the prose lint could false-positive on,
// and (review C2-H3) carrying real, non-claim numerals in coaching idiom.
// ---------------------------------------------------------------------------

const ORDINARY_PROSE_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const ORDINARY_PROSE_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: ORDINARY_PROSE_SUBJECT,
  opponentOrder: [],
});

// Licensed claim values: 6, 4, 10 (the row below) and 62 (a rate numerator,
// below) — the "17" and "5th" numerals in the prose are deliberately absent
// from this set, so the digit rule is genuinely exercised (review C2-H3).
const ORDINARY_PROSE_TEXT = [
  'Unknown matchups are rare for this opponent, so trust what you already see on tape.',
  'A well-timed link punish could swing Game 1: X; if they swap to Y, counter with Z.',
  'Fox players in this bracket often crowd the ledge — never assume a cloud of pressure is safe to challenge.',
  'Hero mains sometimes gamble on a random spell; treat it as noise, not signal, in your gameplan.',
  'Peach floats are a constant threat, but pit your patience against her impatience and wait for an opening.',
  'A Snake main who wolfs down stage control early could pressure you into a bad approach — stay calm.',
  'Robin has a slow neutral, so a Temple layout with long sightlines could favor you more than a compact Summit.',
  'unknown is not the same as unsafe — treat an unfamiliar habit as a question to answer, not a threat to fear.',
  'Link his punish game to your own habits: could you tighten your ledge options before the next set?',
  'A calm gamer never panics off one bad game-1 pick; adjust and move on to the next stock.',
  'They almost always take their strike-order pick 3rd in a five-stage list, so plan your counterpick around it.',
  'Never assume their top-5 pick order tells you their true preference in a strike-order list — it might just be habit.',
  // Review SH-WR-01: tier words as ordinary Smash vocabulary, never a confidence claim.
  'Watch for their high recovery and low percent combos, and keep your shield high.',
].join(' ');

const ordinaryProse: AdversarialFixture = {
  id: 'ordinary-prose-negative-corpus',
  family: 'ordinary_prose',
  rubricRuleIds: ['R4', 'R5'],
  snapshot: makeSnapshot(
    {
      [ORDINARY_PROSE_ROW_ID]: makeRow(
        'stage_record',
        ORDINARY_PROSE_SUBJECT,
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
    },
    { matchIdDigest: { count: 10, hash: 'fixture-ordinary-prose-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [ORDINARY_PROSE_ROW_ID], { kind: 'record', wins: 6, losses: 4, games: 10 }),
    ],
  },
  sections: [{ prose: ORDINARY_PROSE_TEXT, licensedClaimIds: ['c01'] }],
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
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
  wellFormed,
  unissuedClaimId,
  proseEntityUnlicensedSameSection,
  proseEntityLicensedDifferentSection,
  proseEntityStageNameMismatch,
  proseEncodingFullwidthDigit,
  proseEncodingNfdOpponentTag,
  proseEncodingJaLocale,
  confidenceWordStrengthOnLowTier,
  confidenceWordHedgeOnHighTier,
  confidenceWordUnlicensedWord,
  unknownBucketInDenominator,
  unknownBucketNamedAsRealStage,
  subFloor,
  ...tierBoundaryFixtures,
  coldStartEmptySnapshot,
  coldStartOneGame,
  coldStartTwoGame,
  allNullSubject,
  actionUnlinked,
  ordinaryProse,
  unknownBucketNamedPlural,
];
