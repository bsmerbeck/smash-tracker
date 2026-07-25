import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../services/rtdb.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { readMembershipRole, requireTenantRole } from './membershipRoles.js';

const TENANT_ID = 'tenant-1';
const CUSTODIAN_UID = 'coach-custodian';
const DELEGATE_UID = 'coach-delegate';
const STRANGER_UID = 'coach-stranger';

function seedMembership(
  database: FakeDatabase,
  tenantId: string,
  uid: string,
  role: string,
): Promise<void> {
  return database.ref(`clientMembers/${tenantId}/${uid}`).set({ role, joinedAt: 1 });
}

describe('readMembershipRole', () => {
  it("returns 'custodian' for a seeded custodian membership record", async () => {
    const database = new FakeDatabase();
    await seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');

    await expect(readMembershipRole(database as never, CUSTODIAN_UID, TENANT_ID)).resolves.toBe(
      'custodian',
    );
  });

  it('returns null when no membership record exists', async () => {
    const database = new FakeDatabase();

    await expect(
      readMembershipRole(database as never, STRANGER_UID, TENANT_ID),
    ).resolves.toBeNull();
  });

  it('returns null when the stored record fails clientMembershipSchema (fail closed)', async () => {
    const database = new FakeDatabase();
    await database.ref(`clientMembers/${TENANT_ID}/${STRANGER_UID}`).set({ role: 'not-a-role' });

    await expect(
      readMembershipRole(database as never, STRANGER_UID, TENANT_ID),
    ).resolves.toBeNull();
  });
});

describe('requireTenantRole', () => {
  it('resolves to the role for an allowed custodian member', async () => {
    const database = new FakeDatabase();
    await seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');

    await expect(
      requireTenantRole(database as never, CUSTODIAN_UID, TENANT_ID, ['custodian']),
    ).resolves.toBe('custodian');
  });

  it('resolves for either role in a multi-role allowlist', async () => {
    const database = new FakeDatabase();
    await seedMembership(database, TENANT_ID, CUSTODIAN_UID, 'custodian');
    const ownerUid = 'coach-owner';
    await seedMembership(database, TENANT_ID, ownerUid, 'owner');

    await expect(
      requireTenantRole(database as never, CUSTODIAN_UID, TENANT_ID, ['custodian', 'owner']),
    ).resolves.toBe('custodian');
    await expect(
      requireTenantRole(database as never, ownerUid, TENANT_ID, ['custodian', 'owner']),
    ).resolves.toBe('owner');
  });

  it('rejects a delegate denied a custodian-only gate, with the same message as a non-member', async () => {
    const database = new FakeDatabase();
    await seedMembership(database, TENANT_ID, DELEGATE_UID, 'delegate');

    let delegateMessage = '';
    try {
      await requireTenantRole(database as never, DELEGATE_UID, TENANT_ID, ['custodian']);
      throw new Error('expected requireTenantRole to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      delegateMessage = (err as Error).message;
    }

    let strangerMessage = '';
    try {
      await requireTenantRole(database as never, STRANGER_UID, TENANT_ID, ['custodian']);
      throw new Error('expected requireTenantRole to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      strangerMessage = (err as Error).message;
    }

    expect(delegateMessage).toBe(strangerMessage);
  });

  it('throws the exact ForbiddenError class the global handler maps to 403', async () => {
    const database = new FakeDatabase();

    await expect(
      requireTenantRole(database as never, STRANGER_UID, TENANT_ID, ['custodian']),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
