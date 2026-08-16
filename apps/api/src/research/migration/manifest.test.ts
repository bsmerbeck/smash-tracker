import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { ForbiddenError } from '../../services/rtdb.js';
import { createClientCore } from '../../coaching/tenants.js';
import { resolveEntitlement } from '../entitlements.js';
import {
  archiveSources,
  checkTreeDescriptorLock,
  compareTree,
  copyTree,
  enumerateRecords,
  isCopyDescriptor,
  preflightDestinations,
  recordsDeepEqual,
  runMigration,
  TREE_DESCRIPTOR_LOCK,
  TREE_DESCRIPTORS,
  verifyMigration,
  type CopyTreeDescriptor,
} from './manifest.js';
import { TENANT_DELETION_TREES } from '../../coaching/tenants.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function findCopyDescriptor(tree: string): CopyTreeDescriptor {
  const descriptor = TREE_DESCRIPTORS.find((d) => d.tree === tree);
  if (!descriptor || descriptor.disposition !== 'copy') {
    throw new Error(`Expected a copy descriptor for ${tree}`);
  }
  return descriptor;
}

const SOURCE_ID = 'source-tenant-1';
const DEST_UID = 'demo-account-uid-1';

// ---------------------------------------------------------------------------
// Descriptor lock (H1)
// ---------------------------------------------------------------------------

describe('TREE_DESCRIPTORS lock', () => {
  it('the real registry exact-set-locks against TENANT_DELETION_TREES (30 members, 15 copy + 15 assert-empty)', () => {
    expect(TREE_DESCRIPTOR_LOCK.ok).toBe(true);
    expect(TREE_DESCRIPTORS).toHaveLength(30);
    expect(TREE_DESCRIPTORS.filter(isCopyDescriptor)).toHaveLength(15);
    expect(TREE_DESCRIPTORS.filter((d) => d.disposition === 'assert-empty')).toHaveLength(15);
  });

  it('every deletion tree has exactly one descriptor', () => {
    const result = checkTreeDescriptorLock(TREE_DESCRIPTORS, TENANT_DELETION_TREES);
    expect(result).toEqual({
      ok: true,
      missingDescriptors: [],
      unknownDescriptors: [],
      missingDisposition: [],
    });
  });

  it('the authorization-bearing tree is assert-empty, never copy', () => {
    const descriptor = TREE_DESCRIPTORS.find((d) => d.tree === 'researchEntitlements');
    expect(descriptor?.disposition).toBe('assert-empty');
  });

  it('FIXTURE: fails loudly when a deletion tree has no descriptor', () => {
    const brokenRegistry = TREE_DESCRIPTORS.filter((d) => d.tree !== 'matches');
    const result = checkTreeDescriptorLock(brokenRegistry, TENANT_DELETION_TREES);
    expect(result.ok).toBe(false);
    expect(result.missingDescriptors).toEqual(['matches']);
  });

  it('FIXTURE: fails loudly when a descriptor names a non-member tree', () => {
    const brokenRegistry = [
      ...TREE_DESCRIPTORS,
      { tree: 'notARealDeletionTree', disposition: 'assert-empty' as const },
    ];
    const result = checkTreeDescriptorLock(brokenRegistry, TENANT_DELETION_TREES);
    expect(result.ok).toBe(false);
    expect(result.unknownDescriptors).toEqual(['notARealDeletionTree']);
  });

  it('FIXTURE: fails loudly when a descriptor carries no recognized disposition', () => {
    const brokenRegistry = TREE_DESCRIPTORS.map((d) =>
      d.tree === 'matches' ? { tree: 'matches', disposition: 'bogus' as never } : d,
    );
    const result = checkTreeDescriptorLock(brokenRegistry, TENANT_DELETION_TREES);
    expect(result.ok).toBe(false);
    expect(result.missingDisposition).toEqual(['matches']);
  });
});

// ---------------------------------------------------------------------------
// recordsDeepEqual
// ---------------------------------------------------------------------------

