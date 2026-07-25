import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { hashClaimCode, normalizeClaimCode } from './crypto.js';
import {
  checkAndIncrement,
  claimRedemptionAccountPath,
  claimRedemptionIpPath,
  CLAIM_REDEMPTION_PER_ACCOUNT_HOURLY_LIMIT,
} from './rateLimits.js';
import {
  consumeClaimInvitation,
  flipTenantOwnership,
  floorDelay,
  redeemClaimCode,
} from './redemption.js';

const HMAC_SECRET = 'test-claim-secret';
const TENANT_ID = 'tenant-1';
const COACH_UID = 'coach-1';
const CLIENT_UID = 'client-1';
const OTHER_UID = 'other-client';
const SESSION_ID = 'session-1';
const CLIENT_IP = '203.0.113.7';

/**
 * D-class emission (`void createEvent(...)`) is intentionally fire-and-forget
 * — callers never await it. Flush the microtask/macrotask queue before
 * asserting on `eventLedger`, mirroring `apps/api/src/billing/credits.test.ts`.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function eventLedgerEntries(database: FakeDatabase, eventName: string) {
  const dump = database.dump() as Record<string, unknown>;
  const ledgerByDay = dump.eventLedger as Record<string, Record<string, unknown>> | undefined;
  if (!ledgerByDay) return [];
  return Object.values(ledgerByDay).flatMap((dayEntries) =>
    Object.values(dayEntries).filter(
      (entry) => (entry as { eventName?: string }).eventName === eventName,
    ),
  );
}

function digestFor(code: string): string {
  return hashClaimCode(HMAC_SECRET, normalizeClaimCode(code));
}

function seedInvitation(
  database: FakeDatabase,
  digest: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`claimInvitations/${digest}`, {
    tenantId: TENANT_ID,
    issuerUid: COACH_UID,
    createdAt: 1,
    expiresAt: Date.now() + 1000 * 60 * 60,
    ...overrides,
  });
}

interface CallCounts {
  transaction: number;
  get: number;
}

/**
 * Wraps a FakeDatabase so `.transaction()`/`.get()` calls against any
 * returned reference are counted — the primary CI assertion behind the
 * no-oracle structural property (identical RTDB call shape across every
 * failure class).
 */
function wrapWithCounts(database: FakeDatabase): { database: FakeDatabase; counts: CallCounts } {
  const counts: CallCounts = { transaction: 0, get: 0 };
  const wrapped = {
    ref: (path?: string) => {
      const ref = database.ref(path);
      return {
        ...ref,
        get: async () => {
          counts.get += 1;
          return ref.get();
        },
        transaction: async (updateFn: (current: unknown) => unknown) => {
          counts.transaction += 1;
          return ref.transaction(updateFn);
        },
      };
    },
  };
  return { database: wrapped as unknown as FakeDatabase, counts };
}

