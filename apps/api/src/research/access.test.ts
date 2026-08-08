import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ForbiddenError } from '../services/rtdb.js';
import { requireMembership } from '../coaching/tenants.js';
import { assertTenantAccess, resolveTenantAccess } from './access.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const UID = 'uid-1';
const TENANT = 'tenant-1';

describe('resolveTenantAccess', () => {
  it('resolves ordinary for an ordinary tenant, for any caller (existing behavior preserved exactly)', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1 });

    const outcome = await resolveTenantAccess({
      database: asDatabase(database),
      researchConfig: null,
      uid: UID,
      tenantId: TENANT,
    });

    expect(outcome).toEqual({ kind: 'ordinary' });
  });

  it('resolves denied for a research tenant when researchConfig is null', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    const outcome = await resolveTenantAccess({
      database: asDatabase(database),
      researchConfig: null,
      uid: UID,
      tenantId: TENANT,
    });

    expect(outcome).toEqual({ kind: 'denied' });
  });

  it('resolves denied for a research tenant when the caller uid is absent from the allowlist', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    const outcome = await resolveTenantAccess({
      database: asDatabase(database),
      researchConfig: { adminUids: new Set(['someone-else']) },
      uid: UID,
      tenantId: TENANT,
    });

    expect(outcome).toEqual({ kind: 'denied' });
  });

  it('resolves research for a research tenant only when the caller uid is in a non-null allowlist', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    const outcome = await resolveTenantAccess({
      database: asDatabase(database),
      researchConfig: { adminUids: new Set([UID]) },
      uid: UID,
      tenantId: TENANT,
    });

    expect(outcome).toEqual({ kind: 'research' });
  });

  it('resolves indeterminate for an unresolved kind read, regardless of caller', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}/kind`, 'not-a-real-kind');

    const outcome = await resolveTenantAccess({
      database: asDatabase(database),
      researchConfig: { adminUids: new Set([UID]) },
      uid: UID,
      tenantId: TENANT,
    });

    expect(outcome).toEqual({ kind: 'indeterminate' });
  });

  it('never throws, for any of the four outcomes above', async () => {
    const ordinaryDb = new FakeDatabase();
    ordinaryDb.seed(`clientTenants/${TENANT}`, { createdAt: 1 });
    const deniedDb = new FakeDatabase();
    deniedDb.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });
    const indeterminateDb = new FakeDatabase();
    indeterminateDb.seed(`clientTenants/${TENANT}/kind`, 'bogus');

    await expect(
      resolveTenantAccess({
        database: asDatabase(ordinaryDb),
        researchConfig: null,
        uid: UID,
        tenantId: TENANT,
      }),
    ).resolves.toBeDefined();
    await expect(
      resolveTenantAccess({
        database: asDatabase(deniedDb),
        researchConfig: { adminUids: new Set([UID]) },
        uid: UID,
        tenantId: TENANT,
      }),
    ).resolves.toBeDefined();
    await expect(
      resolveTenantAccess({
        database: asDatabase(deniedDb),
        researchConfig: null,
        uid: UID,
        tenantId: TENANT,
      }),
    ).resolves.toBeDefined();
    await expect(
      resolveTenantAccess({
        database: asDatabase(indeterminateDb),
        researchConfig: { adminUids: new Set([UID]) },
        uid: UID,
        tenantId: TENANT,
      }),
    ).resolves.toBeDefined();
  });
});

describe('assertTenantAccess', () => {
  it('returns the permitted kind (not void) for the ordinary outcome', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1 });

    await expect(
      assertTenantAccess({
        database: asDatabase(database),
        researchConfig: null,
        uid: UID,
        tenantId: TENANT,
      }),
    ).resolves.toBe('ordinary');
  });

  it('returns the permitted kind (not void) for the research outcome', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    await expect(
      assertTenantAccess({
        database: asDatabase(database),
        researchConfig: { adminUids: new Set([UID]) },
        uid: UID,
        tenantId: TENANT,
      }),
    ).resolves.toBe('research');
  });

  it('throws for the indeterminate outcome even when the caller IS allowlisted', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}/kind`, 'bogus');

    await expect(
      assertTenantAccess({
        database: asDatabase(database),
        researchConfig: { adminUids: new Set([UID]) },
        uid: UID,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('throws for the denied outcome', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    await expect(
      assertTenantAccess({
        database: asDatabase(database),
        researchConfig: null,
        uid: UID,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("the denied rejection, the indeterminate rejection, and requireMembership's non-member rejection are all deep-equal (class and message)", async () => {
    const deniedDb = new FakeDatabase();
    deniedDb.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });
    let deniedError: unknown;
    try {
      await assertTenantAccess({
        database: asDatabase(deniedDb),
        researchConfig: null,
        uid: UID,
        tenantId: TENANT,
      });
    } catch (err) {
      deniedError = err;
    }

    const indeterminateDb = new FakeDatabase();
    indeterminateDb.seed(`clientTenants/${TENANT}/kind`, 'bogus');
    let indeterminateError: unknown;
    try {
      await assertTenantAccess({
        database: asDatabase(indeterminateDb),
        researchConfig: { adminUids: new Set([UID]) },
        uid: UID,
        tenantId: TENANT,
      });
    } catch (err) {
      indeterminateError = err;
    }

    const membershipDb = new FakeDatabase();
    let membershipError: unknown;
    try {
      await requireMembership(asDatabase(membershipDb), UID, 'nonexistent-tenant', null);
    } catch (err) {
      membershipError = err;
    }

    expect(deniedError).toBeInstanceOf(ForbiddenError);
    expect(indeterminateError).toBeInstanceOf(ForbiddenError);
    expect(membershipError).toBeInstanceOf(ForbiddenError);
    expect(deniedError).toEqual(membershipError);
    expect(indeterminateError).toEqual(membershipError);
  });
});
