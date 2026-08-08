import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type { ResearchSourceSetRecord, ResearchSupplementRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  buildSupplementId,
  countSupplementsForSet,
  deleteSupplement,
  listSupplementsForSet,
  overlaySupplements,
  upsertSupplement,
} from './supplements.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-1';
const TARGET_SET_ID = 'set-1';
const ADMIN_UID = 'admin-1';

function makeSourceRecord(
  overrides: Partial<ResearchSourceSetRecord> = {},
): ResearchSourceSetRecord {
  return {
    providerSetId: TARGET_SET_ID,
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    apiIds: { setId: TARGET_SET_ID },
    ingestionRunId: 'run-1',
    fetchedAtMs: 1,
    lastObservedAtMs: 1,
    ...overrides,
  };
}

describe('buildSupplementId', () => {
  it('returns a stable string for a valid field, called twice with the same input', () => {
    const first = buildSupplementId({ field: 'notes', sourceKind: 'manual' });
    const second = buildSupplementId({ field: 'notes', sourceKind: 'manual' });
    expect(first).toEqual(second);
    expect(typeof first).toBe('string');
  });

  it.each([
    ['vod.url', 'contains a dot'],
    ['a/b', 'contains a slash'],
    ['a b', 'contains a space'],
    ['héro', 'contains a non-ASCII character'],
    ['', 'is empty'],
    ['a'.repeat(65), 'exceeds the 64-character bound'],
  ])('returns null when the field name %s (%s)', (field) => {
    expect(buildSupplementId({ field, sourceKind: 'manual' })).toBeNull();
  });

  it('produces distinct ids for two field names a sanitizing transform would have collapsed', () => {
    // A hypothetical sanitizer might map "vod.url" and "vod_url" onto the
    // same id by stripping/replacing the dot. Since only the already-safe
    // spelling is ever accepted, no collision is possible.
    const safe = buildSupplementId({ field: 'vod_url', sourceKind: 'manual' });
    const unsafe = buildSupplementId({ field: 'vod.url', sourceKind: 'manual' });
    expect(safe).not.toBeNull();
    expect(unsafe).toBeNull();
  });
});

