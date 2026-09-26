import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_FAMILIES,
  ADVERSARIAL_FIXTURES,
  RUBRIC_RULE_IDS,
  type AdversarialFamily,
  type AdversarialFixture,
} from './adversarialFixtures.js';
import {
  buildClaimSet,
  type ClaimAtom,
  type ClaimId,
  type ClaimSubject,
  type ClaimValue,
  type ReportSurface,
} from './claims.js';
import type { EvidenceRow, EvidenceSnapshot } from './snapshot.js';
import { evidenceIdFor } from './snapshot.js';
import { ABSTENTION_FLOOR_GAMES, EVIDENCE_POLICY_VERSION, confidenceTierFor } from './policy.js';
import {
  UNKNOWN_BUCKET_NAMED_PATTERN,
  validateReportOutput,
  type ReportSelectionOutput,
  type ReportSelectionSection,
  type ValidationOutcome,
} from './validateReport.js';
import type { SampleMeta } from './types.js';
import { SpriteList } from '../fighterData.js';
import { StageList } from '../stageData.js';

/**
 * VAL-03 (phase 39 plan 13): THE STOP-SHIP SUITE. Across the whole committed
 * adversarial corpus (`ADVERSARIAL_FIXTURES`, plan 39-01), the number of
 * unsupported factual claims that survive validation is ZERO.
 *
 * WHAT THIS PROVES: a property of the CODE. Every fixture is driven end to
 * end — its snapshot rows through `buildClaimSet` (the one builder), its
 * hand-authored model output through `validateReportOutput` (the one
 * validator) — and every claim that SURVIVES, plus every section of prose
 * that is not stripped, is re-judged by `judgeUnsupported` /
 * `judgeDeliveredProse` below, which recompute from the fixture's RAW
 * `snapshot.rows` per the rubric (`records/RPT-08-rubric.md`) and never from
 * the validator's own decisions. Green means nothing bad-shaped in this corpus
 * can be DELIVERED.
 *
 * WHAT THIS DOES NOT PROVE: how often the real model would attempt such an
 * output. The suite never calls a model; that frequency only moves the
 * drop-rate / refund-rate the owner reads in the PREP-06 readout (D-14), never
 * whether a bad output could ship. Do not read a green run as "the model never
 * tries".
 *
 * The count is conservative. A survivor is judged whether or not its output
 * reached `MIN_VIABLE_CLAIMS` (a `failed` output delivers nothing, so this can
 * only over-count, never under-count), and every non-stripped section's prose
 * is treated as delivered.
 */

/** A rubric rule id, as `records/RPT-08-rubric.md` declares them. */
export type RubricRuleId = (typeof RUBRIC_RULE_IDS)[number];

const ROSTER_FIGHTER_IDS: ReadonlySet<number> = new Set(SpriteList.map((fighter) => fighter.id));
const ROSTER_STAGE_IDS: ReadonlySet<number> = new Set(StageList.map((stage) => stage.id));
const SUBJECT_AXES = ['myFighterId', 'opponentFighterId', 'stageId', 'opponentTag'] as const;

function isAxisFree(subject: ClaimSubject): boolean {
  return SUBJECT_AXES.every((axis) => subject[axis] === null);
}

/** The rubric's R6 "countable games" for one row: the eligible denominator, or the raw sample size for an axis-free row. */
function countableGames(row: EvidenceRow): number {
  return isAxisFree(row.subject) ? row.sample.rawSampleSize : row.sample.eligibleDenominator;
}

/** True when a fighter/stage id is a real roster/stage-list entity rather than the unknown bucket (id 0) or any other non-entity id. */
function isRealEntityId(axis: 'fighter' | 'stage', id: number): boolean {
  return axis === 'fighter' ? ROSTER_FIGHTER_IDS.has(id) : ROSTER_STAGE_IDS.has(id);
}

