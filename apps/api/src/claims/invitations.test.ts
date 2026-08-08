import { describe, expect, it, vi } from 'vitest';
import { MAX_CLAIM_ISSUANCES_PER_DAY } from './rateLimits.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';

const HMAC_SECRET = 'test-claim-secret';
const TENANT_ID = 'tenant-1';
const COACH_UID = 'coach-1';
const SESSION_ID = 'session-1';

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

function seedMembership(
  database: FakeDatabase,
  tenantId: string,
  uid: string,
  role: 'custodian' | 'owner' | 'delegate',
): void {
  database.seed(`clientMembers/${tenantId}/${uid}`, { role, joinedAt: 1 });
}

describe('issueClaimInvitation', () => {
  it('returns a 26-character-derived display code and expiresAt equal to now + CLAIM_CODE_TTL_MS', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const before = Date.now();
    const result = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );

    expect(result.code).toMatch(
      /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{1}$/,
    );
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 72 * 60 * 60 * 1000);
  });

  it('stores claimInvitations/{digest} with tenantId/issuerUid/createdAt/expiresAt and no raw-code field, and activeClaimInvitationByTenant/{tenantId} with { digest, issuedAt }', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const { normalizeClaimCode, hashClaimCode } = await import('./crypto.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const result = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );

    const digest = hashClaimCode(HMAC_SECRET, normalizeClaimCode(result.code));
    const dump = database.dump() as Record<string, unknown>;
    const claimInvitations = dump.claimInvitations as Record<string, unknown>;
    const record = claimInvitations[digest] as Record<string, unknown>;
    expect(record).toMatchObject({
      tenantId: TENANT_ID,
      issuerUid: COACH_UID,
      expiresAt: result.expiresAt,
    });
    expect(record.createdAt).toBeTypeOf('number');
    expect(JSON.stringify(record)).not.toMatch(/code/i);

    const pointer = (dump.activeClaimInvitationByTenant as Record<string, unknown>)[TENANT_ID];
    expect(pointer).toMatchObject({ digest });
    expect((pointer as { issuedAt: number }).issuedAt).toBeTypeOf('number');
  });

  it('JSON.stringify(database.dump()) contains neither the returned display code nor its normalized form', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const { normalizeClaimCode } = await import('./crypto.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const result = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );

    const dumped = JSON.stringify(database.dump());
    expect(dumped).not.toContain(result.code);
    expect(dumped).not.toContain(normalizeClaimCode(result.code));
  });

  it('a second issuance for the same tenant revokes the first digest, leaves its other fields intact, and repoints the pointer', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const { normalizeClaimCode, hashClaimCode } = await import('./crypto.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const first = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    const firstDigest = hashClaimCode(HMAC_SECRET, normalizeClaimCode(first.code));

    const second = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    const secondDigest = hashClaimCode(HMAC_SECRET, normalizeClaimCode(second.code));

    const dump = database.dump() as Record<string, unknown>;
    const claimInvitations = dump.claimInvitations as Record<string, Record<string, unknown>>;
    expect(claimInvitations[firstDigest]?.revokedAt).toBeTypeOf('number');
    expect(claimInvitations[firstDigest]?.tenantId).toBe(TENANT_ID);
    expect(claimInvitations[firstDigest]?.issuerUid).toBe(COACH_UID);

    const pointer = (dump.activeClaimInvitationByTenant as Record<string, unknown>)[TENANT_ID];
    expect(pointer).toMatchObject({ digest: secondDigest });
  });

  it.each(['delegate', 'owner'] as const)(
    "rejects for a '%s' member with the same message as a non-member",
    async (role) => {
      const { issueClaimInvitation } = await import('./invitations.js');
      const database = new FakeDatabase();
      seedMembership(database, TENANT_ID, COACH_UID, role);

      const strangerDatabase = new FakeDatabase();
      const roleError = await issueClaimInvitation(
        database as never,
        COACH_UID,
        TENANT_ID,
        {
          sessionId: SESSION_ID,
          hmacSecret: HMAC_SECRET,
        },
        null,
      ).catch((err: Error) => err);
      const strangerError = await issueClaimInvitation(
        strangerDatabase as never,
        'stranger-uid',
        TENANT_ID,
        { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
        null,
      ).catch((err: Error) => err);

      expect(roleError).toBeInstanceOf(Error);
      expect(strangerError).toBeInstanceOf(Error);
      expect((roleError as Error).message).toBe((strangerError as Error).message);
    },
  );

  it(`throws ClaimIssuanceRateLimitError and writes no invitation once the ${MAX_CLAIM_ISSUANCES_PER_DAY}-th+1 issuance is attempted`, async () => {
    const { issueClaimInvitation, ClaimIssuanceRateLimitError } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    for (let i = 0; i < MAX_CLAIM_ISSUANCES_PER_DAY; i += 1) {
      await issueClaimInvitation(
        database as never,
        COACH_UID,
        TENANT_ID,
        {
          sessionId: SESSION_ID,
          hmacSecret: HMAC_SECRET,
        },
        null,
      );
    }

    const dumpBefore = database.dump() as Record<string, unknown>;
    const countBefore = Object.keys(
      (dumpBefore.claimInvitations as Record<string, unknown>) ?? {},
    ).length;

    await expect(
      issueClaimInvitation(
        database as never,
        COACH_UID,
        TENANT_ID,
        {
          sessionId: SESSION_ID,
          hmacSecret: HMAC_SECRET,
        },
        null,
      ),
    ).rejects.toBeInstanceOf(ClaimIssuanceRateLimitError);

    const dumpAfter = database.dump() as Record<string, unknown>;
    const countAfter = Object.keys(
      (dumpAfter.claimInvitations as Record<string, unknown>) ?? {},
    ).length;
    expect(countAfter).toBe(countBefore);
  });

  it('JSON.stringify(database.dump().eventLedger) contains neither the raw code nor the digest', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const { normalizeClaimCode, hashClaimCode } = await import('./crypto.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const result = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    await flush();

    const digest = hashClaimCode(HMAC_SECRET, normalizeClaimCode(result.code));
    const eventLedger = (database.dump() as Record<string, unknown>).eventLedger;
    const dumped = JSON.stringify(eventLedger);
    expect(dumped).not.toContain(result.code);
    expect(dumped).not.toContain(digest);
  });

  it('emits claim_invitation_created after issuance, and claim_invitation_revoked (reason: rotated) after a rotation', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    await flush();
    expect(eventLedgerEntries(database, 'claim_invitation_created')).toHaveLength(1);
    expect(eventLedgerEntries(database, 'claim_invitation_revoked')).toHaveLength(0);

    await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    await flush();
    expect(eventLedgerEntries(database, 'claim_invitation_created')).toHaveLength(2);
    const revokedEvents = eventLedgerEntries(database, 'claim_invitation_revoked');
    expect(revokedEvents).toHaveLength(1);
    expect((revokedEvents[0] as { payload: { reason: string } }).payload.reason).toBe('rotated');
  });

  it('when the first generated code collides, retries with a fresh code, succeeds, and does not overwrite the pre-existing record', async () => {
    vi.resetModules();
    vi.doMock('./crypto.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./crypto.js')>();
      return { ...actual, generateClaimCode: vi.fn() };
    });

    const { issueClaimInvitation } = await import('./invitations.js');
    const cryptoModule = await import('./crypto.js');
    const { formatClaimCode, hashClaimCode, normalizeClaimCode } = cryptoModule;
    const generateClaimCodeMock = vi.mocked(cryptoModule.generateClaimCode);

    const codeA = 'A'.repeat(26);
    const codeB = 'B'.repeat(26);
    generateClaimCodeMock.mockReturnValueOnce(codeA).mockReturnValueOnce(codeB);

    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');
    const digestA = hashClaimCode(HMAC_SECRET, normalizeClaimCode(codeA));
    const preExisting = {
      tenantId: 'some-other-tenant',
      issuerUid: 'some-other-coach',
      createdAt: 1,
      expiresAt: 2,
    };
    database.seed(`claimInvitations/${digestA}`, preExisting);

    const result = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );

    expect(result.code).toBe(formatClaimCode(codeB));
    const dump = database.dump() as Record<string, unknown>;
    const claimInvitations = dump.claimInvitations as Record<string, unknown>;
    expect(claimInvitations[digestA]).toEqual(preExisting);

    vi.doUnmock('./crypto.js');
    vi.resetModules();
  });

  // Phase 29 (Research Tenancy, Isolation & Governance Gate, review
  // consensus finding 2): a research tenant must not be claimable at ALL
  // before Phase 34 — even by its own allowlisted admin — so issuance is
  // refused BEFORE any code generation, digest computation, transaction, or
  // write. Asserted via whole-database before/after equality since the
  // guard sits strictly above every write.
  it('refuses issuance for a research tenant, leaving the WHOLE database byte-unchanged and producing no invitation record', async () => {
    const { issueClaimInvitation } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');
    database.seed(`clientTenants/${TENANT_ID}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
    const before = database.dump();

    // Message equality, not `.rejects.toThrow(ForbiddenError)` — this
    // test's dynamic `await import('./invitations.js')` may run against a
    // module registry reset by an earlier `vi.resetModules()` in this file,
    // yielding a structurally-identical but distinct ForbiddenError class
    // than the one statically imported at the top of this file.
    await expect(
      issueClaimInvitation(
        database as never,
        COACH_UID,
        TENANT_ID,
        { sessionId: SESSION_ID, hmacSecret: HMAC_SECRET },
        { adminUids: new Set([COACH_UID]) },
      ),
    ).rejects.toThrow('Not a member of this client tenant');

    expect(database.dump()).toEqual(before);
  });
});

describe('revokeClaimInvitation', () => {
  it('on a tenant with an outstanding code, sets revokedAt on that digest and clears the pointer', async () => {
    const { issueClaimInvitation, revokeClaimInvitation } = await import('./invitations.js');
    const { normalizeClaimCode, hashClaimCode } = await import('./crypto.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const issued = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    const digest = hashClaimCode(HMAC_SECRET, normalizeClaimCode(issued.code));

    await revokeClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
      },
      null,
    );

    const dump = database.dump() as Record<string, unknown>;
    const claimInvitations = dump.claimInvitations as Record<string, Record<string, unknown>>;
    expect(claimInvitations[digest]?.revokedAt).toBeTypeOf('number');
    const pointer = (dump.activeClaimInvitationByTenant as Record<string, unknown> | undefined)?.[
      TENANT_ID
    ];
    expect(pointer == null).toBe(true);
  });

  it('on a tenant with no outstanding code resolves without throwing and writes nothing', async () => {
    const { revokeClaimInvitation } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    await expect(
      revokeClaimInvitation(
        database as never,
        COACH_UID,
        TENANT_ID,
        { sessionId: SESSION_ID },
        null,
      ),
    ).resolves.toBeUndefined();

    const dump = database.dump() as Record<string, unknown>;
    expect(dump.claimInvitations).toBeUndefined();
    expect(dump.activeClaimInvitationByTenant).toBeUndefined();
  });

  it('emits claim_invitation_revoked with reason coach_revoked on a standalone revoke', async () => {
    const { issueClaimInvitation, revokeClaimInvitation } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );
    await flush();

    await revokeClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
      },
      null,
    );
    await flush();

    const revokedEvents = eventLedgerEntries(database, 'claim_invitation_revoked');
    expect(revokedEvents).toHaveLength(1);
    expect((revokedEvents[0] as { payload: { reason: string } }).payload.reason).toBe(
      'coach_revoked',
    );
  });

  // Phase 29 (review consensus finding 2): revocation is refused for a
  // research tenant the same way issuance is, leaving the WHOLE database
  // byte-unchanged.
  it('refuses revocation for a research tenant, leaving the database byte-unchanged', async () => {
    const { revokeClaimInvitation } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');
    database.seed(`clientTenants/${TENANT_ID}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
    const before = database.dump();

    await expect(
      revokeClaimInvitation(
        database as never,
        COACH_UID,
        TENANT_ID,
        { sessionId: SESSION_ID },
        { adminUids: new Set([COACH_UID]) },
      ),
    ).rejects.toThrow('Not a member of this client tenant');

    expect(database.dump()).toEqual(before);
  });
});

