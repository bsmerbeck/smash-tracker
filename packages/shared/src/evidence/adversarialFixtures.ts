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
      // U+FF16/U+FF10 (fullwidth "6"/"0") — a fullwidth digit IS a digit.
      // Owner decision D-24: section commentary is qualitative only, so any
      // digit (fullwidth included) withholds the prose, even when a claim in
      // the section licenses its value (c01's 60%). The figure lives on the
      // claim line, never in the prose.
      prose: 'They picked this stage in roughly ６０% of games.',
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
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

// Code review R2-WR-03 (iteration 2): digits INSIDE a licensed opponent tag
// are part of the name, not figures — the tag consumes its span exactly as a
// canonical name does. A sentence-final digit-bearing tag used to be read as
// an unlicensed figure and withhold the section's prose. (A made-up tag:
// the corpus never carries a real account's.)
const PROSE_ENTITY_DIGIT_TAG = 'Zer0Frame';
const PROSE_ENTITY_DIGIT_TAG_SUBJECT: ClaimSubject = {
  ...NULL_SUBJECT,
  opponentTag: PROSE_ENTITY_DIGIT_TAG,
};
const PROSE_ENTITY_DIGIT_TAG_ROW_ID = evidenceIdFor({
  predicate: 'head_to_head_record',
  subject: PROSE_ENTITY_DIGIT_TAG_SUBJECT,
  opponentOrder: [PROSE_ENTITY_DIGIT_TAG],
});

const proseEntityDigitBearingTag: AdversarialFixture = {
  id: 'prose-entity-digit-bearing-tag',
  family: 'prose_entity',
  rubricRuleIds: ['R4'],
  snapshot: makeSnapshot(
    {
      [PROSE_ENTITY_DIGIT_TAG_ROW_ID]: makeRow(
        'head_to_head_record',
        PROSE_ENTITY_DIGIT_TAG_SUBJECT,
        { kind: 'record', wins: 3, losses: 2, games: 5 },
        5,
      ),
    },
    { matchIdDigest: { count: 5, hash: 'fixture-prose-entity-digit-tag-hash' } },
  ),
  issuedClaimIds: ['c01'],
  output: {
    claims: [
      makeClaim('c01', [PROSE_ENTITY_DIGIT_TAG_ROW_ID], {
        kind: 'record',
        wins: 3,
        losses: 2,
        games: 5,
      }),
    ],
  },
  sections: [
    {
      // D-24: qualitative commentary naming the tag. The tag's own "0" is
      // part of the name (consumed first), never a figure.
      prose: `Stay patient against ${PROSE_ENTITY_DIGIT_TAG} and punish the landing.`,
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
};

// Code review R3-CR-01 (iteration 3): head-to-head prose written from the
// OPPONENT's side. The licensed record is 3-2 (the player won 3). A W-L pair
// must be the exact ordered licensed pair from the player's side, and a
// section whose prose carries an opponent-perspective marker ("against you",
// "beat you", ...) withholds every pair in it, because the lint cannot tell
// whose record the pair states. Every fixture below is withheld: the
// inverted user-clause records (false), the unreversed opponent-subject
// record (false), and the reversed one (true, but not licensable).
function makeProseEntityPerspectiveFixture(input: {
  id: string;
  prose: string;
}): AdversarialFixture {
  return {
    ...proseEntityDigitBearingTag,
    id: input.id,
    snapshot: makeSnapshot(proseEntityDigitBearingTag.snapshot.rows, {
      matchIdDigest: { count: 5, hash: `fixture-${input.id}-hash` },
    }),
    sections: [{ prose: input.prose, licensedClaimIds: ['c01'] }],
    expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
  };
}

const proseEntityPerspectiveUserClauseTough = makeProseEntityPerspectiveFixture({
  id: 'prose-entity-perspective-user-clause-tough',
  prose: `${PROSE_ENTITY_DIGIT_TAG} is tough against you, and you are 2-3 in your sets.`,
});

const proseEntityPerspectiveUserClauseTrail = makeProseEntityPerspectiveFixture({
  id: 'prose-entity-perspective-user-clause-trail',
  prose: `${PROSE_ENTITY_DIGIT_TAG} vs you: you trail 2-3.`,
});

const proseEntityPerspectiveUserClauseSit = makeProseEntityPerspectiveFixture({
  id: 'prose-entity-perspective-user-clause-sit',
  prose: `${PROSE_ENTITY_DIGIT_TAG} has struggled against you, yet you sit at 2-3.`,
});

const proseEntityPerspectiveOpponentSubjectUnreversed = makeProseEntityPerspectiveFixture({
  id: 'prose-entity-perspective-opponent-subject-unreversed',
  prose: `${PROSE_ENTITY_DIGIT_TAG} is 3-2 against you.`,
});

const proseEntityPerspectiveOpponentSubjectReversed = makeProseEntityPerspectiveFixture({
  id: 'prose-entity-perspective-opponent-subject-reversed',
  prose: `${PROSE_ENTITY_DIGIT_TAG} is 2-3 against you.`,
});

const proseEntityPerspectiveSplitQuestion = makeProseEntityPerspectiveFixture({
  id: 'prose-entity-perspective-split-question',
  prose: `Against you? ${PROSE_ENTITY_DIGIT_TAG} is 3-2.`,
});

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
      // D-24: the record's own figures in any locale are still digits, so the
      // prose is withheld; the record lives on the claim line.
      prose: 'このステージでの成績は12勝4敗です。',
      licensedClaimIds: ['c01'],
    },
  ],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
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

// Code review R2-CR-02 (iteration 2): a tier word placed AWAY from the noun
// "confidence" still states a confidence tier when its sentence talks about
// confidence. On a low-tier claim each of these overstates the evidence, so
// each section's prose is withheld.
const confidenceWordTierAfterNoun = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-noun',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Confidence is high here.',
  validatorVerdict: 'stripped',
});

const confidenceWordTierInParenthetical = makeConfidenceWordFixture({
  id: 'confidence-word-tier-in-parenthetical',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1 (confidence: high).',
  validatorVerdict: 'stripped',
});

const confidenceWordTierEndOfSentence = makeConfidenceWordFixture({
  id: 'confidence-word-tier-end-of-sentence',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1, and our confidence in this read is high.',
  validatorVerdict: 'stripped',
});

// Code review R3-CR-02 (iteration 3): R5 must not depend on sentence
// splitting. The answer to a confidence QUESTION is a confidence statement,
// and a split on "? " or "! " moved the tier word out of the sentence that
// mentions confidence. On a low-tier claim every variant below overstates
// the evidence, so each section's prose is withheld.
const confidenceWordTierAfterQuestion = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-question',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Our confidence in this read? High.',
  validatorVerdict: 'stripped',
});

