import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { NotFoundError } from '../services/rtdb.js';
import { createSession, updateSession } from './sessions.js';
import { deleteClient, createClient, CANONICAL_TENANT_TREES } from './tenants.js';
import {
  createSessionDelivery,
  listSessionDeliveries,
  readHomeworkProgress,
  revokeSessionDelivery,
  setHomeworkItemDone,
  setHomeworkStatus,
} from './sessionDeliveries.js';

const TENANT_ID = 'tenant-1';
const WEB_BASE_URL = 'https://grandfinals.gg';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** Reads a raw stored `sessionDeliveries/{tenantId}/{sessionId}/{deliveryId}` record straight out of a `FakeDatabase.dump()`. */
function dumpDeliveryRecord(
  database: FakeDatabase,
  tenantId: string,
  sessionId: string,
  deliveryId: string,
): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const sessionDeliveries = dump.sessionDeliveries as
    Record<string, Record<string, Record<string, unknown>>> | undefined;
  return sessionDeliveries![tenantId]![sessionId]![deliveryId] as Record<string, unknown>;
}

/** Reads a raw stored `shareTokens/{token}` record straight out of a `FakeDatabase.dump()`. */
function dumpTokenRecord(database: FakeDatabase, token: string): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const shareTokens = dump.shareTokens as Record<string, Record<string, unknown>> | undefined;
  return shareTokens![token]!;
}

async function seedSession(database: FakeDatabase): Promise<string> {
  const { sessionId } = await createSession(asDatabase(database), TENANT_ID, {
    date: 1_700_000_000_000,
    characterTags: [1, 2],
    summary: 'Great session on neutral game',
    homework: [{ text: 'Practice OOS options', done: false }],
    coachPrivateNotes: 'Client struggles with shield pressure',
  });
  return sessionId;
}

/** Seeds a minimal `matches/{tenantId}/{matchId}` record — a VOD-bearing match by default. */
function seedMatch(
  database: FakeDatabase,
  tenantId: string,
  matchId: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`matches/${tenantId}/${matchId}`, {
    fighter_id: 1,
    opponent_id: 2,
    time: 1_700_000_000_000,
    win: true,
    vodUrl: 'https://youtu.be/abc123',
    ...overrides,
  });
}

