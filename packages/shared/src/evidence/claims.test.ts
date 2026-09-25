import { describe, expect, it } from 'vitest';
import {
  buildClaimSet,
  CLAIM_ID_VOCABULARY_SIZE,
  CLAIM_PREDICATES,
  type ClaimPredicate,
  type ClaimSubject,
  type ClaimValue,
  type ReportSurface,
} from './claims.js';
import type { EvidenceRow } from './snapshot.js';
import {
  ABSTENTION_FLOOR_GAMES,
  CONFIDENCE_TIER_BOUNDS,
  EVIDENCE_POLICY_VERSION,
  confidenceTierFor,
} from './policy.js';
import { UNKNOWN_STAGE_ID } from './predicate.js';
import { ADVERSARIAL_FIXTURES } from './adversarialFixtures.js';
import type { ClaimKind, SampleMeta } from './types.js';

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

  it('two rows differing ONLY in predicate over the same subject yield TWO claims with two distinct ids (review C2-B2)', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, stageId: 1 };
    const rows: Record<string, EvidenceRow> = {
      'sr-s1': row('stage_record', subject, { kind: 'record', wins: 6, losses: 4, games: 10 }, 10),
      'spr-s1': row(
        'stage_pick_rate',
        subject,
        { kind: 'rate', numerator: 6, denominator: 10 },
        10,
      ),
    };

    const result = buildClaimSet({ rows, surface: 'scout' });

    expect(result.claims).toHaveLength(2);
    expect(new Set(result.claims.map((claim) => claim.id)).size).toBe(2);
  });
});

describe('buildClaimSet: every CLAIM_PREDICATES member has a row mapping (Task 2)', () => {
  const EXPECTED_KIND: Readonly<Record<ClaimPredicate, ClaimKind>> = {
    stage_record: 'fact',
    stage_pick_rate: 'fact',
    character_matchup_record: 'fact',
    my_character_record: 'fact',
    head_to_head_record: 'fact',
    recent_form: 'fact',
    opponent_character_usage: 'fact',
    cohort_disclosure: 'fact',
    matchup_advisor_pick: 'recommendation',
    vod_annotation: 'fact',
  };

  const SUBJECT_FOR: Readonly<Record<ClaimPredicate, ClaimSubject>> = {
    stage_record: { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 },
    stage_pick_rate: { ...NULL_SUBJECT, stageId: 1 },
    character_matchup_record: { ...NULL_SUBJECT, myFighterId: 23, opponentFighterId: 59 },
    my_character_record: { ...NULL_SUBJECT, myFighterId: 23 },
    head_to_head_record: { ...NULL_SUBJECT, opponentTag: 'Riverside' },
    recent_form: { ...NULL_SUBJECT },
    opponent_character_usage: { ...NULL_SUBJECT, opponentFighterId: 59 },
    cohort_disclosure: { ...NULL_SUBJECT },
    matchup_advisor_pick: { ...NULL_SUBJECT, myFighterId: 23, opponentFighterId: 59 },
    // vod_annotation's true identity is the (matchId, seconds) pair carried
    // in its evidence id (vodEvidenceId, snapshot.ts) — none of ClaimSubject's
    // four axes describe a VOD moment, so its row subject is all-null.
    vod_annotation: { ...NULL_SUBJECT },
  };

  it.each(CLAIM_PREDICATES)(
    'predicate %s yields a claim with the documented claimKind',
    (predicate) => {
      const subject = SUBJECT_FOR[predicate];
      const games = CONFIDENCE_TIER_BOUNDS.medium;
      const value: ClaimValue = { kind: 'count', count: games };
      const rows: Record<string, EvidenceRow> = {
        [`row-${predicate}`]: row(predicate, subject, value, games),
      };

      const result = buildClaimSet({ rows, surface: 'prep_report' });

      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.predicate).toBe(predicate);
      expect(result.claims[0]!.claimKind).toBe(EXPECTED_KIND[predicate]);
    },
  );

  it('matchup_advisor_pick abstains below the floor rather than naming a pick', () => {
    const games = ABSTENTION_FLOOR_GAMES - 1;
    const subject = SUBJECT_FOR.matchup_advisor_pick;
    const rows: Record<string, EvidenceRow> = {
      'map-f23-g59': row(
        'matchup_advisor_pick',
        subject,
        { kind: 'entity', entityKind: 'fighter', entityId: '23' },
        games,
      ),
    };

    const result = buildClaimSet({ rows, surface: 'prep_report' });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.value.kind).toBe('abstained');
    expect(result.claims[0]!.tier).toBeNull();
  });
});

