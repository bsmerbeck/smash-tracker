import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ConflictingTransactionDatabase } from '../test-support/conflictingTransactionDatabase.js';
import { ForbiddenError } from '../services/rtdb.js';
import { grantEntitlement, revokeEntitlement, resolveEntitlement } from './entitlements.js';

function asDatabase(database: FakeDatabase | ConflictingTransactionDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const COACHING_TENANT_ID = 'coaching-tenant';
const UNRESOLVABLE_TENANT_ID = 'unresolvable-tenant';
const ADMIN_UID = 'admin-1';
const PERSONAL_UID = 'personal-uid-1';

function seedResearchTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'research' });
}

/**
 * B-event emission (`void createEvent(...)`) is fire-and-forget — mirrors
 * `apps/api/src/billing/credits.test.ts`'s `flush` helper: flush the
 * microtask/macrotask queue before asserting on the telemetry trees so
 * these tests aren't racing an emission this module structurally cannot
 * produce anyway.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('grantEntitlement', () => {
  it('creates an active grant with a fresh identifier and returns it with the idempotency key', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const result = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');

    expect(typeof result.grantId).toBe('string');
    expect(result.grantId.length).toBeGreaterThan(0);
    expect(result.idempotencyKey).toBe('idem-key-1');

    const dump = database.dump() as Record<string, unknown>;
    const record = (dump.researchEntitlements as Record<string, unknown>)?.[TENANT_ID] as
      { activeGrant?: { grantId?: string } } | undefined;
    expect(record?.activeGrant?.grantId).toBe(result.grantId);
  });

  it('is a no-op when the SAME idempotency key repeats while the grant is active — same identifier, no duplicated history entry', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const first = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');
    const second = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');

    expect(second.grantId).toBe(first.grantId);

    const dump = database.dump() as Record<string, unknown>;
    const record = (dump.researchEntitlements as Record<string, unknown>)?.[TENANT_ID] as {
      history?: Record<string, unknown>;
    };
    expect(record.history ?? {}).toEqual({});
  });

  it('a previously-used idempotency key arriving AFTER a revoke creates nothing and returns the original identifier', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const granted = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );
    await revokeEntitlement(asDatabase(database), TENANT_ID, granted.grantId);

    const replayed = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );

    expect(replayed.grantId).toBe(granted.grantId);
    const resolution = await resolveEntitlement(asDatabase(database), TENANT_ID);
    expect(resolution.active).toBe(false);
  });

  it('a NEW idempotency key after a revoke creates a new grant with a different identifier; the revoked grant remains in history', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const first = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');
    await revokeEntitlement(asDatabase(database), TENANT_ID, first.grantId);
    const second = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-2');

    expect(second.grantId).not.toBe(first.grantId);

    const dump = database.dump() as Record<string, unknown>;
    const record = (dump.researchEntitlements as Record<string, unknown>)?.[TENANT_ID] as {
      history?: Record<string, { grantId?: string; revokedAt?: number }>;
      activeGrant?: { grantId?: string };
    };
    expect(record.activeGrant?.grantId).toBe(second.grantId);
    const historyEntries = Object.values(record.history ?? {});
    expect(historyEntries.some((entry) => entry.grantId === first.grantId)).toBe(true);
  });

  it('refuses a tenant that is not a research tenant', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${COACHING_TENANT_ID}`, { createdAt: 1, archivedAt: null });

    await expect(
      grantEntitlement(asDatabase(database), COACHING_TENANT_ID, ADMIN_UID, 'idem-key-1'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a tenant whose kind cannot be resolved', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${UNRESOLVABLE_TENANT_ID}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'not-a-real-kind',
    });

    await expect(
      grantEntitlement(asDatabase(database), UNRESOLVABLE_TENANT_ID, ADMIN_UID, 'idem-key-1'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('is correct when the transaction first run sees a null local cache (CR-01)', async () => {
    // FakeDatabase's `.transaction()` ALWAYS invokes the callback with
    // `null` first, regardless of the real stored value — this test simply
    // exercises the store's normal path against a genuinely-empty node,
    // which is exactly the null-first-run condition for a brand-new tenant.
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const result = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');
    expect(result.grantId).toBeTruthy();
  });

  it('produces zero rows across the canonical ledger, dedup markers, and outbox, with the queue drained', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');
    await flush();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.eventLedger).toBeUndefined();
    expect(dump.eventDedup).toBeUndefined();
    expect(dump.outboxPending).toBeUndefined();
  });

  it('two concurrent grants with different keys — driven through ConflictingTransactionDatabase — leave exactly one active grant, and the loser observes the winner identifier', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const conflictDb = new ConflictingTransactionDatabase(database, {
      path: `researchEntitlements/${TENANT_ID}`,
      competingWrite: async () => {
        await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'winner-key');
      },
    });

    const loserResult = await grantEntitlement(
      asDatabase(conflictDb),
      TENANT_ID,
      ADMIN_UID,
      'loser-key',
    );

    const dump = database.dump() as Record<string, unknown>;
    const record = (dump.researchEntitlements as Record<string, unknown>)?.[TENANT_ID] as {
      activeGrant?: { grantId?: string };
      operations?: Record<string, { grantId?: string; outcome?: string }>;
    };

    expect(record.activeGrant).toBeDefined();
    const winnerGrantId = record.activeGrant?.grantId;
    expect(winnerGrantId).toBeTruthy();
    expect(loserResult.grantId).toBe(winnerGrantId);
    expect(record.operations?.['winner-key']).toMatchObject({
      grantId: winnerGrantId,
      outcome: 'created',
    });
    expect(record.operations?.['loser-key']).toMatchObject({
      grantId: winnerGrantId,
      outcome: 'observed-existing',
    });
  });

  it('LOSER-KEY-AFTER-REVOKE regression (cycle-2 finding C2-HIGH-11): the losing concurrent grant key, replayed after the winning grant is revoked, creates nothing and returns the winner identifier', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const conflictDb = new ConflictingTransactionDatabase(database, {
      path: `researchEntitlements/${TENANT_ID}`,
      competingWrite: async () => {
        await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'winner-key');
      },
    });

    const loserResult = await grantEntitlement(
      asDatabase(conflictDb),
      TENANT_ID,
      ADMIN_UID,
      'loser-key',
    );
    const winnerGrantId = loserResult.grantId;

    // Revoke the winning grant.
    await revokeEntitlement(asDatabase(database), TENANT_ID, winnerGrantId);
    expect((await resolveEntitlement(asDatabase(database), TENANT_ID)).active).toBe(false);

    // Replay the LOSER's key after the winner has been revoked.
    const replayed = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'loser-key',
    );

    expect(replayed.grantId).toBe(winnerGrantId);
    expect((await resolveEntitlement(asDatabase(database), TENANT_ID)).active).toBe(false);
  });

  it('the operations index is not pruned by a revoke', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const granted = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );
    await revokeEntitlement(asDatabase(database), TENANT_ID, granted.grantId);

    const dump = database.dump() as Record<string, unknown>;
    const record = (dump.researchEntitlements as Record<string, unknown>)?.[TENANT_ID] as {
      operations?: Record<string, unknown>;
    };
    expect(record.operations?.['idem-key-1']).toBeDefined();
  });
});

describe('revokeEntitlement', () => {
  it('terminates the active grant, stamps the revocation time, moves it into history, and leaves no active grant', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const granted = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );
    const revoked = await revokeEntitlement(asDatabase(database), TENANT_ID, granted.grantId);

    expect(revoked.ok).toBe(true);
    const resolution = await resolveEntitlement(asDatabase(database), TENANT_ID);
    expect(resolution.active).toBe(false);

    const dump = database.dump() as Record<string, unknown>;
    const record = (dump.researchEntitlements as Record<string, unknown>)?.[TENANT_ID] as {
      history?: Record<string, { revokedAt?: number }>;
    };
    const entry = Object.values(record.history ?? {})[0];
    expect(entry?.revokedAt).toBeTypeOf('number');
  });

  it('is a no-op when the expected grant identifier is stale — a delayed revoke cannot terminate a newer grant', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const first = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');
    await revokeEntitlement(asDatabase(database), TENANT_ID, first.grantId);
    const second = await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-2');

    // A delayed revoke naming the FIRST (already-revoked) grant must not
    // touch the second, currently-active grant.
    await revokeEntitlement(asDatabase(database), TENANT_ID, first.grantId);

    const resolution = await resolveEntitlement(asDatabase(database), TENANT_ID);
    expect(resolution.active).toBe(true);
    expect(resolution.grantId).toBe(second.grantId);
  });

  it('is a no-op with the SAME response shape when nothing is active', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const result = await revokeEntitlement(asDatabase(database), TENANT_ID, 'never-granted');
    expect(result).toEqual({ ok: true });
  });

  it('a repeated revoke returns the same response as the first', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const granted = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );
    const firstRevoke = await revokeEntitlement(asDatabase(database), TENANT_ID, granted.grantId);
    const secondRevoke = await revokeEntitlement(asDatabase(database), TENANT_ID, granted.grantId);

    expect(secondRevoke).toEqual(firstRevoke);
  });

  it('is correct when the transaction first run sees a null local cache (CR-01)', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const result = await revokeEntitlement(asDatabase(database), TENANT_ID, 'anything');
    expect(result).toEqual({ ok: true });
  });

  it('produces zero rows across the canonical ledger, dedup markers, and outbox, with the queue drained', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);

    const granted = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );
    await revokeEntitlement(asDatabase(database), TENANT_ID, granted.grantId);
    await flush();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.eventLedger).toBeUndefined();
    expect(dump.eventDedup).toBeUndefined();
    expect(dump.outboxPending).toBeUndefined();
  });
});

describe('resolveEntitlement', () => {
  it('reports an active entitlement only for the exact tenant it was granted to', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);
    seedResearchTenant(database, OTHER_TENANT_ID);

    const granted = await grantEntitlement(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      'idem-key-1',
    );

    const own = await resolveEntitlement(asDatabase(database), TENANT_ID);
    expect(own).toEqual({ active: true, grantId: granted.grantId });

    const other = await resolveEntitlement(asDatabase(database), OTHER_TENANT_ID);
    expect(other).toEqual({ active: false, grantId: null });
  });

  it('reports no entitlement for a personal uid', async () => {
    const database = new FakeDatabase();
    seedResearchTenant(database, TENANT_ID);
    await grantEntitlement(asDatabase(database), TENANT_ID, ADMIN_UID, 'idem-key-1');

    const personal = await resolveEntitlement(asDatabase(database), PERSONAL_UID);
    expect(personal).toEqual({ active: false, grantId: null });
  });
});