describe('createSessionDelivery', () => {
  it('embeds a FROZEN client-visible snapshot and writes shareTokens + sessionDeliveries atomically', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);

    const result = await createSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    expect(result.url).toBe(`${WEB_BASE_URL}/r/${result.token}`);
    const tokenRecord = dumpTokenRecord(database, result.token);
    expect(tokenRecord.shareId).toBe(`session:${TENANT_ID}:${sessionId}:${result.deliveryId}`);
    expect(tokenRecord.ownerUid).toBe(TENANT_ID);
    expect(tokenRecord.permissions).toBe('view');

    const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, result.deliveryId);
    expect(deliveryRecord).toMatchObject({
      status: 'delivered',
      token: result.token,
      revokedAt: null,
    });
    const snapshot = deliveryRecord.snapshot as Record<string, unknown>;
    expect(snapshot.summary).toBe('Great session on neutral game');
    expect(snapshot.characterTags).toEqual([1, 2]);
    expect(snapshot.homework).toEqual([{ text: 'Practice OOS options', done: false }]);
    // coachPrivateNotes must be structurally absent from the embedded snapshot.
    expect(snapshot).not.toHaveProperty('coachPrivateNotes');
  });

  it('does NOT change the delivered snapshot when the live session is edited afterward (D-10 immutability)', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);
    const { deliveryId } = await createSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    await updateSession(asDatabase(database), TENANT_ID, sessionId, {
      summary: 'Edited after delivery — recipient must never see this',
      characterTags: [9],
    });

    const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
    const snapshot = deliveryRecord.snapshot as Record<string, unknown>;
    expect(snapshot.summary).toBe('Great session on neutral game');
    expect(snapshot.characterTags).toEqual([1, 2]);
  });

  it('throws NotFoundError for a missing session — never mints a token for a nonexistent session', async () => {
    const database = new FakeDatabase();

    await expect(
      createSessionDelivery(asDatabase(database), TENANT_ID, 'no-such-session', WEB_BASE_URL),
    ).rejects.toThrow(NotFoundError);

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.shareTokens).toBeUndefined();
    expect(dump.sessionDeliveries).toBeUndefined();
  });

  describe('includedVods freeze (Phase 21, DLVX-02/DLVX-04)', () => {
    it('freezes includedVods the identical way as a review delivery, under the session tenant', async () => {
      const database = new FakeDatabase();
      const sessionId = await seedSession(database);
      seedMatch(database, TENANT_ID, 'match-1', {
        vodUrl: 'https://youtu.be/abc123',
        vodStartSeconds: 42,
        vodTimestamps: [{ seconds: 10, note: 'missed punish' }],
      });

      const { deliveryId } = await createSessionDelivery(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
      const includedVods = deliveryRecord.includedVods as Array<Record<string, unknown>>;
      expect(includedVods).toHaveLength(1);
      expect(includedVods[0]).toMatchObject({
        matchId: 'match-1',
        vodUrl: 'https://youtu.be/abc123',
        startSeconds: 42,
      });
    });

    it('silently drops a picked matchId belonging to a DIFFERENT tenant (T-21-03)', async () => {
      const database = new FakeDatabase();
      const sessionId = await seedSession(database);
      seedMatch(database, 'other-tenant', 'match-1');

      const { deliveryId } = await createSessionDelivery(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();
    });

    it('silently drops a picked matchId whose match has no vodUrl', async () => {
      const database = new FakeDatabase();
      const sessionId = await seedSession(database);
      seedMatch(database, TENANT_ID, 'match-1', { vodUrl: undefined });

      const { deliveryId } = await createSessionDelivery(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();
    });

    it('a delivery created with zero resolvable picks writes NO includedVods key and reads back as an empty array via listSessionDeliveries', async () => {
      const database = new FakeDatabase();
      const sessionId = await seedSession(database);

      const { deliveryId } = await createSessionDelivery(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();

      const rows = await listSessionDeliveries(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
      );
      expect(rows[0]!.includedVods).toEqual([]);
    });

    it('caps the frozen includedVods at MAX_DELIVERY_VODS', async () => {
      const database = new FakeDatabase();
      const sessionId = await seedSession(database);
      const matchIds = Array.from({ length: 15 }, (_, index) => `match-${index}`);
      for (const matchId of matchIds) {
        seedMatch(database, TENANT_ID, matchId);
      }

      const { deliveryId } = await createSessionDelivery(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
        { includedVodMatchIds: matchIds },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
      expect((deliveryRecord.includedVods as unknown[]).length).toBe(10);
    });

    it("does NOT change a delivery's frozen includedVods when the source match is edited afterward (D-10 immutability)", async () => {
      const database = new FakeDatabase();
      const sessionId = await seedSession(database);
      seedMatch(database, TENANT_ID, 'match-1', {
        vodTimestamps: [{ seconds: 10, note: 'original note' }],
      });

      const { deliveryId } = await createSessionDelivery(
        asDatabase(database),
        TENANT_ID,
        sessionId,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      seedMatch(database, TENANT_ID, 'match-1', {
        vodTimestamps: [{ seconds: 99, note: 'edited after delivery — must never surface' }],
      });

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
      const includedVods = deliveryRecord.includedVods as Array<Record<string, unknown>>;
      expect(includedVods[0]!.timestamps).toEqual([{ seconds: 10, note: 'original note' }]);
    });
  });
});

describe('listSessionDeliveries', () => {
  it('returns an empty array when the session has no deliveries', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);

    await expect(
      listSessionDeliveries(asDatabase(database), TENANT_ID, sessionId, WEB_BASE_URL),
    ).resolves.toEqual([]);
  });

  it('lists every delivery, most-recent-first, with a rebuildable url', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);
    const first = await createSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );
    const second = await createSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    const rows = await listSessionDeliveries(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.deliveryId).sort()).toEqual(
      [first.deliveryId, second.deliveryId].sort(),
    );
    for (const row of rows) {
      expect(row.url).toBe(`${WEB_BASE_URL}/r/${row.token}`);
    }
  });

  it('skips a corrupt record instead of breaking the whole list', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);
    database.seed(`sessionDeliveries/${TENANT_ID}/${sessionId}/corrupt`, { garbage: true });
    await createSessionDelivery(asDatabase(database), TENANT_ID, sessionId, WEB_BASE_URL);

    const rows = await listSessionDeliveries(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    expect(rows).toHaveLength(1);
  });
});

describe('revokeSessionDelivery', () => {
  it('flips revokedAt + status on the delivery record AND shareTokens/{token}.revokedAt', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);
    const { deliveryId, token } = await createSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    const result = await revokeSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
    );

    expect(result.revoked).toBe(true);
    const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
    expect(deliveryRecord.status).toBe('revoked');
    expect(typeof deliveryRecord.revokedAt).toBe('number');
    const tokenRecord = dumpTokenRecord(database, token);
    expect(typeof tokenRecord.revokedAt).toBe('number');
  });

  it('is idempotent — a second revoke is a silent no-op (revoked: false), never re-stamps revokedAt', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);
    const { deliveryId } = await createSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    await revokeSessionDelivery(asDatabase(database), TENANT_ID, sessionId, deliveryId);
    const firstRevokedAt = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId).revokedAt;

    const second = await revokeSessionDelivery(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
    );

    expect(second.revoked).toBe(false);
    const secondRevokedAt = dumpDeliveryRecord(
      database,
      TENANT_ID,
      sessionId,
      deliveryId,
    ).revokedAt;
    expect(secondRevokedAt).toBe(firstRevokedAt);
  });

  it('throws NotFoundError for an unknown deliveryId', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);

    await expect(
      revokeSessionDelivery(asDatabase(database), TENANT_ID, sessionId, 'no-such-delivery'),
    ).rejects.toThrow(NotFoundError);
  });
});

