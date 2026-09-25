import { describe, expect, it } from 'vitest';
import {
  CLAIM_SCHEMA_VERSION,
  EVIDENCE_POLICY_VERSION,
  confidenceTierFor,
  evidenceIdFor,
  isSnapshotId,
  type ClaimSubject,
  type CohortComposition,
  type EvidenceRow,
  type EvidenceSnapshot,
  type SampleMeta,
} from '@smash-tracker/shared';
import { canonicalDigest } from '../research/registry/canonical.js';
import {
  normalizeRtdbWriteShape,
  RtdbInteriorNullArrayError,
  snapshotIdFor,
} from './snapshotId.js';

const REFRESHED_AT = 1_700_000_500_000;

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

function sampleFor(games: number, refreshedAt = REFRESHED_AT): SampleMeta {
  return {
    rawSampleSize: games,
    eligibleDenominator: games,
    knownFieldCoverage: games === 0 ? 0 : 1,
    // The evidence's own date range is CONTENT (match times), independent of
    // when it was computed — only `refreshedAt` is wall-clock.
    dateRange:
      games === 0 ? null : { firstMs: REFRESHED_AT - games * 60_000, lastMs: REFRESHED_AT },
    refreshedAt,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: 'unweighted',
    confidenceTier: confidenceTierFor(games),
  };
}

const COHORT: CohortComposition = {
  online: 0,
  offline: 25,
  unspecified: 0,
  manual: 25,
  startgg: 0,
  parrygg: 0,
  mixedContext: false,
  minorityShare: 0,
  minorityLabel: null,
  majorityLabel: 'offline',
};

function snapshotOf(
  rows: Record<string, EvidenceRow>,
  refreshedAt = REFRESHED_AT,
): EvidenceSnapshot {
  return {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    refreshedAt,
    cohort: COHORT,
    rows,
    matchIdDigest: { count: 25, hash: 'fixture-match-id-digest' },
  };
}

/** The cold-start fixture (review C1-H5): a snapshot over an EMPTY evidence set — `rows: {}`. */
const COLD_START_SNAPSHOT = snapshotOf({});

/**
 * The `all_null_subject` case (review C2-H1), mirroring plan 39-01's
 * `all_null_subject` fixture in `packages/shared/src/evidence/adversarialFixtures.ts`
 * (a `recent_form` row and a `cohort_disclosure` row whose four subject axes
 * are all `null`, beside an ordinary `stage_record` row). That module is not
 * reachable from `apps/api` — the shared package's `exports` map has only
 * `.` and `./testUtils`, and the corpus is deliberately NOT barrel-exported
 * — so the same shape is rebuilt here through the same shared
 * `evidenceIdFor`, never a hand-typed id.
 */
function allNullSubjectSnapshot(refreshedAt = REFRESHED_AT): EvidenceSnapshot {
  const ordinarySubject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 23, stageId: 1 };
  return snapshotOf(
    {
      [evidenceIdFor({ predicate: 'recent_form', subject: NULL_SUBJECT, opponentOrder: [] })]: {
        predicate: 'recent_form',
        subject: NULL_SUBJECT,
        value: { kind: 'record', wins: 16, losses: 9, games: 25 },
        sample: sampleFor(25, refreshedAt),
      },
      [evidenceIdFor({ predicate: 'cohort_disclosure', subject: NULL_SUBJECT, opponentOrder: [] })]:
        {
          predicate: 'cohort_disclosure',
          subject: NULL_SUBJECT,
          value: { kind: 'count', count: 25 },
          sample: sampleFor(25, refreshedAt),
        },
      [evidenceIdFor({ predicate: 'stage_record', subject: ordinarySubject, opponentOrder: [] })]: {
        predicate: 'stage_record',
        subject: ordinarySubject,
        value: { kind: 'record', wins: 6, losses: 4, games: 10 },
        sample: sampleFor(10, refreshedAt),
      },
    },
    refreshedAt,
  );
}