describe('recordsDeepEqual', () => {
  it('is true for structurally identical objects with different key order and different references', () => {
    expect(recordsDeepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
  });

  it('is false for a value mismatch at any depth', () => {
    expect(recordsDeepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toBe(false);
  });

  it('is false for arrays of different length and true for equal arrays', () => {
    expect(recordsDeepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(recordsDeepEqual([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
  });

  it('is never referential — a fresh object with the same content is equal', () => {
    const a = { x: [1, 2, { y: 'z' }] };
    const b = { x: [1, 2, { y: 'z' }] };
    expect(a).not.toBe(b);
    expect(recordsDeepEqual(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Depth-correct enumeration + copy (H1)
// ---------------------------------------------------------------------------

describe('depth-correct copy — nested-sets (researchSource)', () => {
  it('copies researchSource/{sourceId}/sets/{id} records to researchSource/{destUid}/sets/{id}, identifiers are the provider set ids, never ["sets"]', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSource/${SOURCE_ID}/sets/p1`, {
      providerSetId: 'p1',
      classification: 'completed',
    });
    database.seed(`researchSource/${SOURCE_ID}/sets/p2`, {
      providerSetId: 'p2',
      classification: 'bye',
    });

    const descriptor = findCopyDescriptor('researchSource');
    const copyResult = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(copyResult).toMatchObject({ copied: 2, skipped: 0, conflicts: [] });

    const dump = database.dump() as Record<string, unknown>;
    const researchSource = dump.researchSource as Record<string, Record<string, unknown>>;
    expect(researchSource[DEST_UID]).toMatchObject({
      sets: {
        p1: { providerSetId: 'p1', classification: 'completed' },
        p2: { providerSetId: 'p2', classification: 'bye' },
      },
    });

    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(true);
    expect(compareResult.sourceCount).toBe(2);
    expect(compareResult.destCount).toBe(2);
    // The compared identifiers are the provider set ids — never a single
    // ["sets"] key (review H1).
    const records = await enumerateRecords(asDatabase(database), descriptor, SOURCE_ID);
    expect([...records.keys()].sort()).toEqual(['p1', 'p2']);
    expect([...records.keys()]).not.toContain('sets');
  });

  it('an id mismatch (one dest record removed) reports the missing id, not ["sets"]', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSource/${SOURCE_ID}/sets/p1`, { providerSetId: 'p1' });
    database.seed(`researchSource/${SOURCE_ID}/sets/p2`, { providerSetId: 'p2' });
    database.seed(`researchSource/${DEST_UID}/sets/p1`, { providerSetId: 'p1' });

    const descriptor = findCopyDescriptor('researchSource');
    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(false);
    expect(compareResult.missingIds).toEqual(['p2']);
    expect(compareResult.extraIds).toEqual([]);
  });

  it('an extra dest record reports the extra id', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSource/${SOURCE_ID}/sets/p1`, { providerSetId: 'p1' });
    database.seed(`researchSource/${DEST_UID}/sets/p1`, { providerSetId: 'p1' });
    database.seed(`researchSource/${DEST_UID}/sets/p2`, { providerSetId: 'p2' });

    const descriptor = findCopyDescriptor('researchSource');
    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(false);
    expect(compareResult.extraIds).toEqual(['p2']);
  });
});

describe('depth-correct copy — nested-two-level (researchSupplements)', () => {
  it('copies researchSupplements/{sourceId}/{targetSetId}/{supplementId} with the composite identifier setA/supA1', async () => {
    const database = new FakeDatabase();
    database.seed(`researchSupplements/${SOURCE_ID}/setA/supA1`, {
      targetSetId: 'setA',
      field: 'note',
      value: 'manual note',
    });

    const descriptor = findCopyDescriptor('researchSupplements');
    const records = await enumerateRecords(asDatabase(database), descriptor, SOURCE_ID);
    expect([...records.keys()]).toEqual(['setA/supA1']);

    const copyResult = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(copyResult).toMatchObject({ copied: 1, skipped: 0, conflicts: [] });

    const dump = database.dump() as Record<string, unknown>;
    const supplements = dump.researchSupplements as Record<string, Record<string, unknown>>;
    expect(supplements[DEST_UID]).toMatchObject({
      setA: { supA1: { targetSetId: 'setA', field: 'note', value: 'manual note' } },
    });

    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(true);
  });
});

describe('depth-correct copy — singleton (researchCoverage / researchIdentity / researchIngestionRuns)', () => {
  it('copies the whole researchCoverage/{sourceId} node as ONE logical record', async () => {
    const database = new FakeDatabase();
    const coverageSnapshot = { asOf: 1000, discovered: 10, imported: 8, skipped: 1, unresolved: 1 };
    database.seed(`researchCoverage/${SOURCE_ID}`, coverageSnapshot);

    const descriptor = findCopyDescriptor('researchCoverage');
    const records = await enumerateRecords(asDatabase(database), descriptor, SOURCE_ID);
    expect(records.size).toBe(1);

    const copyResult = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(copyResult).toMatchObject({ copied: 1, skipped: 0, conflicts: [] });

    const dump = database.dump() as Record<string, unknown>;
    const coverage = dump.researchCoverage as Record<string, unknown>;
    expect(coverage[DEST_UID]).toEqual(coverageSnapshot);

    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(true);
    expect(compareResult.sourceCount).toBe(1);
    expect(compareResult.destCount).toBe(1);
  });
});

describe('flat copy (matches / opponents)', () => {
  it('copies matches/{sourceId}/{id} to matches/{destUid}/{id} with flat identifiers', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { fighter_id: 1, opponent_id: 2, time: 100 });
    database.seed(`matches/${SOURCE_ID}/m2`, { fighter_id: 3, opponent_id: 4, time: 200 });

    const descriptor = findCopyDescriptor('matches');
    const records = await enumerateRecords(asDatabase(database), descriptor, SOURCE_ID);
    expect([...records.keys()].sort()).toEqual(['m1', 'm2']);

    const copyResult = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(copyResult).toMatchObject({ copied: 2, skipped: 0, conflicts: [] });

    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Conflict-aware copy (H2)
// ---------------------------------------------------------------------------

describe('conflict-aware copy', () => {
  it('writes an absent destination record', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    const descriptor = findCopyDescriptor('matches');

    const result = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(result).toMatchObject({ copied: 1, skipped: 0, conflicts: [] });
  });

  it('skips (does not rewrite) a deep-equal destination record — not a conflict', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1, tag: 'a' });
    database.seed(`matches/${DEST_UID}/m1`, { tag: 'a', time: 1 }); // same content, different key order

    const descriptor = findCopyDescriptor('matches');
    const result = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(result).toMatchObject({ copied: 0, skipped: 1, conflicts: [] });
  });

  it('a same-id/different-value destination record is recorded as a conflict and is NEVER written (H2 core)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`matches/${DEST_UID}/m1`, { time: 999 });

    const descriptor = findCopyDescriptor('matches');
    const result = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(result).toMatchObject({ copied: 0, skipped: 0, conflicts: ['m1'] });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[DEST_UID]?.m1).toEqual({ time: 999 });

    const compareResult = await compareTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(compareResult.match).toBe(false);
    expect(compareResult.valueMismatchIds).toEqual(['m1']);
  });

  it('re-running the copy is a no-op: second invocation writes zero, records zero conflicts, destination stays deep-equal', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`matches/${SOURCE_ID}/m2`, { time: 2 });
    const descriptor = findCopyDescriptor('matches');

    const first = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(first).toMatchObject({ copied: 2, skipped: 0, conflicts: [] });

    const dumpAfterFirst = database.dump();
    const second = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(second).toMatchObject({ copied: 0, skipped: 2, conflicts: [] });
    expect(database.dump()).toEqual(dumpAfterFirst);
  });

  it('a pre-existing unrelated sibling at the destination survives the copy (non-overwriting)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${DEST_UID}/manual-pre-1`, { time: 42, manual: true });
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });

    const descriptor = findCopyDescriptor('matches');
    await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[DEST_UID]?.['manual-pre-1']).toEqual({ time: 42, manual: true });
    expect(matches[DEST_UID]?.m1).toEqual({ time: 1 });
  });

  it('no enumerate-then-update race: a destination record seeded with a DIFFERENT value immediately before copyTree runs is recorded as a conflict, never clobbered', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    // Simulates a write that landed after source enumeration but before the
    // destination commit — seeded synchronously before copyTree is invoked.
    database.seed(`matches/${DEST_UID}/m1`, { time: 777 });

    const descriptor = findCopyDescriptor('matches');
    const result = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(result).toMatchObject({ copied: 0, skipped: 0, conflicts: ['m1'] });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[DEST_UID]?.m1).toEqual({ time: 777 });
  });

  it('a deep-equal interim value is skipped, not rewritten (companion to the race case above)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`matches/${DEST_UID}/m1`, { time: 1 });

    const descriptor = findCopyDescriptor('matches');
    const result = await copyTree(asDatabase(database), descriptor, SOURCE_ID, DEST_UID);
    expect(result).toMatchObject({ copied: 0, skipped: 1, conflicts: [] });
  });
});

// ---------------------------------------------------------------------------
// Malformed id (guard-before-ref)
// ---------------------------------------------------------------------------

describe('malformed id — guard-before-ref', () => {
  it('copyTree throws for an RTDB-illegal sourceId before any ref() is built', async () => {
    const database = new FakeDatabase();
    const descriptor = findCopyDescriptor('matches');
    await expect(copyTree(asDatabase(database), descriptor, 'bad.id', DEST_UID)).rejects.toThrow();
  });

  it('copyTree throws for an RTDB-illegal destUid', async () => {
    const database = new FakeDatabase();
    const descriptor = findCopyDescriptor('matches');
    await expect(
      copyTree(asDatabase(database), descriptor, SOURCE_ID, 'bad#uid'),
    ).rejects.toThrow();
  });

  it('compareTree throws for an RTDB-illegal id', async () => {
    const database = new FakeDatabase();
    const descriptor = findCopyDescriptor('matches');
    await expect(
      compareTree(asDatabase(database), descriptor, 'bad[id]', DEST_UID),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runMigration assert-empty PRE-PASS ordering (C3-M1)
// ---------------------------------------------------------------------------

describe('runMigration', () => {
  it('a clean source migrates every copy tree and reports ok=true', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`researchSource/${SOURCE_ID}/sets/p1`, { providerSetId: 'p1' });
    database.seed(`researchCoverage/${SOURCE_ID}`, { asOf: 1 });

    const manifest = await runMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });

    expect(manifest.ok).toBe(true);
    expect(manifest.assertEmptyViolations).toEqual([]);
    // 15 copy descriptors post-30.3 Gate 5 (the 7 Phase-30 trees plus the 8
    // Liquipedia enrichment trees — plan 09's shrink-review log and Gate 5's
    // VOD candidate tree included) — every copy descriptor produces a
    // CopyResult/CompareResult even for a tree with no seeded records.
    expect(manifest.copies).toHaveLength(15);
    expect(manifest.trees).toHaveLength(15);
    expect(manifest.trees.every((t) => t.match)).toBe(true);
  });

  it('refuses (ok=false) BEFORE any copyTree write when an assert-empty tree is non-empty, even with ordinary copy trees also populated (C3-M1)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`researchSource/${SOURCE_ID}/sets/p1`, { providerSetId: 'p1' });
    database.seed(`activeClaimInvitationByTenant/${SOURCE_ID}`, {
      digest: 'digest-1',
      expiresAt: Date.now() + 100000,
    });

    const manifest = await runMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });

    expect(manifest.ok).toBe(false);
    expect(manifest.assertEmptyViolations).toEqual(['activeClaimInvitationByTenant']);
    expect(manifest.copies).toEqual([]);
    expect(manifest.trees).toEqual([]);

    const dump = database.dump() as Record<string, unknown>;
    expect((dump.matches as Record<string, unknown> | undefined)?.[DEST_UID]).toBeUndefined();
    expect(
      (dump.researchSource as Record<string, unknown> | undefined)?.[DEST_UID],
    ).toBeUndefined();
  });
});