/**
 * 260731-b1 (client-interactive session-delivery homework): seeds a session
 * with a THREE-item homework checklist (indexes 0/2 frozen done, index 1
 * frozen not-done) and mints a delivery — the fixture every homework test
 * below builds on.
 */
async function seedSessionWithHomework(database: FakeDatabase): Promise<{
  sessionId: string;
  deliveryId: string;
  token: string;
}> {
  const { sessionId } = await createSession(asDatabase(database), TENANT_ID, {
    date: 1_700_000_000_000,
    summary: 'Session with homework',
    homework: [
      { text: 'Practice OOS options', done: true },
      { text: 'Fix roll habit', done: false },
      { text: 'Watch VOD review', done: true },
    ],
  });
  const { deliveryId, token } = await createSessionDelivery(
    asDatabase(database),
    TENANT_ID,
    sessionId,
    WEB_BASE_URL,
  );
  return { sessionId, deliveryId, token };
}

describe('readHomeworkProgress', () => {
  it('an untouched delivery reads back with doneIndexes from the frozen done state and null stamps', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const progress = await readHomeworkProgress(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
    );

    expect(progress).toEqual({ doneIndexes: [0, 2], acknowledgedAt: null, submittedAt: null });
  });

  it('returns null for a missing delivery, never throws', async () => {
    const database = new FakeDatabase();
    const sessionId = await seedSession(database);

    await expect(
      readHomeworkProgress(asDatabase(database), TENANT_ID, sessionId, 'no-such-delivery'),
    ).resolves.toBeNull();
  });

  it('returns null for a revoked delivery', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);
    await revokeSessionDelivery(asDatabase(database), TENANT_ID, sessionId, deliveryId);

    await expect(
      readHomeworkProgress(asDatabase(database), TENANT_ID, sessionId, deliveryId),
    ).resolves.toBeNull();
  });
});

describe('setHomeworkItemDone', () => {
  it('toggling an item overrides the frozen done state and persists', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const result = await setHomeworkItemDone(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      1,
      true,
    );

    expect(result).toEqual({ doneIndexes: [0, 1, 2], acknowledgedAt: null, submittedAt: null });
    const stored = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
    const homeworkProgress = stored.homeworkProgress as Record<string, unknown>;
    expect(homeworkProgress.items).toEqual({ h1: true });
    expect(typeof homeworkProgress.updatedAt).toBe('number');
  });

  it('an explicit false uncheck persists as a literal false, never a stripped null', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const result = await setHomeworkItemDone(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      0,
      false,
    );

    expect(result).toEqual({ doneIndexes: [2], acknowledgedAt: null, submittedAt: null });
    const stored = dumpDeliveryRecord(database, TENANT_ID, sessionId, deliveryId);
    const homeworkProgress = stored.homeworkProgress as Record<string, unknown>;
    expect((homeworkProgress.items as Record<string, unknown>).h0).toBe(false);
  });

  it('returns null for an out-of-range index, never crashes', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    await expect(
      setHomeworkItemDone(asDatabase(database), TENANT_ID, sessionId, deliveryId, 99, true),
    ).resolves.toBeNull();
    await expect(
      setHomeworkItemDone(asDatabase(database), TENANT_ID, sessionId, deliveryId, -1, true),
    ).resolves.toBeNull();
  });

  it('returns null for a missing or revoked delivery', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);
    await revokeSessionDelivery(asDatabase(database), TENANT_ID, sessionId, deliveryId);

    await expect(
      setHomeworkItemDone(asDatabase(database), TENANT_ID, sessionId, deliveryId, 0, true),
    ).resolves.toBeNull();
    await expect(
      setHomeworkItemDone(asDatabase(database), TENANT_ID, sessionId, 'no-such-delivery', 0, true),
    ).resolves.toBeNull();
  });

  it('multiple toggles accumulate without clobbering earlier entries', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    await setHomeworkItemDone(asDatabase(database), TENANT_ID, sessionId, deliveryId, 1, true);
    const result = await setHomeworkItemDone(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      0,
      false,
    );

    expect(result).toEqual({ doneIndexes: [1, 2], acknowledgedAt: null, submittedAt: null });
  });
});