/** Integer-for-integer equality between an asserted value and the value a cited row stores. */
function sameFigures(asserted: ClaimValue, stored: ClaimValue): boolean {
  if (asserted.kind === 'record' && stored.kind === 'record') {
    return (
      asserted.wins === stored.wins &&
      asserted.losses === stored.losses &&
      asserted.games === stored.games
    );
  }
  if (asserted.kind === 'rate' && stored.kind === 'rate') {
    return asserted.numerator === stored.numerator && asserted.denominator === stored.denominator;
  }
  if (asserted.kind === 'count' && stored.kind === 'count') {
    return asserted.count === stored.count;
  }
  if (asserted.kind === 'entity' && stored.kind === 'entity') {
    return asserted.entityKind === stored.entityKind && asserted.entityId === stored.entityId;
  }
  return false;
}

/**
 * THE INDEPENDENT JUDGE (review C1-H9). Decides, from the snapshot's RAW
 * `rows` alone, whether `claim` is UNSUPPORTED under the rubric, returning the
 * id of the first rule that convicts it or `null`.
 *
 * It MUST NOT read the fixture's hand-written expectation record — not the
 * validator verdict, not the legacy verdict, not any field of it. That record
 * is written by the same executor who wrote the fixture, so grading against it
 * would make VAL-03's zero the corpus restating its own labelling (plan
 * 39-04's own verdict check, counted instead of asserted). This function takes
 * no fixture at all, only the snapshot and the claim, which enforces that by
 * construction; a grep gate in plan 39-13 enforces it textually.
 *
 * Rules, each mechanically re-checkable without the validator:
 * - R1: the claim cites at least one evidence id, and every one is a key of
 *   `snapshot.rows`.
 * - R3: every cited row has the claim's predicate, and every non-null subject
 *   axis of the claim appears in at least one cited row.
 * - R6: an evidenced (non-abstained) value rests on at least
 *   `ABSTENTION_FLOOR_GAMES` countable games in EVERY cited row (the raw
 *   sample size for an axis-free row, per the rubric).
 * - R2: an evidenced value equals the value EVERY cited row stores, integer
 *   for integer (a rate compared as its numerator/denominator pair, never a
 *   derived float). An abstained value carries no figure any surface renders,
 *   so there is nothing to rebuild.
 * - R7: a rate's denominator equals every cited row's eligible (known-field)
 *   denominator, and an evidenced claim never names the unknown bucket (or any
 *   non-roster id) as a real fighter or stage, in its subject or its value.
 *
 * The prose rules (R4, R5) are not re-derived here: this judge sees a claim,
 * not a section. The one prose fault that is a fact about the evidence (R7's
 * unknown-bucket naming) is re-judged by `judgeDeliveredProse` below.
 */
export function judgeUnsupported(
  snapshot: EvidenceSnapshot,
  claim: ClaimAtom,
): RubricRuleId | null {
  if (claim.evidenceIds.length === 0) {
    return 'R1';
  }
  const rows: EvidenceRow[] = [];
  for (const evidenceId of claim.evidenceIds) {
    if (!Object.prototype.hasOwnProperty.call(snapshot.rows, evidenceId)) {
      return 'R1';
    }
    rows.push(snapshot.rows[evidenceId]!);
  }

  if (rows.some((row) => row.predicate !== claim.predicate)) {
    return 'R3';
  }
  for (const axis of SUBJECT_AXES) {
    const value = claim.subject[axis];
    if (value !== null && !rows.some((row) => row.subject[axis] === value)) {
      return 'R3';
    }
  }

  if (claim.value.kind === 'abstained') {
    return null;
  }

  if (rows.some((row) => countableGames(row) < ABSTENTION_FLOOR_GAMES)) {
    return 'R6';
  }

  if (rows.some((row) => !sameFigures(claim.value, row.value))) {
    return 'R2';
  }

  const value = claim.value;
  if (value.kind === 'rate') {
    if (rows.some((row) => value.denominator !== row.sample.eligibleDenominator)) {
      return 'R7';
    }
  }
  if (value.kind === 'entity') {
    const axis =
      value.entityKind === 'fighter' || value.entityKind === 'stage' ? value.entityKind : null;
    if (axis !== null && !isRealEntityId(axis, Number(value.entityId))) {
      return 'R7';
    }
  }
  const fighterAxes = [claim.subject.myFighterId, claim.subject.opponentFighterId];
  if (fighterAxes.some((id) => id !== null && !isRealEntityId('fighter', id))) {
    return 'R7';
  }
  if (claim.subject.stageId !== null && !isRealEntityId('stage', claim.subject.stageId)) {
    return 'R7';
  }

  return null;
}