describe('runMigration — claim-topology refusal (MEDIUM #3)', () => {
  it('refuses when activeClaimInvitationByTenant is non-empty and copies nothing for any tree', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`activeClaimInvitationByTenant/${SOURCE_ID}`, {
      digest: 'digest-1',
      expiresAt: Date.now() + 100000,
    });

    const manifest = await runMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });

    expect(manifest.ok).toBe(false);
    expect(manifest.assertEmptyViolations).toContain('activeClaimInvitationByTenant');
    expect(manifest.copies).toEqual([]);

    const dump = database.dump() as Record<string, unknown>;
    expect((dump.matches as Record<string, unknown> | undefined)?.[DEST_UID]).toBeUndefined();
  });
});

describe('runMigration — entitlement refusal (C2-H1 + C3-M1)', () => {
  it('refuses when researchEntitlements holds an active grant AND ordinary copy trees are populated, leaving the ENTIRE destination unchanged and resolveEntitlement false', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    database.seed(`researchSource/${SOURCE_ID}/sets/p1`, { providerSetId: 'p1' });
    database.seed(`researchEntitlements/${SOURCE_ID}`, {
      activeGrant: {
        grantId: 'g1',
        grantedByUid: 'admin-1',
        grantedAt: Date.now(),
        idempotencyKey: 'k1',
      },
    });

    const manifest = await runMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });

    expect(manifest.ok).toBe(false);
    expect(manifest.assertEmptyViolations).toContain('researchEntitlements');
    expect(manifest.copies).toEqual([]);

    const dump = database.dump() as Record<string, unknown>;
    expect((dump.matches as Record<string, unknown> | undefined)?.[DEST_UID]).toBeUndefined();
    expect(
      (dump.researchSource as Record<string, unknown> | undefined)?.[DEST_UID],
    ).toBeUndefined();
    expect(
      (dump.researchEntitlements as Record<string, unknown> | undefined)?.[DEST_UID],
    ).toBeUndefined();

    const resolution = await resolveEntitlement(asDatabase(database), DEST_UID);
    expect(resolution).toEqual({ active: false, grantId: null });
  });
});

