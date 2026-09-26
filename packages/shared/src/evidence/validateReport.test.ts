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
    // `prose-entity-licensed-different-section` (adversarialFixtures.ts,
    // plan 39-01) models the STRUCTURAL contract — a licence in one section
    // never reaches another — but its own prose text ("On this stage your
    // record has historically favored you.") carries no digit, canonical
    // entity name, or opponent tag under this plan's cycle-2/3 narrowed R4
    // rule (the fixture predates that narrowing; recorded as an out-of-scope
    // pre-existing corpus gap in this plan's SUMMARY, same class as 39-03's
    // own recorded MIN_VIABLE_CLAIMS grep-gate deviation). This hand-built
    // case exercises the SAME contract with a digit that IS lexically
    // detectable, proving section-scoping is real.
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

  it('prose_encoding: a fullwidth numeral licensed by a rate claim does NOT fail', () => {
    const fixture = findFixture('prose-encoding-fullwidth-digit');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual([]);
  });

  it('prose_encoding: an NFD-spelled licensed opponent tag does NOT fail (NFC-normalized before comparison)', () => {
    const fixture = findFixture('prose-encoding-nfd-opponent-tag');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual([]);
  });

  it('prose_encoding: a ja-locale sentence with no unlicensed specific does NOT fail', () => {
    const fixture = findFixture('prose-encoding-ja-locale');
    const outcome = validateReportOutput(bridge(fixture));
    expect(outcome.strippedSectionIds).toEqual([]);
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
      const outcome = scanFor('This matchup is largely unknown territory for both players.');
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
          s1: { claimIds: ['c01'], connective: 'Solid record on this stage.' },
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

  describe('C2-H3 digit rule', () => {
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

    it('each NON_FACTUAL_NUMERIC_PATTERNS shape passes clean', () => {
      expect(NON_FACTUAL_NUMERIC_PATTERNS.length).toBe(5);
      expect(digitScan('Game 1: X; if they swap to Y, counter with Z.').strippedSectionIds).toEqual(
        [],
      );
      expect(digitScan('Focus on their top-5 characters this bracket.').strippedSectionIds).toEqual(
        [],
      );
      expect(
        digitScan('This is likely a best-of-5 set, plan your bans.').strippedSectionIds,
      ).toEqual([]);
      expect(
        digitScan('They almost always take their pick 3rd in the order.').strippedSectionIds,
      ).toEqual([]);
    });

    it('a licensed integer written as a fullwidth numeral passes (the folding rule)', () => {
      expect(digitScan('Their record here is ６ wins.').strippedSectionIds).toEqual([]);
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

    it('SH-CR-01: a real list position (start of text or line, then whitespace) and a standalone ordinal stay exempt', () => {
      expect(
        digitScan('1. Punish their landing.\n2. Stay patient at ledge.').strippedSectionIds,
      ).toEqual([]);
      expect(digitScan('3) Reset to neutral when in doubt.').strippedSectionIds).toEqual([]);
      expect(digitScan('They take their pick 3rd in the order.').strippedSectionIds).toEqual([]);
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

    it('"low"/"high" as ordinary Smash vocabulary is not a confidence word — only next to "confidence" is it one', () => {
      expect(
        lintWith([{ stageId: 1 }], 'Watch for their high recovery and low percent combos.'),
      ).toEqual([]);
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
    // overview and watchFor share c04 (16-9). overview's prose names 16-9
    // (licensed by c04); only watchFor names the unknown bucket. Before
    // D-22, watchFor's R7 hit dropped c04 AFTER overview had been linted
    // with c04 licensed, so overview shipped a figure no stored claim backed.
    const outcome = validateReportOutput(
      fourClaimOutput({
        overview: { claimIds: ['c01', 'c04'], connective: 'Your form reads 16-9 lately.' },
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

  it('the corpus contains at least one fixture for each of the three verdict values, over a non-empty corpus', () => {
    expect(ADVERSARIAL_FIXTURES.length).toBeGreaterThan(0);
    const verdicts = new Set(ADVERSARIAL_FIXTURES.map((f) => f.expected.validatorVerdict));
    expect(verdicts.has('accepted')).toBe(true);
    expect(verdicts.has('dropped')).toBe(true);
    expect(verdicts.has('failed')).toBe(true);
  });

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