const confidenceWordTierAfterBareQuestion = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-bare-question',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Confidence? High.',
  validatorVerdict: 'stripped',
});

const confidenceWordTierAfterExclamation = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-exclamation',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Our confidence in this read! High.',
  validatorVerdict: 'stripped',
});

const confidenceWordTierAfterSemicolon = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-semicolon',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Our confidence in this read; high.',
  validatorVerdict: 'stripped',
});

const confidenceWordTierAfterNewline = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-newline',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Our confidence in this read\nHigh.',
  validatorVerdict: 'stripped',
});

const confidenceWordTierAfterDash = makeConfidenceWordFixture({
  id: 'confidence-word-tier-after-dash',
  games: CONFIDENCE_TIER_BOUNDS.low,
  prose: 'This stage record is 2-1. Our confidence in this read — high.',
  validatorVerdict: 'stripped',
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

// Owner decision D-24: section commentary is QUALITATIVE ONLY. This corpus is
// the qualitative coaching English a report is now asked to write — no
// digit, number word, W-L pair, percentage or confidence-tier word — still
// deliberately loaded with words the entity lint could false-positive on
// (lowercase and capitalised fighter/stage names, "unknown", "Game" plus a
// letter). It must ship untouched. Code review iteration 6 (R6-CR-01,
// R6-WR-01) lists "never" and "always" and reads a lone "X" as a roman
// numeral, so the sentences that used them now say "do not", "tend to" and
// "your pocket pick"; the price is pinned in `validateReport.test.ts`.
const ORDINARY_PROSE_TEXT = [
  'Unknown matchups are rare for this opponent, so trust what you already see on tape.',
  'A well-timed link punish could swing the opening game; if they swap characters, counter with your pocket pick.',
  'Fox players in this bracket often crowd the ledge — do not assume a cloud of pressure is safe to challenge.',
  'Hero mains sometimes gamble on a random spell; treat it as noise, not signal, in your gameplan.',
  'Peach floats are a constant threat, but pit your patience against her impatience and wait for an opening.',
  'A Snake main who wolfs down stage control early could pressure you into a bad approach — stay calm.',
  'Robin has a slow neutral, so a Temple layout with long sightlines could favor you more than a compact Summit.',
  'unknown is not the same as unsafe — treat an unfamiliar habit as a question to answer, not a threat to fear.',
  'Link his punish game to your own habits: could you tighten your ledge options before the next set?',
  'A calm gamer does not panic off a bad opening pick; adjust and move on to the next stock.',
  'They tend to take their strike-order pick late in a long stage list, so plan your counterpick around it.',
  'Do not assume their usual pick order tells you their true preference in a strike-order list — it might just be habit.',
  'Watch for their recovery and their combo starters, and keep your shield up.',
].join(' ');

// The PRE-D-24 negative corpus's numeric coaching idiom (review C2-H3): real,
// non-claim numerals ("Game 1", "top-5", "3rd", a licensed "6-4") and tier
// words used as Smash vocabulary ("high recovery", "low percent"). Under
// D-24 every one of these withholds the section's prose — disclosed, never
// refunded (D-22), and never a validation failure (the output's status is
// decided by claims alone). Kept so the price of D-24 stays visible.
// Licensed claim values: 6, 4, 10 (the row below); "17" and "5th" are not.
const ORDINARY_PROSE_NUMERIC_IDIOM_TEXT = [
  'A well-timed link punish could swing Game 1: X; if they swap to Y, counter with Z.',
  'A calm gamer never panics off one bad game-1 pick; adjust and move on to the next stock.',
  'They almost always take their strike-order pick 3rd in a five-stage list, so plan your counterpick around it.',
  'Never assume their top-5 pick order tells you their true preference in a strike-order list — it might just be habit.',
  'Your record here is 6-4, and they placed 17th and 5th at their last events.',
  // Review SH-WR-01: tier words as ordinary Smash vocabulary.
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

const ordinaryProseNumericIdiom: AdversarialFixture = {
  ...ordinaryProse,
  id: 'ordinary-prose-numeric-idiom',
  snapshot: makeSnapshot(ordinaryProse.snapshot.rows, {
    matchIdDigest: { count: 10, hash: 'fixture-ordinary-prose-numeric-idiom-hash' },
  }),
  sections: [{ prose: ORDINARY_PROSE_NUMERIC_IDIOM_TEXT, licensedClaimIds: ['c01'] }],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

// ---------------------------------------------------------------------------
// Owner decision D-24 (code review R4-CR-01 / R4-CR-02, iteration 4):
// section commentary is QUALITATIVE ONLY. A section's prose is withheld when
// it carries any digit (Unicode and fullwidth included), a spelled-out
// number word, a percentage, a W-L-like pair with any separator, or a
// confidence-tier word anywhere — true or false. Tag and name spans are
// consumed first, so "Zer0Frame" and "Pokémon Stadium 2" are names, not
// figures. Every head-to-head fixture below licenses 3-2 (the player won 3)
// against the made-up tag; every phrasing is FALSE except where noted, and
// every one is withheld.
// ---------------------------------------------------------------------------

const D24_RECORD_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  // R4-CR-01's separator bypasses (the em dash is the R3-CR-01 target).
  ['em-dash', `${PROSE_ENTITY_DIGIT_TAG} is 3—2 against you.`],
  ['to', `${PROSE_ENTITY_DIGIT_TAG} is 3 to 2 against you.`],
  ['colon', `${PROSE_ENTITY_DIGIT_TAG} is 3:2 against you.`],
  ['slash', `${PROSE_ENTITY_DIGIT_TAG} is 3/2 against you.`],
  ['minus-sign', `${PROSE_ENTITY_DIGIT_TAG} is 3 − 2 against you.`],
  ['lost-em-dash', `You have lost 3—2 to ${PROSE_ENTITY_DIGIT_TAG}.`],
  // Phrasings outside the retired closed marker list.
  ['leads-head-to-head', `${PROSE_ENTITY_DIGIT_TAG} leads the head-to-head 3-2.`],
  ['leads', `${PROSE_ENTITY_DIGIT_TAG} leads 3-2.`],
  ['up-on-you', `${PROSE_ENTITY_DIGIT_TAG} is up 3-2 on you.`],
  ['won-this-matchup', `${PROSE_ENTITY_DIGIT_TAG} has won this matchup 3-2.`],
  ['won-your-sets', `${PROSE_ENTITY_DIGIT_TAG} won your sets 3-2.`],
  ['holds-an-edge', `${PROSE_ENTITY_DIGIT_TAG} holds a 3-2 edge in your sets.`],
  ['better-of-you', `${PROSE_ENTITY_DIGIT_TAG} has gotten the better of you, 3-2.`],
  ['your-number', `${PROSE_ENTITY_DIGIT_TAG} has your number at 3-2.`],
  ['you-lost-head-to-head', 'You lost the head-to-head 3-2.'],
  ['you-are-down', `You are down 3-2 to ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['you-trail', `You trail ${PROSE_ENTITY_DIGIT_TAG} 3-2.`],
  ['in-your-meetings', `${PROSE_ENTITY_DIGIT_TAG} is 3-2 in your meetings.`],
  // The count form.
  ['won-of-your-sets', `${PROSE_ENTITY_DIGIT_TAG} has won 3 of your 5 sets.`],
  ['you-won-only', `You have won only 2 of 5 sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['took-sets', `${PROSE_ENTITY_DIGIT_TAG} took 3 sets, you took 2.`],
  ['you-are-seven-one', `You are 7-1 against ${PROSE_ENTITY_DIGIT_TAG}.`],
  // Spelled-out figures.
  ['spelled-three-and-two', `${PROSE_ENTITY_DIGIT_TAG} is three and two against you.`],
  ['spelled-sets-to', `${PROSE_ENTITY_DIGIT_TAG} leads the series three sets to two.`],
  ['spelled-seven-and-one', `You are seven and one against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['spelled-ordinal', `${PROSE_ENTITY_DIGIT_TAG} took the first set and never looked back.`],
  ['spelled-half', `Half of your sets against ${PROSE_ENTITY_DIGIT_TAG} went the distance.`],
  ['spelled-dozen', `You have played ${PROSE_ENTITY_DIGIT_TAG} a dozen times.`],
  ['spelled-twenty', `${PROSE_ENTITY_DIGIT_TAG} has twenty wins on the circuit.`],
  // TRUE, and withheld all the same: figures live on the claim line.
  ['true-player-record', `You are 3-2 against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['true-opponent-record', `${PROSE_ENTITY_DIGIT_TAG} is 2-3 against you.`],
];

const d24RecordFixtures: readonly AdversarialFixture[] = D24_RECORD_PHRASINGS.map(
  ([suffix, prose]) => makeProseEntityPerspectiveFixture({ id: `d24-record-${suffix}`, prose }),
);

// R4-CR-02: tier words without the "confiden" stem, a misspelt stem, the
// mixed case, and invisible characters inside the stem — each on a LOW-tier
// claim, so each is false; and each is withheld by the tier word itself.
const D24_TIER_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['how-sure', 'Take them to this stage. How sure should you be? High.'],
  ['certainty', 'Take them to this stage. Certainty: high.'],
  ['high-certainty', 'This is a high-certainty read.'],
  ['trust', 'Trust in this read: high.'],
  ['reliability', 'Reliability of this read: high.'],
  ['conviction', 'Our conviction here is high.'],
  ['misspelt', 'Our confidance here is high.'],
  ['caps', 'Our CONFIDENCE here is HIGH.'],
  ['soft-hyphen', 'Con\u00adfidence here is high.'],
  ['zero-width', 'Con\u200bfidence here is high.'],
  ['very-strong', 'Our confidence here: very strong.'],
  ['moderate', 'This is a moderate read at best.'],
  ['weak', 'The evidence for this pick is weak.'],
  ['medium', 'Treat this as a medium read.'],
  ['smash-sense', 'Keep your shield high and punish the low recovery.'],
  // The iteration-4 review's probe strings, verbatim (with the record).
  ['probe-certainty', 'Fox on Battlefield: 3-2. Certainty: high.'],
  ['probe-how-sure', 'Fox on Battlefield: 3-2. How sure should you be? High.'],
  ['probe-rock-solid', 'Fox on Battlefield: 3-2. This read is rock solid.'],
];

const d24TierFixtures: readonly AdversarialFixture[] = D24_TIER_PHRASINGS.map(([suffix, prose]) =>
  makeConfidenceWordFixture({
    id: `d24-tier-${suffix}`,
    games: CONFIDENCE_TIER_BOUNDS.low,
    prose,
    validatorVerdict: 'stripped',
  }),
);

// R4-CR-02's union case: one HIGH-tier and one LOW-tier claim in the same
// section. "high" is false for the thin claim, and the section cannot say
// which claim it means — withheld.
const D24_MIXED_TIER_HIGH_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
const D24_MIXED_TIER_LOW_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 59 };
const D24_MIXED_TIER_HIGH_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: D24_MIXED_TIER_HIGH_SUBJECT,
  opponentOrder: [],
});
const D24_MIXED_TIER_LOW_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: D24_MIXED_TIER_LOW_SUBJECT,
  opponentOrder: [],
});
const D24_MIXED_TIER_HIGH_VALUE: ClaimValue = {
  kind: 'record',
  wins: CONFIDENCE_TIER_BOUNDS.high - 1,
  losses: 1,
  games: CONFIDENCE_TIER_BOUNDS.high,
};
const D24_MIXED_TIER_LOW_VALUE: ClaimValue = {
  kind: 'record',
  wins: CONFIDENCE_TIER_BOUNDS.low - 1,
  losses: 1,
  games: CONFIDENCE_TIER_BOUNDS.low,
};