describe('getClaimInvitationStatus', () => {
  it('returns { outstanding: false, expiresAt: null } when there is none', async () => {
    const { getClaimInvitationStatus } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const status = await getClaimInvitationStatus(database as never, COACH_UID, TENANT_ID, null);
    expect(status).toEqual({ outstanding: false, expiresAt: null });
  });

  it('returns { outstanding: true, expiresAt } for a live invitation', async () => {
    const { issueClaimInvitation, getClaimInvitationStatus } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    const issued = await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );

    const status = await getClaimInvitationStatus(database as never, COACH_UID, TENANT_ID, null);
    expect(status).toEqual({ outstanding: true, expiresAt: issued.expiresAt });
  });

  it('returns outstanding: false for a pointer whose record is expired, revoked, or consumed', async () => {
    const { getClaimInvitationStatus } = await import('./invitations.js');

    for (const overrides of [
      { revokedAt: 1000 },
      { consumedAt: 1000, consumedByUid: 'client-uid' },
      { expiresAt: Date.now() - 1000 },
    ]) {
      const database = new FakeDatabase();
      seedMembership(database, TENANT_ID, COACH_UID, 'custodian');
      const digest = 'a'.repeat(64);
      database.seed(`claimInvitations/${digest}`, {
        tenantId: TENANT_ID,
        issuerUid: COACH_UID,
        createdAt: 1,
        expiresAt: Date.now() + 1000,
        ...overrides,
      });
      database.seed(`activeClaimInvitationByTenant/${TENANT_ID}`, { digest, issuedAt: 1 });

      const status = await getClaimInvitationStatus(database as never, COACH_UID, TENANT_ID, null);
      expect(status).toEqual({ outstanding: false, expiresAt: null });
    }
  });

  it('never returns the digest', async () => {
    const { issueClaimInvitation, getClaimInvitationStatus } = await import('./invitations.js');
    const database = new FakeDatabase();
    seedMembership(database, TENANT_ID, COACH_UID, 'custodian');

    await issueClaimInvitation(
      database as never,
      COACH_UID,
      TENANT_ID,
      {
        sessionId: SESSION_ID,
        hmacSecret: HMAC_SECRET,
      },
      null,
    );

    const status = await getClaimInvitationStatus(database as never, COACH_UID, TENANT_ID, null);
    expect(Object.keys(status)).toEqual(['outstanding', 'expiresAt']);
  });
});