describe('consumeClaimInvitation', () => {
  it('a fresh unexpired/unrevoked/unconsumed invitation yields outcome fresh, captures tenantId/issuerUid, and stamps consumedAt/consumedByUid', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('SOME-CODE');
    seedInvitation(database, digest);

    const result = await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    expect(result.outcome).toBe('fresh');
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.issuerUid).toBe(COACH_UID);

    const stored = (await database.ref(`claimInvitations/${digest}`).get()).val() as Record<
      string,
      unknown
    >;
    expect(stored.consumedByUid).toBe(CLIENT_UID);
    expect(stored.consumedAt).toBeTypeOf('number');
  });

  it('re-running consumption with the SAME uid on the now-consumed record yields replay-same-client and does not rewrite consumedAt', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('SOME-CODE-2');
    seedInvitation(database, digest);

    const first = await consumeClaimInvitation(database as never, digest, CLIENT_UID);
    expect(first.outcome).toBe('fresh');
    const consumedAtAfterFirst = (
      (await database.ref(`claimInvitations/${digest}`).get()).val() as Record<string, unknown>
    ).consumedAt;

    const second = await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    expect(second.outcome).toBe('replay-same-client');
    expect(second.tenantId).toBe(TENANT_ID);
    expect(second.issuerUid).toBe(COACH_UID);
    const consumedAtAfterSecond = (
      (await database.ref(`claimInvitations/${digest}`).get()).val() as Record<string, unknown>
    ).consumedAt;
    expect(consumedAtAfterSecond).toBe(consumedAtAfterFirst);
  });

  it('re-running consumption with a DIFFERENT uid on the consumed record yields ineligible', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('SOME-CODE-3');
    seedInvitation(database, digest);
    await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    const result = await consumeClaimInvitation(database as never, digest, OTHER_UID);

    expect(result).toEqual({ outcome: 'ineligible', tenantId: null, issuerUid: null });
  });

  it('an expired invitation yields ineligible', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('EXPIRED-CODE');
    seedInvitation(database, digest, { expiresAt: Date.now() - 1000 });

    const result = await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    expect(result).toEqual({ outcome: 'ineligible', tenantId: null, issuerUid: null });
  });

  it('a revoked invitation yields ineligible', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('REVOKED-CODE');
    seedInvitation(database, digest, { revokedAt: Date.now() - 1000 });

    const result = await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    expect(result).toEqual({ outcome: 'ineligible', tenantId: null, issuerUid: null });
  });

  it('a digest with no record at all yields ineligible', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('NEVER-ISSUED');

    const result = await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    expect(result).toEqual({ outcome: 'ineligible', tenantId: null, issuerUid: null });
  });

  it('a corrupt (schema-failing) record yields ineligible', async () => {
    const database = new FakeDatabase();
    const digest = digestFor('CORRUPT-CODE');
    database.seed(`claimInvitations/${digest}`, { tenantId: TENANT_ID }); // missing required fields

    const result = await consumeClaimInvitation(database as never, digest, CLIENT_UID);

    expect(result).toEqual({ outcome: 'ineligible', tenantId: null, issuerUid: null });
  });

  it('the number of .transaction() and .get() calls is identical across all five ineligible classes', async () => {
    const cases: Array<{ name: string; setup: (db: FakeDatabase, digest: string) => void }> = [
      {
        name: 'expired',
        setup: (db, digest) => seedInvitation(db, digest, { expiresAt: Date.now() - 1000 }),
      },
      {
        name: 'revoked',
        setup: (db, digest) => seedInvitation(db, digest, { revokedAt: Date.now() - 1000 }),
      },
      {
        name: 'consumed-by-other',
        setup: (db, digest) =>
          seedInvitation(db, digest, { consumedAt: Date.now() - 1000, consumedByUid: OTHER_UID }),
      },
      { name: 'never-issued', setup: () => {} },
      {
        name: 'corrupt',
        setup: (db, digest) => db.seed(`claimInvitations/${digest}`, { tenantId: TENANT_ID }),
      },
    ];

    const observedCounts: CallCounts[] = [];
    for (const testCase of cases) {
      const database = new FakeDatabase();
      const digest = digestFor(`CODE-${testCase.name}`);
      testCase.setup(database, digest);
      const { database: counted, counts } = wrapWithCounts(database);

      const result = await consumeClaimInvitation(counted as never, digest, CLIENT_UID);
      expect(result.outcome).toBe('ineligible');
      observedCounts.push({ ...counts });
    }

    const [first, ...rest] = observedCounts;
    for (const counts of rest) {
      expect(counts).toEqual(first);
    }
  });
});

