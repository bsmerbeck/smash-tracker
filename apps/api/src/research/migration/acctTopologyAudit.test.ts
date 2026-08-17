import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { auditAcctTopology } from './acctTopologyAudit.js';

const COACH_UID = 'dev-coach-uid-1';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const HBOX = { label: 'hbox', uid: 'B4AoA73kJ2dlk9B61POUsTUjM6w2' };
const MKLEO = { label: 'mkleo', uid: 'eVJih9SgfJVk5oMPAQydPGbEBpU2' };
const SPARG0 = { label: 'sparg0', uid: 'cosPe2wagVZsTWprGKnpjrcUEsb2' };
const IZAW = { label: 'izaw', uid: 'VnWOqNRRP5ZqFF0457DPqiBsT4D3' };
const FOUR = [HBOX, MKLEO, SPARG0, IZAW];

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** A coach with two real client tenants, neither owned by nor containing a demo uid. */
function seedHealthyCoachTree(database: FakeDatabase): void {
  database.seed(`coachClients/${COACH_UID}/${TENANT_A}`, {
    label: 'Client A',
    createdAt: 1,
    archivedAt: null,
  });
  database.seed(`coachClients/${COACH_UID}/${TENANT_B}`, {
    label: 'Client B',
    createdAt: 2,
    archivedAt: null,
  });
  database.seed(`clientMembers/${TENANT_A}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
  database.seed(`clientMembers/${TENANT_B}/${COACH_UID}`, { role: 'custodian', joinedAt: 2 });
}

describe('auditAcctTopology (Phase 30.1, ACCT-01/ACCT-03: no demo account is a managed client)', () => {
  it('passes when the coach has real clients and none of the four is a member or owner', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    // Each demo account exists as an ordinary user — present, but unrelated.
    for (const subject of FOUR) {
      database.seed(`users/${subject.uid}/email`, `${subject.label}@example.com`);
    }

    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.coachTenantIds).toHaveLength(2);
    expect(result.vacuousMembershipSweep).toBe(false);
    // Proof the sweep actually ran: 2 tenants x 4 subjects.
    expect(result.membershipReads).toBe(8);
  });

  it('FAILS when a demo account is a member of one of the coach client tenants', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    database.seed(`clientMembers/${TENANT_B}/${SPARG0.uid}`, { role: 'viewer', joinedAt: 9 });

    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      violation: 'coach-tenant-member',
      label: 'sparg0',
      uid: SPARG0.uid,
      tenantId: TENANT_B,
    });
  });

  it('FAILS when a demo account OWNS a managed tenant (the v2.4 claim link)', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    database.seed(`clientOwnedTenants/${IZAW.uid}/${TENANT_A}`, true);

    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      violation: 'owns-managed-tenant',
      label: 'izaw',
      uid: IZAW.uid,
      tenantId: TENANT_A,
    });
  });

  it('reports BOTH violation classes together rather than stopping at the first', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    database.seed(`clientMembers/${TENANT_A}/${HBOX.uid}`, { role: 'viewer', joinedAt: 3 });
    database.seed(`clientOwnedTenants/${MKLEO.uid}/${TENANT_B}`, true);

    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.violation).sort()).toEqual([
      'coach-tenant-member',
      'owns-managed-tenant',
    ]);
  });

  it('does NOT report ok when the coach tree is empty — the sweep would be vacuous', async () => {
    const database = new FakeDatabase();
    // No coachClients at all: the membership half checked nothing. Most often a
    // mistyped coach uid, which must never read as a clean pass.
    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.findings).toEqual([]);
    expect(result.vacuousMembershipSweep).toBe(true);
    expect(result.membershipReads).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('still catches an ownership link even when the coach tree is empty', async () => {
    const database = new FakeDatabase();
    database.seed(`clientOwnedTenants/${SPARG0.uid}/${TENANT_A}`, true);

    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ violation: 'owns-managed-tenant' });
  });

  it('a coaching-kind clientTenants row does NOT by itself constitute a finding', async () => {
    // Guards the corrected mechanism: the audit keys on the uid-keyed trees, not
    // on clientTenants (which is randomUUID-keyed and cannot hold a uid). A
    // coaching tenant merely existing is the normal state of the product.
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    database.seed(`clientTenants/${TENANT_A}`, { createdAt: 1, archivedAt: null });
    database.seed(`clientTenants/${TENANT_B}`, { createdAt: 2, archivedAt: null });

    const result = await auditAcctTopology(asDatabase(database), {
      coachUid: COACH_UID,
      subjects: FOUR,
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('rejects a malformed coach uid before constructing any ref', async () => {
    const database = new FakeDatabase();
    await expect(
      auditAcctTopology(asDatabase(database), { coachUid: 'bad/uid', subjects: FOUR }),
    ).rejects.toThrow(/path-safe/);
  });

  it('rejects a malformed subject uid before constructing any ref', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    await expect(
      auditAcctTopology(asDatabase(database), {
        coachUid: COACH_UID,
        subjects: [{ label: 'broken', uid: 'has.a.dot' }],
      }),
    ).rejects.toThrow(/path-safe/);
  });

  it('rejects an empty subject set rather than passing vacuously', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    await expect(
      auditAcctTopology(asDatabase(database), { coachUid: COACH_UID, subjects: [] }),
    ).rejects.toThrow(/audits nothing/);
  });

  it('writes nothing — the tree is byte-identical after a run', async () => {
    const database = new FakeDatabase();
    seedHealthyCoachTree(database);
    database.seed(`clientMembers/${TENANT_A}/${HBOX.uid}`, { role: 'viewer', joinedAt: 3 });
    const before = JSON.stringify(database.dump());

    await auditAcctTopology(asDatabase(database), { coachUid: COACH_UID, subjects: FOUR });

    expect(JSON.stringify(database.dump())).toBe(before);
  });
});
