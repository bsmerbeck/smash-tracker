import { describe, expect, it } from 'vitest';
import {
  CLAIM_SCHEMA_VERSION,
  EVENT_CATALOG,
  EVIDENCE_POLICY_VERSION,
  buildClaimSet,
  confidenceTierFor,
  evidenceIdFor,
  evidenceSnapshotRecordSchema,
  isSnapshotId,
  scoutReportRecordSchema,
  storedScoutReportSchema,
  type ClaimSubject,
  type CohortComposition,
  type EvidenceRow,
  type EvidenceSnapshot,
  type SampleMeta,
} from '@smash-tracker/shared';
import { canonicalDigest } from '../research/registry/canonical.js';
import { RECONCILED_EVENT_NAMES } from '../jobs/reconcile.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { projectScoutSelection, type ClaimSelection } from './claimSelection.js';
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

// ---------------------------------------------------------------------------
// Plan 39-06 Task 2: the stored contracts survive the RTDB write/read cycle.
// ---------------------------------------------------------------------------

const SELECTION: ClaimSelection = {
  sections: {
    overview: { claimIds: ['c01'], connective: 'Stay patient early.' },
    gameplan: { claimIds: ['c02'], connective: 'Keep the pressure steady.' },
    watchFor: { claimIds: ['c03'], connective: 'Watch the ledge habits.' },
  },
  action1: { actionId: 'a01', claimId: 'c01' },
  action2: null,
  action3: { actionId: 'a02', claimId: null },
};

function storedReportFrom(snapshot: EvidenceSnapshot, strippedSectionIds: string[] = []) {
  const { claims } = buildClaimSet({ rows: snapshot.rows, surface: 'scout' });
  return projectScoutSelection({ selection: SELECTION, claims, strippedSectionIds });
}

describe('stored claim contracts: round trip through the fake database (plan 39-06 Task 2)', () => {
  it('a report with a three-claim map, a sections map and an actions map holding only action1 and action3 reads back schema-valid, with action2 simply absent', async () => {
    const report = storedReportFrom(allNullSubjectSnapshot());
    expect(Object.keys(report.claims ?? {})).toHaveLength(3);
    const database = new FakeDatabase();
    const record = {
      createdAt: 1,
      model: 'claude-opus-4-8',
      player: { id: 1, gamerTag: 'Fixture' },
      report,
    };
    await database.ref('scoutReports/uid/r1').set(record);
    const readBack = (await database.ref('scoutReports/uid/r1').get()).val();
    const parsed = scoutReportRecordSchema.parse({ id: 'r1', ...(readBack as object) });
    expect(Object.keys(parsed.report.actions ?? {}).sort()).toEqual(['action1', 'action3']);
    expect(parsed.report.actions).not.toHaveProperty('action2');
    expect(parsed.report.actions?.action3).toEqual({ actionId: 'a02' });
    expect(Object.keys(parsed.report.claims ?? {})).toHaveLength(3);
  });

  it('a snapshot record with a multi-row keyed map round-trips', async () => {
    const snapshot = allNullSubjectSnapshot();
    const database = new FakeDatabase();
    await database.ref('evidenceSnapshots/uid/s1').set(normalizeRtdbWriteShape(snapshot));
    const readBack = (await database.ref('evidenceSnapshots/uid/s1').get()).val();
    const parsed = evidenceSnapshotRecordSchema.parse(readBack);
    expect(Object.keys(parsed.rows ?? {}).sort()).toEqual(Object.keys(snapshot.rows).sort());
  });

  it("the projection's written shape reads back as itself: the additive claim fields are a fixed point of normalizeRtdbWriteShape, and the whole record re-parses identically", () => {
    const report = storedReportFrom(allNullSubjectSnapshot(), ['watchFor']);
    const { claims, sections, actions } = report;
    expect(normalizeRtdbWriteShape({ claims, sections, actions })).toEqual({
      claims,
      sections,
      actions,
    });
    // A stripped list section projects to `[]`, which RTDB drops; the stored
    // schema's `.default([])` restores it — the pre-existing house rule for
    // every legacy array field.
    expect(storedScoutReportSchema.parse(normalizeRtdbWriteShape(report))).toEqual(
      storedScoutReportSchema.parse(report),
    );
    expect(report.strippedSectionCount).toBe(1);
    expect(report.sections?.watchFor).toEqual({ claimIds: ['c03'], connective: '' });
  });
});