/** The unknown bucket named as a thing, e.g. "Unknown Stage" or "an unknown character". */
const UNKNOWN_BUCKET_NAMING = /\bunknown\s+(?:stage|character)s?\b/iu;

/**
 * R7's lexical half, re-judged on DELIVERED prose: a section whose prose was
 * not stripped must not name the unknown stage/character bucket as if it were
 * a real, pickable entity (rubric R7). Reads only the prose text.
 */
export function judgeDeliveredProse(prose: string): RubricRuleId | null {
  return UNKNOWN_BUCKET_NAMING.test(prose.normalize('NFC')) ? 'R7' : null;
}

// ---------------------------------------------------------------------------
// The end-to-end pipeline. Nothing below reads a fixture's expectation record.
// ---------------------------------------------------------------------------

/** Survivors are surface-independent (the surface only sets the output's `MIN_VIABLE_CLAIMS` status); one surface is enough for the count. */
const SURFACE: ReportSurface = 'scout';

const ZERO_SAMPLE: SampleMeta = {
  rawSampleSize: 0,
  eligibleDenominator: 0,
  knownFieldCoverage: 0,
  dateRange: null,
  refreshedAt: 0,
  evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
  recencyTreatment: 'unweighted',
  confidenceTier: null,
};

/** The metadata of a claim whose citation points at no row at all (the `citation_missing` family): nothing to inherit from the builder. */
function phantomAtom(id: ClaimId): ClaimAtom {
  return {
    id,
    predicate: 'stage_record',
    subject: { myFighterId: null, opponentFighterId: null, stageId: null, opponentTag: null },
    value: { kind: 'abstained', gamesNeeded: ABSTENTION_FLOOR_GAMES },
    claimKind: 'fact',
    evidenceIds: [],
    tier: null,
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: ZERO_SAMPLE,
  };
}

/**
 * The claims a fixture's adversarial output tries to deliver. Each one starts
 * from the atom `buildClaimSet` issued for the row it cites (predicate,
 * subject, sample, tier, kind all come from the builder), then carries the
 * output's own claim id, citation and ASSERTED value — the untrusted part. An
 * output claim id outside the fixture's issued set is not issued at all, so it
 * reaches the validator as a selection with no atom behind it.
 */
function adversarialIssuedClaims(fixture: AdversarialFixture): ClaimAtom[] {
  const issuedByEngine = buildClaimSet({ rows: fixture.snapshot.rows, surface: SURFACE }).claims;
  return fixture.output.claims
    .filter((claim) => fixture.issuedClaimIds.includes(claim.claimId as ClaimId))
    .map((claim) => {
      const id = claim.claimId as ClaimId;
      const base =
        issuedByEngine.find((atom) =>
          claim.evidenceIds.some((evidenceId) => atom.evidenceIds.includes(evidenceId)),
        ) ?? phantomAtom(id);
      return { ...base, id, evidenceIds: [...claim.evidenceIds], value: claim.assertedValue };
    });
}

/** The fixture's selection: one section per prose section (plus a prose-free carrier for any claim no section references), or one prose-free section selecting every output claim. */
function adversarialSelection(fixture: AdversarialFixture): ReportSelectionOutput {
  const sections: Record<string, ReportSelectionSection> = {};
  const outputClaimIds = fixture.output.claims.map((claim) => claim.claimId as ClaimId);
  if (fixture.sections && fixture.sections.length > 0) {
    fixture.sections.forEach((section, index) => {
      sections[`section-${index}`] = {
        claimIds: section.licensedClaimIds,
        connective: section.prose,
      };
    });
    const referenced = new Set(Object.values(sections).flatMap((section) => section.claimIds));
    const carried = outputClaimIds.filter((id) => !referenced.has(id));
    if (carried.length > 0) {
      sections['claims-carrier'] = { claimIds: carried, connective: '' };
    }
  } else {
    sections.main = { claimIds: outputClaimIds, connective: '' };
  }
  const [action1, action2, action3] = fixture.actions ?? [null, null, null];
  return { sections, action1, action2, action3 };
}

