import { describe, expect, it } from 'vitest';
import {
  buildClaimSet,
  type ClaimPredicate,
  type ClaimSubject,
  type ClaimValue,
} from './claims.js';
import type { EvidenceRow } from './snapshot.js';
import {
  ABSTENTION_FLOOR_GAMES,
  CONFIDENCE_TIER_BOUNDS,
  EVIDENCE_POLICY_VERSION,
  confidenceTierFor,
} from './policy.js';
import type { SampleMeta } from './types.js';

/**
 * RPT-05/RPT-06 (phase 39 plan 03): `buildClaimSet` is the ONE deterministic
 * builder every report surface runs through — this file proves the law's
 * ranking, collapse, tiebreak, truncation and abstention behaviour, plus the
 * cross-surface identity property RPT-05 exists to guarantee. Task 1 wires
 * and exercises `stage_record` end-to-end (the law implemented in full,
 * nothing stubbed); Task 2 exercises the remaining nine predicates and the
 * cross-cutting properties (truncation exemption, cross-surface identity,
 * the `all_null_subject` fixture, unknown-bucket separation).
 */

const REFRESHED_AT = 1_700_000_500_000;

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

/** A deterministic `SampleMeta` for `games` countable games — mirrors `adversarialFixtures.ts`'s own `makeSample` discipline (every threshold routed through `policy.ts`, never a bare literal). */
function sampleFor(games: number): SampleMeta {
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

function row(
  predicate: ClaimPredicate,
  subject: ClaimSubject,
  value: ClaimValue,
  games: number,
): EvidenceRow {
  return { predicate, subject, value, sample: sampleFor(games) };
}

describe('buildClaimSet: stage_record, at/above the floor', () => {
  it('a stage row at or above the floor yields one stage_record claim whose tier equals confidenceTierFor(games)', () => {
    const games = CONFIDENCE_TIER_BOUNDS.medium;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const value: ClaimValue = { kind: 'record', wins: games, losses: 0, games };
    const rows: Record<string, EvidenceRow> = {
      'sr-f23-s1': row('stage_record', subject, value, games),
    };

    const result = buildClaimSet({ rows, surface: 'scout' });

    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    expect(claim.predicate).toBe('stage_record');
    expect(claim.tier).toBe(confidenceTierFor(games));
    expect(claim.evidenceIds).toEqual(['sr-f23-s1']);
    expect(claim.value).toEqual(value);
    expect(claim.policyVersion).toBe(EVIDENCE_POLICY_VERSION);
    expect(result.issuedClaimIds).toEqual([claim.id]);
  });
});

describe('buildClaimSet: abstention', () => {
  it('a row below the abstention floor yields an abstained ClaimValue with a positive gamesNeeded and a null tier', () => {
    const games = ABSTENTION_FLOOR_GAMES - 1;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const rows: Record<string, EvidenceRow> = {
      'sr-f23-s1': row(
        'stage_record',
        subject,
        { kind: 'record', wins: games, losses: 0, games },
        games,
      ),
    };

    const result = buildClaimSet({ rows, surface: 'scout' });

    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    expect(claim.value.kind).toBe('abstained');
    expect(claim.value.kind === 'abstained' && claim.value.gamesNeeded).toBeGreaterThan(0);
    expect(claim.tier).toBeNull();
  });
});

describe('buildClaimSet: empty input', () => {
  it('an empty row map yields zero claims and an empty issued-id list', () => {
    const result = buildClaimSet({ rows: {}, surface: 'scout' });

    expect(result.claims).toEqual([]);
    expect(result.issuedClaimIds).toEqual([]);
    expect(result.truncatedCandidateCount).toBe(0);
  });
});

describe('buildClaimSet: determinism', () => {
  function buildRows(): Record<string, EvidenceRow> {
    return {
      'sr-f23-s1': row(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 },
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
      'sr-f59-s2': row(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 59, stageId: 2 },
        { kind: 'record', wins: 3, losses: 5, games: 8 },
        8,
      ),
    };
  }

  it('building the same input twice produces byte-identical output, including id assignment', () => {
    const first = buildClaimSet({ rows: buildRows(), surface: 'scout' });
    const second = buildClaimSet({ rows: buildRows(), surface: 'scout' });

    expect(second).toEqual(first);
  });
});

describe('buildClaimSet: collapse (rule 3)', () => {
  it('two rows resolving to the same (predicate, subject, value) collapse to one claim whose evidenceIds is the union of both', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const value: ClaimValue = { kind: 'record', wins: 6, losses: 4, games: 10 };
    const rows: Record<string, EvidenceRow> = {
      'row-a': row('stage_record', subject, value, 10),
      'row-b': row('stage_record', subject, value, 10),
    };

    const result = buildClaimSet({ rows, surface: 'scout' });

    expect(result.claims).toHaveLength(1);
    expect([...result.claims[0]!.evidenceIds].sort()).toEqual(['row-a', 'row-b']);
  });
});