describe('stored claim contracts: the NORMALISED round trip (reviews C1-H5 + C2-H1)', () => {
  // `FakeDatabase` simulates only empty-ARRAY and array-null stripping — it
  // hands null-valued members and empty objects straight back — so these
  // assertions are on the SCHEMAS' TOLERANCE of the shape real RTDB returns
  // (modelled by `normalizeRtdbWriteShape`), never on the double's behaviour.

  it('(a) cold start: an empty-rows snapshot and an all-empty-maps stored report both parse once normalised', () => {
    const snapshotRead = normalizeRtdbWriteShape(COLD_START_SNAPSHOT) as Record<string, unknown>;
    expect(snapshotRead).not.toHaveProperty('rows');
    expect(evidenceSnapshotRecordSchema.safeParse(snapshotRead).success).toBe(true);

    const coldReport = {
      ...projectScoutSelection({ selection: SELECTION, claims: [] }),
      claims: {},
      sections: {},
      actions: {},
    };
    const reportRead = normalizeRtdbWriteShape(coldReport) as Record<string, unknown>;
    for (const field of ['claims', 'sections', 'actions']) {
      expect(reportRead).not.toHaveProperty(field);
    }
    expect(storedScoutReportSchema.safeParse(reportRead).success).toBe(true);
  });

  it('(b) all_null_subject: a snapshot row and a stored claim whose four axes are null parse once normalised, with subject ABSENT', () => {
    const snapshot = allNullSubjectSnapshot();
    const snapshotRead = normalizeRtdbWriteShape(snapshot) as {
      rows: Record<string, Record<string, unknown>>;
    };
    expect(snapshotRead.rows['rf-all']).not.toHaveProperty('subject');
    expect(snapshotRead.rows['cd-all']).not.toHaveProperty('subject');
    expect(evidenceSnapshotRecordSchema.safeParse(snapshotRead).success).toBe(true);

    // Write the claims RAW (nulls and all) to model the worst case, then read
    // back what RTDB would return.
    const { claims } = buildClaimSet({ rows: snapshot.rows, surface: 'scout' });
    const rawReport = {
      ...projectScoutSelection({ selection: SELECTION, claims }),
      claims: Object.fromEntries(claims.map((claim) => [claim.id, claim])),
    };
    const reportRead = normalizeRtdbWriteShape(rawReport) as {
      claims: Record<string, Record<string, unknown>>;
    };
    const axisFree = Object.values(reportRead.claims).filter(
      (claim) => claim.predicate === 'recent_form' || claim.predicate === 'cohort_disclosure',
    );
    expect(axisFree.length).toBeGreaterThan(0);
    for (const claim of axisFree) {
      expect(claim).not.toHaveProperty('subject');
    }
    expect(storedScoutReportSchema.safeParse(reportRead).success).toBe(true);
  });
});

describe('Phase 39 event names (plan 39-06 Task 2, Pitfall 6)', () => {
  it('EVENT_CATALOG carries all three new names at class B', () => {
    expect(EVENT_CATALOG.report_failed_validation).toBe('B');
    expect(EVENT_CATALOG.report_claims_dropped).toBe('B');
    expect(EVENT_CATALOG.report_prose_stripped).toBe('B');
  });

  it('RECONCILED_EVENT_NAMES keeps exactly its seven pre-existing members and none of the three', () => {
    expect([...RECONCILED_EVENT_NAMES].sort()).toEqual(
      [
        'checkout_completed',
        'credit_refunded',
        'credit_spent',
        'credits_granted',
        'report_completed',
        'report_failed',
        'report_started',
      ].sort(),
    );
    for (const name of [
      'report_failed_validation',
      'report_claims_dropped',
      'report_prose_stripped',
    ]) {
      expect(RECONCILED_EVENT_NAMES.has(name)).toBe(false);
    }
  });
});