describe('upsertSupplement', () => {
  it('writes a record under the target set subtree, stamped with uid/timestamp, returning a deterministic id', async () => {
    const database = new FakeDatabase();
    const result = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'played it safe on stage 2',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      now: 1000,
    });

    expect(result.outcome).toBe('created');
    expect(result.supplementId).toBe(buildSupplementId({ field: 'notes', sourceKind: 'manual' }));

    const records = await listSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      field: 'notes',
      value: 'played it safe on stage 2',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      recordedAtMs: 1000,
    });
  });

  it('overwrites in place and yields the SAME id on a repeat upsert of the same target/field/sourceKind', async () => {
    const database = new FakeDatabase();
    const first = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'first note',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      now: 1000,
    });
    const second = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'revised note',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      now: 2000,
    });

    expect(second.outcome).toBe('replaced');
    expect(second.supplementId).toBe(first.supplementId);

    const records = await listSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.value).toBe('revised note');
  });

  it('creates a SECOND record when the same target/field has a different source kind — manual and VOD coexist', async () => {
    const database = new FakeDatabase();
    const manual = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'manual note',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      now: 1000,
    });
    const vod = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'vod note',
      sourceKind: 'vod',
      attributedToUid: ADMIN_UID,
      now: 1000,
    });

    expect(manual.supplementId).not.toBe(vod.supplementId);
    const records = await listSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(records).toHaveLength(2);
  });

  it('writes nothing and returns rejected-key for an RTDB-illegal tenant id or target set id', async () => {
    const database = new FakeDatabase();
    const badTenant = await upsertSupplement(asDatabase(database), 'tenant.bad', {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
    });
    const badTargetSet = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: 'set.bad',
      field: 'notes',
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
    });

    expect(badTenant).toEqual({ outcome: 'rejected-key', supplementId: null });
    expect(badTargetSet).toEqual({ outcome: 'rejected-key', supplementId: null });
    expect(database.dump()).toEqual({});
  });

  it.each([
    ['vod.url', 'contains a dot'],
    ['a/b', 'contains a slash'],
    ['a b', 'contains a space'],
    ['héro', 'contains a non-ASCII character'],
    ['', 'is empty'],
    ['a'.repeat(65), 'exceeds the 64-character bound'],
  ])('rejects a field name that %s with rejected-field and an unchanged dump', async (field) => {
    const database = new FakeDatabase();
    const result = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field,
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
    });

    expect(result).toEqual({ outcome: 'rejected-field', supplementId: null });
    expect(database.dump()).toEqual({});
  });

  it('rejects a NEW supplement id once the set already holds RESEARCH_MAX_SUPPLEMENTS_PER_SET records, but a REPLACE still succeeds', async () => {
    const database = new FakeDatabase();
    const { RESEARCH_MAX_SUPPLEMENTS_PER_SET } = await import('@smash-tracker/shared');

    for (let i = 0; i < RESEARCH_MAX_SUPPLEMENTS_PER_SET; i += 1) {
      const result = await upsertSupplement(asDatabase(database), TENANT_ID, {
        targetSetId: TARGET_SET_ID,
        field: `field${i}`,
        value: `value${i}`,
        sourceKind: 'manual',
        attributedToUid: ADMIN_UID,
        now: 1000,
      });
      expect(result.outcome).toBe('created');
    }

    const beforeDump = database.dump();
    const rejected = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'oneTooMany',
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      now: 2000,
    });
    expect(rejected).toEqual({ outcome: 'rejected-cap', supplementId: null });
    expect(database.dump()).toEqual(beforeDump);

    const replaced = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'field0',
      value: 'replaced value',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      now: 3000,
    });
    expect(replaced.outcome).toBe('replaced');
  });

  it('never reads or writes anything under the source tier — the source subtree stays byte-identical', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSource/${TENANT_ID}/sets/${TARGET_SET_ID}`, makeSourceRecord());
    const beforeSource = (database.dump() as Record<string, unknown>).researchSource;

    await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
    });

    const afterSource = (database.dump() as Record<string, unknown>).researchSource;
    expect(afterSource).toEqual(beforeSource);
  });
});

describe('listSupplementsForSet', () => {
  it('returns an empty array for a set with no supplements', async () => {
    const database = new FakeDatabase();
    expect(await listSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID)).toEqual([]);
  });

  it('safe-parses each child independently: a malformed sibling does not hide the valid records', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSupplements/${TENANT_ID}/${TARGET_SET_ID}`, {
      good1: {
        sourceKind: 'manual',
        targetSetId: TARGET_SET_ID,
        field: 'notes',
        value: 'ok',
        attributedToUid: ADMIN_UID,
        recordedAtMs: 1,
      },
      good2: {
        sourceKind: 'vod',
        targetSetId: TARGET_SET_ID,
        field: 'notes',
        value: 'also ok',
        attributedToUid: ADMIN_UID,
        recordedAtMs: 2,
      },
      malformed: { sourceKind: 'not-a-real-kind', targetSetId: TARGET_SET_ID },
    });

    const records = await listSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.value).sort()).toEqual(['also ok', 'ok']);
  });
});

