import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { classifyReportSubject } from './reportSubject.js';

const UID = 'report-caller-uid-1';
const TENANT_ID = 'report-tenant-abc';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** Wraps a `Database`, counting every `.ref(...)` call (a proxy for "was a database reference constructed"). */
function countingDatabase(database: Database): { database: Database; refCount: () => number } {
  let refCount = 0;
  const spied = {
    ref: (path?: string) => {
      refCount += 1;
      return database.ref(path);
    },
  } as unknown as Database;
  return { database: spied, refCount: () => refCount };
}

/** A `Database` whose `.ref(path).get()` throws for any path starting with `throwOnPrefix`, delegating everything else to `base`. */
function selectiveThrowDatabase(base: FakeDatabase, throwOnPrefix: string): Database {
  return {
    ref: (path?: string) => {
      if (path !== undefined && path.startsWith(throwOnPrefix)) {
        return {
          get: async () => {
            throw new Error('simulated read failure');
          },
        };
      }
      return base.ref(path);
    },
  } as unknown as Database;
}

function seedResearchTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'research' });
}

function seedOrdinaryTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'coaching' });
}

function seedMembership(database: FakeDatabase, tenantId: string, uid: string): void {
  database.seed(`clientMembers/${tenantId}/${uid}`, { role: 'custodian', joinedAt: 1 });
}

describe('classifyReportSubject', () => {
  it('classifies not-applicable with zero database reads when the header is absent', async () => {
    const { database, refCount } = countingDatabase(asDatabase(new FakeDatabase()));

    const result = await classifyReportSubject({ database, uid: UID, header: undefined });

    expect(result).toBe('not-applicable');
    expect(refCount()).toBe(0);
  });

  it("classifies not-applicable with zero database reads when the header is 'personal'", async () => {
    const { database, refCount } = countingDatabase(asDatabase(new FakeDatabase()));

    const result = await classifyReportSubject({ database, uid: UID, header: 'personal' });

    expect(result).toBe('not-applicable');
    expect(refCount()).toBe(0);
  });

  it('classifies not-applicable and never throws for a malformed header (no client: prefix)', async () => {
    const database = asDatabase(new FakeDatabase());

    await expect(
      classifyReportSubject({ database, uid: UID, header: 'bogus-value' }),
    ).resolves.toBe('not-applicable');
  });

  it('classifies not-applicable and never throws for an empty tenant id', async () => {
    const database = asDatabase(new FakeDatabase());

    await expect(classifyReportSubject({ database, uid: UID, header: 'client:' })).resolves.toBe(
      'not-applicable',
    );
  });

  it('classifies not-applicable, never throws, and constructs ZERO database references for a path-illegal tenant id (key-shape-ordering guard)', async () => {
    const { database, refCount } = countingDatabase(asDatabase(new FakeDatabase()));

    await expect(
      classifyReportSubject({ database, uid: UID, header: 'client:tenant.with.dots' }),
    ).resolves.toBe('not-applicable');
    expect(refCount()).toBe(0);
  });

  it('classifies a NON-MEMBER naming a real research tenant as not-applicable (no-oracle case)', async () => {
    const fake = new FakeDatabase();
    seedResearchTenant(fake, TENANT_ID);
    // Deliberately no membership record for UID.

    const result = await classifyReportSubject({
      database: asDatabase(fake),
      uid: UID,
      header: `client:${TENANT_ID}`,
    });

    expect(result).toBe('not-applicable');
  });

  it('classifies a MEMBER of a research tenant as research', async () => {
    const fake = new FakeDatabase();
    seedResearchTenant(fake, TENANT_ID);
    seedMembership(fake, TENANT_ID, UID);

    const result = await classifyReportSubject({
      database: asDatabase(fake),
      uid: UID,
      header: `client:${TENANT_ID}`,
    });

    expect(result).toBe('research');
  });

  it('classifies a MEMBER of an ORDINARY tenant as not-applicable', async () => {
    const fake = new FakeDatabase();
    seedOrdinaryTenant(fake, TENANT_ID);
    seedMembership(fake, TENANT_ID, UID);

    const result = await classifyReportSubject({
      database: asDatabase(fake),
      uid: UID,
      header: `client:${TENANT_ID}`,
    });

    expect(result).toBe('not-applicable');
  });

  it('classifies a MEMBER of a tenant whose kind read fails as indeterminate', async () => {
    const fake = new FakeDatabase();
    seedMembership(fake, TENANT_ID, UID);
    // No clientTenants/{TENANT_ID} record; force the kind read to throw.
    const database = selectiveThrowDatabase(fake, `clientTenants/${TENANT_ID}`);

    const result = await classifyReportSubject({
      database,
      uid: UID,
      header: `client:${TENANT_ID}`,
    });

    expect(result).toBe('indeterminate');
  });

  it('classifies a rejecting MEMBERSHIP read as indeterminate — not not-applicable — and never throws', async () => {
    const fake = new FakeDatabase();
    seedResearchTenant(fake, TENANT_ID);
    const database = selectiveThrowDatabase(fake, `clientMembers/${TENANT_ID}`);

    await expect(
      classifyReportSubject({ database, uid: UID, header: `client:${TENANT_ID}` }),
    ).resolves.toBe('indeterminate');
  });
});
