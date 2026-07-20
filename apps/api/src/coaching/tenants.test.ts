import { describe, expect, it } from 'vitest';
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
      },
    ]);
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