describe('setHomeworkStatus', () => {
  it("'acknowledged' stamps acknowledgedAt once; a second call is a no-op that still returns the same stamp", async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const first = await setHomeworkStatus(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      'acknowledged',
    );
    expect(typeof first?.acknowledgedAt).toBe('number');
    expect(first?.submittedAt).toBeNull();

    const second = await setHomeworkStatus(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      'acknowledged',
    );
    expect(second?.acknowledgedAt).toBe(first?.acknowledgedAt);
  });

  it("'submitted' stamps submittedAt and back-fills an absent acknowledgedAt", async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const result = await setHomeworkStatus(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      'submitted',
    );

    expect(typeof result?.submittedAt).toBe('number');
    expect(typeof result?.acknowledgedAt).toBe('number');
  });

  it("'submitted' after an existing 'acknowledged' preserves the original acknowledgedAt", async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const acked = await setHomeworkStatus(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      'acknowledged',
    );
    const submitted = await setHomeworkStatus(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      'submitted',
    );

    expect(submitted?.acknowledgedAt).toBe(acked?.acknowledgedAt);
  });

  it('a later item toggle still succeeds after submission — submitting does not lock the list (F6)', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    await setHomeworkStatus(asDatabase(database), TENANT_ID, sessionId, deliveryId, 'submitted');
    const result = await setHomeworkItemDone(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
      1,
      true,
    );

    expect(result?.doneIndexes).toEqual([0, 1, 2]);
  });

  it('returns null for a missing or revoked delivery', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);
    await revokeSessionDelivery(asDatabase(database), TENANT_ID, sessionId, deliveryId);

    await expect(
      setHomeworkStatus(asDatabase(database), TENANT_ID, sessionId, deliveryId, 'acknowledged'),
    ).resolves.toBeNull();
  });
});

describe('listSessionDeliveries homework fields (260731-b1)', () => {
  it('carries homeworkDoneCount/homeworkTotal matching resolveHomeworkDoneIndexes, and null stamps for an untouched delivery', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    const rows = await listSessionDeliveries(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );

    const row = rows.find((r) => r.deliveryId === deliveryId)!;
    expect(row.homeworkDoneCount).toBe(2);
    expect(row.homeworkTotal).toBe(3);
    expect(row.homeworkAcknowledgedAt).toBeNull();
    expect(row.homeworkSubmittedAt).toBeNull();
  });

  it("the coach list's homeworkDoneCount matches the anonymous snapshot's doneIndexes length after a client toggle", async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);

    await setHomeworkItemDone(asDatabase(database), TENANT_ID, sessionId, deliveryId, 1, true);

    const rows = await listSessionDeliveries(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );
    const row = rows.find((r) => r.deliveryId === deliveryId)!;
    const progress = await readHomeworkProgress(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      deliveryId,
    );

    expect(row.homeworkDoneCount).toBe(progress!.doneIndexes.length);
    expect(row.homeworkDoneCount).toBe(3);
  });

  it('carries the stamps once set', async () => {
    const database = new FakeDatabase();
    const { sessionId, deliveryId } = await seedSessionWithHomework(database);
    await setHomeworkStatus(asDatabase(database), TENANT_ID, sessionId, deliveryId, 'submitted');

    const rows = await listSessionDeliveries(
      asDatabase(database),
      TENANT_ID,
      sessionId,
      WEB_BASE_URL,
    );
    const row = rows.find((r) => r.deliveryId === deliveryId)!;
    expect(typeof row.homeworkAcknowledgedAt).toBe('number');
    expect(typeof row.homeworkSubmittedAt).toBe('number');
  });
});

describe('deleteClient session-delivery shareTokens cascade (T-20-11)', () => {
  it('nulls the root-level shareTokens/{token} for every session delivery under the deleted tenant', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), 'coach-1', 'Client A', {
      sessionId: 'session-x',
    });
    const { sessionId } = await createSession(asDatabase(database), tenantId, {
      date: 1_700_000_000_000,
      summary: 'Session for deletion test',
    });
    const { token } = await createSessionDelivery(
      asDatabase(database),
      tenantId,
      sessionId,
      WEB_BASE_URL,
    );
    expect(dumpTokenRecord(database, token)).toBeDefined();

    await deleteClient(asDatabase(database), 'coach-1', tenantId, null);

    const dump = database.dump() as Record<string, unknown>;
    const shareTokens = dump.shareTokens as Record<string, unknown> | undefined;
    expect(shareTokens?.[token]).toBeUndefined();
    for (const tree of CANONICAL_TENANT_TREES) {
      expect((dump[tree] as Record<string, unknown> | undefined)?.[tenantId]).toBeUndefined();
    }
  });

  it('is a harmless no-op when the tenant has no session deliveries', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClient(asDatabase(database), 'coach-1', 'Client B', {
      sessionId: 'session-x',
    });

    await expect(
      deleteClient(asDatabase(database), 'coach-1', tenantId, null),
    ).resolves.not.toThrow();
  });
});
