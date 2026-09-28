import { describe, expect, it } from 'vitest';
import * as validateReportModule from './validateReport.js';
import {
  AMBIGUOUS_ENTITY_NAMES,
  NON_FACTUAL_NUMERIC_PATTERNS,
  resolveSubjectDisplayName,
  validateReportOutput,
  type ReportSelectionOutput,
  type ReportSelectionSection,
  type ValidateReportInput,
} from './validateReport.js';
import type { ClaimAtom, ClaimId, ClaimSubject, ReportSurface } from './claims.js';
import { EVIDENCE_POLICY_VERSION, CONFIDENCE_TIER_BOUNDS, confidenceTierFor } from './policy.js';
import type { EvidenceRow, EvidenceSnapshot } from './snapshot.js';
import { evidenceIdFor } from './snapshot.js';
import { legacyCitationOnlyVerdict, type LegacyRuleClaim } from './legacyCitationRule.js';
import { ADVERSARIAL_FIXTURES, type AdversarialFixture } from './adversarialFixtures.js';
import { SpriteList } from '../fighterData.js';
import { StageList } from '../stageData.js';
import type { SampleMeta } from './types.js';

/**
 * RPT-07/D-06/D-07 (phase 39 plan 04): `validateReportOutput` is the pure
 * validator every report surface's output runs through — this file proves
 * the wave-1 oracle's passing direction (Task 1), the section-scoped D-04
 * prose lint (Task 2), and the remaining rules plus the at-least-as-strict
 * migration gate (Task 3). Driven from `ADVERSARIAL_FIXTURES` wherever a
 * fixture exists for the case, so the corpus and the validator cannot drift.
 */

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

const REFRESHED_AT = 1_700_000_500_000;

const FALLBACK_SAMPLE: SampleMeta = {
  rawSampleSize: 0,
  eligibleDenominator: 0,
  knownFieldCoverage: 0,
  dateRange: null,
  refreshedAt: REFRESHED_AT,
  evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
  recencyTreatment: 'unweighted',
  confidenceTier: null,
};

// ---------------------------------------------------------------------------
// The fixture bridge: `ADVERSARIAL_FIXTURES` (plan 39-01) was authored for
// the FROZEN legacy rule's `LegacyRuleOutput` shape (claimId + evidenceIds +
// assertedValue per claim), which predates this plan's `ReportSelectionOutput`
// (sections + claimIds only). This bridge builds a `ValidateReportInput`
// from a fixture: `issuedClaims` is built ONLY from the legacy claims whose
// `claimId` is ALSO a member of `fixture.issuedClaimIds` (so an unissued id
// the model selected — the `unissued_claim_id` family — genuinely is absent
// from `issuedClaims`, not merely relabeled); each atom's `value` is the
// legacy claim's OWN `assertedValue` (possibly wrong relative to the
// snapshot row it cites — exactly the untrusted-input shape R2 recomputes
// against); `output.sections` comes from `fixture.sections` when present
// (one section per `FixtureProseSection`, keyed `section-N`, `claimIds` =
// that section's own `licensedClaimIds`) or a single `main` section with
// every output claim id and an empty connective otherwise.
// ---------------------------------------------------------------------------

function toClaimAtom(legacyClaim: LegacyRuleClaim, snapshot: EvidenceSnapshot): ClaimAtom {
  const firstRow = legacyClaim.evidenceIds
    .map((evidenceId) => snapshot.rows[evidenceId])
    .find((row): row is EvidenceRow => row !== undefined);
  return {
    id: legacyClaim.claimId as ClaimId,
    predicate: firstRow?.predicate ?? 'stage_record',
    subject: firstRow?.subject ?? NULL_SUBJECT,
    value: legacyClaim.assertedValue,
    claimKind: 'fact',
    evidenceIds: legacyClaim.evidenceIds,
    tier: firstRow?.sample.confidenceTier ?? null,
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: firstRow?.sample ?? FALLBACK_SAMPLE,
  };
}

function bridge(
  fixture: AdversarialFixture,
  surface: ReportSurface = 'scout',
): ValidateReportInput {
  const issuedClaims = fixture.output.claims
    .filter((legacyClaim) => fixture.issuedClaimIds.includes(legacyClaim.claimId as ClaimId))
    .map((legacyClaim) => toClaimAtom(legacyClaim, fixture.snapshot));

  let sections: Record<string, ReportSelectionSection>;
  if (fixture.sections && fixture.sections.length > 0) {
    sections = {};
    fixture.sections.forEach((section, index) => {
      sections[`section-${index}`] = {
        claimIds: section.licensedClaimIds,
        connective: section.prose,
      };
    });
    // Every claim in the fixture's output must still be REGISTERED for
    // R1/R2/R3/R6/R7 validation even when no prose section's own
    // `licensedClaimIds` happens to reference it (that field models
    // prose-licensing scope, not "is this claim part of the output at
    // all" — a claim absent from every section's licence is exactly the
    // `prose_entity` "unlicensed" fixtures' own setup). A synthetic,
    // empty-prose carrier section registers any such claim without
    // introducing an R4/R5 offense of its own.
    const alreadyRegistered = new Set(Object.values(sections).flatMap((s) => s.claimIds));
    const unregistered = issuedClaims
      .map((claim) => claim.id)
      .filter((id) => !alreadyRegistered.has(id));
    if (unregistered.length > 0) {
      sections['claims-carrier'] = { claimIds: unregistered, connective: '' };
    }
  } else {
    sections = {
      main: {
        claimIds: fixture.output.claims.map((legacyClaim) => legacyClaim.claimId as ClaimId),
        connective: '',
      },
    };
  }

  let action1: ReportSelectionOutput['action1'] = null;
  let action2: ReportSelectionOutput['action2'] = null;
  let action3: ReportSelectionOutput['action3'] = null;
  if (fixture.actions) {
    [action1, action2, action3] = fixture.actions;
  }

  return {
    snapshot: fixture.snapshot,
    issuedClaims,
    output: { sections, action1, action2, action3 },
    surface,
  };
}

function findFixture(id: string): AdversarialFixture {
  const fixture = ADVERSARIAL_FIXTURES.find((entry) => entry.id === id);
  if (!fixture) {
    throw new Error(`adversarial fixture not found: ${id}`);
  }
  return fixture;
}

function dropRule(
  outcome: ReturnType<typeof validateReportOutput>,
  claimId: string,
): string | undefined {
  return outcome.droppedClaims.find((dropped) => dropped.claimId === claimId)?.rule;
}

// ---------------------------------------------------------------------------
// Task 1: the oracle's passing direction — R1, R2, R3, determinism.
// ---------------------------------------------------------------------------

