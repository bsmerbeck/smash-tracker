import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ConflictError, ForbiddenError } from '../services/rtdb.js';
import {
  archiveClient,
  CANONICAL_TENANT_TREES,
  createClient,
  deleteClient,
  exportClient,
  listClients,
  MAX_ACTIVE_CLIENTS_PER_COACH,
} from './tenants.js';

const COACH_UID = 'coach-uid-1';
const SESSION_ID = 'session-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function allLedgerRows(database: FakeDatabase): unknown[] {
  const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
  const days = dump.eventLedger ?? {};
  return Object.values(days).flatMap((day) => Object.values(day));
}

describe('createClient', () => {
  it('writes three sibling records with a fresh randomUUID tenantId and emits managed_client_created', async () => {
    const database = new FakeDatabase();

    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    await flushMacrotask();

    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tenantId).not.toContain(COACH_UID);

    const dump = database.dump() as Record<string, unknown>;
    expect(dump).toMatchObject({
      clientTenants: { [tenantId]: { archivedAt: null } },
      coachClients: { [COACH_UID]: { [tenantId]: { label: 'Alex', archivedAt: null } } },
      clientMembers: { [tenantId]: { [COACH_UID]: { role: 'custodian' } } },
    });

    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventName: 'managed_client_created',
      actorId: COACH_UID,
      causationId: tenantId,
      consentState: 'unknown',
      payload: {},
    });
  });

  // Phase 13 (ONBD-05, D-08): the coach-cause payload rides in `payload`,
  // never `causationId`, and only when the coach's saved intent is
  // coach_clients.
  it('stamps payload.onboardingCause=coach_clients when the coach saved that intent', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${COACH_UID}/onboardingIntent`, 'coach_clients');

    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    await flushMacrotask();

    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventName: 'managed_client_created',
      causationId: tenantId,
      payload: { onboardingCause: 'coach_clients' },
    });
  });

  it('does not stamp onboardingCause when the coach saved a different intent', async () => {
    const database = new FakeDatabase();
    database.seed(`users/${COACH_UID}/onboardingIntent`, 'scout');

    await createClient(asDatabase(database), COACH_UID, 'Alex', { sessionId: SESSION_ID });
    await flushMacrotask();

    const rows = allLedgerRows(database);
    expect(rows[0]).toMatchObject({ payload: {} });
  });

  it('rejects a duplicate label for the same coach with ConflictError (409)', async () => {
    const database = new FakeDatabase();

    await createClient(asDatabase(database), COACH_UID, 'Alex', { sessionId: SESSION_ID });

    await expect(
      createClient(asDatabase(database), COACH_UID, 'Alex', { sessionId: SESSION_ID }),
    ).rejects.toThrow(ConflictError);
  });

  it('treats labels as case-insensitive/whitespace-collapsed collisions', async () => {
    const database = new FakeDatabase();

    await createClient(asDatabase(database), COACH_UID, 'Alex  Jones', { sessionId: SESSION_ID });

    await expect(
      createClient(asDatabase(database), COACH_UID, '  alex JONES ', { sessionId: SESSION_ID }),
    ).rejects.toThrow(ConflictError);
  });

  it('allows two different coaches to use the identical label (uniqueness is per-coach)', async () => {
    const database = new FakeDatabase();

    await createClient(asDatabase(database), COACH_UID, 'Alex', { sessionId: SESSION_ID });

    await expect(
      createClient(asDatabase(database), 'coach-uid-2', 'Alex', { sessionId: SESSION_ID }),
    ).resolves.toBeDefined();
  });

  it('enforces the MAX_ACTIVE_CLIENTS_PER_COACH soft cap with ForbiddenError', async () => {
    const database = new FakeDatabase();

    for (let i = 0; i < MAX_ACTIVE_CLIENTS_PER_COACH; i += 1) {
      await createClient(asDatabase(database), COACH_UID, `Client ${i}`, {
        sessionId: SESSION_ID,
      });
    }

    await expect(
      createClient(asDatabase(database), COACH_UID, 'One too many', { sessionId: SESSION_ID }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('listClients', () => {
  it('returns an empty list for a coach with no clients', async () => {
    const database = new FakeDatabase();

    await expect(listClients(asDatabase(database), COACH_UID)).resolves.toEqual([]);
  });

  it('lists active clients as Client Hub rows, deriving lastActivityAt from the client match tree', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    database.seed(`matches/${tenantId}/m1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 1, name: 'Battlefield' },
      notes: '',
      matchType: 'online-friendly',
      win: true,
    });
    database.seed(`matches/${tenantId}/m2`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 1500,
      map: { id: 1, name: 'Battlefield' },
      notes: '',
      matchType: 'online-friendly',
      win: false,
    });

    const rows = await listClients(asDatabase(database), COACH_UID);

    expect(rows).toEqual([
      {
        clientId: tenantId,
        label: 'Alex',
        lastActivityAt: 1500,
        draftCount: 0,
        deliveryState: null,
        archivedAt: null,
        claimedAt: null,
        pendingInvitationExpiresAt: null,
      },
    ]);
  });

  // Phase 24 (CTRL-03): four badge states derivable from one listClients call.
  describe('claim-status projection', () => {
    it('reports claimedAt: null and pendingInvitationExpiresAt: null for a never-claimed, no-code client', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });

      const rows = await listClients(asDatabase(database), COACH_UID);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        clientId: tenantId,
        claimedAt: null,
        pendingInvitationExpiresAt: null,
      });
    });

    it('reports pendingInvitationExpiresAt equal to expiresAt for a live invitation', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });
      const digest = 'digest-live';
      const expiresAt = Date.now() + 1000 * 60 * 60;
      database.seed(`activeClaimInvitationByTenant/${tenantId}`, {
        digest,
        issuedAt: Date.now(),
      });
      database.seed(`claimInvitations/${digest}`, {
        tenantId,
        issuerUid: COACH_UID,
        createdAt: Date.now(),
        expiresAt,
      });

      const rows = await listClients(asDatabase(database), COACH_UID);

      expect(rows[0]).toMatchObject({ claimedAt: null, pendingInvitationExpiresAt: expiresAt });
    });

    it('reports pendingInvitationExpiresAt: null for an EXPIRED invitation', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });
      const digest = 'digest-expired';
      database.seed(`activeClaimInvitationByTenant/${tenantId}`, {
        digest,
        issuedAt: Date.now() - 1000,
      });
      database.seed(`claimInvitations/${digest}`, {
        tenantId,
        issuerUid: COACH_UID,
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() - 500,
      });

      const rows = await listClients(asDatabase(database), COACH_UID);

      expect(rows[0]).toMatchObject({ pendingInvitationExpiresAt: null });
    });

    it('reports pendingInvitationExpiresAt: null for a REVOKED invitation', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });
      const digest = 'digest-revoked';
      database.seed(`activeClaimInvitationByTenant/${tenantId}`, {
        digest,
        issuedAt: Date.now(),
      });
      database.seed(`claimInvitations/${digest}`, {
        tenantId,
        issuerUid: COACH_UID,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60,
        revokedAt: Date.now(),
      });

      const rows = await listClients(asDatabase(database), COACH_UID);

      expect(rows[0]).toMatchObject({ pendingInvitationExpiresAt: null });
    });

    it('reports claimedAt from the coachClients entry when claimed, with pendingInvitationExpiresAt null (pointer already nulled by the flip)', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });
      const claimedAt = Date.now();
      database.seed(`coachClients/${COACH_UID}/${tenantId}`, {
        label: 'Alex',
        createdAt: Date.now(),
        archivedAt: null,
        claimedAt,
      });

      const rows = await listClients(asDatabase(database), COACH_UID);

      expect(rows[0]).toMatchObject({ claimedAt, pendingInvitationExpiresAt: null });
    });

    it('reports pendingInvitationExpiresAt: null without throwing for a dangling pointer whose record is missing', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });
      database.seed(`activeClaimInvitationByTenant/${tenantId}`, {
        digest: 'digest-missing',
        issuedAt: Date.now(),
      });
      // No claimInvitations/{digest} record seeded — dangling pointer.

      await expect(listClients(asDatabase(database), COACH_UID)).resolves.toBeDefined();
      const rows = await listClients(asDatabase(database), COACH_UID);
      expect(rows[0]).toMatchObject({ pendingInvitationExpiresAt: null });
    });

    it('reports pendingInvitationExpiresAt: null without throwing for an unparseable pointer', async () => {
      const database = new FakeDatabase();
      const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
        sessionId: SESSION_ID,
      });
      database.seed(`activeClaimInvitationByTenant/${tenantId}`, { notAPointer: true });

      const rows = await listClients(asDatabase(database), COACH_UID);

      expect(rows[0]).toMatchObject({ pendingInvitationExpiresAt: null });
    });
  });

  it('hides archived clients from the default listing', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });

    await archiveClient(asDatabase(database), COACH_UID, tenantId);

    await expect(listClients(asDatabase(database), COACH_UID)).resolves.toEqual([]);
  });

  it('restores an archived client back into the default listing when archived=false', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    await archiveClient(asDatabase(database), COACH_UID, tenantId);

    await archiveClient(asDatabase(database), COACH_UID, tenantId, false);

    const rows = await listClients(asDatabase(database), COACH_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.archivedAt).toBeNull();
  });

  // 260725-juj: defense-in-depth — one tenant's corrupt/unparseable
  // reviewStatus subtree must degrade that one row, never 500 the whole hub.
  it('260725-juj: degrades a single poisoned tenant to a minimal row instead of rejecting the whole list', async () => {
    const database = new FakeDatabase();
    const { tenantId: goodTenant } = await createClient(asDatabase(database), COACH_UID, 'Good', {
      sessionId: SESSION_ID,
    });
    const { tenantId: badTenant } = await createClient(asDatabase(database), COACH_UID, 'Bad', {
      sessionId: SESSION_ID,
    });
    // A reviewDrafts entry is required so countOpenDrafts actually reads the
    // deliberately unparseable reviewStatus record seeded below.
    database.seed(`reviewDrafts/${badTenant}/review-1`, {
      revision: 1,
      sections: [],
      coachPrivateNotes: null,
      createdAt: 0,
      lastAutosavedAt: 0,
    });
    database.seed(`reviewStatus/${badTenant}/review-1`, { status: 'not-a-real-status' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rows = await listClients(asDatabase(database), COACH_UID);

    expect(rows).toHaveLength(2);
    const goodRow = rows.find((row) => row.clientId === goodTenant);
    const badRow = rows.find((row) => row.clientId === badTenant);
    expect(goodRow).toMatchObject({ label: 'Good', draftCount: 0, deliveryState: null });
    expect(badRow).toMatchObject({
      label: 'Bad',
      draftCount: 0,
      deliveryState: null,
      lastActivityAt: null,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('archiveClient', () => {
  it('throws ForbiddenError when the caller has no membership record', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });

    await expect(archiveClient(asDatabase(database), 'foreign-coach', tenantId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('deleteClient', () => {
  it('cascades a null-delete across every CANONICAL_TENANT_TREES entry plus tenant/index/membership records', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    for (const tree of CANONICAL_TENANT_TREES) {
      database.seed(`${tree}/${tenantId}`, { seeded: true });
    }

    await deleteClient(asDatabase(database), COACH_UID, tenantId);

    const dump = database.dump() as Record<string, unknown>;
    for (const tree of CANONICAL_TENANT_TREES) {
      expect((dump[tree] as Record<string, unknown> | undefined)?.[tenantId]).toBeUndefined();
    }
    expect((dump.clientTenants as Record<string, unknown> | undefined)?.[tenantId]).toBeUndefined();
    expect(
      (dump.coachClients as Record<string, unknown> | undefined)?.[COACH_UID],
    ).not.toHaveProperty(tenantId);
    expect((dump.clientMembers as Record<string, unknown> | undefined)?.[tenantId]).toBeUndefined();
  });

  it('throws ForbiddenError when the caller has no membership record', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });

    await expect(deleteClient(asDatabase(database), 'foreign-coach', tenantId)).rejects.toThrow(
      ForbiddenError,
    );
  });

  // Quick 260726-r7 (P0 regression): flipTenantOwnership's 7th path,
  // `clientOwnedTenants/{clientUid}/{tenantId}`, is client-keyed and was
  // never reached by CANONICAL_TENANT_TREES — this is the test that would
  // have caught it.
  it('removes the owner clientOwnedTenants row when deleting a claimed tenant (260726-r7 regression)', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    const CLIENT_UID = 'client-uid-1';
    // Mirrors flipTenantOwnership's writes without invoking the redemption
    // module, keeping this test scoped to the cascade's own behavior.
    database.seed(`clientMembers/${tenantId}/${CLIENT_UID}`, { role: 'owner', joinedAt: 1 });
    database.seed(`clientMembers/${tenantId}/${COACH_UID}`, { role: 'delegate', joinedAt: 1 });
    database.seed(`clientTenants/${tenantId}/ownerUid`, CLIENT_UID);
    database.seed(`clientTenants/${tenantId}/claimedAt`, 1);
    database.seed(`coachClients/${COACH_UID}/${tenantId}/claimedAt`, 1);
    database.seed(`clientOwnedTenants/${CLIENT_UID}/${tenantId}`, { label: 'Alex', claimedAt: 1 });

    // Post-claim, only the owner (or a custodian, which no longer applies)
    // can hard-delete — the delegate coach's role no longer qualifies.
    await deleteClient(asDatabase(database), CLIENT_UID, tenantId);

    const dump = database.dump() as Record<string, unknown>;
    expect(
      (dump.clientOwnedTenants as Record<string, Record<string, unknown>> | undefined)?.[
        CLIENT_UID
      ]?.[tenantId],
    ).toBeUndefined();
    expect((dump.clientMembers as Record<string, unknown> | undefined)?.[tenantId]).toBeUndefined();
  });

  it('deletes an unclaimed (never-claimed) client without error and touches no clientOwnedTenants row', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });

    await expect(deleteClient(asDatabase(database), COACH_UID, tenantId)).resolves.toBeUndefined();

    const dump = database.dump() as Record<string, unknown>;
    // No owner membership ever existed, so the (owner-uid-resolution) step
    // must be a pure no-op — no clientOwnedTenants tree is created at all.
    expect(dump.clientOwnedTenants).toBeUndefined();
  });
});

describe('exportClient', () => {
  it('assembles a JSON workspace dump from the client tenant trees', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });
    database.seed(`matches/${tenantId}/m1`, {
      fighter_id: 1,
      opponent_id: 2,
      time: 500,
      map: { id: 1, name: 'Battlefield' },
      notes: '',
      matchType: 'online-friendly',
      win: true,
    });

    const dump = await exportClient(asDatabase(database), COACH_UID, tenantId);

    expect(dump.clientId).toBe(tenantId);
    expect(dump.label).toBe('Alex');
    expect(typeof dump.exportedAt).toBe('number');
    expect(dump.matches).toHaveLength(1);
    expect(dump.matches[0]).toMatchObject({ id: 'm1', time: 500 });
    expect(dump.playlists).toEqual([]);
    expect(dump.opponents).toEqual([]);
    expect(dump.opponentAliases).toEqual({});
    expect(dump.opponentNotes).toEqual({});
    expect(dump.fighterSelection).toEqual({ primary: [], secondary: [] });
  });

  it('throws ForbiddenError when the caller has no membership record', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), COACH_UID, 'Alex', {
      sessionId: SESSION_ID,
    });

    await expect(exportClient(asDatabase(database), 'foreign-coach', tenantId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