type PipelinePath = 'adversarial' | 'engine';

interface PipelineRun {
  fixtureId: string;
  family: AdversarialFamily;
  path: PipelinePath;
  snapshot: EvidenceSnapshot;
  issuedClaims: readonly ClaimAtom[];
  selection: ReportSelectionOutput;
  outcome: ValidationOutcome;
}

/** Drives one fixture's adversarial output through the builder and the validator. */
function runAdversarial(fixture: AdversarialFixture): PipelineRun {
  const issuedClaims = adversarialIssuedClaims(fixture);
  const selection = adversarialSelection(fixture);
  const outcome = validateReportOutput({
    snapshot: fixture.snapshot,
    issuedClaims,
    output: selection,
    surface: SURFACE,
  });
  return {
    fixtureId: fixture.id,
    family: fixture.family,
    path: 'adversarial',
    snapshot: fixture.snapshot,
    issuedClaims,
    selection,
    outcome,
  };
}

/** Drives the same snapshot's ENGINE issue (every claim `buildClaimSet` emits, all selected, no prose) through the validator — the builder's own output is judged too. */
function runEngine(
  fixture: AdversarialFixture,
  transform?: (claim: ClaimAtom) => ClaimAtom,
): PipelineRun {
  const built = buildClaimSet({ rows: fixture.snapshot.rows, surface: SURFACE }).claims;
  const issuedClaims = transform ? built.map(transform) : built;
  const selection: ReportSelectionOutput = {
    sections: { engine: { claimIds: issuedClaims.map((claim) => claim.id), connective: '' } },
    action1: null,
    action2: null,
    action3: null,
  };
  const outcome = validateReportOutput({
    snapshot: fixture.snapshot,
    issuedClaims,
    output: selection,
    surface: SURFACE,
  });
  return {
    fixtureId: fixture.id,
    family: fixture.family,
    path: 'engine',
    snapshot: fixture.snapshot,
    issuedClaims,
    selection,
    outcome,
  };
}

interface Conviction {
  fixtureId: string;
  path: PipelinePath;
  claimId: string | null;
  sectionId: string | null;
  rule: RubricRuleId;
}

/** Every surviving claim the judge convicts, plus every delivered section whose prose the judge convicts. */
function convictionsOf(run: PipelineRun): Conviction[] {
  const convictions: Conviction[] = [];
  const issuedById = new Map(run.issuedClaims.map((claim) => [claim.id as string, claim]));
  for (const claimId of run.outcome.survivingClaimIds) {
    const claim = issuedById.get(claimId);
    // A survivor with no issued atom behind it cannot be recomputed at all: R1.
    const rule = claim ? judgeUnsupported(run.snapshot, claim) : 'R1';
    if (rule !== null) {
      convictions.push({
        fixtureId: run.fixtureId,
        path: run.path,
        claimId,
        sectionId: null,
        rule,
      });
    }
  }
  const stripped = new Set(run.outcome.strippedSectionIds);
  for (const [sectionId, section] of Object.entries(run.selection.sections)) {
    if (stripped.has(sectionId)) {
      continue;
    }
    const rule = judgeDeliveredProse(section.connective);
    if (rule !== null) {
      convictions.push({
        fixtureId: run.fixtureId,
        path: run.path,
        claimId: null,
        sectionId,
        rule,
      });
    }
  }
  return convictions;
}

function describeConvictions(convictions: readonly Conviction[]): string {
  return convictions
    .map(
      (c) =>
        `fixture "${c.fixtureId}" (${c.path} path): ${
          c.claimId !== null ? `claim ${c.claimId}` : `delivered section "${c.sectionId}"`
        } survived validation but the independent judge convicts it under ${c.rule}`,
    )
    .join('\n');
}

/** +1 on the first figure a value asserts; `null` for a value with no figure (an entity or an abstention). */
function perturbFigure(value: ClaimValue): ClaimValue | null {
  switch (value.kind) {
    case 'record':
      return { ...value, wins: value.wins + 1 };
    case 'rate':
      return { ...value, numerator: value.numerator + 1 };
    case 'count':
      return { ...value, count: value.count + 1 };
    case 'entity':
    case 'abstained':
      return null;
  }
}