describe("buildClaimSet: unknown-bucket rows never enter a known-entity claim's denominator", () => {
  it('an unknown-stage row stays a separate claim carrying the unknown stage identifier, and does not alter the known-stage claim value', () => {
    const knownSubject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
    const unknownSubject: ClaimSubject = {
      ...NULL_SUBJECT,
      myFighterId: 23,
      stageId: UNKNOWN_STAGE_ID,
    };
    const knownValue: ClaimValue = { kind: 'record', wins: 6, losses: 4, games: 10 };
    const unknownValue: ClaimValue = { kind: 'record', wins: 2, losses: 1, games: 3 };
    const rows: Record<string, EvidenceRow> = {
      'sr-f23-s1': row('stage_record', knownSubject, knownValue, 10),
      'sr-f23-s0': row('stage_record', unknownSubject, unknownValue, 3),
    };

    const result = buildClaimSet({ rows, surface: 'scout' });

    expect(result.claims).toHaveLength(2);
    const known = result.claims.find((claim) => claim.subject.stageId === 1)!;
    const unknown = result.claims.find((claim) => claim.subject.stageId === UNKNOWN_STAGE_ID)!;
    expect(known.value).toEqual(knownValue);
    expect(unknown.subject.stageId).toBe(UNKNOWN_STAGE_ID);
    expect(unknown.subject.stageId).not.toBe(1);
  });
});

describe('buildClaimSet: truncation', () => {
  function buildOversizedRows(): Record<string, EvidenceRow> {
    const rows: Record<string, EvidenceRow> = {};
    const total = CLAIM_ID_VOCABULARY_SIZE + 5;
    for (let i = 0; i < total; i += 1) {
      const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: i + 1, stageId: 1 };
      const games = total - i + ABSTENTION_FLOOR_GAMES; // strictly descending, all above the floor, all distinct
      rows[`sr-f${i + 1}-s1`] = row(
        'stage_record',
        subject,
        { kind: 'record', wins: games, losses: 0, games },
        games,
      );
    }
    return rows;
  }

  it('keeps exactly the top CLAIM_ID_VOCABULARY_SIZE candidates by the documented ranking, reports the remainder, and is stable across two builds', () => {
    const first = buildClaimSet({ rows: buildOversizedRows(), surface: 'scout' });
    const second = buildClaimSet({ rows: buildOversizedRows(), surface: 'scout' });

    expect(first.claims).toHaveLength(CLAIM_ID_VOCABULARY_SIZE);
    expect(first.truncatedCandidateCount).toBe(5);
    expect(second).toEqual(first);
    // myFighterId 1 (i=0) carries the highest games value — it must rank first.
    expect(first.claims[0]!.subject.myFighterId).toBe(1);
  });

  it('cohort_disclosure is present once and survives truncation when candidates exceed the vocabulary size (D-09/D-10)', () => {
    const rows = buildOversizedRows();
    const nonCohortCount = Object.keys(rows).length;
    rows['cd-all'] = row('cohort_disclosure', NULL_SUBJECT, { kind: 'count', count: 25 }, 25);

    const result = buildClaimSet({ rows, surface: 'scout' });

    expect(result.claims).toHaveLength(CLAIM_ID_VOCABULARY_SIZE);
    expect(result.claims.some((claim) => claim.predicate === 'cohort_disclosure')).toBe(true);
    expect(result.truncatedCandidateCount).toBe(nonCohortCount - (CLAIM_ID_VOCABULARY_SIZE - 1));
  });
});

describe('buildClaimSet: RPT-05 cross-surface identity', () => {
  // If a future surface legitimately needs a different row SET, that
  // difference belongs in what the API puts in `rows`, not in the builder —
  // do not "fix" this test later by adding a surface branch to buildClaimSet.
  const REPORT_SURFACES: readonly ReportSurface[] = [
    'scout',
    'prep_report',
    'prep_bundle_child',
    'post_event_synthesis',
  ];

  it('buildClaimSet returns deeply-equal ClaimSets for all four ReportSurface values on the same rows', () => {
    const rows: Record<string, EvidenceRow> = {
      'sr-f23-s1': row(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 },
        { kind: 'record', wins: 6, losses: 4, games: 10 },
        10,
      ),
      'cd-all': row('cohort_disclosure', NULL_SUBJECT, { kind: 'count', count: 10 }, 10),
    };

    const results = REPORT_SURFACES.map((surface) => buildClaimSet({ rows, surface }));

    for (const result of results.slice(1)) {
      expect(result).toEqual(results[0]);
    }
  });
});

describe('buildClaimSet: all_null_subject fixture (review C2-B2/C2-H1)', () => {
  it('recent_form and cohort_disclosure claims carry all four subject axes null and cite the axis-free evidence ids', () => {
    const fixture = ADVERSARIAL_FIXTURES.find((f) => f.id === 'all-null-subject')!;

    const result = buildClaimSet({ rows: fixture.snapshot.rows, surface: 'scout' });

    const recentForm = result.claims.find((claim) => claim.predicate === 'recent_form');
    expect(recentForm).toBeDefined();
    expect(recentForm!.subject).toEqual(NULL_SUBJECT);
    expect(recentForm!.evidenceIds).toContain('rf-all');

    const cohort = result.claims.find((claim) => claim.predicate === 'cohort_disclosure');
    expect(cohort).toBeDefined();
    expect(cohort!.subject).toEqual(NULL_SUBJECT);
    expect(cohort!.evidenceIds).toContain('cd-all');
  });
});
