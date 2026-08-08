import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { createClientCore } from '../coaching/tenants.js';
import { createResearchTenant, listResearchTenants } from './tenants.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const ADMIN_UID = 'admin-1';

/**
 * B-event emission (`void createEvent(...)`) is fire-and-forget — mirrors
 * `apps/api/src/billing/credits.test.ts`'s `flush` helper (line 16-23):
 * flush the microtask/macrotask queue before asserting on the telemetry
 * trees so these tests aren't racing an emission this module structurally
 * cannot produce anyway (belt-and-braces, not merely a spy assertion).
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createResearchTenant', () => {
  it('returns a tenant id and writes the tenant record, custodian membership, and index entry', async () => {
    const database = new FakeDatabase();

    const { tenantId } = await createResearchTenant(
      asDatabase(database),
      ADMIN_UID,
      'Hbox snapshot',
    );

    expect(typeof tenantId).toBe('string');
    expect(tenantId.length).toBeGreaterThan(0);

    const dump = database.dump() as Record<string, unknown>;
    const tenantRecord = (dump.clientTenants as Record<string, unknown>)?.[tenantId] as
      { kind?: string; createdAt?: number; archivedAt?: number | null } | undefined;
    expect(tenantRecord?.kind).toBe('research');

    const membership = (dump.clientMembers as Record<string, unknown>)?.[tenantId] as
      Record<string, { role?: string }> | undefined;
    expect(membership?.[ADMIN_UID]?.role).toBe('custodian');

    const indexEntry = (dump.coachClients as Record<string, unknown>)?.[ADMIN_UID] as
      Record<string, { label?: string }> | undefined;
    expect(indexEntry?.[tenantId]?.label).toBe('Hbox snapshot');
  });

  it('produces zero rows across the three telemetry trees, even after the fire-and-forget queue flushes', async () => {
    const database = new FakeDatabase();

    await createResearchTenant(asDatabase(database), ADMIN_UID, 'Telemetry-silent client');
    await flush();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.eventLedger).toBeUndefined();
    expect(dump.eventDedup).toBeUndefined();
    expect(dump.outboxPending).toBeUndefined();
  });
});

describe('listResearchTenants', () => {
  it('returns exactly one row for a mixed fixture (one coaching tenant, one research tenant, one unresolvable tenant)', async () => {
    const database = new FakeDatabase();

    const { tenantId: researchTenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Research client',
      'research',
    );
    await createClientCore(asDatabase(database), ADMIN_UID, 'Coaching client', 'coaching');
    const { tenantId: unresolvableTenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Unresolvable client',
      'coaching',
    );
    // Corrupt the third tenant's stored kind so readSubjectKind resolves it
    // to 'unresolved' rather than 'ordinary' or 'research'.
    database.seed(`clientTenants/${unresolvableTenantId}/kind`, 12345);

    const rows = await listResearchTenants(asDatabase(database), ADMIN_UID);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe(researchTenantId);
    expect(rows[0]?.kind).toBe('research');
  });

  it('omits a tenant whose kind read fails to resolve', async () => {
    const database = new FakeDatabase();

    const { tenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Bad kind',
      'research',
    );
    database.seed(`clientTenants/${tenantId}/kind`, { not: 'a string' });

    const rows = await listResearchTenants(asDatabase(database), ADMIN_UID);

    expect(rows).toHaveLength(0);
  });

  it('returns an empty list for a caller with no indexed tenants (no error, no oracle)', async () => {
    const database = new FakeDatabase();

    const rows = await listResearchTenants(asDatabase(database), 'nobody');

    expect(rows).toEqual([]);
  });

  it('consults the per-tenant membership record for every returned row', async () => {
    const database = new FakeDatabase();

    const { tenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Membership test',
      'research',
    );

    const before = await listResearchTenants(asDatabase(database), ADMIN_UID);
    expect(before).toHaveLength(1);

    // Remove the membership record for the indexed tenant directly — the
    // index scan alone would still find it, proving the listing re-checks
    // membership rather than trusting the index.
    database.seed(`clientMembers/${tenantId}`, null);

    const after = await listResearchTenants(asDatabase(database), ADMIN_UID);
    expect(after).toHaveLength(0);
  });

  it('excludes a coaching tenant the same admin owns', async () => {
    const database = new FakeDatabase();

    await createClientCore(asDatabase(database), ADMIN_UID, 'Coaching only', 'coaching');

    const rows = await listResearchTenants(asDatabase(database), ADMIN_UID);

    expect(rows).toEqual([]);
  });
});