/** The metamorphic transform (C1-H9): every asserted figure in the fixture's output, +1. A pure function of the fixture's output and nothing else. */
function perturbAssertedFigures(fixture: AdversarialFixture): AdversarialFixture {
  return {
    ...fixture,
    output: {
      claims: fixture.output.claims.map((claim) => ({
        ...claim,
        assertedValue: perturbFigure(claim.assertedValue) ?? claim.assertedValue,
      })),
    },
  };
}

/**
 * Families whose fixtures carry a fault the pipeline must REJECT, taken from
 * the family column of `records/RPT-08-rubric.md`'s rule table. Rejection is
 * observed on the validator's outcome (a dropped claim or action, a stripped
 * section, or — for a cold start — a failed output with nothing surviving);
 * this is the non-vacuity check that the suite has cases which must fail, not
 * the VAL-03 count.
 */
const MUST_REJECT_FAMILIES: readonly AdversarialFamily[] = [
  'wrong_value',
  'citation_missing',
  'unissued_claim_id',
  'prose_entity',
  'confidence_word',
  'unknown_bucket',
  'sub_floor',
  'tier_boundary',
  'cold_start',
  'action_unlinked',
];

function wasRejected(run: PipelineRun): boolean {
  const { outcome } = run;
  return (
    outcome.droppedClaimCount > 0 ||
    outcome.strippedSectionIds.length > 0 ||
    (outcome.status === 'failed' && outcome.survivingClaimIds.length === 0)
  );
}

const ADVERSARIAL_RUNS: readonly PipelineRun[] = ADVERSARIAL_FIXTURES.map(runAdversarial);
const ENGINE_RUNS: readonly PipelineRun[] = ADVERSARIAL_FIXTURES.map((fixture) =>
  runEngine(fixture),
);
const ALL_RUNS: readonly PipelineRun[] = [...ADVERSARIAL_RUNS, ...ENGINE_RUNS];

