import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { isPathSafeTenantId, isResearchTenant, readSubjectKind } from './subjectKind.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** A `Database` whose `.ref(...).get()` always throws — simulates a read failure. */
function throwingDatabase(): Database {
  return {
    ref: () => ({
      get: async () => {
        throw new Error('simulated read failure');
      },
    }),
  } as unknown as Database;
}

const TENANT = 'tenant-1';

describe('isPathSafeTenantId', () => {
  it('rejects an empty id', () => {
    expect(isPathSafeTenantId('')).toBe(false);
  });

  it('rejects an id containing an RTDB-illegal character', () => {
    expect(isPathSafeTenantId('foo.bar')).toBe(false);
    expect(isPathSafeTenantId('foo#bar')).toBe(false);
    expect(isPathSafeTenantId('foo$bar')).toBe(false);
    expect(isPathSafeTenantId('foo[bar')).toBe(false);
    expect(isPathSafeTenantId('foo]bar')).toBe(false);
    expect(isPathSafeTenantId('foo/bar')).toBe(false);
  });

  it('accepts an ordinary randomUUID-shaped tenant id', () => {
    expect(isPathSafeTenantId('4fdd0c28-bfd1-4da8-a226-1bf04ffc3f04')).toBe(true);
  });
});

describe('readSubjectKind', () => {
  it('resolves research for a tenant record whose stored discriminator is the research member', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    await expect(readSubjectKind(asDatabase(database), TENANT)).resolves.toBe('research');
  });

  it('resolves ordinary for a legacy tenant record with no discriminator key', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1 });

    await expect(readSubjectKind(asDatabase(database), TENANT)).resolves.toBe('ordinary');
  });

  it('resolves ordinary for an id with no tenant record at all (personal uid, unknown id)', async () => {
    const database = new FakeDatabase();

    await expect(readSubjectKind(asDatabase(database), TENANT)).resolves.toBe('ordinary');
  });

  it('resolves unresolved (never throws) for an unparseable/unrecognized stored value', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}/kind`, 'not-a-real-kind');

    await expect(readSubjectKind(asDatabase(database), TENANT)).resolves.toBe('unresolved');
  });

  it('resolves unresolved (never throws) for an id containing an RTDB-illegal character', async () => {
    const database = new FakeDatabase();

    await expect(readSubjectKind(asDatabase(database), 'foo.bar')).resolves.toBe('unresolved');
  });

  it('resolves unresolved (never throws) when the underlying read throws', async () => {
    await expect(readSubjectKind(throwingDatabase(), TENANT)).resolves.toBe('unresolved');
  });
});

describe('isResearchTenant', () => {
  it('returns true only for the research resolution', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1, kind: 'research' });

    await expect(isResearchTenant(asDatabase(database), TENANT)).resolves.toBe(true);
  });

  it('returns false for the ordinary resolution', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}`, { createdAt: 1 });

    await expect(isResearchTenant(asDatabase(database), TENANT)).resolves.toBe(false);
  });

  it('returns false for the unresolved resolution (never a silent upgrade to research)', async () => {
    const database = new FakeDatabase();
    database.seed(`clientTenants/${TENANT}/kind`, 'not-a-real-kind');

    await expect(isResearchTenant(asDatabase(database), TENANT)).resolves.toBe(false);
  });
});