describe('flipTenantOwnership', () => {
  it("sets clientMembers/{tenantId}/{clientUid} to owner, demotes the coach's role to delegate while preserving joinedAt, updates clientTenants/coachClients, and clears the active pointer", async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, {
      role: 'custodian',
      joinedAt: 12345,
    });
    database.seed(`activeClaimInvitationByTenant/${TENANT_ID}`, { digest: 'abc', issuedAt: 1 });
    const now = Date.now();

    await flipTenantOwnership(database as never, {
      tenantId: TENANT_ID,
      clientUid: CLIENT_UID,
      coachUid: COACH_UID,
      now,
    });

    const dump = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    expect(dump.clientMembers?.[TENANT_ID]?.[CLIENT_UID]).toEqual({ role: 'owner', joinedAt: now });
    expect(dump.clientMembers?.[TENANT_ID]?.[COACH_UID]).toEqual({
      role: 'delegate',
      joinedAt: 12345,
    });
    expect(
      (dump.clientTenants as unknown as Record<string, Record<string, unknown>>)[TENANT_ID],
    ).toMatchObject({
      ownerUid: CLIENT_UID,
      claimedAt: now,
    });
    expect(
      (dump.coachClients as unknown as Record<string, Record<string, Record<string, unknown>>>)[
        COACH_UID
      ]?.[TENANT_ID],
    ).toMatchObject({ claimedAt: now });
    const activePointer = (
      dump.activeClaimInvitationByTenant as unknown as Record<string, unknown> | undefined
    )?.[TENANT_ID];
    expect(activePointer == null).toBe(true);
  });

  it('leaves every content subtree byte-for-byte unchanged', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${TENANT_ID}`, {
      m1: { fighter_id: 1, opponent_id: 2, time: 1, win: true },
    });
    database.seed(`playlists/${TENANT_ID}`, { p1: { name: 'set 1' } });
    database.seed(`reviewVersions/${TENANT_ID}`, { r1: { text: 'notes' } });
    database.seed(`matches/${CLIENT_UID}`, {
      m2: { fighter_id: 3, opponent_id: 4, time: 2, win: false },
    });

    const beforeTenantMatches = JSON.stringify(
      (await database.ref(`matches/${TENANT_ID}`).get()).val(),
    );
    const beforePlaylists = JSON.stringify(
      (await database.ref(`playlists/${TENANT_ID}`).get()).val(),
    );
    const beforeReviewVersions = JSON.stringify(
      (await database.ref(`reviewVersions/${TENANT_ID}`).get()).val(),
    );
    const beforeClientMatches = JSON.stringify(
      (await database.ref(`matches/${CLIENT_UID}`).get()).val(),
    );

    await flipTenantOwnership(database as never, {
      tenantId: TENANT_ID,
      clientUid: CLIENT_UID,
      coachUid: COACH_UID,
      now: Date.now(),
    });

    expect(JSON.stringify((await database.ref(`matches/${TENANT_ID}`).get()).val())).toBe(
      beforeTenantMatches,
    );
    expect(JSON.stringify((await database.ref(`playlists/${TENANT_ID}`).get()).val())).toBe(
      beforePlaylists,
    );
    expect(JSON.stringify((await database.ref(`reviewVersions/${TENANT_ID}`).get()).val())).toBe(
      beforeReviewVersions,
    );
    expect(JSON.stringify((await database.ref(`matches/${CLIENT_UID}`).get()).val())).toBe(
      beforeClientMatches,
    );
  });
});

describe('floorDelay', () => {
  it('waits until the floor when elapsed is below it', async () => {
    const start = Date.now();
    await floorDelay(start, 40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });

  it('does not sleep when already past the floor', async () => {
    const start = Date.now() - 1000;
    const before = Date.now();
    await floorDelay(start, 40);
    expect(Date.now() - before).toBeLessThan(40);
  });
});

describe('redeemClaimCode', () => {
  it("returns { status: 'ok', tenantId } for a fresh valid code and atomically flips ownership", async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
    const code = 'FRESH-CODE-1';
    const digest = digestFor(code);
    seedInvitation(database, digest);

    const result = await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });

    expect(result).toEqual({ status: 'ok', tenantId: TENANT_ID });
    const dump = database.dump() as Record<
      string,
      Record<string, Record<string, { role: string }>>
    >;
    expect(dump.clientMembers?.[TENANT_ID]?.[CLIENT_UID]?.role).toBe('owner');
    expect(dump.clientMembers?.[TENANT_ID]?.[COACH_UID]?.role).toBe('delegate');
  });

  it("returns { status: 'ok', tenantId } for a same-client replay, with consumedAt unchanged (zero additional writes to the invitation record)", async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
    const code = 'REPLAY-CODE-1';
    const digest = digestFor(code);
    seedInvitation(database, digest);

    const first = await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });
    const consumedAtAfterFirst = (
      (await database.ref(`claimInvitations/${digest}`).get()).val() as Record<string, unknown>
    ).consumedAt;

    const second = await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });
    const consumedAtAfterSecond = (
      (await database.ref(`claimInvitations/${digest}`).get()).val() as Record<string, unknown>
    ).consumedAt;

    expect(first).toEqual({ status: 'ok', tenantId: TENANT_ID });
    expect(second).toEqual({ status: 'ok', tenantId: TENANT_ID });
    expect(consumedAtAfterSecond).toBe(consumedAtAfterFirst);
  });

  it.each(['expired', 'revoked', 'consumed-by-other', 'never-issued'] as const)(
    "returns { status: 'invalid' } for a %s code",
    async (kind) => {
      const database = new FakeDatabase();
      const code = `CODE-${kind}`;
      const digest = digestFor(code);
      if (kind === 'expired') seedInvitation(database, digest, { expiresAt: Date.now() - 1000 });
      if (kind === 'revoked') seedInvitation(database, digest, { revokedAt: Date.now() - 1000 });
      if (kind === 'consumed-by-other') {
        seedInvitation(database, digest, {
          consumedAt: Date.now() - 1000,
          consumedByUid: OTHER_UID,
        });
      }
      // never-issued: no seed.

      const result = await redeemClaimCode(database as never, {
        code,
        redeemerUid: CLIENT_UID,
        clientIp: CLIENT_IP,
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      });

      expect(result).toEqual({ status: 'invalid' });
    },
  );

  it("returns { status: 'rate_limited' } once either counter is at its cap, and performs no invitation transaction", async () => {
    const database = new FakeDatabase();
    const code = 'CAPPED-CODE';
    const digest = digestFor(code);
    seedInvitation(database, digest);
    const now = Date.now();
    for (let i = 0; i < CLAIM_REDEMPTION_PER_ACCOUNT_HOURLY_LIMIT; i += 1) {
      await checkAndIncrement(
        database as never,
        claimRedemptionAccountPath(CLIENT_UID, now),
        CLAIM_REDEMPTION_PER_ACCOUNT_HOURLY_LIMIT,
      );
    }

    const result = await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });

    expect(result).toEqual({ status: 'rate_limited' });
    const stored = (await database.ref(`claimInvitations/${digest}`).get()).val() as Record<
      string,
      unknown
    >;
    expect(stored.consumedAt == null).toBe(true);
  });

  it('increments both counters on every attempt regardless of outcome', async () => {
    const database = new FakeDatabase();
    const code = 'ANY-CODE-XYZ'; // never issued -> ineligible
    const now = Date.now();

    await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });

    const accountCount = (
      await database.ref(claimRedemptionAccountPath(CLIENT_UID, now)).get()
    ).val() as number;
    const ipCount = (
      await database.ref(claimRedemptionIpPath(CLIENT_IP, now)).get()
    ).val() as number;
    expect(accountCount).toBe(1);
    expect(ipCount).toBe(1);
  });

  it("returns { status: 'invalid' } rather than throwing when an unexpected internal error occurs, and the logger receives only the error object", async () => {
    const brokenDatabase = {
      ref: () => {
        throw new Error('boom');
      },
    } as unknown as FakeDatabase;
    const loggedCalls: unknown[] = [];
    const logger = { error: (obj: unknown, msg: string) => loggedCalls.push({ obj, msg }) };

    const result = await redeemClaimCode(
      brokenDatabase as never,
      {
        code: 'ANY-RAW-CODE',
        redeemerUid: CLIENT_UID,
        clientIp: CLIENT_IP,
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      logger,
    );

    expect(result).toEqual({ status: 'invalid' });
    expect(loggedCalls).toHaveLength(1);
    expect(JSON.stringify(loggedCalls[0])).not.toContain('ANY-RAW-CODE');
  });

  it('after a successful fresh claim, eventLedger contains claim_completed and coach_delegation_granted, and claim_conflict_detected is absent when the client has no personal library', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
    const code = 'EVENT-CODE-1';
    const digest = digestFor(code);
    seedInvitation(database, digest);

    await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });
    await flush();

    expect(eventLedgerEntries(database, 'claim_completed')).toHaveLength(1);
    expect(eventLedgerEntries(database, 'coach_delegation_granted')).toHaveLength(1);
    expect(eventLedgerEntries(database, 'claim_conflict_detected')).toHaveLength(0);
  });

  it('emits claim_conflict_detected alongside claim_completed when the redeeming client already has a personal library', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
    database.seed(`matches/${CLIENT_UID}`, {
      m1: { fighter_id: 1, opponent_id: 2, time: 1, win: true },
    });
    const code = 'EVENT-CODE-2';
    const digest = digestFor(code);
    seedInvitation(database, digest);

    await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });
    await flush();

    expect(eventLedgerEntries(database, 'claim_completed')).toHaveLength(1);
    expect(eventLedgerEntries(database, 'claim_conflict_detected')).toHaveLength(1);
  });

  it('a replay-same-client redemption emits no additional events', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
    const code = 'REPLAY-EVENT-CODE';
    const digest = digestFor(code);
    seedInvitation(database, digest);

    await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });
    await flush();
    const completedAfterFirst = eventLedgerEntries(database, 'claim_completed').length;
    const grantedAfterFirst = eventLedgerEntries(database, 'coach_delegation_granted').length;

    await redeemClaimCode(database as never, {
      code,
      redeemerUid: CLIENT_UID,
      clientIp: CLIENT_IP,
      sessionId: SESSION_ID,
      hmacSecret: HMAC_SECRET,
    });
    await flush();

    expect(eventLedgerEntries(database, 'claim_completed')).toHaveLength(completedAfterFirst);
    expect(eventLedgerEntries(database, 'coach_delegation_granted')).toHaveLength(
      grantedAfterFirst,
    );
  });
});