describe('VAL-03 stop-ship: zero unsupported factual claims survive the full adversarial corpus', () => {
  it('the corpus is non-empty and at least as large as the declared family list', () => {
    expect(ADVERSARIAL_FIXTURES.length).toBeGreaterThan(0);
    expect(ADVERSARIAL_RUNS.length).toBe(ADVERSARIAL_FIXTURES.length);
    expect(ADVERSARIAL_RUNS.length).toBeGreaterThanOrEqual(ADVERSARIAL_FAMILIES.length);
  });

  it('every declared family contributed at least one fixture to the run', () => {
    const contributed = new Set(ADVERSARIAL_RUNS.map((run) => run.family));
    const missing = ADVERSARIAL_FAMILIES.filter((family) => !contributed.has(family));
    expect(missing, `declared families with no fixture in the run: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('the judge actually judged something: the run has surviving claims and at least one output that clears MIN_VIABLE_CLAIMS', () => {
    const judged = ALL_RUNS.reduce((sum, run) => sum + run.outcome.survivingClaimIds.length, 0);
    expect(judged).toBeGreaterThan(0);
    expect(ALL_RUNS.some((run) => run.outcome.status === 'passed')).toBe(true);
  });

  it('VAL-03: across every fixture, on both the adversarial and the engine path, the independent judge convicts ZERO survivors', () => {
    const convictions = ALL_RUNS.flatMap(convictionsOf);
    expect(convictions, describeConvictions(convictions)).toEqual([]);
    expect(convictions.length).toBe(0);
  });

  it('the control survives: the well_formed fixture keeps its claim, so the validator is not rejecting everything', () => {
    const controls = ADVERSARIAL_RUNS.filter((run) => run.family === 'well_formed');
    expect(controls.length).toBeGreaterThan(0);
    for (const run of controls) {
      expect(run.outcome.survivingClaimIds.length, run.fixtureId).toBeGreaterThan(0);
      expect(run.outcome.droppedClaims, run.fixtureId).toEqual([]);
      expect(run.outcome.strippedSectionIds, run.fixtureId).toEqual([]);
    }
  });

  it.each(MUST_REJECT_FAMILIES)(
    'the %s family has at least one fixture the pipeline rejects',
    (family) => {
      const runs = ADVERSARIAL_RUNS.filter((run) => run.family === family);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.some(wasRejected)).toBe(true);
    },
  );

  it('C1-H9 metamorphic proof: +1 on every well_formed asserted figure drops the survivor count to zero, and the judge convicts every perturbed claim under R2', () => {
    // This is what makes the stop-ship number a measurement of the CODE
    // rather than of the corpus's own labelling: no expectation field is
    // read, the transform is pure, and a validator or judge that agreed with
    // whatever it was given would leave the perturbed claims standing.
    const controls = ADVERSARIAL_FIXTURES.filter((fixture) => fixture.family === 'well_formed');
    expect(controls.length).toBeGreaterThan(0);
    for (const fixture of controls) {
      const baseline = runAdversarial(fixture);
      expect(baseline.outcome.survivingClaimIds.length, fixture.id).toBeGreaterThan(0);

      const mutated = runAdversarial(perturbAssertedFigures(fixture));
      expect(mutated.issuedClaims.length, fixture.id).toBeGreaterThan(0);
      expect(mutated.outcome.survivingClaimIds, fixture.id).toEqual([]);
      for (const claim of mutated.issuedClaims) {
        expect(judgeUnsupported(fixture.snapshot, claim), `${fixture.id} ${claim.id}`).toBe('R2');
      }
    }
  });

  it('C1-H9 metamorphic proof on the engine path: +1 on every figure the builder issues, across the corpus, leaves no perturbed claim standing', () => {
    let perturbed = 0;
    for (const fixture of ADVERSARIAL_FIXTURES) {
      const perturbedIds = new Set<string>();
      const run = runEngine(fixture, (claim) => {
        const value = perturbFigure(claim.value);
        if (value === null) {
          return claim;
        }
        perturbedIds.add(claim.id);
        return { ...claim, value };
      });
      perturbed += perturbedIds.size;
      const standing = run.outcome.survivingClaimIds.filter((id) => perturbedIds.has(id));
      expect(standing, fixture.id).toEqual([]);
      for (const claim of run.issuedClaims.filter((atom) => perturbedIds.has(atom.id))) {
        expect(judgeUnsupported(fixture.snapshot, claim), `${fixture.id} ${claim.id}`).toBe('R2');
      }
    }
    expect(perturbed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The judge's own unit tests: one supported claim, one violation per rule.
// ---------------------------------------------------------------------------

const MARTH = 23;
const BATTLEFIELD = 1;
const UNKNOWN_BUCKET_ID = 0;
const JUDGE_GAMES = 10;

function judgeSample(games: number, overrides: Partial<SampleMeta> = {}): SampleMeta {
  return {
    rawSampleSize: games,
    eligibleDenominator: games,
    knownFieldCoverage: 1,
    dateRange: null,
    refreshedAt: 0,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: 'unweighted',
    confidenceTier: confidenceTierFor(games),
    ...overrides,
  };
}

const STAGE_SUBJECT: ClaimSubject = {
  myFighterId: MARTH,
  opponentFighterId: null,
  stageId: BATTLEFIELD,
  opponentTag: null,
};
const STAGE_ROW_ID = evidenceIdFor({
  predicate: 'stage_record',
  subject: STAGE_SUBJECT,
  opponentOrder: [],
});
const RATE_SUBJECT: ClaimSubject = { ...STAGE_SUBJECT, myFighterId: null };
const RATE_ROW_ID = evidenceIdFor({
  predicate: 'stage_pick_rate',
  subject: RATE_SUBJECT,
  opponentOrder: [],
});

function judgeSnapshot(rows: Record<string, EvidenceRow>): EvidenceSnapshot {
  return {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: 1,
    refreshedAt: 0,
    cohort: {
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
    },
    rows,
    matchIdDigest: { count: 0, hash: 'judge-unit-test' },
  };
}

const JUDGE_SNAPSHOT = judgeSnapshot({
  [STAGE_ROW_ID]: {
    predicate: 'stage_record',
    subject: STAGE_SUBJECT,
    value: { kind: 'record', wins: 6, losses: 4, games: JUDGE_GAMES },
    sample: judgeSample(JUDGE_GAMES),
  },
  [RATE_ROW_ID]: {
    predicate: 'stage_pick_rate',
    subject: RATE_SUBJECT,
    value: { kind: 'rate', numerator: 4, denominator: JUDGE_GAMES },
    sample: judgeSample(JUDGE_GAMES),
  },
});

function supportedClaim(overrides: Partial<ClaimAtom> = {}): ClaimAtom {
  return {
    id: 'c01',
    predicate: 'stage_record',
    subject: STAGE_SUBJECT,
    value: { kind: 'record', wins: 6, losses: 4, games: JUDGE_GAMES },
    claimKind: 'fact',
    evidenceIds: [STAGE_ROW_ID],
    tier: confidenceTierFor(JUDGE_GAMES),
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: judgeSample(JUDGE_GAMES),
    ...overrides,
  };
}

describe('judgeUnsupported: the independent rubric recompute (C1-H9)', () => {
  it('a claim the snapshot supports returns null', () => {
    expect(judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim())).toBeNull();
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({
          predicate: 'stage_pick_rate',
          subject: RATE_SUBJECT,
          value: { kind: 'rate', numerator: 4, denominator: JUDGE_GAMES },
          evidenceIds: [RATE_ROW_ID],
        }),
      ),
    ).toBeNull();
  });

  it('an abstained claim asserts no figure and returns null even on a thin row', () => {
    const thin = judgeSnapshot({
      [STAGE_ROW_ID]: {
        predicate: 'stage_record',
        subject: STAGE_SUBJECT,
        value: { kind: 'record', wins: 1, losses: 0, games: 1 },
        sample: judgeSample(1),
      },
    });
    expect(
      judgeUnsupported(thin, supportedClaim({ value: { kind: 'abstained', gamesNeeded: 2 } })),
    ).toBeNull();
  });

  it('R1: an evidence id absent from the snapshot, or no evidence id at all', () => {
    expect(
      judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ evidenceIds: ['sr-f999-s999'] })),
    ).toBe('R1');
    expect(judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ evidenceIds: [] }))).toBe('R1');
    // An inherited Object property name is not a row.
    expect(judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ evidenceIds: ['constructor'] }))).toBe(
      'R1',
    );
  });

  it('R2: a real citation paired with a wrong number', () => {
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({ value: { kind: 'record', wins: 7, losses: 4, games: JUDGE_GAMES } }),
      ),
    ).toBe('R2');
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({
          predicate: 'stage_pick_rate',
          subject: RATE_SUBJECT,
          value: { kind: 'rate', numerator: 5, denominator: JUDGE_GAMES },
          evidenceIds: [RATE_ROW_ID],
        }),
      ),
    ).toBe('R2');
    // A different value kind over the same row is a mismatch, not a pass.
    expect(
      judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ value: { kind: 'count', count: 6 } })),
    ).toBe('R2');
  });

  it('R3: a subject axis no cited row carries, or a predicate the cited row does not have', () => {
    expect(
      judgeUnsupported(
        JUDGE_SNAPSHOT,
        supportedClaim({ subject: { ...STAGE_SUBJECT, opponentFighterId: 59 } }),
      ),
    ).toBe('R3');
    expect(
      judgeUnsupported(JUDGE_SNAPSHOT, supportedClaim({ predicate: 'my_character_record' })),
    ).toBe('R3');
  });

  it('R6: an evidenced figure on fewer than ABSTENTION_FLOOR_GAMES countable games', () => {
    const games = ABSTENTION_FLOOR_GAMES - 1;
    const thin = judgeSnapshot({
      [STAGE_ROW_ID]: {
        predicate: 'stage_record',
        subject: STAGE_SUBJECT,
        value: { kind: 'record', wins: games, losses: 0, games },
        sample: judgeSample(games),
      },
    });
    expect(
      judgeUnsupported(
        thin,
        supportedClaim({ value: { kind: 'record', wins: games, losses: 0, games } }),
      ),
    ).toBe('R6');
  });

  it('R7: a rate whose denominator folds in the unknown bucket, and the unknown bucket named as a real entity', () => {
    const withUnknown = JUDGE_GAMES + 2;
    const folded = judgeSnapshot({
      [RATE_ROW_ID]: {
        predicate: 'stage_pick_rate',
        subject: RATE_SUBJECT,
        value: { kind: 'rate', numerator: 4, denominator: withUnknown },
        sample: judgeSample(withUnknown, { eligibleDenominator: JUDGE_GAMES }),
      },
    });
    expect(
      judgeUnsupported(
        folded,
        supportedClaim({
          predicate: 'stage_pick_rate',
          subject: RATE_SUBJECT,
          value: { kind: 'rate', numerator: 4, denominator: withUnknown },
          evidenceIds: [RATE_ROW_ID],
        }),
      ),
    ).toBe('R7');

    const unknownStageSubject: ClaimSubject = { ...STAGE_SUBJECT, stageId: UNKNOWN_BUCKET_ID };
    const unknownStageRowId = evidenceIdFor({
      predicate: 'stage_record',
      subject: unknownStageSubject,
      opponentOrder: [],
    });
    const named = judgeSnapshot({
      [unknownStageRowId]: {
        predicate: 'stage_record',
        subject: unknownStageSubject,
        value: { kind: 'record', wins: 6, losses: 4, games: JUDGE_GAMES },
        sample: judgeSample(JUDGE_GAMES),
      },
    });
    expect(
      judgeUnsupported(
        named,
        supportedClaim({ subject: unknownStageSubject, evidenceIds: [unknownStageRowId] }),
      ),
    ).toBe('R7');

    const entityRowId = evidenceIdFor({
      predicate: 'matchup_advisor_pick',
      subject: { ...STAGE_SUBJECT, stageId: null },
      opponentOrder: [],
    });
    const entity = judgeSnapshot({
      [entityRowId]: {
        predicate: 'matchup_advisor_pick',
        subject: { ...STAGE_SUBJECT, stageId: null },
        value: { kind: 'entity', entityKind: 'fighter', entityId: String(UNKNOWN_BUCKET_ID) },
        sample: judgeSample(JUDGE_GAMES),
      },
    });
    expect(
      judgeUnsupported(
        entity,
        supportedClaim({
          predicate: 'matchup_advisor_pick',
          subject: { ...STAGE_SUBJECT, stageId: null },
          value: { kind: 'entity', entityKind: 'fighter', entityId: String(UNKNOWN_BUCKET_ID) },
          evidenceIds: [entityRowId],
        }),
      ),
    ).toBe('R7');
  });
});

describe('judgeDeliveredProse: R7 lexical on delivered prose', () => {
  it('convicts prose naming the unknown bucket as a thing', () => {
    expect(judgeDeliveredProse('They are 4-2 on Unknown Stage, a strong pick.')).toBe('R7');
    expect(judgeDeliveredProse('They picked an unknown stage in 3 of 12 games.')).toBe('R7');
    expect(judgeDeliveredProse('Their Unknown Character games are all wins.')).toBe('R7');
  });

  it('convicts the plural naming too', () => {
    expect(judgeDeliveredProse('Their Unknown Stages record is 6-4.')).toBe('R7');
  });

  it("SH-WR-08: the validator's R7 lexical pattern is a DELIBERATE duplicate of this judge's — same source, same flags", () => {
    // The judge keeps its own copy (it must never read the validator's
    // decisions); this assertion is what stops the two from drifting apart.
    expect(UNKNOWN_BUCKET_NAMED_PATTERN.source).toBe(UNKNOWN_BUCKET_NAMING.source);
    expect(UNKNOWN_BUCKET_NAMED_PATTERN.flags).toBe(UNKNOWN_BUCKET_NAMING.flags);
  });

  it('does not convict ordinary uses of "unknown", or empty prose', () => {
    expect(judgeDeliveredProse('Unknown matchups are rare for this opponent.')).toBeNull();
    expect(judgeDeliveredProse('unknown is not the same as unsafe')).toBeNull();
    expect(judgeDeliveredProse('')).toBeNull();
  });
});