const d24MixedTierUnion: AdversarialFixture = {
  id: 'd24-tier-mixed-union',
  family: 'confidence_word',
  rubricRuleIds: ['R5'],
  snapshot: makeSnapshot(
    {
      [D24_MIXED_TIER_HIGH_ROW_ID]: makeRow(
        'stage_record',
        D24_MIXED_TIER_HIGH_SUBJECT,
        D24_MIXED_TIER_HIGH_VALUE,
        CONFIDENCE_TIER_BOUNDS.high,
      ),
      [D24_MIXED_TIER_LOW_ROW_ID]: makeRow(
        'stage_record',
        D24_MIXED_TIER_LOW_SUBJECT,
        D24_MIXED_TIER_LOW_VALUE,
        CONFIDENCE_TIER_BOUNDS.low,
      ),
    },
    { matchIdDigest: { count: 2, hash: 'fixture-d24-tier-mixed-union-hash' } },
  ),
  issuedClaimIds: ['c01', 'c02'],
  output: {
    claims: [
      makeClaim('c01', [D24_MIXED_TIER_HIGH_ROW_ID], D24_MIXED_TIER_HIGH_VALUE),
      makeClaim('c02', [D24_MIXED_TIER_LOW_ROW_ID], D24_MIXED_TIER_LOW_VALUE),
    ],
  },
  sections: [{ prose: 'Confidence in the thin read is high.', licensedClaimIds: ['c01', 'c02'] }],
  expected: { legacyAccepts: true, validatorVerdict: 'stripped' },
};