describe('path-safety guard family (review C2-A6)', () => {
  const illegalTargetSetIds = ['set.bad', 'set#bad'];
  const illegalSupplementIds = ['supp.bad', 'supp#bad'];

  it.each(illegalTargetSetIds)(
    'listSupplementsForSet returns [] for targetSetId %s without throwing',
    async (targetSetId) => {
      const database = new FakeDatabase();
      await expect(
        listSupplementsForSet(asDatabase(database), TENANT_ID, targetSetId),
      ).resolves.toEqual([]);
    },
  );

  it.each(illegalTargetSetIds)(
    'countSupplementsForSet returns 0 for targetSetId %s without throwing',
    async (targetSetId) => {
      const database = new FakeDatabase();
      await expect(
        countSupplementsForSet(asDatabase(database), TENANT_ID, targetSetId),
      ).resolves.toBe(0);
    },
  );

  it.each(illegalTargetSetIds)(
    'deleteSupplement returns { ok: true } for targetSetId %s without throwing',
    async (targetSetId) => {
      const database = new FakeDatabase();
      await expect(
        deleteSupplement(asDatabase(database), TENANT_ID, targetSetId, 'supp-1'),
      ).resolves.toEqual({ ok: true });
    },
  );

  it.each(illegalSupplementIds)(
    'deleteSupplement returns { ok: true } for supplementId %s without throwing',
    async (supplementId) => {
      const database = new FakeDatabase();
      await expect(
        deleteSupplement(asDatabase(database), TENANT_ID, TARGET_SET_ID, supplementId),
      ).resolves.toEqual({ ok: true });
    },
  );
});

describe('deleteSupplement', () => {
  it('removes exactly one record and leaves the target set other supplements intact', async () => {
    const database = new FakeDatabase();
    const first = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
    });
    const second = await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'y',
      sourceKind: 'vod',
      attributedToUid: ADMIN_UID,
    });

    await deleteSupplement(asDatabase(database), TENANT_ID, TARGET_SET_ID, first.supplementId!);

    const records = await listSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceKind).toBe('vod');
    expect(second.supplementId).not.toBe(first.supplementId);
  });
});

describe('countSupplementsForSet', () => {
  it('counts the supplements on a set', async () => {
    const database = new FakeDatabase();
    await upsertSupplement(asDatabase(database), TENANT_ID, {
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'x',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
    });
    expect(await countSupplementsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID)).toBe(1);
  });
});

describe('overlaySupplements', () => {
  function makeSupplement(
    overrides: Partial<ResearchSupplementRecord> = {},
  ): ResearchSupplementRecord {
    return {
      sourceKind: 'manual',
      targetSetId: TARGET_SET_ID,
      field: 'notes',
      value: 'a value',
      attributedToUid: ADMIN_UID,
      recordedAtMs: 1000,
      ...overrides,
    };
  }

  it('returns provider unmodified and supplements only in the sibling map', () => {
    const provider = makeSourceRecord();
    const overlay = overlaySupplements(provider, [makeSupplement()]);

    expect(overlay.provider).toBe(provider);
    expect(overlay.supplemented.notes).toMatchObject({
      value: 'a value',
      sourceKind: 'manual',
      attributedToUid: ADMIN_UID,
      recordedAtMs: 1000,
    });
    // The provider object itself must never receive a supplemented value.
    expect((overlay.provider as unknown as Record<string, unknown>).notes).toBeUndefined();
  });

  it('leaves the provider value in place under `provider` even when the field name collides', () => {
    const provider = makeSourceRecord({ displayScore: '3-2' });
    const overlay = overlaySupplements(provider, [
      makeSupplement({ field: 'displayScore', value: 'corrected 3-1' }),
    ]);

    expect(overlay.provider.displayScore).toBe('3-2');
    expect(overlay.supplemented.displayScore?.value).toBe('corrected 3-1');
  });

  it('every entry carries sourceKind, attributedToUid, and recordedAtMs', () => {
    const overlay = overlaySupplements(makeSourceRecord(), [
      makeSupplement({ sourceKind: 'vod', attributedToUid: 'uid-2', recordedAtMs: 555 }),
    ]);
    expect(overlay.supplemented.notes).toEqual(
      expect.objectContaining({ sourceKind: 'vod', attributedToUid: 'uid-2', recordedAtMs: 555 }),
    );
  });
});