// ---------------------------------------------------------------------------
// verifyMigration — read-only, live re-check
// ---------------------------------------------------------------------------

describe('verifyMigration', () => {
  it('returns ok=true and performs ZERO writes after a clean migration', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    await runMigration(asDatabase(database), { sourceId: SOURCE_ID, destUid: DEST_UID });

    const dumpBefore = database.dump();
    const result = await verifyMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });

    expect(result.ok).toBe(true);
    expect(database.dump()).toEqual(dumpBefore);
  });

  it('returns ok=false (valueMismatch) when a destination record is mutated out-of-band after a clean migration', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    await runMigration(asDatabase(database), { sourceId: SOURCE_ID, destUid: DEST_UID });

    database.seed(`matches/${DEST_UID}/m1`, { time: 9999 });

    const result = await verifyMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });
    expect(result.ok).toBe(false);
    const matchesTree = result.trees.find((t) => t.tree === 'matches');
    expect(matchesTree?.valueMismatchIds).toEqual(['m1']);
  });

  it('returns ok=false (missing id) when a destination record is deleted out-of-band after a clean migration', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    await runMigration(asDatabase(database), { sourceId: SOURCE_ID, destUid: DEST_UID });

    database.seed(`matches/${DEST_UID}/m1`, null);

    const result = await verifyMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });
    expect(result.ok).toBe(false);
    const matchesTree = result.trees.find((t) => t.tree === 'matches');
    expect(matchesTree?.missingIds).toEqual(['m1']);
  });

  it('returns ok=false when an assert-empty tree is later populated at the source', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${SOURCE_ID}/m1`, { time: 1 });
    await runMigration(asDatabase(database), { sourceId: SOURCE_ID, destUid: DEST_UID });

    database.seed(`playlists/${SOURCE_ID}`, { 'playlist-1': { name: 'unexpected' } });

    const result = await verifyMigration(asDatabase(database), {
      sourceId: SOURCE_ID,
      destUid: DEST_UID,
    });
    expect(result.ok).toBe(false);
    expect(result.assertEmptyViolations).toContain('playlists');
  });
});

// ---------------------------------------------------------------------------
// preflightDestinations (MEDIUM #2)
// ---------------------------------------------------------------------------

function seedOrdinaryUser(database: FakeDatabase, uid: string): void {
  database.seed(`users/${uid}`, { email: `${uid}@example.com` });
}

describe('preflightDestinations', () => {
  it('ok=true for four distinct, existing, ordinary uids none of which is a source', async () => {
    const database = new FakeDatabase();
    const destUids = ['demo-1', 'demo-2', 'demo-3', 'demo-4'];
    for (const uid of destUids) {
      seedOrdinaryUser(database, uid);
    }

    const result = await preflightDestinations(asDatabase(database), {
      destUids,
      sourceIds: [SOURCE_ID],
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('ok=false with a duplicate problem naming the repeated uid', async () => {
    const database = new FakeDatabase();
    seedOrdinaryUser(database, 'demo-1');

    const result = await preflightDestinations(asDatabase(database), {
      destUids: ['demo-1', 'demo-1'],
      sourceIds: [],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('demo-1'))).toBe(true);
  });

  it('ok=false when a destination uid has no users/{uid} record', async () => {
    const database = new FakeDatabase();

    const result = await preflightDestinations(asDatabase(database), {
      destUids: ['demo-missing'],
      sourceIds: [],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('demo-missing'))).toBe(true);
  });

  it('ok=false when a destination uid resolves non-ordinary', async () => {
    const database = new FakeDatabase();
    seedOrdinaryUser(database, 'demo-research');
    database.seed('clientTenants/demo-research/kind', 'research');

    const result = await preflightDestinations(asDatabase(database), {
      destUids: ['demo-research'],
      sourceIds: [],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('demo-research'))).toBe(true);
  });

  it('ok=false when a destination uid collides with a source tenant id', async () => {
    const database = new FakeDatabase();
    seedOrdinaryUser(database, SOURCE_ID);

    const result = await preflightDestinations(asDatabase(database), {
      destUids: [SOURCE_ID],
      sourceIds: [SOURCE_ID],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes(SOURCE_ID))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// archiveSources — non-destructive, hard-delete import-absence
// ---------------------------------------------------------------------------

const COACH_UID = 'coach-uid-migration-1';

describe('archiveSources', () => {
  it('marks the source tenant archived without deleting any content tree', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClientCore(
      asDatabase(database),
      COACH_UID,
      'Hbox',
      'coaching',
    );
    database.seed(`matches/${tenantId}/m1`, { time: 1 });
    database.seed(`researchSource/${tenantId}/sets/p1`, { providerSetId: 'p1' });

    await archiveSources(asDatabase(database), COACH_UID, [tenantId], null);

    const dump = database.dump() as Record<string, unknown>;
    const clientTenants = dump.clientTenants as Record<string, Record<string, unknown>>;
    const coachClients = dump.coachClients as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(clientTenants[tenantId]?.archivedAt).not.toBeNull();
    expect(coachClients[COACH_UID]?.[tenantId]?.archivedAt).not.toBeNull();

    // Content trees survive — archive is non-destructive.
    const matches = dump.matches as Record<string, unknown>;
    const researchSource = dump.researchSource as Record<string, unknown>;
    expect(matches[tenantId]).toEqual({ m1: { time: 1 } });
    expect(researchSource[tenantId]).toBeDefined();
  });

  it('fails closed (ForbiddenError) for a research-kind source tenant when researchConfig is null (Pitfall 3)', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClientCore(
      asDatabase(database),
      COACH_UID,
      'Research tenant',
      'research',
    );

    await expect(archiveSources(asDatabase(database), COACH_UID, [tenantId], null)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('archiveSources import-absence (the hard-delete cascade is structurally un-importable)', () => {
  it('manifest.ts imports archiveClient but never the hard-delete cascade function', () => {
    const source = readFileSync(resolve('src/research/migration/manifest.ts'), 'utf-8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');

    expect(importLines).toMatch(/\barchiveClient\b/);
    // Mirrors the hard-delete cascade's identifier from
    // apps/api/src/coaching/tenants.ts, checked by import lines only so a
    // stray comment can never false-trip this (telemetrySilence.test.ts
    // pattern).
    expect(importLines).not.toMatch(/\bdeleteClient\b/);
  });
});