// The qualitative controls: commentary that names licensed entities and a
// digit-bearing canonical stage name, with no figure and no tier word, ships.
const d24QualitativeControlTag = makeProseEntityPerspectiveFixture({
  id: 'd24-qualitative-control-tag',
  prose: `${PROSE_ENTITY_DIGIT_TAG} likes to camp the ledge; take the centre and make them come to you.`,
});
const d24QualitativeControls: readonly AdversarialFixture[] = [
  {
    ...d24QualitativeControlTag,
    expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
  },
  {
    ...d24MixedTierUnion,
    id: 'd24-qualitative-control-stage-name',
    family: 'prose_entity',
    rubricRuleIds: ['R4'],
    snapshot: makeSnapshot(d24MixedTierUnion.snapshot.rows, {
      matchIdDigest: { count: 2, hash: 'fixture-d24-qualitative-control-stage-name-hash' },
    }),
    sections: [
      {
        prose:
          'Pokémon Stadium 2 rewards your patience, and Battlefield platforms suit your landing game.',
        licensedClaimIds: ['c01', 'c02'],
      },
    ],
    expected: { legacyAccepts: true, validatorVerdict: 'accepted' },
  },
];

// ---------------------------------------------------------------------------
// Code review iteration 5 (R5-CR-01..04, R5-IN-02): the phrasings the
// iteration-4 word lists missed — Markdown emphasis, exact number, record and
// quantifier words, ASCII roman numerals, exact tier synonyms and strength
// adjectives, non-English prose, and Unicode obfuscation (invisible
// characters, compatibility letterforms, Cyrillic homoglyphs, emoji). The
// D-24 check is now an allowlist over folded prose, so every one of these is
// withheld. Head-to-head fixtures license 3-2 against the made-up tag; tier
// fixtures sit on a LOW-tier claim. VAL-03 re-judges every one of them with
// its own procedure (`val03Acceptance.test.ts`).
// ---------------------------------------------------------------------------

