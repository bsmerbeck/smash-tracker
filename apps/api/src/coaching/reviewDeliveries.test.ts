import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { NotFoundError } from '../services/rtdb.js';
import { autosaveDraft, publishReview, getLatestDeliveryState } from './reviews.js';
import {
  createReviewDelivery,
  listReviewDeliveries,
  revokeReviewDelivery,
} from './reviewDeliveries.js';

const TENANT_ID = 'tenant-1';
const COACH_UID = 'coach-1';
const SESSION_ID = 'session-1';
const WEB_BASE_URL = 'https://grandfinals.gg';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** Reads a raw stored `reviewDeliveries/{tenantId}/{reviewId}/{deliveryId}` record straight out of a `FakeDatabase.dump()`, without threading a brittle nested-cast expression through every test. */
function dumpDeliveryRecord(
  database: FakeDatabase,
  tenantId: string,
  reviewId: string,
  deliveryId: string,
): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const reviewDeliveries = dump.reviewDeliveries as
    Record<string, Record<string, Record<string, unknown>>> | undefined;
  return reviewDeliveries![tenantId]![reviewId]![deliveryId] as Record<string, unknown>;
}

/** Reads a raw stored `shareTokens/{token}` record straight out of a `FakeDatabase.dump()`. */
function dumpTokenRecord(database: FakeDatabase, token: string): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const shareTokens = dump.shareTokens as Record<string, Record<string, unknown>> | undefined;
  return shareTokens![token]!;
}

/** Publishes review-1 in a fresh database, returning it at version 1. */
async function seedPublishedReview(database: FakeDatabase): Promise<void> {
  await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
  await publishReview(asDatabase(database), TENANT_ID, 'review-1', {
    coachUid: COACH_UID,
    sessionId: SESSION_ID,
  });
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

describe('createReviewDelivery', () => {
  it('mints a delivery pinned to a published version, writing shareTokens + reviewDeliveries atomically', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);

    const result = await createReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      1,
      WEB_BASE_URL,
    );

    expect(result.url).toBe(`${WEB_BASE_URL}/r/${result.token}`);
    const tokenRecord = dumpTokenRecord(database, result.token);
    expect(tokenRecord.shareId).toBe(`review:${TENANT_ID}:review-1:1`);
    expect(tokenRecord.ownerUid).toBe(TENANT_ID);
    expect(tokenRecord.permissions).toBe('view');

    const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
    expect(deliveryRecord).toMatchObject({
      status: 'delivered',
      token: result.token,
      version: 1,
      revokedAt: null,
      ackAt: null,
      viewedAt: null,
    });
  });

  it('throws NotFoundError for a missing/unpublished version — never mints a token for a draft', async () => {
    const database = new FakeDatabase();
    await autosaveDraft(asDatabase(database), TENANT_ID, 'review-1', { sections: [] }, 0);
    // Never published — reviewVersions/.../1 does not exist.

    await expect(
      createReviewDelivery(asDatabase(database), TENANT_ID, 'review-1', 1, WEB_BASE_URL),
    ).rejects.toThrow(NotFoundError);

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.shareTokens).toBeUndefined();
    expect(dump.reviewDeliveries).toBeUndefined();
  });

  it('throws NotFoundError for a version number that was never sealed (e.g. version 2 when only 1 is published)', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);

    await expect(
      createReviewDelivery(asDatabase(database), TENANT_ID, 'review-1', 2, WEB_BASE_URL),
    ).rejects.toThrow(NotFoundError);
  });

  it('honors an optional expiresAt', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);
    const expiresAt = Date.now() + 1000;

    const result = await createReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      1,
      WEB_BASE_URL,
      { expiresAt },
    );

    const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
    expect(deliveryRecord.expiresAt).toBe(expiresAt);
  });

  it('keeps getLatestDeliveryState (12-03) working unchanged against the grown record shape', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);

    await createReviewDelivery(asDatabase(database), TENANT_ID, 'review-1', 1, WEB_BASE_URL);

    await expect(getLatestDeliveryState(asDatabase(database), TENANT_ID, 'review-1')).resolves.toBe(
      'delivered',
    );
  });

  describe('includedVods freeze (Phase 21, DLVX-02/DLVX-04)', () => {
    it('freezes an IncludedVod for each existing VOD-bearing match under the review tenant', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);
      seedMatch(database, TENANT_ID, 'match-1', {
        vodUrl: 'https://youtu.be/abc123',
        vodStartSeconds: 42,
        vodTimestamps: [{ seconds: 10, note: 'missed punish', tags: ['punish'] }],
      });

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      const includedVods = deliveryRecord.includedVods as Array<Record<string, unknown>>;
      expect(includedVods).toHaveLength(1);
      expect(includedVods[0]).toMatchObject({
        matchId: 'match-1',
        vodUrl: 'https://youtu.be/abc123',
        startSeconds: 42,
      });
      expect(includedVods[0]!.timestamps).toEqual([
        { seconds: 10, note: 'missed punish', tags: ['punish'] },
      ]);
    });

    it('silently drops a picked matchId that does not exist under the review tenant', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: ['no-such-match'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();
    });

    it('silently drops a picked matchId belonging to a DIFFERENT tenant (T-21-03, never throws/leaks)', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);
      seedMatch(database, 'other-tenant', 'match-1');

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();
    });

    it('silently drops a picked matchId whose match has no vodUrl', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);
      seedMatch(database, TENANT_ID, 'match-1', { vodUrl: undefined });

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();
    });

    it('skips a malformed/path-unsafe matchId before any ref() call (review WR-07)', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: ['../etc/passwd', 'a.b', 'a#b'] },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();
    });

    it('caps the frozen includedVods at MAX_DELIVERY_VODS', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);
      const matchIds = Array.from({ length: 15 }, (_, index) => `match-${index}`);
      for (const matchId of matchIds) {
        seedMatch(database, TENANT_ID, matchId);
      }

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: matchIds },
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      expect((deliveryRecord.includedVods as unknown[]).length).toBe(10);
    });

    it('a delivery created with zero resolvable picks writes NO includedVods key and reads back as an empty array via listReviewDeliveries', async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
      );

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      expect(deliveryRecord.includedVods).toBeUndefined();

      const rows = await listReviewDeliveries(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        WEB_BASE_URL,
      );
      expect(rows[0]!.includedVods).toEqual([]);
    });

    it("does NOT change a delivery's frozen includedVods when the source match is edited afterward (D-10 immutability)", async () => {
      const database = new FakeDatabase();
      await seedPublishedReview(database);
      seedMatch(database, TENANT_ID, 'match-1', {
        vodTimestamps: [{ seconds: 10, note: 'original note' }],
      });

      const result = await createReviewDelivery(
        asDatabase(database),
        TENANT_ID,
        'review-1',
        1,
        WEB_BASE_URL,
        { includedVodMatchIds: ['match-1'] },
      );

      // Edit the source match's notes AFTER the delivery was minted.
      seedMatch(database, TENANT_ID, 'match-1', {
        vodTimestamps: [{ seconds: 99, note: 'edited after delivery — must never surface' }],
      });

      const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', result.deliveryId);
      const includedVods = deliveryRecord.includedVods as Array<Record<string, unknown>>;
      expect(includedVods[0]!.timestamps).toEqual([{ seconds: 10, note: 'original note' }]);
    });
  });
});