describe('validateReportOutput: the wave-1 oracle passing direction (Task 1)', () => {
  it('R2: a claim citing a real evidence id whose asserted value contradicts the snapshot is dropped — the named hard case the frozen legacy rule ACCEPTS', () => {
    const fixture = findFixture('wrong-number-with-real-id');
    const legacyVerdict = legacyCitationOnlyVerdict({
      snapshot: fixture.snapshot,
      output: fixture.output,
    });
    expect(legacyVerdict.accepted).toBe(true); // the contrast: legacy accepts this

    const outcome = validateReportOutput(bridge(fixture));
    expect(dropRule(outcome, 'c01')).toBe('R2');
    expect(outcome.survivingClaimIds).not.toContain('c01');
  });

  it('R1: an evidence id absent from the snapshot is dropped, not accepted (control — proves the R2 proof above is not vacuous)', () => {
    const fixture = findFixture('missing-evidence-id');
    const outcome = validateReportOutput(bridge(fixture));
    expect(dropRule(outcome, 'c01')).toBe('R1');
  });

  it('R1: a claim id inside the vocabulary but never issued for this job is dropped, not thrown', () => {
    const fixture = findFixture('unissued-claim-id');
    expect(() => validateReportOutput(bridge(fixture))).not.toThrow();
    const outcome = validateReportOutput(bridge(fixture));
    expect(dropRule(outcome, 'c31')).toBe('R1');
  });

  it('R3: a claim whose subject entity appears in no cited row is dropped', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    const row: EvidenceRow = {
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      sample: makeSample(10),
    };
    const snapshot = makeSnapshot({ [rowId]: row });
    const claim: ClaimAtom = {
      id: 'c01',
      predicate: 'stage_record',
      // A different, unresolvable stage id than the row it cites.
      subject: { ...NULL_SUBJECT, myFighterId: 23, stageId: 999 },
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: confidenceTierFor(10),
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(10),
    };
    const outcome = validateReportOutput({
      snapshot,
      issuedClaims: [claim],
      output: {
        sections: { main: { claimIds: ['c01'], connective: '' } },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(dropRule(outcome, 'c01')).toBe('R3');
  });

  it('R2: rate comparison happens on the integer numerator/denominator pair, not a derived float — 61.9% against a stored 34/55 is judged by that exact pair', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, stageId: 1 };
    const rowId = evidenceIdFor({ predicate: 'stage_pick_rate', subject, opponentOrder: [] });
    const row: EvidenceRow = {
      predicate: 'stage_pick_rate',
      subject,
      value: { kind: 'rate', numerator: 34, denominator: 55 },
      sample: makeSample(55),
    };
    const snapshot = makeSnapshot({ [rowId]: row });
    const claim: ClaimAtom = {
      id: 'c01',
      predicate: 'stage_pick_rate',
      subject,
      // 61.9% rounds from 34/55, but is asserted as a DIFFERENT pair.
      value: { kind: 'rate', numerator: 619, denominator: 1000 },
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: confidenceTierFor(55),
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(55),
    };
    const outcome = validateReportOutput({
      snapshot,
      issuedClaims: [claim],
      output: {
        sections: { main: { claimIds: ['c01'], connective: '' } },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(dropRule(outcome, 'c01')).toBe('R2');

    // The SAME 34/55 pair, asserted exactly, survives.
    const matchingClaim: ClaimAtom = {
      ...claim,
      value: { kind: 'rate', numerator: 34, denominator: 55 },
    };
    const matchingOutcome = validateReportOutput({
      snapshot,
      issuedClaims: [matchingClaim],
      output: {
        sections: { main: { claimIds: ['c01'], connective: '' } },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(matchingOutcome.survivingClaimIds).toContain('c01');
  });

  it('validating the same input twice returns a deeply-equal outcome', () => {
    const fixture = findFixture('well-formed-control');
    const input = bridge(fixture);
    expect(validateReportOutput(input)).toEqual(validateReportOutput(input));
  });

  it('accepts the well-formed control fixture', () => {
    const fixture = findFixture('well-formed-control');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.survivingClaimIds).toContain('c01');
    expect(outcome.droppedClaims).toEqual([]);
  });
});

describe("SH-WR-03: the recompute reads the SNAPSHOT rows — never the claim's own metadata — and checks every cited row", () => {
  const STAGE_SUBJECT: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
  const RECORD_ROW_ID = evidenceIdFor({
    predicate: 'stage_record',
    subject: STAGE_SUBJECT,
    opponentOrder: [],
  });

  function outcomeFor(snapshotRows: Record<string, EvidenceRow>, claim: ClaimAtom) {
    return validateReportOutput({
      snapshot: makeSnapshot(snapshotRows),
      issuedClaims: [claim],
      output: {
        sections: { main: { claimIds: [claim.id], connective: '' } },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
  }

  function recordClaim(overrides: Partial<ClaimAtom> = {}): ClaimAtom {
    return {
      id: 'c01',
      predicate: 'stage_record',
      subject: STAGE_SUBJECT,
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      claimKind: 'fact',
      evidenceIds: [RECORD_ROW_ID],
      tier: confidenceTierFor(10),
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(10),
      ...overrides,
    };
  }

  const RECORD_ROW: EvidenceRow = {
    predicate: 'stage_record',
    subject: STAGE_SUBJECT,
    value: { kind: 'record', wins: 6, losses: 4, games: 10 },
    sample: makeSample(10),
  };

  it('an evidence id naming an inherited Object property ("constructor") is R1, never a throw', () => {
    const claim = recordClaim({ evidenceIds: ['constructor'] });
    expect(() => outcomeFor({ [RECORD_ROW_ID]: RECORD_ROW }, claim)).not.toThrow();
    expect(dropRule(outcomeFor({ [RECORD_ROW_ID]: RECORD_ROW }, claim), 'c01')).toBe('R1');
  });

  it("a cited row whose predicate differs from the claim's is R3", () => {
    const rateRowId = evidenceIdFor({
      predicate: 'stage_pick_rate',
      subject: STAGE_SUBJECT,
      opponentOrder: [],
    });
    const rateRow: EvidenceRow = { ...RECORD_ROW, predicate: 'stage_pick_rate' };
    const claim = recordClaim({ evidenceIds: [rateRowId] });
    expect(dropRule(outcomeFor({ [rateRowId]: rateRow }, claim), 'c01')).toBe('R3');
  });

  it('R2 compares the value against EVERY cited row, not only the first', () => {
    const otherRowId = evidenceIdFor({
      predicate: 'stage_record',
      subject: { ...STAGE_SUBJECT, stageId: 3 },
      opponentOrder: [],
    });
    const otherRow: EvidenceRow = {
      ...RECORD_ROW,
      subject: { ...STAGE_SUBJECT, stageId: 3 },
      value: { kind: 'record', wins: 1, losses: 9, games: 10 },
    };
    const claim = recordClaim({ evidenceIds: [RECORD_ROW_ID, otherRowId] });
    expect(
      dropRule(outcomeFor({ [RECORD_ROW_ID]: RECORD_ROW, [otherRowId]: otherRow }, claim), 'c01'),
    ).toBe('R2');
  });

  it("R6 reads the ROW's countable games: a claim whose own sample claims 10 games over a 1-game row is dropped", () => {
    const thinRow: EvidenceRow = {
      ...RECORD_ROW,
      value: { kind: 'record', wins: 1, losses: 0, games: 1 },
      sample: makeSample(1),
    };
    const claim = recordClaim({
      value: { kind: 'record', wins: 1, losses: 0, games: 1 },
      sample: makeSample(10),
    });
    expect(dropRule(outcomeFor({ [RECORD_ROW_ID]: thinRow }, claim), 'c01')).toBe('R6');
  });

  it("R7 (recompute) compares a rate's denominator with the ROW's eligible denominator, not the claim's own sample", () => {
    const rateSubject: ClaimSubject = { ...NULL_SUBJECT, stageId: 1 };
    const rateRowId = evidenceIdFor({
      predicate: 'stage_pick_rate',
      subject: rateSubject,
      opponentOrder: [],
    });
    const rateRow: EvidenceRow = {
      predicate: 'stage_pick_rate',
      subject: rateSubject,
      value: { kind: 'rate', numerator: 4, denominator: 12 },
      sample: { ...makeSample(12), eligibleDenominator: 10 },
    };
    const claim: ClaimAtom = {
      ...recordClaim(),
      predicate: 'stage_pick_rate',
      subject: rateSubject,
      value: { kind: 'rate', numerator: 4, denominator: 12 },
      evidenceIds: [rateRowId],
      sample: makeSample(12),
    };
    expect(dropRule(outcomeFor({ [rateRowId]: rateRow }, claim), 'c01')).toBe('R7');
  });
});

describe('validateReportOutput: purity (grep-gated separately; this proves no side effect via double-invocation)', () => {
  it('does not mutate its input snapshot or issuedClaims', () => {
    const fixture = findFixture('well-formed-control');
    const input = bridge(fixture);
    const snapshotBefore = JSON.stringify(input.snapshot);
    const claimsBefore = JSON.stringify(input.issuedClaims);
    validateReportOutput(input);
    expect(JSON.stringify(input.snapshot)).toBe(snapshotBefore);
    expect(JSON.stringify(input.issuedClaims)).toBe(claimsBefore);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the D-04 prose lint.
// ---------------------------------------------------------------------------

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

function makeSnapshot(rows: Record<string, EvidenceRow>): EvidenceSnapshot {
  return {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: 1,
    refreshedAt: REFRESHED_AT,
    cohort: {
      online: 5,
      offline: 4,
      unspecified: 0,
      manual: 2,
      startgg: 4,
      parrygg: 2,
      mixedContext: false,
      minorityShare: 0,
      minorityLabel: null,
      majorityLabel: null,
    },
    rows,
    matchIdDigest: { count: Object.keys(rows).length, hash: 'validate-report-test-hash' },
  };
}

describe('validateReportOutput: the D-04 prose lint (Task 2)', () => {
  it('prose_entity: an unlicensed entity/number in the SAME section fails R4', () => {
    const fixture = findFixture('prose-entity-unlicensed-same-section');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual(['section-0']);
    // The claim itself survives — a prose fault never drops a claim (C1-H4).
    expect(outcome.survivingClaimIds).toContain('c01');
  });

  it('prose_entity: an entity licensed only in a DIFFERENT section still fails R4 in the section that mentions it', () => {
    // `prose-entity-licensed-different-section` (adversarialFixtures.ts)
    // models the same STRUCTURAL contract — a licence in one section never
    // reaches another — and, since review SH-WR-07, its prose carries the
    // record's figures so the per-fixture verdict check proves it too. This
    // hand-built case keeps the contract pinned independently of the corpus.
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    const row: EvidenceRow = {
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      sample: makeSample(10),
    };
    const claim: ClaimAtom = {
      id: 'c01',
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: confidenceTierFor(10),
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(10),
    };
    const outcome = validateReportOutput({
      snapshot: makeSnapshot({ [rowId]: row }),
      issuedClaims: [claim],
      output: {
        sections: {
          's1-unlicensed': {
            claimIds: [],
            connective: 'Your record here is 6-4, historically favorable.',
          },
          's2-licenses-c01': {
            claimIds: ['c01'],
            connective: 'The stage record claim above is grounded in your own matches.',
          },
        },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    // c01 licenses 6/4/10 — but that licence lives in s2, not s1; s1's
    // mention of "6-4" is therefore unlicensed in its OWN section.
    expect(outcome.strippedSectionIds).toContain('s1-unlicensed');
    expect(outcome.strippedSectionIds).not.toContain('s2-licenses-c01');
  });

  it('prose_entity: a stored-vs-canonical stage name mismatch (resolveSubjectDisplayName C2-M6) produces NO R4 fault', () => {
    const fixture = findFixture('prose-entity-stage-name-mismatch');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual([]);
  });

  it('prose_encoding (D-24): a fullwidth numeral is a digit — the prose is withheld even when a claim licenses its value, and the claim survives', () => {
    const fixture = findFixture('prose-encoding-fullwidth-digit');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual(['section-0']);
    expect(outcome.survivingClaimIds).toContain('c01');
  });

  it('prose_encoding: an NFD-spelled licensed opponent tag does NOT fail (NFC-normalized before comparison)', () => {
    const fixture = findFixture('prose-encoding-nfd-opponent-tag');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual([]);
  });

  it('prose_encoding (D-24): a ja-locale sentence restating the record in digits is withheld', () => {
    const fixture = findFixture('prose-encoding-ja-locale');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual(['section-0']);
    expect(outcome.survivingClaimIds).toContain('c01');
  });

  it('the model prose string in the outcome-adjacent input is byte-identical to what was passed in — the validator never edits prose', () => {
    const fixture = findFixture('prose-entity-unlicensed-same-section');
    const input = bridge(fixture);
    const originalProse = input.output.sections['section-0']!.connective;
    validateReportOutput(input);
    expect(input.output.sections['section-0']!.connective).toBe(originalProse);
  });

  it('confidence_word: a forbidden strength word fails R5 regardless of tier', () => {
    const fixture = findFixture('confidence-word-strength-on-low-tier');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual(['section-0']);
    expect(outcome.survivingClaimIds).toContain('c01');
  });

  it('confidence_word: a tier word licensed only by a claim in a DIFFERENT section fails R5', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    const games = CONFIDENCE_TIER_BOUNDS.high;
    const row: EvidenceRow = {
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: games - 1, losses: 1, games },
      sample: makeSample(games),
    };
    const snapshot = makeSnapshot({ [rowId]: row });
    const claim: ClaimAtom = {
      id: 'c01',
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: games - 1, losses: 1, games },
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: 'high',
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(games),
    };
    const outcome = validateReportOutput({
      snapshot,
      issuedClaims: [claim],
      output: {
        sections: {
          'section-0': { claimIds: [], connective: 'This is high confidence, trust it.' },
          'section-1': {
            claimIds: ['c01'],
            connective: 'The record above is grounded in real matches.',
          },
        },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(outcome.strippedSectionIds).toContain('section-0');
  });

  describe('C1-H4 entity rules', () => {
    function scanFor(prose: string) {
      const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
      const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
      const row: EvidenceRow = {
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        sample: makeSample(10),
      };
      const snapshot = makeSnapshot({ [rowId]: row });
      const claim: ClaimAtom = {
        id: 'c01',
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        claimKind: 'fact',
        evidenceIds: [rowId],
        tier: confidenceTierFor(10),
        policyVersion: EVIDENCE_POLICY_VERSION,
        sample: makeSample(10),
      };
      return validateReportOutput({
        snapshot,
        issuedClaims: [claim],
        output: {
          sections: { main: { claimIds: ['c01'], connective: prose } },
          action1: null,
          action2: null,
          action3: null,
        },
        surface: 'scout',
      });
    }

    it('lowercase fox/cloud/peach in ordinary prose is NOT a violation', () => {
      const outcome = scanFor(
        'Watch the fox recover to the ledge and keep a cloud of pressure near the peach.',
      );
      expect(outcome.strippedSectionIds).toEqual([]);
    });

    it('a capitalised AMBIGUOUS_ENTITY_NAMES member with NO adjacency signal is NOT a violation', () => {
      const outcome = scanFor('Fox players tend to crowd the ledge in this matchup.');
      expect(outcome.strippedSectionIds).toEqual([]);
    });

    it('the same name WITH an adjacency signal (digit, %, another entity, matchup marker) IS a violation when unlicensed', () => {
      expect(scanFor('They went 62% Fox in their last event.').strippedSectionIds).toEqual([
        'main',
      ]);
      expect(scanFor('Watch out for Fox vs Marth in this bracket.').strippedSectionIds).toEqual([
        'main',
      ]);
    });

    it('an unambiguous multi-token name is a violation on a case-sensitive match alone', () => {
      const outcome = scanFor('They love picking Kalos Pokémon League when given the option.');
      expect(outcome.strippedSectionIds).toEqual(['main']);
    });

    it('UNKNOWN_STAGE.name and NO_SELECTION_STAGE.name are absent from the recognized-entity table, and ordinary "unknown" produces no R4 fault', () => {
      expect(AMBIGUOUS_ENTITY_NAMES).not.toContain('unknown');
      expect(AMBIGUOUS_ENTITY_NAMES).not.toContain('no selection');
      const outcome = scanFor('This matchup is largely unknown territory for you.');
      expect(outcome.strippedSectionIds).toEqual([]);
    });
  });

  it('C1-H4 penalty decoupling: a three-claim scout output with ONE R4-faulting section still yields status "passed" with all three claims surviving', () => {
    const rows: Record<string, EvidenceRow> = {};
    const claims: ClaimAtom[] = [];
    for (let i = 0; i < 3; i += 1) {
      const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: i + 1 };
      const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
      rows[rowId] = {
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        sample: makeSample(10),
      };
      claims.push({
        id: `c0${i + 1}` as ClaimId,
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        claimKind: 'fact',
        evidenceIds: [rowId],
        tier: confidenceTierFor(10),
        policyVersion: EVIDENCE_POLICY_VERSION,
        sample: makeSample(10),
      });
    }
    const outcome = validateReportOutput({
      snapshot: makeSnapshot(rows),
      issuedClaims: claims,
      output: {
        sections: {
          s1: { claimIds: ['c01'], connective: 'Steady results on this stage.' },
          s2: {
            claimIds: ['c02'],
            connective: 'Fox vs Marth is a common opener here — worth studying.',
          },
          s3: { claimIds: ['c03'], connective: 'This stage tends to favor the aggressor.' },
        },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.survivingClaimIds).toEqual(['c01', 'c02', 'c03']);
    expect(outcome.strippedSectionIds).toEqual(['s2']);
  });

  it('C2-H3 total-prose-loss is PASSING: all three sections faulting R4 still yields status "passed" with every claim surviving', () => {
    const rows: Record<string, EvidenceRow> = {};
    const claims: ClaimAtom[] = [];
    for (let i = 0; i < 3; i += 1) {
      const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: i + 1 };
      const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
      rows[rowId] = {
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        sample: makeSample(10),
      };
      claims.push({
        id: `c0${i + 1}` as ClaimId,
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        claimKind: 'fact',
        evidenceIds: [rowId],
        tier: confidenceTierFor(10),
        policyVersion: EVIDENCE_POLICY_VERSION,
        sample: makeSample(10),
      });
    }
    const outcome = validateReportOutput({
      snapshot: makeSnapshot(rows),
      issuedClaims: claims,
      output: {
        sections: {
          s1: {
            claimIds: ['c01'],
            connective: 'Fox vs Marth on this stage tends to favor the aggressor.',
          },
          s2: { claimIds: ['c02'], connective: 'Watch out for a 62% Fox pick rate here.' },
          s3: { claimIds: ['c03'], connective: 'Kalos Pokémon League decides this matchup often.' },
        },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.survivingClaimIds).toEqual(['c01', 'c02', 'c03']);
    expect(outcome.strippedSectionIds).toEqual(['s1', 's2', 's3']);
  });

  describe('C2-H3 digit rule, under D-24 (any figure withholds the prose)', () => {
    function digitScan(prose: string) {
      const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
      const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
      const row: EvidenceRow = {
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        sample: makeSample(10),
      };
      const claim: ClaimAtom = {
        id: 'c01',
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        claimKind: 'fact',
        evidenceIds: [rowId],
        tier: confidenceTierFor(10),
        policyVersion: EVIDENCE_POLICY_VERSION,
        sample: makeSample(10),
      };
      return validateReportOutput({
        snapshot: makeSnapshot({ [rowId]: row }),
        issuedClaims: [claim],
        output: {
          sections: { main: { claimIds: ['c01'], connective: prose } },
          action1: null,
          action2: null,
          action3: null,
        },
        surface: 'scout',
      });
    }

    it('D-24: the retired NON_FACTUAL_NUMERIC_PATTERNS shapes no longer exempt anything — each one withholds the prose', () => {
      expect(NON_FACTUAL_NUMERIC_PATTERNS.length).toBe(5);
      for (const prose of [
        'Game 1: X; if they swap to Y, counter with Z.',
        'Focus on their top-5 characters this bracket.',
        'This is likely a best-of-5 set, plan your bans.',
        'They almost always take their pick 3rd in the order.',
      ]) {
        expect(digitScan(prose).strippedSectionIds, prose).toEqual(['main']);
      }
    });

    it('D-24: a licensed integer written as a fullwidth numeral is still a figure', () => {
      expect(digitScan('Their record here is ６ wins.').strippedSectionIds).toEqual(['main']);
    });

    it('an unlicensed percentage, W-L record shape, and raw count each still fail', () => {
      expect(digitScan('They win roughly 61% of the time here.').strippedSectionIds).toEqual([
        'main',
      ]);
      expect(digitScan('Their overall record is 12-6 on this stage.').strippedSectionIds).toEqual([
        'main',
      ]);
      expect(digitScan('They have played 42 sets on this stage.').strippedSectionIds).toEqual([
        'main',
      ]);
    });

    it('SH-WR-04 under D-24: every W-L shape is withheld — the licensed pair included, since the record lives on the claim line', () => {
      // Licensed record: 6-4 (10 games).
      expect(digitScan('You are 6-4 on Battlefield, keep it.').strippedSectionIds).toEqual([
        'main',
      ]);
      expect(digitScan('You are 6 – 4 on Battlefield, keep it.').strippedSectionIds).toEqual([
        'main',
      ]);
      expect(digitScan('You are 4-6 on Battlefield, so ban it.').strippedSectionIds).toEqual([
        'main',
      ]);
      expect(digitScan('You are 6-10 on Battlefield overall.').strippedSectionIds).toEqual([
        'main',
      ]);
    });

    it('SH-CR-01: a sentence-final figure, the whole part of a decimal, and a trailing record digit are NOT list positions — each unlicensed one fails', () => {
      // Licensed: 6, 4, 10 only. `83`, `71` and `0` are unlicensed factual
      // figures that merely sit before a `.` — never a list index.
      expect(digitScan('Their win rate here is 83.').strippedSectionIds).toEqual(['main']);
      expect(digitScan('They win 71.4% of their games on Battlefield.').strippedSectionIds).toEqual(
        ['main'],
      );
      expect(digitScan('Your record is 6-4 here and 10-0.').strippedSectionIds).toEqual(['main']);
      expect(digitScan('Their record (6-4) hides a 83) streak.').strippedSectionIds).toEqual([
        'main',
      ]);
    });

    it('D-24: a list position and a standalone ordinal are figures too — no numeric shape is exempt', () => {
      expect(
        digitScan('1. Punish their landing.\n2. Stay patient at ledge.').strippedSectionIds,
      ).toEqual(['main']);
      expect(digitScan('3) Reset to neutral when in doubt.').strippedSectionIds).toEqual(['main']);
      expect(digitScan('They take their pick 3rd in the order.').strippedSectionIds).toEqual([
        'main',
      ]);
    });
  });

  describe('SH-WR-01: licensed prose about overlapping names, digits inside names, Smash idiom and short tags is not stripped', () => {
    /**
     * One section licensing a `stage_record` claim per given subject (each
     * 6-4 over 10 games, medium tier), plus an OTHER-section claim carrying
     * `otherTag` so that tag is known to the job but unlicensed here.
     */
    function lintWith(
      subjects: ReadonlyArray<Partial<ClaimSubject>>,
      prose: string,
      options: { otherTag?: string; games?: number } = {},
    ) {
      const games = options.games ?? 10;
      const rows: Record<string, EvidenceRow> = {};
      const claims: ClaimAtom[] = [];
      const all = [
        ...subjects.map((subject) => ({ ...NULL_SUBJECT, ...subject })),
        ...(options.otherTag ? [{ ...NULL_SUBJECT, opponentTag: options.otherTag }] : []),
      ];
      all.forEach((subject, index) => {
        const predicate = subject.opponentTag !== null ? 'head_to_head_record' : 'stage_record';
        const rowId = evidenceIdFor({
          predicate,
          subject,
          opponentOrder: options.otherTag ? [options.otherTag] : [],
        });
        const value = { kind: 'record' as const, wins: 6, losses: 4, games };
        rows[rowId] = { predicate, subject, value, sample: makeSample(games) };
        claims.push({
          id: `c0${index + 1}` as ClaimId,
          predicate,
          subject,
          value,
          claimKind: 'fact',
          evidenceIds: [rowId],
          tier: confidenceTierFor(games),
          policyVersion: EVIDENCE_POLICY_VERSION,
          sample: makeSample(games),
        });
      });
      const licensed = claims.slice(0, subjects.length).map((claim) => claim.id);
      const other = claims.slice(subjects.length).map((claim) => claim.id);
      return validateReportOutput({
        snapshot: makeSnapshot(rows),
        issuedClaims: claims,
        output: {
          sections: {
            main: { claimIds: licensed, connective: prose },
            ...(other.length > 0 ? { other: { claimIds: other, connective: '' } } : {}),
          },
          action1: null,
          action2: null,
          action3: null,
        },
        surface: 'scout',
      }).strippedSectionIds;
    }

    it('a licensed longer name is consumed before its shorter contained names are scanned', () => {
      expect(
        lintWith([{ stageId: 113 }], 'Take them to Small Battlefield against this opponent.'),
      ).toEqual([]);
      expect(lintWith([{ opponentFighterId: 46 }], 'Play patiently against Toon Link.')).toEqual(
        [],
      );
      expect(
        lintWith([{ myFighterId: 25 }], 'Young Link against their zoning is your best answer.'),
      ).toEqual([]);
    });

    it('digits inside a licensed canonical name need no licence of their own', () => {
      expect(
        lintWith([{ stageId: 59 }], 'Pokémon Stadium 2 is your best counterpick here.'),
      ).toEqual([]);
      expect(lintWith([{ stageId: 19 }], 'Figure-8 Circuit on this opponent is fine.')).toEqual([]);
    });

    it('D-24: "low"/"high" are confidence-tier words anywhere, Smash sense included — the prose is withheld', () => {
      expect(
        lintWith([{ stageId: 1 }], 'Watch for their high recovery and low percent combos.'),
      ).toEqual(['main']);
    });

    it('R2-CR-02: a tier word anywhere in a sentence that mentions confidence is judged — not only when it sits beside the noun', () => {
      // The licence is medium (10 games); "high" is unlicensed wherever it sits.
      expect(lintWith([{ stageId: 1 }], 'Confidence is high here.')).toEqual(['main']);
      expect(lintWith([{ stageId: 1 }], 'Take them to Battlefield (confidence: high).')).toEqual([
        'main',
      ]);
      expect(lintWith([{ stageId: 1 }], 'Our confidence in this read is high.')).toEqual(['main']);
      expect(lintWith([{ stageId: 1 }], 'Confidence here is medium to high.')).toEqual(['main']);
      expect(lintWith([{ stageId: 1 }], 'We are confident that this read is high.')).toEqual([
        'main',
      ]);
    });

    it('D-24: a tier word is withheld even when a claim in the section licenses that tier, and in a section that never mentions confidence', () => {
      expect(lintWith([{ stageId: 1 }], 'Confidence is medium here.')).toEqual(['main']);
      expect(lintWith([{ stageId: 1 }], 'Our confidence in this read is medium.')).toEqual([
        'main',
      ]);
      expect(lintWith([{ stageId: 1 }], 'Keep your shield high. Their recovery is low.')).toEqual([
        'main',
      ]);
    });

    it('D-24 control: the noun "confidence" with no tier word or figure, on a tiered claim, is qualitative commentary and ships', () => {
      expect(lintWith([{ stageId: 1 }], 'Play this stage with confidence.')).toEqual([]);
    });

    it('R3-CR-02: R5 does not depend on sentence splitting — a tier word anywhere in a section that mentions confidence is judged', () => {
      // The licence is medium (10 games); "high" is unlicensed in every one.
      for (const prose of [
        'Take them to Battlefield. Our confidence in this read? High.',
        'Take them to Battlefield. Our confidence in this read! High.',
        'Take them to Battlefield. Our confidence in this read; high.',
        'Take them to Battlefield. Our confidence in this read\nHigh.',
        'Take them to Battlefield. Our confidence in this read — high.',
        'Confidence? High.',
        'How confident should you be here? Very. High, even.',
        'High. That is how confident you can be.',
      ]) {
        expect(lintWith([{ stageId: 1 }], prose), prose).toEqual(['main']);
      }
    });

    it('R3-CR-02 / R3-IN-01 (accepted over-strip, recorded in the rubric): a Smash-sense tier word in a section that mentions confidence is withheld too', () => {
      expect(
        lintWith(
          [{ stageId: 1 }],
          'Keep your shield high. Confidence is medium here. Their recovery is low.',
        ),
      ).toEqual(['main']);
      expect(lintWith([{ stageId: 1 }], 'Confidently punish his high recovery.')).toEqual(['main']);
    });

    it('an opponent tag known elsewhere in the job matches on token boundaries only', () => {
      expect(
        lintWith([{ stageId: 1 }], 'Team up your ledge options with steady pressure.', {
          otherTag: 'Tea',
        }),
      ).toEqual([]);
    });

    it('controls: an unlicensed contained or containing name, an unlicensed tag token and a mismatched confidence word still strip', () => {
      expect(
        lintWith([{ stageId: 113 }], 'Take them to Battlefield against this opponent.'),
      ).toEqual(['main']);
      expect(
        lintWith([{ stageId: 58 }], 'Pokémon Stadium 2 is your best counterpick here.'),
      ).toEqual(['main']);
      expect(
        lintWith([{ stageId: 1 }], 'Watch Tea closely in neutral.', { otherTag: 'Tea' }),
      ).toEqual(['main']);
      // A medium-tier licence does not license "high confidence".
      expect(lintWith([{ stageId: 1 }], 'This is a high confidence read.')).toEqual(['main']);
    });
  });

  it('C2-M7: AMBIGUOUS_ENTITY_NAMES equals the single-token subset of SpriteList ∪ StageList, computed mechanically', () => {
    const expected = new Set(
      [...SpriteList.map((f) => f.name), ...StageList.map((s) => s.name)].filter(
        (name) => !name.includes(' '),
      ),
    );
    expect(new Set(AMBIGUOUS_ENTITY_NAMES)).toEqual(expected);
  });

  it('C2-M6: resolveSubjectDisplayName is the one resolver — the licensed set for a canonical stage id equals its StageList name', () => {
    const battlefield = StageList.find((s) => s.id === 1)!;
    expect(resolveSubjectDisplayName('stage', 1)).toBe(battlefield.name);
  });

  it('C1-H4 + C2-H3 false-positive budget: every ordinary_prose fixture yields zero R4/R5 drops and empty strippedSectionIds', () => {
    const fixture = findFixture('ordinary-prose-negative-corpus');
    const outcome = validateReportOutput(bridge(fixture));
    const r4r5 = outcome.droppedClaims.filter((d) => d.rule === 'R4' || d.rule === 'R5');
    expect(r4r5).toEqual([]);
    expect(outcome.strippedSectionIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Code review iteration 2 (R2-WR-03) and iteration 3 (R3-CR-01): head-to-head prose. One
// section licensing one `head_to_head_record` claim against `tag`.
// ---------------------------------------------------------------------------

function validateHeadToHead(
  tag: string,
  record: { wins: number; losses: number },
  prose: string,
): { stripped: readonly string[]; dropped: number } {
  const games = record.wins + record.losses;
  const subject: ClaimSubject = { ...NULL_SUBJECT, opponentTag: tag };
  const predicate = 'head_to_head_record' as const;
  const rowId = evidenceIdFor({ predicate, subject, opponentOrder: [tag] });
  const value = { kind: 'record' as const, wins: record.wins, losses: record.losses, games };
  const claim: ClaimAtom = {
    id: 'c01' as ClaimId,
    predicate,
    subject,
    value,
    claimKind: 'fact',
    evidenceIds: [rowId],
    tier: confidenceTierFor(games),
    policyVersion: EVIDENCE_POLICY_VERSION,
    sample: makeSample(games),
  };
  const outcome = validateReportOutput({
    snapshot: makeSnapshot({ [rowId]: { predicate, subject, value, sample: makeSample(games) } }),
    issuedClaims: [claim],
    output: {
      sections: { main: { claimIds: [claim.id], connective: prose } },
      action1: null,
      action2: null,
      action3: null,
    },
    surface: 'scout',
  });
  return { stripped: outcome.strippedSectionIds, dropped: outcome.droppedClaimCount };
}

describe('R2-WR-03: digits inside a licensed opponent tag are part of the name, not figures', () => {
  it('qualitative prose naming a digit-bearing tag passes — the tag is sentence-final', () => {
    expect(
      validateHeadToHead('Sparg0', { wins: 3, losses: 2 }, 'Stay patient against Sparg0.'),
    ).toEqual({ stripped: [], dropped: 0 });
  });

  it('the tag mid-sentence passes too, and a digit-bearing tag of any shape is consumed whole', () => {
    expect(
      validateHeadToHead('Sparg0', { wins: 3, losses: 2 }, 'Against Sparg0 you tend to rush.'),
    ).toEqual({ stripped: [], dropped: 0 });
    expect(
      validateHeadToHead(
        'Zer0Frame 2',
        { wins: 6, losses: 4 },
        'Zer0Frame 2 camps the ledge, so take the centre this season.',
      ),
    ).toEqual({ stripped: [], dropped: 0 });
  });

  it('D-24: the licensed record beside the tag is withheld all the same', () => {
    expect(
      validateHeadToHead('Sparg0', { wins: 3, losses: 2 }, 'You are 3-2 against Sparg0.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });

  it('controls: an unlicensed figure beside the tag still strips, and so does a wrong record', () => {
    expect(
      validateHeadToHead(
        'Sparg0',
        { wins: 3, losses: 2 },
        'You are 3-2 against Sparg0 over 7 sets.',
      ),
    ).toEqual({ stripped: ['main'], dropped: 0 });
    expect(
      validateHeadToHead('Sparg0', { wins: 3, losses: 2 }, 'You are 4-1 against Sparg0.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });
});

describe('R3-IN-02: only a tag that contains a letter consumes its span in the digit rule', () => {
  it('a digit-only tag does not exempt an unlicensed figure that happens to equal it', () => {
    expect(
      validateHeadToHead(
        '7',
        { wins: 3, losses: 2 },
        'You are 3-2 against 7, and 7 of those games went last stock.',
      ),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });

  it('control: a different unlicensed figure beside a digit-only tag strips too', () => {
    expect(
      validateHeadToHead(
        '7',
        { wins: 3, losses: 2 },
        'You are 3-2 against 7, and 8 of those games went last stock.',
      ),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });

  it('control: a letter-bearing digit tag is still consumed whole', () => {
    expect(
      validateHeadToHead('Sparg0', { wins: 3, losses: 2 }, 'Sparg0 likes to camp the ledge.'),
    ).toEqual({ stripped: [], dropped: 0 });
  });
});

describe('R3-CR-01, superseded by D-24: every W-L pair in prose is withheld, whichever side states it', () => {
  it('opponent-perspective phrasings are withheld again, whichever order the pair is in', () => {
    // A licensed 3-2 (the player won 3). "MkLeo is 3-2 against you" is false
    // from MkLeo's side; "MkLeo is 2-3 against you" is true but is withheld
    // too: the lint cannot read perspective, so it never licenses it.
    for (const prose of [
      'MkLeo is 3-2 against you.',
      'MkLeo is 2-3 against you.',
      "MkLeo's record against you is 2-3.",
      'MkLeo beat you 3-2.',
      'MkLeo leads you 3-2 in sets.',
      'MkLeo vs. you: 3-2.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: ['main'],
        dropped: 0,
      });
    }
  });

  it("the reviewer's inverted user-clause phrasings all strip", () => {
    for (const prose of [
      'MkLeo is tough against you, and you are 2-3 in your sets.',
      'MkLeo vs you: you trail 2-3.',
      'MkLeo has struggled against you, yet you sit at 2-3.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: ['main'],
        dropped: 0,
      });
    }
  });

  it('the perspective marker is judged over the whole section, so a sentence split cannot move the pair away from it', () => {
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'Against you? MkLeo is 3-2.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
    expect(
      validateHeadToHead(
        'MkLeo',
        { wins: 3, losses: 2 },
        'MkLeo plays patiently against you. Their record here: 3-2.',
      ),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });

  it('D-24: a TRUE user-clause record is withheld like any other figure', () => {
    expect(
      validateHeadToHead(
        'MkLeo',
        { wins: 3, losses: 2 },
        'MkLeo has struggled against you, and you lead 3-2.',
      ),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });

  it('D-24: the player as subject is withheld too — no W-L pair is ever licensed in prose', () => {
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'You are 3-2 against MkLeo.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'You are 2-3 against MkLeo.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'MkLeo sets went 3-2 your way.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
    // A perspective marker with no W-L pair in the section strips nothing.
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'MkLeo plays patiently against you.'),
    ).toEqual({ stripped: [], dropped: 0 });
  });

  it('D-24: a winner-first loss idiom is withheld', () => {
    expect(
      validateHeadToHead('MkLeo', { wins: 2, losses: 3 }, 'You lost that stretch 3-2 to MkLeo.'),
    ).toEqual({ stripped: ['main'], dropped: 0 });
  });
});

// ---------------------------------------------------------------------------
// Task 3: drop-or-fail, remaining rules, migration gate.
// ---------------------------------------------------------------------------

/**
 * Four evidenced claims over the all-null-subject fixture's four rows (c01
 * recent_form 16-9, c02 cohort, c03 stage_record 6-4, c04 my_character
 * 16-9), selected by the given sections — a scout output that clears
 * MIN_VIABLE_CLAIMS on its own claims.
 */
function fourClaimOutput(sections: Record<string, ReportSelectionSection>): ValidateReportInput {
  const fixture = findFixture('all-null-subject');
  const ids = ['c01', 'c02', 'c03', 'c04'] as ClaimId[];
  const issuedClaims = Object.entries(fixture.snapshot.rows).map(([evidenceId, row], index) =>
    toClaimAtom(
      { claimId: ids[index]!, evidenceIds: [evidenceId], assertedValue: row.value },
      fixture.snapshot,
    ),
  );
  return {
    snapshot: fixture.snapshot,
    issuedClaims,
    output: { sections, action1: null, action2: null, action3: null },
    surface: 'scout',
  };
}

describe('validateReportOutput: the remaining rules and the outcome policy (Task 3)', () => {
  it('R6: a sub-floor evidenced claim is dropped while an abstained claim on the same sample is not', () => {
    const fixture = findFixture('sub-floor-assertion');
    const outcome = validateReportOutput(bridge(fixture));
    expect(dropRule(outcome, 'c01')).toBe('R6');

    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    const games = 2;
    const row: EvidenceRow = {
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: games, losses: 0, games },
      sample: makeSample(games),
    };
    const abstainedClaim: ClaimAtom = {
      id: 'c01',
      predicate: 'stage_record',
      subject,
      value: { kind: 'abstained', gamesNeeded: 1 },
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: null,
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(games),
    };
    const abstainedOutcome = validateReportOutput({
      snapshot: makeSnapshot({ [rowId]: row }),
      issuedClaims: [abstainedClaim],
      output: {
        sections: { main: { claimIds: ['c01'], connective: '' } },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'post_event_synthesis',
    });
    expect(dropRule(abstainedOutcome, 'c01')).toBeUndefined();
    expect(abstainedOutcome.survivingClaimIds).toContain('c01');
  });

  it('R7 (D-22): both unknown_bucket fixtures have their section prose withheld while claim c01 survives — a prose hit never drops a claim', () => {
    for (const id of ['unknown-bucket-in-denominator', 'unknown-bucket-named-as-real-stage']) {
      const outcome = validateReportOutput(bridge(findFixture(id)));
      expect(dropRule(outcome, 'c01'), id).toBeUndefined();
      expect(outcome.survivingClaimIds, id).toContain('c01');
      expect(outcome.strippedSectionIds, id).toEqual(['section-0']);
    }
  });

  it('R7 (lexical, D-22) STRIPS the section and drops nothing: prose naming the unknown bucket is never delivered, and its claim still counts (plan 39-13, VAL-03)', () => {
    // Three evidenced claims in one clean section keep the scout output at
    // MIN_VIABLE_CLAIMS; a fourth section's prose names the unknown bucket.
    // Its prose must not ship — the API persists every section's connective
    // that is not in strippedSectionIds — but its claim (engine-authored,
    // judged on its own ids) survives.
    const outcome = validateReportOutput(
      fourClaimOutput({
        overview: { claimIds: ['c01', 'c02', 'c03'], connective: '' },
        watchFor: {
          claimIds: ['c04'],
          connective: 'They are 16-9 on Unknown Stage, a strong pick.',
        },
      }),
    );
    expect(outcome.status).toBe('passed');
    expect(dropRule(outcome, 'c04')).toBeUndefined();
    expect(outcome.survivingClaimIds).toContain('c04');
    expect(outcome.strippedSectionIds).toEqual(['watchFor']);
  });

  it('R7 (lexical, D-22 / SH-CR-02): lowercase "unknown character" in a section that shares a claim with a clean section strips only that prose — no claim is dropped and the output still passes', () => {
    const outcome = validateReportOutput(
      fourClaimOutput({
        overview: { claimIds: ['c01', 'c02'], connective: 'Stay patient.' },
        gameplan: {
          claimIds: ['c02', 'c03'],
          connective: 'If they pull an unknown character pocket pick, reset to neutral.',
        },
      }),
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.droppedClaims).toEqual([]);
    expect(outcome.survivingClaimIds).toEqual(['c01', 'c02', 'c03']);
    expect(outcome.strippedSectionIds).toEqual(['gameplan']);
  });

  it('R7 (lexical, D-22 / SH-WR-08): plural and any-casing forms of the unknown bucket strip the section too', () => {
    for (const connective of [
      'Their Unknown Stages record is 16-9.',
      'Some of those games were on unknown stages.',
      'Their UNKNOWN CHARACTERS are a mystery.',
    ]) {
      const outcome = validateReportOutput(
        fourClaimOutput({
          overview: { claimIds: ['c01', 'c02', 'c03'], connective: '' },
          watchFor: { claimIds: ['c04'], connective },
        }),
      );
      expect(outcome.strippedSectionIds, connective).toEqual(['watchFor']);
      expect(outcome.droppedClaims, connective).toEqual([]);
    }
  });

  it("API-WR-04 (D-22): a later section naming the unknown bucket never removes a claim an EARLIER section's delivered prose rests on", () => {
    // overview and watchFor share c04 (16-9). overview's prose rests on c04
    // (qualitative under D-24); only watchFor names the unknown bucket.
    // Before D-22, watchFor's R7 hit dropped c04 AFTER overview had been
    // linted with c04 licensed, so overview shipped prose no stored claim
    // backed.
    const outcome = validateReportOutput(
      fourClaimOutput({
        overview: {
          claimIds: ['c01', 'c04'],
          connective: 'Your recent form is holding up well lately.',
        },
        gameplan: { claimIds: ['c02', 'c03'], connective: '' },
        watchFor: { claimIds: ['c04'], connective: 'Watch the Unknown Stage games.' },
      }),
    );
    expect(outcome.survivingClaimIds).toContain('c04');
    expect(outcome.strippedSectionIds).toEqual(['watchFor']);
    // Every section that is delivered rests only on surviving claims.
    const surviving = new Set(outcome.survivingClaimIds);
    expect(['c01', 'c04'].every((id) => surviving.has(id))).toBe(true);
  });

  describe('R7 (structural, D-22 / SH-WR-02): a claim whose own stage/fighter id is the unknown bucket or off the roster is rejected', () => {
    const UNKNOWN_BUCKET_ID = 0;

    function singleClaimOutcome(
      predicate: EvidenceRow['predicate'],
      subject: ClaimSubject,
      value: ClaimAtom['value'],
    ) {
      const rowId = evidenceIdFor({ predicate, subject, opponentOrder: [] });
      const row: EvidenceRow = { predicate, subject, value, sample: makeSample(10) };
      const claim: ClaimAtom = {
        id: 'c01',
        predicate,
        subject,
        value,
        claimKind: 'fact',
        evidenceIds: [rowId],
        tier: value.kind === 'abstained' ? null : confidenceTierFor(10),
        policyVersion: EVIDENCE_POLICY_VERSION,
        sample: makeSample(10),
      };
      return validateReportOutput({
        snapshot: makeSnapshot({ [rowId]: row }),
        issuedClaims: [claim],
        output: {
          sections: { main: { claimIds: ['c01'], connective: '' } },
          action1: null,
          action2: null,
          action3: null,
        },
        surface: 'scout',
      });
    }

    it('an evidenced stage_record on stage id 0 is dropped under R7', () => {
      const outcome = singleClaimOutcome(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 23, stageId: UNKNOWN_BUCKET_ID },
        { kind: 'record', wins: 6, losses: 4, games: 10 },
      );
      expect(dropRule(outcome, 'c01')).toBe('R7');
    });

    it('an evidenced character_matchup_record against opponent fighter id 0 is dropped under R7', () => {
      const outcome = singleClaimOutcome(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId: 23, opponentFighterId: UNKNOWN_BUCKET_ID },
        { kind: 'record', wins: 6, losses: 4, games: 10 },
      );
      expect(dropRule(outcome, 'c01')).toBe('R7');
    });

    it('an abstained claim about the unknown fighter bucket is rejected too (D-22: id 0 ⇒ claim rejected)', () => {
      const outcome = singleClaimOutcome(
        'matchup_advisor_pick',
        { ...NULL_SUBJECT, opponentFighterId: UNKNOWN_BUCKET_ID },
        { kind: 'abstained', gamesNeeded: 2 },
      );
      expect(dropRule(outcome, 'c01')).toBe('R7');
    });

    it('an entity value naming fighter id 0, or a stage off the StageList, is dropped under R7', () => {
      expect(
        dropRule(
          singleClaimOutcome(
            'matchup_advisor_pick',
            { ...NULL_SUBJECT, opponentFighterId: 23 },
            { kind: 'entity', entityKind: 'fighter', entityId: String(UNKNOWN_BUCKET_ID) },
          ),
          'c01',
        ),
      ).toBe('R7');
      expect(
        dropRule(
          singleClaimOutcome(
            'matchup_advisor_pick',
            { ...NULL_SUBJECT, opponentFighterId: 23 },
            { kind: 'entity', entityKind: 'stage', entityId: '9999' },
          ),
          'c01',
        ),
      ).toBe('R7');
    });

    it('control: the same shapes on roster ids survive', () => {
      const outcome = singleClaimOutcome(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId: 23, opponentFighterId: 8 },
        { kind: 'record', wins: 6, losses: 4, games: 10 },
      );
      expect(outcome.droppedClaims).toEqual([]);
      expect(outcome.survivingClaimIds).toEqual(['c01']);
    });
  });

  it('R8: an action slot referencing a dropped (never-issued) claim becomes null and is reported — as a dropped ACTION, never a dropped claim (SH-WR-05)', () => {
    const fixture = findFixture('action-unlinked');
    const outcome = validateReportOutput(bridge(fixture));
    const actionDrop = outcome.droppedActions.find((d) => d.actionId === 'a01');
    expect(actionDrop?.rule).toBe('R8');
    // SH-WR-05 / API-IN-03: droppedClaimCount (the "N claims couldn't be
    // verified" caption and the report_claims_dropped event) counts claims only.
    expect(outcome.droppedClaims.some((d) => d.claimId === 'a01')).toBe(false);
    expect(outcome.droppedClaimCount).toBe(0);
    // The claim the action tried to reference (c09) was never issued at all.
    expect(outcome.survivingClaimIds).not.toContain('c09');
  });

  it('status is "failed" when survivors fall below MIN_VIABLE_CLAIMS[surface], using the exported constant', () => {
    const fixture = findFixture('sub-floor-assertion');
    const outcome = validateReportOutput(bridge(fixture, 'scout'));
    expect(outcome.status).toBe('failed');
  });

  describe('D-23 / SH-CR-03: only EVIDENCED surviving claims count toward MIN_VIABLE_CLAIMS', () => {
    /** `evidenced` claims on stages 1.., then `abstained` claims on the next stages, all selected in one section. */
    function mixedOutcome(evidenced: number, abstained: number) {
      const rows: Record<string, EvidenceRow> = {};
      const claims: ClaimAtom[] = [];
      for (let i = 0; i < evidenced + abstained; i += 1) {
        const isAbstained = i >= evidenced;
        const games = isAbstained ? 1 : 10;
        const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: i + 1 };
        const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
        const value = { kind: 'record' as const, wins: games, losses: 0, games };
        rows[rowId] = { predicate: 'stage_record', subject, value, sample: makeSample(games) };
        claims.push({
          id: `c0${i + 1}` as ClaimId,
          predicate: 'stage_record',
          subject,
          value: isAbstained ? { kind: 'abstained', gamesNeeded: 2 } : value,
          claimKind: 'fact',
          evidenceIds: [rowId],
          tier: isAbstained ? null : confidenceTierFor(games),
          policyVersion: EVIDENCE_POLICY_VERSION,
          sample: makeSample(games),
        });
      }
      return validateReportOutput({
        snapshot: makeSnapshot(rows),
        issuedClaims: claims,
        output: {
          sections: { main: { claimIds: claims.map((claim) => claim.id), connective: '' } },
          action1: null,
          action2: null,
          action3: null,
        },
        surface: 'scout',
      });
    }

    it('an output of nothing but abstained claims FAILS even though every claim survives', () => {
      const outcome = mixedOutcome(0, 3);
      expect(outcome.survivingClaimIds).toHaveLength(3);
      expect(outcome.status).toBe('failed');
    });

    it('two evidenced claims plus one abstention FAIL the scout minimum of three', () => {
      const outcome = mixedOutcome(2, 1);
      expect(outcome.survivingClaimIds).toHaveLength(3);
      expect(outcome.status).toBe('failed');
    });

    it('three evidenced claims plus one abstention PASS — abstentions still survive and are delivered', () => {
      const outcome = mixedOutcome(3, 1);
      expect(outcome.survivingClaimIds).toHaveLength(4);
      expect(outcome.status).toBe('passed');
    });
  });

  it('zero selected claims yields "failed", and an empty snapshot drops every selected claim', () => {
    const emptyOutcome = validateReportOutput({
      snapshot: makeSnapshot({}),
      issuedClaims: [],
      output: { sections: {}, action1: null, action2: null, action3: null },
      surface: 'scout',
    });
    expect(emptyOutcome.status).toBe('failed');

    const fixture = findFixture('cold-start-empty-snapshot');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.status).toBe('failed');
    expect(outcome.survivingClaimIds).toEqual([]);
  });

  it('C2-H3: status is independent of strippedSectionIds at every length — the outcome branch never references it', () => {
    const rows: Record<string, EvidenceRow> = {};
    const claims: ClaimAtom[] = [];
    for (let i = 0; i < 3; i += 1) {
      const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: i + 1 };
      const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
      rows[rowId] = {
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        sample: makeSample(10),
      };
      claims.push({
        id: `c0${i + 1}` as ClaimId,
        predicate: 'stage_record',
        subject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        claimKind: 'fact',
        evidenceIds: [rowId],
        tier: confidenceTierFor(10),
        policyVersion: EVIDENCE_POLICY_VERSION,
        sample: makeSample(10),
      });
    }
    const snapshot = makeSnapshot(rows);
    const noFault = validateReportOutput({
      snapshot,
      issuedClaims: claims,
      output: {
        sections: {
          s1: { claimIds: ['c01'], connective: '' },
          s2: { claimIds: ['c02'], connective: '' },
          s3: { claimIds: ['c03'], connective: '' },
        },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    const allFault = validateReportOutput({
      snapshot,
      issuedClaims: claims,
      output: {
        sections: {
          s1: { claimIds: ['c01'], connective: 'Fox vs Marth on this stage.' },
          s2: { claimIds: ['c02'], connective: 'A 62% pick rate for Fox is notable.' },
          s3: { claimIds: ['c03'], connective: 'Kalos Pokémon League comes up often.' },
        },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(noFault.status).toBe('passed');
    expect(allFault.status).toBe('passed');
    expect(allFault.survivingClaimIds).toEqual(['c01', 'c02', 'c03']);
  });

  it('a section with claim ids and an empty-after-trim connective joins strippedSectionIds rather than dropping claims or failing', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    const row: EvidenceRow = {
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      sample: makeSample(10),
    };
    const claim: ClaimAtom = {
      id: 'c01',
      predicate: 'stage_record',
      subject,
      value: { kind: 'record', wins: 6, losses: 4, games: 10 },
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: confidenceTierFor(10),
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(10),
    };
    const outcome = validateReportOutput({
      snapshot: makeSnapshot({ [rowId]: row }),
      issuedClaims: [claim],
      output: {
        sections: { main: { claimIds: ['c01'], connective: '   ' } },
        action1: null,
        action2: null,
        action3: null,
      },
      surface: 'scout',
    });
    expect(outcome.strippedSectionIds).toEqual([]);
    expect(outcome.survivingClaimIds).toContain('c01');
  });

  it('C2-L2: the module exports no stripped-prose reason constant — strippedSectionIds membership is the only channel', () => {
    expect(Object.keys(validateReportModule)).not.toContain('SECTION_PROSE_STRIPPED');
  });

  it('every claim the frozen legacy rule rejects is also dropped by validateReportOutput, across the whole corpus (plan 39-08 precondition)', () => {
    for (const fixture of ADVERSARIAL_FIXTURES) {
      const legacyVerdict = legacyCitationOnlyVerdict({
        snapshot: fixture.snapshot,
        output: fixture.output,
      });
      if (legacyVerdict.rejectedClaimIds.length === 0) {
        continue;
      }
      const outcome = validateReportOutput(bridge(fixture));
      for (const claimId of legacyVerdict.rejectedClaimIds) {
        expect(outcome.survivingClaimIds).not.toContain(claimId);
      }
    }
  });

  it('the corpus contains at least one fixture for each of the four verdict values, over a non-empty corpus', () => {
    expect(ADVERSARIAL_FIXTURES.length).toBeGreaterThan(0);
    const verdicts = new Set(ADVERSARIAL_FIXTURES.map((f) => f.expected.validatorVerdict));
    expect(verdicts.has('accepted')).toBe(true);
    expect(verdicts.has('stripped')).toBe(true);
    expect(verdicts.has('dropped')).toBe(true);
    expect(verdicts.has('failed')).toBe(true);
  });

  it.each(ADVERSARIAL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    'SH-WR-07: fixture %s — its expected.validatorVerdict label matches what the validator actually does',
    (_id, fixture) => {
      // This file may read the labels (only the VAL-03 judge must not). The
      // observed verdict, most severe first: any claim or action dropped;
      // else any section's prose withheld; else nothing survived; else
      // accepted.
      const outcome = validateReportOutput(bridge(fixture));
      const observed =
        outcome.droppedClaimCount > 0 || outcome.droppedActions.length > 0
          ? 'dropped'
          : outcome.strippedSectionIds.length > 0
            ? 'stripped'
            : outcome.survivingClaimIds.length === 0
              ? 'failed'
              : 'accepted';
      expect(observed).toBe(fixture.expected.validatorVerdict);
    },
  );

  it('tier_boundary fixtures produce the tier the policy function computes, with no off-by-one at the boundaries', () => {
    const boundaryGames = [
      CONFIDENCE_TIER_BOUNDS.low - 1,
      CONFIDENCE_TIER_BOUNDS.low,
      CONFIDENCE_TIER_BOUNDS.medium - 1,
      CONFIDENCE_TIER_BOUNDS.medium,
      CONFIDENCE_TIER_BOUNDS.high - 1,
      CONFIDENCE_TIER_BOUNDS.high,
    ];
    for (const games of boundaryGames) {
      const fixture = findFixture(`tier-boundary-${games}-games`);
      const outcome = validateReportOutput(bridge(fixture));
      if (games < CONFIDENCE_TIER_BOUNDS.low) {
        expect(outcome.survivingClaimIds).not.toContain('c01');
      } else {
        expect(outcome.survivingClaimIds).toContain('c01');
      }
    }
  });

  it('C2-H1: the all_null_subject fixture (recent_form / cohort_disclosure) is accepted, never crashing on an all-null subject', () => {
    const fixture = findFixture('all-null-subject');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.survivingClaimIds).toContain('c01');
  });
});

// ---------------------------------------------------------------------------
// Owner decision D-24 (code review R4-CR-01 / R4-CR-02, iteration 4): report
// commentary is QUALITATIVE ONLY. A section's prose is withheld (disclosed,
// never refunded — D-22) when it carries a digit of any script, a
// spelled-out number word, a percentage, a W-L-like pair with any
// separator, or a confidence-tier word ANYWHERE. Tag and name spans are
// consumed first. Every figure a user sees comes from a checked claim.
// ---------------------------------------------------------------------------

/** One section licensing one `stage_record` claim per spec (the opponent plays Fox on the given stage), each `wins`-`games - wins` over `games`. */
function validateStageRecords(
  specs: ReadonlyArray<{ stageId: number; games: number; wins: number }>,
  prose: string,
): { stripped: readonly string[]; dropped: number; tiers: string } {
  const rows: Record<string, EvidenceRow> = {};
  const claims: ClaimAtom[] = [];
  specs.forEach((spec, index) => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, opponentFighterId: 8, stageId: spec.stageId };
    const rowId = evidenceIdFor({ predicate: 'stage_record', subject, opponentOrder: [] });
    const value = {
      kind: 'record' as const,
      wins: spec.wins,
      losses: spec.games - spec.wins,
      games: spec.games,
    };
    rows[rowId] = { predicate: 'stage_record', subject, value, sample: makeSample(spec.games) };
    claims.push({
      id: `c0${index + 1}` as ClaimId,
      predicate: 'stage_record',
      subject,
      value,
      claimKind: 'fact',
      evidenceIds: [rowId],
      tier: confidenceTierFor(spec.games),
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: makeSample(spec.games),
    });
  });
  const outcome = validateReportOutput({
    snapshot: makeSnapshot(rows),
    issuedClaims: claims,
    output: {
      sections: { main: { claimIds: claims.map((claim) => claim.id), connective: prose } },
      action1: null,
      action2: null,
      action3: null,
    },
    surface: 'scout',
  });
  return {
    stripped: outcome.strippedSectionIds,
    dropped: outcome.droppedClaimCount,
    tiers: claims.map((claim) => claim.tier).join('/'),
  };
}

describe('D-24 / R4-CR-01: every W-L restatement is withheld, whatever its separator, phrasing or spelling', () => {
  // The iteration-4 review's probes (`r4v`), verbatim. A licensed 3-2: the
  // player won 3 and lost 2 against MkLeo. Every row is FALSE.
  const FALSE_HEAD_TO_HEAD = [
    'MkLeo leads the head-to-head 3-2.',
    'MkLeo leads 3-2.',
    'MkLeo is up 3-2 on you.',
    'MkLeo has won this matchup 3-2.',
    'MkLeo won your sets 3-2.',
    'MkLeo holds a 3-2 edge in your sets.',
    'MkLeo has gotten the better of you, 3-2.',
    'MkLeo has your number at 3-2.',
    'You lost the head-to-head 3-2.',
    'You are down 3-2 to MkLeo.',
    'You trail MkLeo 3-2.',
    'MkLeo is 3-2 in your meetings.',
    'MkLeo has won 3 of your 5 sets.',
    'You have won only 2 of 5 sets against MkLeo.',
    'MkLeo took 3 sets, you took 2.',
    'MkLeo is 3-2 against you.',
    // Separators and spellings.
    'MkLeo is 3—2 against you.',
    'MkLeo is 3 to 2 against you.',
    'MkLeo is 3:2 against you.',
    'MkLeo is 3/2 against you.',
    'MkLeo is 3 − 2 against you.',
    'MkLeo is three and two against you.',
    'MkLeo leads the series three sets to two.',
    'You have lost 3—2 to MkLeo.',
    'You are 7-1 against MkLeo.',
    'You are 7—1 against MkLeo.',
    'You are 7 to 1 against MkLeo.',
    'You are seven and one against MkLeo.',
  ];

  it.each(FALSE_HEAD_TO_HEAD)('withholds %j', (prose) => {
    expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose)).toEqual({
      stripped: ['main'],
      dropped: 0,
    });
  });

  it('the TRUE statements are withheld too: figures live on the claim line, never in the prose', () => {
    for (const prose of [
      'You are 3-2 against MkLeo.',
      'You lead MkLeo 3-2.',
      'You have won 3 of 5 sets against MkLeo.',
      'MkLeo is 2-3 against you.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: ['main'],
        dropped: 0,
      });
    }
  });

  it('spelled-out numbers, a dozen, a half and the ordinals are figures', () => {
    for (const prose of [
      'You have played MkLeo a dozen times.',
      'Half of your sets against MkLeo went the distance.',
      'MkLeo took the first set and never looked back.',
      'Your second set against MkLeo went better.',
      'MkLeo has won ninety sets this year.',
      'MkLeo has twenty wins on the circuit.',
      'Zero of those sets were close.',
      'Three of them went to the last stock.',
      'MkLeo won the tenth game.',
      'MkLeo won twice.',
      'MkLeo won twenty-one sets.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: ['main'],
        dropped: 0,
      });
    }
  });

  it('digits of any script and a percentage are figures', () => {
    for (const prose of [
      'MkLeo is ３-２ against you.',
      'MkLeo won ٣ sets.',
      'MkLeo won the set 3² times over.',
      'MkLeo wins about ½ of your games.',
      'MkLeo wins a big ％ of your games.',
      'MkLeo wins a big % of your games.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: ['main'],
        dropped: 0,
      });
    }
  });

  it('qualitative commentary survives, and word boundaries hold (someone, tone, highlight, often)', () => {
    for (const prose of [
      'MkLeo tends to camp ledge against you, so take the center.',
      'Someone who panics against MkLeo drops the lead; stay calm and highlight his landing habits.',
      'The tone of the set often shifts when MkLeo is behind.',
      'Play this matchup with confidence and patience.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: [],
        dropped: 0,
      });
    }
  });

  it('names still consume their letters and digits first: a digit-bearing canonical name or tag is not a figure', () => {
    expect(
      validateHeadToHead('Sparg0', { wins: 3, losses: 2 }, 'Sparg0 punishes a rushed approach.'),
    ).toEqual({ stripped: [], dropped: 0 });
    expect(
      validateStageRecords(
        [{ stageId: 59, games: 10, wins: 6 }],
        'Fox on Pokémon Stadium 2 rewards your patience.',
      ).stripped,
    ).toEqual([]);
  });
});

describe('D-24 / R4-CR-02: a confidence-tier word withholds the prose anywhere in the section, with no confidence stem required', () => {
  // The iteration-4 review's probes (`r4v`), verbatim: one LOW-tier claim
  // (Fox on Battlefield, 3-2 over five games). Every row is false.
  const PROBE_ROWS = [
    'Fox on Battlefield: 3-2. Certainty: high.',
    'Fox on Battlefield: 3-2. How sure should you be? High.',
    'Fox on Battlefield: 3-2. This is a high-certainty read.',
    'Fox on Battlefield: 3-2. Trust in this read: high.',
    'Fox on Battlefield: 3-2. Reliability of this read: high.',
    'Fox on Battlefield: 3-2. Our conviction here is high.',
    'Fox on Battlefield: 3-2. Our confidance here is high.',
    'Fox on Battlefield: 3-2. Our CONFIDENCE here is HIGH.',
    'Fox on Battlefield: 3-2. Con­fidence here is high.',
    'Fox on Battlefield: 3-2. Con​fidence here is high.',
    'Fox on Battlefield: 3-2. Our confidence here: very strong.',
    'Fox on Battlefield: 3-2. This read is rock solid.',
    'Fox on Battlefield: 3-2. Our confidence in this read? High.',
  ];

  it.each(PROBE_ROWS)('withholds %j', (prose) => {
    const result = validateStageRecords([{ stageId: 1, games: 5, wins: 3 }], prose);
    expect(result.tiers).toBe('low');
    expect(result.stripped).toEqual(['main']);
    expect(result.dropped).toBe(0);
  });

  it('the same tier words without any figure are withheld on their own — synonyms and misspellings of the stem no longer matter', () => {
    for (const prose of [
      'How sure should you be? High.',
      'Certainty: high.',
      'This is a high-certainty read.',
      'Trust in this read: high.',
      'Reliability of this read: high.',
      'Our conviction here is high.',
      'Our confidance here is high.',
      'Our confidence here: very strong.',
      'This is a moderate read at best.',
      'The evidence for this pick is weak.',
      'Treat this as a medium read.',
      'This is highly likely to come up.',
      'This is their strongest stage.',
    ]) {
      expect(
        validateStageRecords([{ stageId: 1, games: 5, wins: 3 }], prose).stripped,
        prose,
      ).toEqual(['main']);
    }
  });

  it('the union case: a section holding a HIGH-tier and a LOW-tier claim cannot say "high"', () => {
    const result = validateStageRecords(
      [
        { stageId: 1, games: 20, wins: 12 },
        { stageId: 3, games: 5, wins: 3 },
      ],
      'Confidence in the thin read is high.',
    );
    expect(result.tiers).toBe('high/low');
    expect(result.stripped).toEqual(['main']);
    expect(result.dropped).toBe(0);
  });

  it('every key of the licensed tier table is one of the withheld tier words', () => {
    for (const tier of ['low', 'medium', 'high']) {
      expect(
        validateStageRecords([{ stageId: 1, games: 20, wins: 12 }], `This is a ${tier} read.`)
          .stripped,
        tier,
      ).toEqual(['main']);
    }
  });

  it('R5-IN-02 (iteration 5): the strength adjective the rubric used to record as a limit ("rock solid") is now withheld', () => {
    expect(
      validateStageRecords([{ stageId: 1, games: 5, wins: 3 }], 'This read is rock solid.')
        .stripped,
    ).toEqual(['main']);
  });

  it('known limit (recorded in the rubric): a strength adjective outside the closed tier vocabulary, with no figure, is not recognised', () => {
    expect(
      validateStageRecords(
        [{ stageId: 1, games: 5, wins: 3 }],
        'We are very confident in this read.',
      ).stripped,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Code review iteration 5 (R5-CR-01..04, R5-IN-02, R5-IN-03): the D-24 prose
// check is an ALLOWLIST. The prose is folded (NFKC, format characters
// removed, NFD with combining marks removed, Markdown emphasis and code
// markers read as spaces), names and known tags consume their spans, and
// what remains may hold only ASCII letters, whitespace and the rubric's
// listed punctuation. The word lists stay as defence in depth. Every row
// below is the iteration-5 review's probe (`r5v/d24.test.ts`), verbatim,
// against a licensed 3-2 (the player won 3) or one LOW-tier stage claim
// (Fox on Battlefield, 3-2 over five games). Each one shipped at 2b332e6c.
// ---------------------------------------------------------------------------

const R5_HEAD_TO_HEAD_WITHHELD: ReadonlyArray<readonly [string, string]> = [
  // R5-CR-01: Markdown emphasis around a figure or a tier word.
  ['md-underscore-pair', 'You are _three and two_ against MkLeo.'],
  ['md-underscore-words', 'You are _three_ and _two_ against MkLeo.'],
  ['md-underscore-ordinals', 'You took the _first_ set off MkLeo and lost the _second_.'],
  ['md-underscore-half', 'MkLeo wins about _half_ your sets.'],
  ['md-underscore-strong', 'MkLeo is _strong_ against you.'],
  // R5-CR-02: exact number and record words outside the old list.
  ['word-once', 'You have beaten MkLeo once and never lost to him.'],
  ['word-once-only', 'You have only lost to MkLeo once.'],
  ['word-pair', 'You took a pair of sets from MkLeo and dropped a single set.'],
  ['word-couple', 'You won a couple of sets against MkLeo and lost a trio of them.'],
  ['word-single', 'MkLeo has taken just a single set off you.'],
  ['word-both', 'MkLeo won both of your sets.'],
  ['word-none', 'You have won none of your sets against MkLeo.'],
  ['word-nil', 'Your record against MkLeo is nil and nought.'],
  ['word-quarter', 'You win a quarter of your sets against MkLeo.'],
  ['word-eleventh', 'This is your eleventh set against MkLeo.'],
  ['word-twelfth', 'This is your twelfth set against MkLeo.'],
  ['word-twentieth', 'This is your twentieth set against MkLeo.'],
  ['word-hundredth', 'This is your hundredth game against MkLeo.'],
  ['word-million', 'You have lost to MkLeo a million times.'],
  ['word-sweep', 'You swept MkLeo.'],
  ['word-clean-sweep', 'Your history with MkLeo is a clean sweep.'],
  ['word-perfect-record', 'You have a perfect record against MkLeo.'],
  ['word-undefeated', 'You are undefeated against MkLeo.'],
  ['word-winless', 'You are winless against MkLeo.'],
  ['word-unbeaten', 'You are unbeaten against MkLeo.'],
  ['word-flawless', 'Your run against MkLeo is flawless.'],
  ['word-all-but-single', 'MkLeo has won all but a single set.'],
  ['word-trio-duo', 'You took a trio of sets and lost a duo against MkLeo.'],
  ['word-score', 'You have played MkLeo a score of times.'],
  ['word-percentage', 'You win a large percentage of sets against MkLeo.'],
  ['roman-pair', 'You are III-II against MkLeo.'],
  ['roman-words', 'Against MkLeo you sit at III and II.'],
  // R5-IN-02: vague quantifiers.
  ['quantifier-several', 'You have lost several sets to MkLeo.'],
  ['quantifier-most', 'You win most of your sets against MkLeo.'],
  ['quantifier-majority', 'You win the majority of your sets against MkLeo.'],
  ['quantifier-minority', 'MkLeo wins only a minority of your sets.'],
  ['quantifier-few', 'MkLeo has taken few sets off you.'],
  ['quantifier-many', 'MkLeo has taken many sets off you.'],
  ['quantifier-pct', 'You win most sets (pct) against MkLeo.'],
  // R5-CR-03: non-English prose.
  ['lang-es', 'Estás tres a dos contra MkLeo; la confianza es alta.'],
  ['lang-fr', 'Tu es à trois contre deux face à MkLeo.'],
  ['lang-de', 'Du stehst drei zu zwei gegen MkLeo, Vertrauen hoch.'],
  ['lang-ja', 'MkLeoに三勝二敗、信頼度は高い。'],
  ['lang-ja-daiji', 'MkLeoに参勝弐敗。'],
  ['lang-ja-rate', 'MkLeoに対して六割の勝率。'],
  // R5-CR-04: invisible characters, compatibility letterforms, homoglyphs.
  ['uni-cyrillic', 'You are thrее and twо against MkLeo.'],
  ['uni-zwsp', 'You are thr​ee and tw​o against MkLeo.'],
  ['uni-shy-three', 'You beat MkLeo th­ree times.'],
  ['uni-wj-three', 'You beat MkLeo th⁠ree times.'],
  ['uni-fullwidth', 'You are ｔｈｒｅｅ and ｔｗｏ against MkLeo.'],
  [
    'uni-math-bold',
    'You are \u{1d42d}\u{1d421}\u{1d42b}\u{1d41e}\u{1d41e} and \u{1d42d}\u{1d430}\u{1d428} against MkLeo.',
  ],
  ['uni-ligature', 'You won the ﬁrst set against MkLeo.'],
  ['uni-keycap-ten', 'You have beaten MkLeo \u{1f51f} times.'],
  ['uni-hundred', 'You win \u{1f4af} against MkLeo.'],
  ['uni-dice', 'You are ⚂-⚁ against MkLeo.'],
];

const R5_STAGE_WITHHELD: ReadonlyArray<readonly [string, string]> = [
  // R5-CR-01.
  ['md-underscore-sentence', 'Fox on Battlefield. _Confidence here is high_.'],
  ['md-double-underscore', 'Fox on Battlefield. Confidence here is __high__.'],
  ['md-underscore-word', 'Fox on Battlefield. Confidence: _high_.'],
  ['md-trailing-underscore', 'Fox on Battlefield. Confidence: high_.'],
  ['md-strike', 'Fox on Battlefield. Confidence here is ~~high~~.'],
  ['md-code', 'Fox on Battlefield. Confidence here is `high`.'],
  // R5-CR-02: exact tier synonyms.
  ['tier-mid', 'Fox on Battlefield. Confidence: mid.'],
  ['tier-hi', 'Fox on Battlefield. Confidence: hi.'],
  ['tier-lo', 'Fox on Battlefield. Confidence: lo.'],
  ['tier-middling', 'Fox on Battlefield. Confidence here is middling.'],
  ['tier-top', 'Fox on Battlefield. Confidence: top.'],
  ['tier-max', 'Fox on Battlefield. Confidence: max.'],
  ['tier-poor', 'Fox on Battlefield. Confidence: poor.'],
  ['tier-limited', 'Fox on Battlefield. Confidence: limited.'],
  ['tier-elevated', 'Fox on Battlefield. Confidence: elevated.'],
  // R5-IN-02: strength adjectives.
  ['tier-solid', 'Fox on Battlefield. Confidence: solid.'],
  ['tier-reliable', 'Fox on Battlefield. This is a reliable read.'],
  ['tier-shaky', 'Fox on Battlefield. This read is shaky.'],
  ['tier-certain', 'Fox on Battlefield. This read is certain.'],
  ['tier-sure', 'Fox on Battlefield. We are sure of this read.'],
  ['tier-iffy', 'Fox on Battlefield. This read is iffy.'],
  // R5-CR-04.
  ['uni-cyrillic-high', 'Fox on Battlefield. Confidence here is hіgh.'],
  ['uni-zwj-high', 'Fox on Battlefield. Confidence here is hi‍gh.'],
  ['uni-shy-high', 'Fox on Battlefield. Confidence here is hi­gh.'],
  ['uni-combining-high', 'Fox on Battlefield. Confidence here is h̲igh.'],
  ['uni-fullwidth-high', 'Fox on Battlefield. Confidence here is ｈｉｇｈ.'],
];

describe('R5 (iteration 5): the D-24 allowlist withholds every figure and grade the word lists missed', () => {
  it.each(R5_HEAD_TO_HEAD_WITHHELD)('head-to-head %s: %j', (_id, prose) => {
    expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose)).toEqual({
      stripped: ['main'],
      dropped: 0,
    });
  });

  it.each(R5_STAGE_WITHHELD)('stage %s: %j', (_id, prose) => {
    const result = validateStageRecords([{ stageId: 1, games: 5, wins: 3 }], prose);
    expect(result.tiers).toBe('low');
    expect(result).toMatchObject({ stripped: ['main'], dropped: 0 });
  });

  it('any character outside the allowlist withholds the section, even with no figure in it', () => {
    for (const prose of [
      'MkLeo camps the ledge & you should take the centre.',
      'Stay patient + punish his landing.',
      'Watch his {ledge} options.',
      'MkLeo loves ledge traps → take the centre.',
      'MkLeo wins the neutral @ the ledge.',
      'Take the centre #patience.',
      'MkLeo camps the ledge 🙂 so stay patient.',
      'MkLeo camps the ledge so stay patient.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose).stripped, prose).toEqual([
        'main',
      ]);
    }
  });

  it('controls: every allowed punctuation mark, square brackets and line breaks ship (R6-IN-05: the prompts permit brackets)', () => {
    for (const prose of [
      'MkLeo tends to camp the ledge; take the centre — and stay patient.',
      'Don’t chase “reads” off stage (be patient), and/or reset to neutral!',
      "Is MkLeo rushing? Stay calm: reset. MkLeo's recovery is predictable - punish it.",
      'MkLeo likes ‘safe’ options – so "call" them.',
      'Watch his [ledge] options.',
      'MkLeo camps the ledge.\nTake the centre.\nStay calm.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: [],
        dropped: 0,
      });
    }
  });

  it('licensed names consume their symbols, digits and accented letters first: "Pokémon Stadium 2" and an accented tag (decomposed in the prose) ship', () => {
    expect(
      validateStageRecords(
        [{ stageId: 59, games: 10, wins: 6 }],
        'Fox on Pokémon Stadium 2 rewards your patience.',
      ).stripped,
    ).toEqual([]);
    expect(
      validateHeadToHead('José', { wins: 3, losses: 2 }, 'Stay patient against Jose\u0301.'),
    ).toEqual({ stripped: [], dropped: 0 });
  });

  it('R5-IN-03 (decided fail-closed): a tag that reads as a figure or a grade is not consumed, so its mentions withhold the prose', () => {
    for (const [tag, prose] of [
      ['High', 'You beat High, and confidence is High.'],
      ['High', 'You beat High, keep it up.'],
      ['Twice', 'You beat Twice, keep it up.'],
      ['Leo 3-2', 'You are Leo 3-2 against, keep it up.'],
    ] as const) {
      expect(validateHeadToHead(tag, { wins: 3, losses: 2 }, prose), `${tag}: ${prose}`).toEqual({
        stripped: ['main'],
        dropped: 0,
      });
    }
    // Controls: a digit-bearing letter tag is still a name.
    for (const [tag, prose] of [
      ['Sparg0', 'Sparg0 punishes a rushed approach.'],
      ['2GG Tweek', 'You keep losing to 2GG Tweek.'],
      ['Mew2King', 'Mew2King has your number.'],
    ] as const) {
      expect(validateHeadToHead(tag, { wins: 3, losses: 2 }, prose), `${tag}: ${prose}`).toEqual({
        stripped: [],
        dropped: 0,
      });
    }
  });

  it('R5-IN-03: a digit- or numeral-bearing canonical name read as a count withholds the prose', () => {
    for (const [stageId, prose] of [
      [59, 'Fox on Pokémon Stadium 2 wins for you.'],
      [59, 'On Pokémon Stadium 2 sets have gone your way.'],
      [99, 'Fox on PictoChat 2 times has beaten you.'],
      [31, 'Fox on 75m wins.'],
      [21, 'Fox on 3D Land losses pile up.'],
      [15, 'Fox on Mushroom Kingdom II to III.'],
    ] as const) {
      expect(validateStageRecords([{ stageId, games: 5, wins: 3 }], prose).stripped, prose).toEqual(
        ['main'],
      );
    }
    // Controls: the same names in qualitative commentary.
    for (const [stageId, prose] of [
      [15, 'Fox on Mushroom Kingdom II.'],
      [75, 'Fox on Flat Zone X.'],
      [59, 'Pokémon Stadium 2 and its transformations suit your patience.'],
    ] as const) {
      expect(validateStageRecords([{ stageId, games: 5, wins: 3 }], prose).stripped, prose).toEqual(
        [],
      );
    }
  });

  it('the price, stated: ordinary words on the extended lists are withheld in their everyday sense too', () => {
    for (const prose of [
      'The tone of the set often shifts once MkLeo is behind.',
      'Make sure you take the centre against MkLeo.',
      'Watch for MkLeo on the top platform.',
      'MkLeo has solid ledge options.',
      'Most of MkLeo’s kills come off the ledge.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose).stripped, prose).toEqual([
        'main',
      ]);
    }
  });

  it('known limit (recorded in the rubric): English-only commentary, so non-English prose in plain ASCII letters with no listed word ships', () => {
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'Juega con paciencia contra MkLeo.')
        .stripped,
    ).toEqual([]);
  });

  it('R6-WR-01 (iteration 6): the degenerate forms this test used to pin as shipping are withheld now', () => {
    for (const prose of [
      'MkLeo has won every set you have played.',
      'Your head-to-head with MkLeo is dead even.',
      'You won your last set against MkLeo.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose).stripped, prose).toEqual([
        'main',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Code review iteration 6 (R6-CR-01..04, R6-WR-01..03, R6-IN-04, R6-IN-05):
// the iteration-5 check folded the prose and ran the allowlist on the FOLDED
// copy, but the product delivers the ORIGINAL text. Roman-numeral characters
// folded into letters, bidi overrides and tag characters were deleted, and
// Markdown markers inside a word became spaces, so the delivered text said
// "two" while the checked text did not. The check now reads exactly the text
// that is delivered: no fold, only a licensed name's or tag's exact span is
// consumed, and every other character outside the allowlist withholds the
// section. Each row below is the iteration-6 review's probe
// (`r6v/d24.test.ts`), against a licensed 3-2 (the player won 3) or one
// LOW-tier stage claim (Fox on Battlefield, 3-2 over five games). Invisible
// and bidi characters are written as escapes. Every row shipped at 04ab0064.
// ---------------------------------------------------------------------------

const R6_HEAD_TO_HEAD_WITHHELD: ReadonlyArray<readonly [string, string]> = [
  // R6-CR-01: roman-numeral characters (Nl), then ASCII roman numerals.
  ['nl-V', 'You took \u2164 games off MkLeo.'],
  ['nl-I', 'You took \u2160 set off MkLeo.'],
  ['nl-X', 'You won \u2169 games against MkLeo.'],
  ['nl-XL', 'You won \u2169\u216c games against MkLeo.'],
  ['nl-L', 'You won \u216c games against MkLeo.'],
  ['nl-C', 'You won \u216d games against MkLeo.'],
  ['nl-small-iii', 'You won \u2172 sets against MkLeo.'],
  ['nl-small-ii', 'You lost \u2171 sets to MkLeo.'],
  ['nl-small-pair', 'You are \u2172-\u2171 against MkLeo.'],
  ['nl-V-and-I', 'You are \u2164 and \u2160 against MkLeo.'],
  ['ascii-iii', 'You won iii sets against MkLeo.'],
  ['ascii-iii-ii', 'You are iii-ii against MkLeo.'],
  ['ascii-V-and-I', 'You are V and I against MkLeo.'],
  ['ascii-XL', 'You won XL games against MkLeo.'],
  ['ascii-V-to-I', 'You lead MkLeo V to I.'],
  ['ascii-X', 'You took X games off MkLeo.'],
  ['ascii-xiv', 'You won xiv sets against MkLeo.'],
  ['ascii-XC', 'You have played MkLeo XC times.'],
  ['ascii-I-to-I', 'You and MkLeo are I to I.'],
  ['ascii-I-dash-I', 'You and MkLeo sit at I - I.'],
  ["ascii-X's", "X's worth of sets went to MkLeo."],
  // R6-CR-02: bidi controls and tag characters are delivered, so they withhold.
  ['rlo-owt', 'You beat MkLeo \u202eowt\u202c times.'],
  ['rli-owt', 'You beat MkLeo \u2067owt\u2069 times.'],
  ['rlo-pair', 'You are \u202eeerht\u202c and \u202eowt\u202c against MkLeo.'],
  ['lro', 'You beat MkLeo \u202dtwo\u202c times.'],
  ['rlm', 'You beat MkLeo\u200f often.'],
  ['tag-digit', 'You beat MkLeo \udb40\udc33 times.'],
  ['tag-letters', 'You beat MkLeo \udb40\udc74\udb40\udc77\udb40\udc6f times.'],
  // R6-CR-03: a Markdown marker anywhere, inside a word or around one.
  ['md-t**w**o', 'You beat MkLeo t**w**o times.'],
  ['md-th**ree**', 'You are th**ree** and t**wo** against MkLeo.'],
  ['md-code', 'You are t`w`o up on MkLeo.'],
  ['md-strike', 'You are t~~w~~o up on MkLeo.'],
  // R6-CR-04: a listed word spelled out letter by letter.
  ['sep-t-w-o', 'You beat MkLeo t-w-o times.'],
  ['sep-t.w.o', 'You beat MkLeo t.w.o times.'],
  ['sep-t w o', 'You beat MkLeo t w o times.'],
  ['sep-t/w/o', 'You beat MkLeo t/w/o times.'],
  ['sep-t–w–o', 'You beat MkLeo t–w–o times.'],
  ["sep-t'w'o", "You beat MkLeo t'w'o times."],
  ['sep-T, W, O', 'You beat MkLeo T, W, O times.'],
  // R6-WR-01: all-or-nothing, even records, margins, multiples, single
  // results and zero sides.
  ['every', 'You won every set against MkLeo.'],
  ['all', 'You won all your sets against MkLeo.'],
  ['never-lost', 'You have never lost to MkLeo.'],
  ['never-beaten', 'You have never beaten MkLeo.'],
  ['never', 'You never beat MkLeo.'],
  ['always', 'You always beat MkLeo.'],
  ['yet-to-beat', 'You are yet to beat MkLeo.'],
  ['perfect', 'You are perfect against MkLeo.'],
  ['nothing', 'You have won nothing against MkLeo.'],
  ['zilch', 'You have zilch wins against MkLeo.'],
  ['zip', 'You have won zip against MkLeo.'],
  ['nada', 'You have won nada against MkLeo.'],
  ['dead-even', 'You are dead even with MkLeo.'],
  ['tied', 'You are tied with MkLeo.'],
  ['split', 'You split your sets with MkLeo.'],
  ['evenly', 'Your sets with MkLeo are split evenly.'],
  ['even-record', 'Your record against MkLeo is even.'],
  ['coin-flip', 'Your sets with MkLeo are a coin flip.'],
  ['a-set-each', 'You and MkLeo have taken a set each.'],
  ['a-win-and-a-loss', 'You have a win and a loss against MkLeo.'],
  ['up-a-set', 'You are up a set on MkLeo.'],
  ['down-a-game', 'You are down a game to MkLeo.'],
  ['lead-by-a-set', 'You lead MkLeo by a set.'],
  ['lead-by-a-game', 'You lead MkLeo by a game.'],
  ['trail-by-a-set', 'You trail MkLeo by a set.'],
  ['double', 'You have double the wins MkLeo has.'],
  ['triple', 'You have triple the wins against MkLeo.'],
  ['treble', 'You have treble the wins against MkLeo.'],
  ['double-digit', 'You have double-digit wins against MkLeo.'],
  ['hat-trick', 'You scored a hat trick of wins over MkLeo.'],
  ['brace', 'You took a brace of sets from MkLeo.'],
  ['lone', 'Your lone win against MkLeo came last year.'],
  ['only', 'Your only win against MkLeo was close.'],
  ['sole', 'Your sole loss to MkLeo was close.'],
  ['solo', 'You have a solo win over MkLeo.'],
  ['last-set', 'You lost your last set to MkLeo.'],
  ['shut-out', 'MkLeo has shut you out.'],
  ['shutout', 'MkLeo has a shutout over you.'],
  ['blanked', 'MkLeo has blanked you.'],
  ['clean-record', 'You have a clean record against MkLeo.'],
  ['spotless', 'Your record against MkLeo is spotless.'],
  ['unblemished', 'Your record against MkLeo is unblemished.'],
  // R6-WR-02: glued and stretched listed words.
  ['glue-twotimes', 'You beat MkLeo twotimes.'],
  ['glue-threeandtwo', 'You are threeandtwo against MkLeo.'],
  ['glue-twofold', 'Your lead over MkLeo is twofold.'],
  ['stretch-twooo', 'You beat MkLeo twooo times.'],
  ['stretch-alll', 'You took alll the sets from MkLeo.'],
  ['stretch-IIII', 'You won IIII sets against MkLeo.'],
];

const R6_STAGE_WITHHELD: ReadonlyArray<readonly [string, string]> = [
  // R6-CR-02.
  ['rlo-hgih', 'Fox on Battlefield. Confidence here is \u202ehgih\u202c.'],
  // R6-CR-03.
  ['md-h*igh*', 'Fox on Battlefield. Confidence here is h*igh*.'],
  ['md-h_ig_h', 'Fox on Battlefield. Confidence is h_ig_h.'],
  // R6-CR-04.
  ['sep-H-I-G-H', 'Fox on Battlefield. Confidence here is H-I-G-H.'],
  ['sep-h i g h', 'Fox on Battlefield. Confidence here is h i g h.'],
  ['sep-l.o.w', 'Fox on Battlefield. Confidence here is l.o.w.'],
  // R6-WR-01: tier derivatives.
  ['tier-lowish', 'Fox on Battlefield. Confidence is lowish.'],
  ['tier-highish', 'Fox on Battlefield. Confidence is highish.'],
  ['tier-minimal', 'Fox on Battlefield. Confidence is minimal.'],
  ['tier-maximal', 'Fox on Battlefield. Confidence is maximal.'],
  ['tier-solidly', 'Fox on Battlefield. This read holds solidly.'],
  ['tier-shakier', 'Fox on Battlefield. This read is shakier.'],
  // R6-WR-02.
  ['glue-highconfidence', 'Fox on Battlefield, highconfidence.'],
  ['glue-lowconfidence', 'Fox on Battlefield, lowconfidence.'],
  ['glue-toptier', 'Fox on Battlefield is a toptier pick.'],
  ['stretch-hiiigh', 'Fox on Battlefield. Confidence here is hiiigh.'],
  ['stretch-looow', 'Fox on Battlefield. Confidence here is looow.'],
];

/** Text that is now outside the allowlist although it states no figure: the delivered bytes are what is checked. */
const R6_UNFOLDED_WITHHELD: ReadonlyArray<readonly [string, string]> = [
  ['md-underscore-word', 'Stay _patient_ against MkLeo and punish the landing.'],
  ['md-bold-word', 'Stay patient against MkLeo and **punish** the landing.'],
  ['soft-hyphen', 'Stay pa\u00adtient against MkLeo.'],
  ['zero-width-space', 'Stay pa\u200btient against MkLeo.'],
  ['word-joiner', 'Stay pa\u2060tient against MkLeo.'],
  ['zero-width-joiner', 'Stay pa\u200dtient against MkLeo.'],
  ['no-break-space', 'Stay\u00a0patient against MkLeo.'],
  ['combining-mark', 'Stay pa\u0332tient against MkLeo.'],
  ['fullwidth', 'Stay \uff50\uff41\uff54\uff49\uff45\uff4e\uff54 against MkLeo.'],
  ['ligature', 'Stay \ufb01rm against MkLeo.'],
  ['accent-outside-name', 'MkLeo loves a caf\u00e9-style slow neutral, so stay patient.'],
  [
    'decomposed-accent-outside-name',
    'MkLeo loves a cafe\u0301-style slow neutral, so stay patient.',
  ],
  ['carriage-return', 'MkLeo camps the ledge.\r\nTake the centre.'],
  ['tab', 'MkLeo camps the ledge.\tTake the centre.'],
  ['curly-brace', 'Watch his {ledge} options.'],
];

describe('R6 (iteration 6): the D-24 check reads the delivered text, never a folded copy', () => {
  it.each(R6_HEAD_TO_HEAD_WITHHELD)('head-to-head %s: %j', (_id, prose) => {
    expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose)).toEqual({
      stripped: ['main'],
      dropped: 0,
    });
  });

  it.each(R6_STAGE_WITHHELD)('stage %s: %j', (_id, prose) => {
    const result = validateStageRecords([{ stageId: 1, games: 5, wins: 3 }], prose);
    expect(result.tiers).toBe('low');
    expect(result).toMatchObject({ stripped: ['main'], dropped: 0 });
  });

  it.each(R6_UNFOLDED_WITHHELD)('unfolded %s: %j', (_id, prose) => {
    expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose)).toEqual({
      stripped: ['main'],
      dropped: 0,
    });
  });

  it('R6-CR-03: a Markdown marker inside a licensed tag withholds the section too, since the renderer reads it', () => {
    expect(
      validateHeadToHead('Light_', { wins: 3, losses: 2 }, 'Stay patient against Light_.').stripped,
    ).toEqual(['main']);
  });

  it('only a LICENSED name or tag consumes non-ASCII letters: the same accent elsewhere withholds', () => {
    expect(
      validateStageRecords(
        [{ stageId: 59, games: 10, wins: 6 }],
        'Poke\u0301mon Stadium 2 rewards your patience.',
      ).stripped,
    ).toEqual([]);
    expect(
      validateStageRecords(
        [{ stageId: 1, games: 10, wins: 6 }],
        'Your Pok\u00e9mon knowledge helps on Battlefield.',
      ).stripped,
    ).toEqual(['main']);
    expect(
      validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, 'Stay patient against Jos\u00e9.')
        .stripped,
    ).toEqual(['main']);
  });

  it('R6-IN-04: a licensed name written with a numeral glyph is not the licensed name, so the glyph withholds', () => {
    for (const [stageId, prose] of [
      [59, 'Fox on Pok\u00e9mon Stadium \u2461, keep it up.'],
      [31, 'Fox on \u2077\u2075m, keep it up.'],
      [75, 'Fox on Flat Zone \u2169, keep it up.'],
      [15, 'Fox on Mushroom Kingdom \u2171, keep it up.'],
    ] as const) {
      expect(validateStageRecords([{ stageId, games: 5, wins: 3 }], prose).stripped, prose).toEqual(
        ['main'],
      );
    }
    expect(
      validateHeadToHead('Leo \u2164', { wins: 3, losses: 2 }, 'You beat Leo \u2164, keep it up.')
        .stripped,
    ).toEqual(['main']);
  });

  it('R6-WR-03: a digit- or numeral-bearing name or tag followed by any count word withholds', () => {
    for (const [stageId, prose] of [
      [59, 'Fox on Pok\u00e9mon Stadium 2 matches went your way.'],
      [59, 'You took Pok\u00e9mon Stadium 2 straight.'],
      [59, 'You won Pok\u00e9mon Stadium 2 in a row.'],
      [59, 'Fox on Pok\u00e9mon Stadium 2 victories keep coming.'],
      [59, 'Fox on Pok\u00e9mon Stadium 2 rounds went your way.'],
      [59, 'Fox on Pok\u00e9mon Stadium 2 defeats pile up.'],
      [99, 'Fox on PictoChat 2 matches.'],
      [15, 'Fox on Mushroom Kingdom II matches.'],
      [75, 'Fox on Flat Zone X matches.'],
      [31, 'Fox on 75m matches.'],
    ] as const) {
      expect(validateStageRecords([{ stageId, games: 5, wins: 3 }], prose).stripped, prose).toEqual(
        ['main'],
      );
    }
    for (const [tag, prose] of [
      ['Leo 2', 'You have beaten Leo 2 times.'],
      ['Leo 2', 'You took Leo 2 sets in a row.'],
      ['Zer0Frame 3', 'You beat Zer0Frame 3 games straight.'],
      ['Sparg0', 'Sparg0 wins keep piling up.'],
    ] as const) {
      expect(validateHeadToHead(tag, { wins: 3, losses: 2 }, prose).stripped, prose).toEqual([
        'main',
      ]);
    }
  });

  it('R6-WR-03 controls: the same digit-bearing names and tags in qualitative commentary ship', () => {
    for (const [stageId, prose] of [
      [59, 'Pok\u00e9mon Stadium 2 and its transformations suit your patience.'],
      [15, 'Fox on Mushroom Kingdom II.'],
      [75, 'Fox on Flat Zone X.'],
      [31, 'Fox on 75m likes the upper girders.'],
    ] as const) {
      expect(validateStageRecords([{ stageId, games: 5, wins: 3 }], prose).stripped, prose).toEqual(
        [],
      );
    }
    for (const [tag, prose] of [
      ['Leo 2', 'Leo 2 camps the ledge; stay patient.'],
      ['Zer0Frame 3', 'Zer0Frame 3 rushes the landing, so wait him out.'],
      ['Sparg0', 'Sparg0 punishes a rushed approach.'],
    ] as const) {
      expect(validateHeadToHead(tag, { wins: 3, losses: 2 }, prose).stripped, prose).toEqual([]);
    }
  });

  it('over-strip controls: ordinary sentences near the new rules still ship', () => {
    for (const prose of [
      // R6-CR-04: "a" and "I" alone, contractions, and "e.g."/"i.e.".
      'I think a read on MkLeo’s ledge habits will pay off.',
      "It's a good idea to reset when MkLeo presses you, and I'd take the centre.",
      "I'm going to say it plainly: wait for MkLeo to commit.",
      'Take the centre, e.g. when MkLeo lands, and punish; i.e. make him come to you.',
      // R6-CR-01: English words that are valid roman numerals, and "I" alone.
      'Mix up your options and improve your DI when MkLeo combos you.',
      'MkLeo did not adapt; stay civil, keep a vivid picture of his mild habits and an ill-timed roll will come.',
      'Use your i-frames on the ledge when MkLeo presses you.',
      // R6-WR-02: words that contain a listed word but are not glued figures.
      'The tone of the set often shifts when MkLeo is alone at the ledge.',
      'Shift your weight, highlight the punish, and shout it out in review against MkLeo.',
      'Someone who panics against MkLeo drops the lead; anyone calm can wait him out.',
      'Overall, stay patient in the neutral and let MkLeo come to you.',
      'Remember to take the centre against MkLeo; toward the ledge he gets predictable.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose), prose).toEqual({
        stripped: [],
        dropped: 0,
      });
    }
  });

  it('the price, stated: everyday senses of the R6 words and of a lone letter are withheld too', () => {
    for (const prose of [
      'Always shield when MkLeo lands.',
      'Never chase MkLeo off stage.',
      'Only commit when MkLeo is in the air.',
      'Even so, stay patient against MkLeo.',
      'Double jump sparingly against MkLeo.',
      'Keep a perfect shield ready for MkLeo.',
      'Everyone struggles with MkLeo’s ledge game.',
      'MkLeo and I like the ledge.',
      'Label his habit X and punish it.',
    ]) {
      expect(validateHeadToHead('MkLeo', { wins: 3, losses: 2 }, prose).stripped, prose).toEqual([
        'main',
      ]);
    }
  });
});