const D24_R5_RECORD_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['md-underscore-pair', `You are _three and two_ against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['md-underscore-words', `You are _three_ and _two_ against ${PROSE_ENTITY_DIGIT_TAG}.`],
  [
    'md-underscore-ordinals',
    `You took the _first_ set off ${PROSE_ENTITY_DIGIT_TAG} and lost the _second_.`,
  ],
  ['md-underscore-half', `${PROSE_ENTITY_DIGIT_TAG} wins about _half_ your sets.`],
  ['md-underscore-strong', `${PROSE_ENTITY_DIGIT_TAG} is _strong_ against you.`],
  ['once', `You have beaten ${PROSE_ENTITY_DIGIT_TAG} once and never lost to them.`],
  [
    'pair-single',
    `You took a pair of sets from ${PROSE_ENTITY_DIGIT_TAG} and dropped a single set.`,
  ],
  ['couple', `You won a couple of sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['single', `${PROSE_ENTITY_DIGIT_TAG} has taken just a single set off you.`],
  ['both', `${PROSE_ENTITY_DIGIT_TAG} won both of your sets.`],
  ['none', `You have won none of your sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['trio-duo', `You took a trio of sets and lost a duo against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['quarter', `You win a quarter of your sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['eleventh', `This is your eleventh set against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['twentieth', `This is your twentieth set against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['undefeated', `You are undefeated against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['unbeaten', `You are unbeaten against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['winless', `You are winless against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['swept', `You swept ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['sweep', `Your history with ${PROSE_ENTITY_DIGIT_TAG} is a clean sweep.`],
  ['perfect-record', `You have a perfect record against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['roman-pair', `You are III-II against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['several', `You have lost several sets to ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['most', `You win most of your sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['few', `${PROSE_ENTITY_DIGIT_TAG} has taken few sets off you.`],
  ['many', `${PROSE_ENTITY_DIGIT_TAG} has taken many sets off you.`],
  ['majority', `You win the majority of your sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['minority', `${PROSE_ENTITY_DIGIT_TAG} wins only a minority of your sets.`],
  ['lang-es', `Estás tres a dos contra ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lang-fr', `Tu es à trois contre deux face à ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lang-de', `Du stehst drei zu zwei gegen ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lang-ja', `${PROSE_ENTITY_DIGIT_TAG}に三勝二敗。`],
  ['uni-cyrillic', `You are thr\u0435\u0435 and tw\u043e against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['uni-soft-hyphen', `You are thr\u00adee and tw\u00ado against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['uni-zero-width', `You are thr\u200bee and tw\u200bo against ${PROSE_ENTITY_DIGIT_TAG}.`],
  [
    'uni-fullwidth',
    `You are \uff54\uff48\uff52\uff45\uff45 and \uff54\uff57\uff4f against ${PROSE_ENTITY_DIGIT_TAG}.`,
  ],
  [
    'uni-math-bold',
    `You are \u{1d42d}\u{1d421}\u{1d42b}\u{1d41e}\u{1d41e} and \u{1d42d}\u{1d430}\u{1d428} against ${PROSE_ENTITY_DIGIT_TAG}.`,
  ],
  ['uni-ligature', `You won the \ufb01rst set against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['uni-emoji', `You have beaten ${PROSE_ENTITY_DIGIT_TAG} \u{1f51f} times.`],
  ['uni-dice', `You are \u2682-\u2681 against ${PROSE_ENTITY_DIGIT_TAG}.`],
];

const D24_R5_TIER_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['md-underscore', 'Our confidence here is _high_.'],
  ['md-double-underscore', 'Our confidence here is __high__.'],
  ['mid', 'Confidence: mid.'],
  ['hi', 'Confidence: hi.'],
  ['lo', 'Confidence: lo.'],
  ['middling', 'Confidence here is middling.'],
  ['top', 'Confidence: top.'],
  ['max', 'Confidence: max.'],
  ['poor', 'Confidence: poor.'],
  ['solid', 'Confidence: solid.'],
  ['reliable', 'This is a reliable read.'],
  ['shaky', 'This read is shaky.'],
  ['certain', 'This read is certain.'],
  ['sure', 'We are sure of this read.'],
  ['iffy', 'This read is iffy.'],
  ['lang-es', 'La confianza es alta.'],
  ['lang-de', 'Vertrauen hoch.'],
  ['uni-cyrillic', 'Our confidence here is h\u0456gh.'],
  ['uni-soft-hyphen', 'Our confidence here is hi\u00adgh.'],
  ['uni-combining', 'Our confidence here is h\u0332igh.'],
  ['uni-fullwidth', 'Our confidence here is \uff48\uff49\uff47\uff48.'],
];

const d24R5Fixtures: readonly AdversarialFixture[] = [
  ...D24_R5_RECORD_PHRASINGS.map(([suffix, prose]) =>
    makeProseEntityPerspectiveFixture({ id: `d24-r5-record-${suffix}`, prose }),
  ),
  ...D24_R5_TIER_PHRASINGS.map(([suffix, prose]) =>
    makeConfidenceWordFixture({
      id: `d24-r5-tier-${suffix}`,
      games: CONFIDENCE_TIER_BOUNDS.low,
      prose,
      validatorVerdict: 'stripped',
    }),
  ),
];

// ---------------------------------------------------------------------------
// Code review iteration 6 (R6-CR-01..04, R6-WR-01..03): the phrasings the
// iteration-5 check missed because it read a FOLDED copy of the prose while
// the product delivers the original — roman-numeral characters folded into
// letters, bidi overrides and tag characters deleted, Markdown markers inside
// a word read as spaces — and the forms the word lists missed: a listed word
// spelled out letter by letter, glued or stretched, ASCII roman numerals in
// any case, the unlisted all-or-nothing, even-record, margin and multiple
// words, and a count word after a digit-bearing name or tag. The D-24 check
// now reads the delivered text. VAL-03 requires every one of these to be
// withheld by the validator AND convicted by its own judge
// (`val03Acceptance.test.ts`). Invisible and bidi characters are escapes.
// ---------------------------------------------------------------------------

const D24_R6_RECORD_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['nl-v', `You took \u2164 games off ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['nl-xl', `You won \u2169\u216c games against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['nl-small-pair', `You are \u2172-\u2171 against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['nl-v-and-i', `You are \u2164 and \u2160 against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['roman-lower-pair', `You are iii-ii against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['roman-xl', `You won XL games against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['roman-v-to-i', `You lead ${PROSE_ENTITY_DIGIT_TAG} V to I.`],
  ['roman-x', `You took X games off ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['rlo-owt', `You beat ${PROSE_ENTITY_DIGIT_TAG} \u202eowt\u202c times.`],
  ['rli-owt', `You beat ${PROSE_ENTITY_DIGIT_TAG} \u2067owt\u2069 times.`],
  ['tag-digit', `You beat ${PROSE_ENTITY_DIGIT_TAG} \udb40\udc33 times.`],
  ['md-intraword-bold', `You beat ${PROSE_ENTITY_DIGIT_TAG} t**w**o times.`],
  ['md-intraword-code', `You are t\`w\`o up on ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['sep-hyphen', `You beat ${PROSE_ENTITY_DIGIT_TAG} t-w-o times.`],
  ['sep-dot', `You beat ${PROSE_ENTITY_DIGIT_TAG} t.w.o times.`],
  ['sep-space', `You beat ${PROSE_ENTITY_DIGIT_TAG} t w o times.`],
  ['sep-slash', `You beat ${PROSE_ENTITY_DIGIT_TAG} t/w/o times.`],
  ['every', `You won every set against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['all', `You won all your sets against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['never', `You never beat ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['always', `You always beat ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['yet-to-beat', `You are yet to beat ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['perfect', `You are perfect against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['nothing', `You have won nothing against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['zilch', `You have zilch wins against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['dead-even', `You are dead even with ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['tied', `You are tied with ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['split', `You split your sets with ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['coin-flip', `Your sets with ${PROSE_ENTITY_DIGIT_TAG} are a coin flip.`],
  ['a-set-each', `You and ${PROSE_ENTITY_DIGIT_TAG} have taken a set each.`],
  ['a-win-and-a-loss', `You have a win and a loss against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['up-a-set', `You are up a set on ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lead-by-a-game', `You lead ${PROSE_ENTITY_DIGIT_TAG} by a game.`],
  ['double', `You have double the wins ${PROSE_ENTITY_DIGIT_TAG} has.`],
  ['hat-trick', `You scored a hat trick of wins over ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['brace', `You took a brace of sets from ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lone', `Your lone win against ${PROSE_ENTITY_DIGIT_TAG} came late.`],
  ['only', `Your only win against ${PROSE_ENTITY_DIGIT_TAG} was close.`],
  ['sole', `Your sole loss to ${PROSE_ENTITY_DIGIT_TAG} was close.`],
  ['last-set', `You lost your last set to ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['shut-out', `${PROSE_ENTITY_DIGIT_TAG} has shut you out.`],
  ['blanked', `${PROSE_ENTITY_DIGIT_TAG} has blanked you.`],
  ['clean-record', `You have a clean record against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['spotless', `Your record against ${PROSE_ENTITY_DIGIT_TAG} is spotless.`],
  ['unblemished', `Your record against ${PROSE_ENTITY_DIGIT_TAG} is unblemished.`],
  ['glue-twotimes', `You beat ${PROSE_ENTITY_DIGIT_TAG} twotimes.`],
  ['glue-threeandtwo', `You are threeandtwo against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['stretch-twooo', `You beat ${PROSE_ENTITY_DIGIT_TAG} twooo times.`],
  ['tag-count', `${PROSE_ENTITY_DIGIT_TAG} wins keep piling up.`],
];

const D24_R6_TIER_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['rlo-hgih', 'Our confidence here is \u202ehgih\u202c.'],
  ['md-intraword-star', 'Our confidence here is h*igh*.'],
  ['md-intraword-underscore', 'Our confidence here is h_ig_h.'],
  ['sep-caps', 'Our confidence here is H-I-G-H.'],
  ['lowish', 'Our confidence here is lowish.'],
  ['minimal', 'Our confidence here is minimal.'],
  ['maximal', 'Our confidence here is maximal.'],
  ['glue-highconfidence', 'This is a highconfidence read.'],
  ['stretch-hiiigh', 'Our confidence here is hiiigh.'],
];

/** One stage_record claim for Marth on `stageId`, with `prose` in its own section. */
function makeStageNameFixture(input: {
  id: string;
  stageId: number;
  prose: string;
  validatorVerdict: AdversarialFixture['expected']['validatorVerdict'];
}): AdversarialFixture {
  const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: input.stageId };
  const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
  const games = CONFIDENCE_TIER_BOUNDS.low;
  const value: ClaimValue = { kind: 'record', wins: games - 1, losses: 1, games };
  return {
    id: input.id,
    family: 'prose_entity',
    rubricRuleIds: ['R4'],
    snapshot: makeSnapshot(
      { [rowId]: makeRow('stage_record', subject, value, games) },
      { matchIdDigest: { count: games, hash: `fixture-${input.id}-hash` } },
    ),
    issuedClaimIds: ['c01'],
    output: { claims: [makeClaim('c01', [rowId], value)] },
    sections: [{ prose: input.prose, licensedClaimIds: ['c01'] }],
    expected: { legacyAccepts: true, validatorVerdict: input.validatorVerdict },
  };
}

/** One head_to_head_record claim against `tag`, with `prose` in its own section. */
function makeTagFixture(input: {
  id: string;
  tag: string;
  prose: string;
  validatorVerdict: AdversarialFixture['expected']['validatorVerdict'];
}): AdversarialFixture {
  const subject: ClaimSubject = { ...NULL_SUBJECT, opponentTag: input.tag };
  const rowId = evidenceIdFor({
    predicate: 'head_to_head_record',
    subject,
    opponentOrder: [input.tag],
  });
  const games = CONFIDENCE_TIER_BOUNDS.low;
  const value: ClaimValue = { kind: 'record', wins: games - 1, losses: 1, games };
  return {
    id: input.id,
    family: 'prose_entity',
    rubricRuleIds: ['R4'],
    snapshot: makeSnapshot(
      { [rowId]: makeRow('head_to_head_record', subject, value, games) },
      { matchIdDigest: { count: games, hash: `fixture-${input.id}-hash` } },
    ),
    issuedClaimIds: ['c01'],
    output: { claims: [makeClaim('c01', [rowId], value)] },
    sections: [{ prose: input.prose, licensedClaimIds: ['c01'] }],
    expected: { legacyAccepts: true, validatorVerdict: input.validatorVerdict },
  };
}

const POKEMON_STADIUM_TWO = 59;
const PICTOCHAT_TWO = 99;
const MUSHROOM_KINGDOM_TWO = 15;
const FLAT_ZONE_TEN = 75;
const SEVENTY_FIVE_M = 31;

const D24_R6_NAME_COUNT_PHRASINGS: ReadonlyArray<readonly [string, number, string]> = [
  ['matches', POKEMON_STADIUM_TWO, 'Marth on Pok\u00e9mon Stadium 2 matches went your way.'],
  ['straight', POKEMON_STADIUM_TWO, 'You took Pok\u00e9mon Stadium 2 straight.'],
  ['in-a-row', POKEMON_STADIUM_TWO, 'You won Pok\u00e9mon Stadium 2 in a row.'],
  ['victories', POKEMON_STADIUM_TWO, 'Marth on Pok\u00e9mon Stadium 2 victories keep coming.'],
  ['rounds', POKEMON_STADIUM_TWO, 'Marth on Pok\u00e9mon Stadium 2 rounds went your way.'],
  ['pictochat', PICTOCHAT_TWO, 'Marth on PictoChat 2 matches.'],
  ['roman-name', MUSHROOM_KINGDOM_TWO, 'Marth on Mushroom Kingdom II matches.'],
  ['flat-zone', FLAT_ZONE_TEN, 'Marth on Flat Zone X matches.'],
  ['seventy-five-m', SEVENTY_FIVE_M, 'Marth on 75m matches.'],
  ['circled-glyph', POKEMON_STADIUM_TWO, 'Marth on Pok\u00e9mon Stadium \u2461, keep it up.'],
  ['nl-glyph', FLAT_ZONE_TEN, 'Marth on Flat Zone \u2169, keep it up.'],
];

const D24_R6_TAG_COUNT_PHRASINGS: ReadonlyArray<readonly [string, string, string]> = [
  ['times', 'Leo 2', 'You have beaten Leo 2 times.'],
  ['sets-in-a-row', 'Leo 2', 'You took Leo 2 sets in a row.'],
  ['games-straight', 'Zer0Frame 7', 'You beat Zer0Frame 7 games straight.'],
];

/** Over-strip controls: ordinary commentary near the new rules is delivered, and the judge must not convict it. */
const D24_R6_CONTROL_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['a-and-i', `I think a read on ${PROSE_ENTITY_DIGIT_TAG}'s landing will pay off.`],
  ['contractions', `It's a good idea to reset when ${PROSE_ENTITY_DIGIT_TAG} presses you.`],
  ['mix-and-di', `Mix up your options and improve your DI against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['i-frames', `Use your i-frames on the ledge when ${PROSE_ENTITY_DIGIT_TAG} presses you.`],
  [
    'contained-words',
    `The tone of the set often shifts when ${PROSE_ENTITY_DIGIT_TAG} is alone at the ledge; shift your weight and highlight the punish.`,
  ],
  ['brackets', `Watch the ledge [roll, jump, getup] when ${PROSE_ENTITY_DIGIT_TAG} is below you.`],
];

const d24R6Fixtures: readonly AdversarialFixture[] = [
  ...D24_R6_RECORD_PHRASINGS.map(([suffix, prose]) =>
    makeProseEntityPerspectiveFixture({ id: `d24-r6-record-${suffix}`, prose }),
  ),
  ...D24_R6_TIER_PHRASINGS.map(([suffix, prose]) =>
    makeConfidenceWordFixture({
      id: `d24-r6-tier-${suffix}`,
      games: CONFIDENCE_TIER_BOUNDS.low,
      prose,
      validatorVerdict: 'stripped',
    }),
  ),
  ...D24_R6_NAME_COUNT_PHRASINGS.map(([suffix, stageId, prose]) =>
    makeStageNameFixture({
      id: `d24-r6-name-${suffix}`,
      stageId,
      prose,
      validatorVerdict: 'stripped',
    }),
  ),
  ...D24_R6_TAG_COUNT_PHRASINGS.map(([suffix, tag, prose]) =>
    makeTagFixture({ id: `d24-r6-tag-${suffix}`, tag, prose, validatorVerdict: 'stripped' }),
  ),
  ...D24_R6_CONTROL_PHRASINGS.map(([suffix, prose]) => ({
    ...makeProseEntityPerspectiveFixture({ id: `d24-r6-control-${suffix}`, prose }),
    expected: { legacyAccepts: true, validatorVerdict: 'accepted' as const },
  })),
];

// ---------------------------------------------------------------------------
// Code review iteration 7 (R7-WR-01..03): NATURAL phrasings — what a model
// writing ordinary commentary might say, not deliberate obfuscation (the
// D-24 threat model) — that state a figure with words the iteration-6 lists
// did not hold: a zero side ("no wins", "not beaten", "without dropping a
// game", "a goose egg"), an even record ("level with", "all square",
// "parity", "deadlocked", "a stalemate", "deuce"), a whitewash, the jargon
// "JV", a count noun one or two words after a digit-bearing name or tag
// ("Leo 2 close sets", "Pokémon Stadium 2 series"), and a lone "I" read as
// the numeral one ("You took I set"). VAL-03 requires every one to be
// withheld by the validator AND convicted by the judge; every control must
// ship and pass the judge.
// ---------------------------------------------------------------------------

const D24_R7_RECORD_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['no-wins', `You have no wins against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-losses', `You have no losses to ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-sets', `You have taken no sets off ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-games', `${PROSE_ENTITY_DIGIT_TAG} has taken no games off you.`],
  ['not-beaten', `You have not beaten ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['havent-beaten', `You haven't beaten ${PROSE_ENTITY_DIGIT_TAG} yet.`],
  ['not-yet-won', `You have not yet won against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['not-lost-to', `You have not lost to ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['without-dropping', `You beat ${PROSE_ENTITY_DIGIT_TAG} without dropping a game.`],
  ['without-losing-any', `You beat ${PROSE_ENTITY_DIGIT_TAG} without losing any sets.`],
  ['goose-egg', `You have a goose egg against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['level-with', `You are level with ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['square-with', `You are square with ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['all-square', `You and ${PROSE_ENTITY_DIGIT_TAG} are all square.`],
  ['parity', `Your record against ${PROSE_ENTITY_DIGIT_TAG} sits at parity.`],
  ['deadlocked', `You and ${PROSE_ENTITY_DIGIT_TAG} are deadlocked.`],
  ['stalemate', `Your sets with ${PROSE_ENTITY_DIGIT_TAG} are a stalemate.`],
  ['whitewashed', `${PROSE_ENTITY_DIGIT_TAG} whitewashed you.`],
  ['deuce', `Your sets with ${PROSE_ENTITY_DIGIT_TAG} sit at deuce.`],
  ['jv', `You JV'd ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lone-i-set', `You took I set off ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lone-i-game', `You won I game against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['lone-i-stock', `You dropped I stock to ${PROSE_ENTITY_DIGIT_TAG}.`],
];

const D24_R7_NAME_COUNT_PHRASINGS: ReadonlyArray<readonly [string, number, string]> = [
  ['series', POKEMON_STADIUM_TWO, 'Marth on Pok\u00e9mon Stadium 2 series went your way.'],
  ['close-games', POKEMON_STADIUM_TWO, 'Marth took Pok\u00e9mon Stadium 2 close games.'],
  ['tournaments', PICTOCHAT_TWO, 'Marth on PictoChat 2 tournaments went your way.'],
];

const D24_R7_TAG_COUNT_PHRASINGS: ReadonlyArray<readonly [string, string, string]> = [
  ['close-sets', 'Leo 2', 'You lost to Leo 2 close sets.'],
  ['series', 'Leo 2', 'You dropped Leo 2 series.'],
  ['encounters', 'Leo 2', 'Leo 2 encounters went your way.'],
  ['bouts', 'Zer0Frame 3', 'Zer0Frame 3 bouts went your way.'],
  ['hard-fought-sets', 'Leo 2', 'You took Leo 2 hard-fought sets.'],
];

/** Over-strip controls: ordinary commentary near the R7 rules is delivered, and the judge must not convict it. */
const D24_R7_CONTROL_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['no-need', `No need to rush against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-reason', `There is no reason to chase ${PROSE_ENTITY_DIGIT_TAG} off stage.`],
  ['level-head', `Keep a level head when ${PROSE_ENTITY_DIGIT_TAG} presses you.`],
  ['without-dropping-combo', `Punish ${PROSE_ENTITY_DIGIT_TAG} without dropping a combo.`],
  ['i-set-up', `I set up the ledge trap early against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['i-lose', `When I lose a stock to ${PROSE_ENTITY_DIGIT_TAG}, I reset to neutral.`],
  ['tag-then-words', `${PROSE_ENTITY_DIGIT_TAG} plays a patient game, so wait him out.`],
  ['tag-then-possessive', `${PROSE_ENTITY_DIGIT_TAG} punishes your landing, so vary it.`],
];

const D24_R7_NAME_CONTROL_PHRASINGS: ReadonlyArray<readonly [string, number, string]> = [
  ['name-suits-your-game', POKEMON_STADIUM_TWO, 'Marth on Pok\u00e9mon Stadium 2 suits your game.'],
  [
    'name-and-its',
    POKEMON_STADIUM_TWO,
    'Pok\u00e9mon Stadium 2 and its transformations reward a patient Marth.',
  ],
];

const d24R7Fixtures: readonly AdversarialFixture[] = [
  ...D24_R7_RECORD_PHRASINGS.map(([suffix, prose]) =>
    makeProseEntityPerspectiveFixture({ id: `d24-r7-record-${suffix}`, prose }),
  ),
  ...D24_R7_NAME_COUNT_PHRASINGS.map(([suffix, stageId, prose]) =>
    makeStageNameFixture({
      id: `d24-r7-name-${suffix}`,
      stageId,
      prose,
      validatorVerdict: 'stripped',
    }),
  ),
  ...D24_R7_TAG_COUNT_PHRASINGS.map(([suffix, tag, prose]) =>
    makeTagFixture({ id: `d24-r7-tag-${suffix}`, tag, prose, validatorVerdict: 'stripped' }),
  ),
  ...D24_R7_CONTROL_PHRASINGS.map(([suffix, prose]) => ({
    ...makeProseEntityPerspectiveFixture({ id: `d24-r7-control-${suffix}`, prose }),
    expected: { legacyAccepts: true, validatorVerdict: 'accepted' as const },
  })),
  ...D24_R7_NAME_CONTROL_PHRASINGS.map(([suffix, stageId, prose]) =>
    makeStageNameFixture({
      id: `d24-r7-control-${suffix}`,
      stageId,
      prose,
      validatorVerdict: 'accepted',
    }),
  ),
];

// ---------------------------------------------------------------------------
// Code review iteration 8 (R8-WR-01, R8-WR-02): iteration 7's rules withheld
// ordinary commentary that shipped before them. After a digit-bearing name or
// tag, a pronoun or verb no longer bridges to a count noun — only a closed list
// of attributive words does ("close", "recent", "ranked"); and the singular
// "no set/win/game/stock" is a figure only when it is not attributive ("no set
// pattern", "no win condition" and "no set-ups" ship), "not won/beaten by" is
// the passive, and "not lost to his ..." names a habit. The probes keep the
// zero-side and count readings withheld; the controls are the reviewer's
// over-strip sentences, which must ship and pass the judge.
// ---------------------------------------------------------------------------

const D24_R8_RECORD_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['no-win-against', `You have no win against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-set-off', `You have taken no set off ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-set-wins', `You have no set wins against ${PROSE_ENTITY_DIGIT_TAG}.`],
  ['no-win-end', `Against ${PROSE_ENTITY_DIGIT_TAG} you have no win.`],
  ['not-lost-to-you', `${PROSE_ENTITY_DIGIT_TAG} has not lost to you.`],
  ['not-beaten-end', `${PROSE_ENTITY_DIGIT_TAG} is not beaten.`],
];

const D24_R8_TAG_COUNT_PHRASINGS: ReadonlyArray<readonly [string, string, string]> = [
  ['consecutive-games', 'Leo 2', 'You took Leo 2 consecutive games.'],
  ['recent-ranked-sets', 'Leo 2', 'You lost Leo 2 recent, ranked sets.'],
];

/** Over-strip controls: the reviewer's R8-WR-02 sentences. */
const D24_R8_CONTROL_PHRASINGS: ReadonlyArray<readonly [string, string]> = [
  ['no-set-pattern', `${PROSE_ENTITY_DIGIT_TAG} has no set pattern on ledge, so stay patient.`],
  [
    'no-set-answer',
    `There is no set answer to ${PROSE_ENTITY_DIGIT_TAG}'s ledge options; mix it up.`,
  ],
  [
    'no-win-condition',
    `Offstage ${PROSE_ENTITY_DIGIT_TAG} has no win condition, so edgeguard with confidence.`,
  ],
  ['no-set-ups', `${PROSE_ENTITY_DIGIT_TAG} has no set-ups from a missed tech chase.`],
  [
    'not-lost-to-his',
    `You have not lost to his ledge trap when you mix up getups against ${PROSE_ENTITY_DIGIT_TAG}.`,
  ],
  ['not-won-by', `Neutral against ${PROSE_ENTITY_DIGIT_TAG} is not won by rushing in.`],
  ['not-beaten-by', `${PROSE_ENTITY_DIGIT_TAG}'s shield is not beaten by pressure alone.`],
];

/** Over-strip controls: the reviewer's R8-WR-01 sentences after a digit-bearing tag ("Vex0" is made up and stands in for a tag such as the reviewer's; the corpus never carries a real account's). */
const D24_R8_TAG_CONTROL_PHRASINGS: ReadonlyArray<readonly [string, string, string]> = [
  ['plays-patient-games', 'Vex0', 'Vex0 plays patient games, so bait his shield.'],
  ['closes-out-games', 'Vex0', 'Vex0 closes out games with ledge traps.'],
  ['tends-to-win', 'Vex0', 'Vex0 tends to win exchanges near ledge.'],
  ['you-lose-stocks', 'Vex0', 'Against Vex0 you lose stocks to his up air.'],
  ['likes-long-sets', 'Leo 2', 'Leo 2 likes long sets and slows the pace.'],
];

/** Over-strip controls: the reviewer's R8-WR-01 sentences after the starter stage. */
const D24_R8_NAME_CONTROL_PHRASINGS: ReadonlyArray<readonly [string, number, string]> = [
  [
    'you-win-neutral',
    POKEMON_STADIUM_TWO,
    'On Pokémon Stadium 2 you win neutral with patient spacing.',
  ],
  ['you-trade-stocks', POKEMON_STADIUM_TWO, 'On Pokémon Stadium 2 you trade stocks too early.'],
  ['rewards-patient-games', POKEMON_STADIUM_TWO, 'Pokémon Stadium 2 rewards patient games.'],
];

const d24R8Fixtures: readonly AdversarialFixture[] = [
  ...D24_R8_RECORD_PHRASINGS.map(([suffix, prose]) =>
    makeProseEntityPerspectiveFixture({ id: `d24-r8-record-${suffix}`, prose }),
  ),
  ...D24_R8_TAG_COUNT_PHRASINGS.map(([suffix, tag, prose]) =>
    makeTagFixture({ id: `d24-r8-tag-${suffix}`, tag, prose, validatorVerdict: 'stripped' }),
  ),
  ...D24_R8_CONTROL_PHRASINGS.map(([suffix, prose]) => ({
    ...makeProseEntityPerspectiveFixture({ id: `d24-r8-control-${suffix}`, prose }),
    expected: { legacyAccepts: true, validatorVerdict: 'accepted' as const },
  })),
  ...D24_R8_TAG_CONTROL_PHRASINGS.map(([suffix, tag, prose]) =>
    makeTagFixture({ id: `d24-r8-control-${suffix}`, tag, prose, validatorVerdict: 'accepted' }),
  ),
  ...D24_R8_NAME_CONTROL_PHRASINGS.map(([suffix, stageId, prose]) =>
    makeStageNameFixture({
      id: `d24-r8-control-${suffix}`,
      stageId,
      prose,
      validatorVerdict: 'accepted',
    }),
  ),
];

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
  confidenceWordTierAfterNoun,
  confidenceWordTierInParenthetical,
  confidenceWordTierEndOfSentence,
  proseEntityDigitBearingTag,
  proseEntityPerspectiveUserClauseTough,
  proseEntityPerspectiveUserClauseTrail,
  proseEntityPerspectiveUserClauseSit,
  proseEntityPerspectiveOpponentSubjectUnreversed,
  proseEntityPerspectiveOpponentSubjectReversed,
  proseEntityPerspectiveSplitQuestion,
  confidenceWordTierAfterQuestion,
  confidenceWordTierAfterBareQuestion,
  confidenceWordTierAfterExclamation,
  confidenceWordTierAfterSemicolon,
  confidenceWordTierAfterNewline,
  confidenceWordTierAfterDash,
  ordinaryProseNumericIdiom,
  ...d24RecordFixtures,
  ...d24TierFixtures,
  d24MixedTierUnion,
  ...d24QualitativeControls,
  ...d24R5Fixtures,
  ...d24R6Fixtures,
  ...d24R7Fixtures,
  ...d24R8Fixtures,
];