describe('listReviewDeliveries', () => {
  it('returns an empty array when the review has no deliveries', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);

    await expect(
      listReviewDeliveries(asDatabase(database), TENANT_ID, 'review-1', WEB_BASE_URL),
    ).resolves.toEqual([]);
  });

  it('lists every delivery, most-recent-first, with a rebuildable url', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);
    const first = await createReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      1,
      WEB_BASE_URL,
    );
    const second = await createReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      1,
      WEB_BASE_URL,
    );

    const rows = await listReviewDeliveries(
      asDatabase(database),
      TENANT_ID,
      'review-1',
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
    await seedPublishedReview(database);
    database.seed(`reviewDeliveries/${TENANT_ID}/review-1/corrupt`, { garbage: true });
    await createReviewDelivery(asDatabase(database), TENANT_ID, 'review-1', 1, WEB_BASE_URL);

    const rows = await listReviewDeliveries(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      WEB_BASE_URL,
    );

    expect(rows).toHaveLength(1);
  });
});

describe('revokeReviewDelivery', () => {
  it('flips revokedAt + status on the delivery record AND shareTokens/{token}.revokedAt', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);
    const { deliveryId, token } = await createReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      1,
      WEB_BASE_URL,
    );

    const result = await revokeReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      deliveryId,
    );

    expect(result.revoked).toBe(true);
    const deliveryRecord = dumpDeliveryRecord(database, TENANT_ID, 'review-1', deliveryId);
    expect(deliveryRecord.status).toBe('revoked');
    expect(typeof deliveryRecord.revokedAt).toBe('number');
    const tokenRecord = dumpTokenRecord(database, token);
    expect(typeof tokenRecord.revokedAt).toBe('number');
  });

  it('is idempotent — a second revoke is a silent no-op (revoked: false), never re-stamps revokedAt', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);
    const { deliveryId } = await createReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      1,
      WEB_BASE_URL,
    );

    await revokeReviewDelivery(asDatabase(database), TENANT_ID, 'review-1', deliveryId);
    const firstRevokedAt = dumpDeliveryRecord(
      database,
      TENANT_ID,
      'review-1',
      deliveryId,
    ).revokedAt;

    const second = await revokeReviewDelivery(
      asDatabase(database),
      TENANT_ID,
      'review-1',
      deliveryId,
    );

    expect(second.revoked).toBe(false);
    const secondRevokedAt = dumpDeliveryRecord(
      database,
      TENANT_ID,
      'review-1',
      deliveryId,
    ).revokedAt;
    expect(secondRevokedAt).toBe(firstRevokedAt);
  });

  it('throws NotFoundError for an unknown deliveryId', async () => {
    const database = new FakeDatabase();
    await seedPublishedReview(database);

    await expect(
      revokeReviewDelivery(asDatabase(database), TENANT_ID, 'review-1', 'no-such-delivery'),
    ).rejects.toThrow(NotFoundError);
  });
});
