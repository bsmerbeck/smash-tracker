import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  activeGrantSchema,
  grantHistoryEntrySchema,
  idempotencyKeySchema,
  operationEntrySchema,
  researchChargeSnapshotSchema,
  researchEntitlementRecordSchema,
} from './researchEntitlement.js';

const VALID_IDEMPOTENCY_KEY = 'idem-key-001';
const VALID_GRANT_ID = 'a3f1c9d2-1111-4a2b-9c3d-000000000001';

function makeActiveGrant(overrides: Partial<z.infer<typeof activeGrantSchema>> = {}) {
  return {
    grantId: VALID_GRANT_ID,
    grantedByUid: 'admin-1',
    grantedAt: 1_000,
    idempotencyKey: VALID_IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function makeHistoryEntry(overrides: Partial<z.infer<typeof grantHistoryEntrySchema>> = {}) {
  return {
    ...makeActiveGrant(),
    revokedAt: 2_000,
    ...overrides,
  };
}

function makeOperationEntry(overrides: Partial<z.infer<typeof operationEntrySchema>> = {}) {
  return {
    grantId: VALID_GRANT_ID,
    outcome: 'created' as const,
    recordedAt: 1_000,
    ...overrides,
  };
}

describe('researchEntitlementRecordSchema', () => {
  it('parses with an active grant present', () => {
    const parsed = researchEntitlementRecordSchema.parse({
      activeGrant: makeActiveGrant(),
      history: null,
      operations: { [VALID_IDEMPOTENCY_KEY]: makeOperationEntry() },
    });
    expect(parsed.activeGrant?.grantId).toBe(VALID_GRANT_ID);
  });

  it('parses when every optional field is absent', () => {
    expect(() => researchEntitlementRecordSchema.parse({})).not.toThrow();
  });

  it('parses when every optional field is explicitly null (RTDB strips absent values on read)', () => {
    expect(() =>
      researchEntitlementRecordSchema.parse({
        activeGrant: null,
        history: null,
        operations: null,
      }),
    ).not.toThrow();
  });

  it('parses a history of prior grants, each retaining identifier, grant timestamp, revocation timestamp, and idempotency key', () => {
    const parsed = researchEntitlementRecordSchema.parse({
      activeGrant: null,
      history: {
        'opaque-key-1': makeHistoryEntry({ grantId: 'grant-a', idempotencyKey: 'idem-key-002' }),
      },
      operations: null,
    });
    const entry = parsed.history?.['opaque-key-1'];
    expect(entry).toMatchObject({
      grantId: 'grant-a',
      grantedAt: 1_000,
      revokedAt: 2_000,
      idempotencyKey: 'idem-key-002',
    });
  });

  it('parses an operations index, each entry retaining grant identifier, outcome, and recorded timestamp', () => {
    const parsed = researchEntitlementRecordSchema.parse({
      activeGrant: makeActiveGrant(),
      history: null,
      operations: {
        [VALID_IDEMPOTENCY_KEY]: makeOperationEntry({ outcome: 'observed-existing' }),
      },
    });
    expect(parsed.operations?.[VALID_IDEMPOTENCY_KEY]).toMatchObject({
      grantId: VALID_GRANT_ID,
      outcome: 'observed-existing',
      recordedAt: 1_000,
    });
  });

  it('parses when the operations index is absent or explicitly null', () => {
    expect(() =>
      researchEntitlementRecordSchema.parse({
        activeGrant: null,
        history: null,
        operations: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      researchEntitlementRecordSchema.parse({ activeGrant: null, history: null, operations: null }),
    ).not.toThrow();
  });
});

describe('idempotencyKeySchema (cycle-3 finding: RTDB-illegal-key-before-write)', () => {
  it('accepts a well-formed key at each length bound', () => {
    expect(idempotencyKeySchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse('Az09_-Az09_-Az09').success).toBe(true);
  });

  it('rejects a key shorter than 8 characters', () => {
    expect(idempotencyKeySchema.safeParse('a'.repeat(7)).success).toBe(false);
  });

  it('rejects a key longer than 64 characters', () => {
    expect(idempotencyKeySchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it.each(['.', '#', '$', '[', ']', '/'])(
    'rejects a key containing the RTDB-illegal character %s',
    (illegal) => {
      const candidate = `abcdefg${illegal}`;
      expect(idempotencyKeySchema.safeParse(candidate).success).toBe(false);
    },
  );
});

describe('researchChargeSnapshotSchema (D-12, review finding 29-09 HIGH)', () => {
  it('parses as one nested object with the waived mode and a grant identifier', () => {
    const parsed = researchChargeSnapshotSchema.parse({
      chargeMode: 'waived',
      grantId: VALID_GRANT_ID,
      subjectId: 'tenant-1',
    });
    expect(parsed.chargeMode).toBe('waived');
  });

  it('parses with the charged mode and no grant identifier', () => {
    const parsed = researchChargeSnapshotSchema.parse({
      chargeMode: 'charged',
      grantId: null,
      subjectId: 'tenant-1',
    });
    expect(parsed.chargeMode).toBe('charged');
    expect(parsed.grantId).toBeNull();
  });

  it('REJECTS a waived-mode snapshot with no grant identifier — enforced by the schema itself, not a caller check', () => {
    const result = researchChargeSnapshotSchema.safeParse({
      chargeMode: 'waived',
      grantId: null,
      subjectId: 'tenant-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown charge-mode value', () => {
    const result = researchChargeSnapshotSchema.safeParse({
      chargeMode: 'free',
      grantId: null,
      subjectId: 'tenant-1',
    });
    expect(result.success).toBe(false);
  });

  it('regression guard: the waived-without-grant-identifier rejection SURVIVES attaching the snapshot as a single .nullish() member of a host object', () => {
    // Throwaway host schema mirroring the intended attachment shape
    // (packages/shared/src/reports.ts's future consumer per plan 29-11's
    // re-scope) — decomposing the snapshot into independently-nullish
    // sibling fields would silently discard this refinement; this test is
    // the guard against ever doing that.
    const hostSchema = z.object({
      jobId: z.string().min(1),
      chargeSnapshot: researchChargeSnapshotSchema.nullish(),
    });

    const result = hostSchema.safeParse({
      jobId: 'job-1',
      chargeSnapshot: {
        chargeMode: 'waived',
        grantId: null,
        subjectId: 'tenant-1',
      },
    });
    expect(result.success).toBe(false);

    const validResult = hostSchema.safeParse({
      jobId: 'job-1',
      chargeSnapshot: {
        chargeMode: 'waived',
        grantId: VALID_GRANT_ID,
        subjectId: 'tenant-1',
      },
    });
    expect(validResult.success).toBe(true);

    const absentResult = hostSchema.safeParse({ jobId: 'job-1', chargeSnapshot: null });
    expect(absentResult.success).toBe(true);
  });
});