describe('normalizeRtdbWriteShape (reviews C1-H5 + C2-H1)', () => {
  it('deletes a null-valued object member (the CAUSE step)', () => {
    expect(normalizeRtdbWriteShape({ a: 1, b: null })).toEqual({ a: 1 });
    expect(normalizeRtdbWriteShape({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('deletes an empty-object member and an empty-array member', () => {
    expect(normalizeRtdbWriteShape({ a: 1, b: {}, c: [] })).toEqual({ a: 1 });
  });

  it('cascades: an object emptied by its own members is deleted from its parent, up to the root', () => {
    const input = { keep: 'x', outer: { middle: { axis1: null, axis2: null }, alsoNull: null } };
    expect(normalizeRtdbWriteShape(input)).toEqual({ keep: 'x' });
    // A root whose every member vanishes normalises to {} ("this node would not exist").
    expect(normalizeRtdbWriteShape({ only: { a: null } })).toEqual({});
  });

  it('an all-null subject is ABSENT after normalisation, not merely null-valued', () => {
    const row = {
      predicate: 'recent_form',
      subject: { ...NULL_SUBJECT },
      value: { kind: 'record', wins: 1, losses: 2, games: 3 },
    };
    const normalized = normalizeRtdbWriteShape(row) as Record<string, unknown>;
    expect(normalized).not.toHaveProperty('subject');
    expect(normalized.value).toEqual(row.value);
  });

  it('throws its named error on an array carrying an interior null, rather than reproducing the shred', () => {
    expect(() => normalizeRtdbWriteShape({ ids: ['a', null, 'b'] })).toThrow(
      RtdbInteriorNullArrayError,
    );
    expect(() => normalizeRtdbWriteShape({ ids: ['a', null] })).toThrow(RtdbInteriorNullArrayError);
    expect(() => normalizeRtdbWriteShape({ ids: ['a', {}] })).toThrow(RtdbInteriorNullArrayError);
  });

  it('keeps arrays of non-null members, empty strings, zero and false', () => {
    expect(normalizeRtdbWriteShape({ ids: ['a', 'b'], s: '', n: 0, f: false })).toEqual({
      ids: ['a', 'b'],
      s: '',
      n: 0,
      f: false,
    });
  });

  it('is idempotent and never mutates its input', () => {
    const input = { a: { b: null, c: [1, 2] }, d: {} };
    const frozen = JSON.stringify(input);
    const once = normalizeRtdbWriteShape(input);
    expect(normalizeRtdbWriteShape(once)).toEqual(once);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('snapshotIdFor (content addressing, C1-B2 reuse of canonical.ts)', () => {
  it('returns 64 lowercase hex that satisfies the shared isSnapshotId', () => {
    const id = snapshotIdFor(allNullSubjectSnapshot());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(isSnapshotId(id)).toBe(true);
  });

  it('is stable across two calls on structurally identical input', () => {
    expect(snapshotIdFor(allNullSubjectSnapshot())).toBe(snapshotIdFor(allNullSubjectSnapshot()));
  });

  it('agrees across wall-clock refreshedAt at every depth (the snapshot field AND every row sample)', () => {
    expect(snapshotIdFor(allNullSubjectSnapshot(REFRESHED_AT))).toBe(
      snapshotIdFor(allNullSubjectSnapshot(REFRESHED_AT + 86_400_000)),
    );
  });

  it('differs when evidence content differs', () => {
    const base = allNullSubjectSnapshot();
    const changed: EvidenceSnapshot = {
      ...base,
      matchIdDigest: { count: 26, hash: 'fixture-match-id-digest' },
    };
    expect(snapshotIdFor(changed)).not.toBe(snapshotIdFor(base));
  });

  it('agrees on a snapshot whose rows map is empty (the cold-start fixture)', () => {
    const id = snapshotIdFor(COLD_START_SNAPSHOT);
    expect(isSnapshotId(id)).toBe(true);
    expect(snapshotIdFor(normalizeRtdbWriteShape(COLD_START_SNAPSHOT) as EvidenceSnapshot)).toBe(
      id,
    );
  });

  it('hash-before-write equals hash-after-read on the all_null_subject fixture (C2-H1)', () => {
    const snapshot = allNullSubjectSnapshot();
    const readBack = normalizeRtdbWriteShape(snapshot) as EvidenceSnapshot;
    // The read-back really has lost the subject key on the axis-free rows...
    const recentFormRow = readBack.rows['rf-all'] as unknown as Record<string, unknown>;
    expect(recentFormRow).not.toHaveProperty('subject');
    // ...and the content address survives the round trip anyway.
    expect(snapshotIdFor(readBack)).toBe(snapshotIdFor(snapshot));
  });

  it('FALSIFIER: without normalisation the digest of the all-null subject diverges from its read-back', () => {
    // canonicalJson keeps null and omits only undefined — so an unnormalised
    // hash of the written shape is NOT the hash of what RTDB hands back. This
    // is the exact defect snapshotIdFor's normalisation step exists to close.
    const snapshot = allNullSubjectSnapshot();
    const readBack = normalizeRtdbWriteShape(snapshot);
    expect(canonicalDigest(snapshot)).not.toBe(canonicalDigest(readBack));
  });
});
