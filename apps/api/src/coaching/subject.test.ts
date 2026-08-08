import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import type { ResearchConfig } from '../config/env.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ForbiddenError } from '../services/rtdb.js';
import { resolveSubject, resolveSubjectId } from './subject.js';

const UID = 'coach-uid-1';
const TENANT_ID = 'tenant-abc';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function countingDatabase(database: FakeDatabase): { database: Database; readCount: () => number } {
  let readCount = 0;
  const spied = {
    ref: (path?: string) => {
      readCount += 1;
      return database.ref(path);
    },
  } as unknown as Database;
  return { database: spied, readCount: () => readCount };
}

describe('resolveSubjectId', () => {
  it('resolves to the caller uid with zero RTDB reads when the header is absent', async () => {
    const database = new FakeDatabase();
    const { database: spied, readCount } = countingDatabase(database);

    const subjectId = await resolveSubjectId({
      database: spied,
      uid: UID,
      header: undefined,
      researchConfig: null,
    });

    expect(subjectId).toBe(UID);
    expect(readCount()).toBe(0);
  });

  it("resolves to the caller uid with zero RTDB reads when the header is 'personal'", async () => {
    const database = new FakeDatabase();
    const { database: spied, readCount } = countingDatabase(database);

    const subjectId = await resolveSubjectId({
      database: spied,
      uid: UID,
      header: 'personal',
      researchConfig: null,
    });

    expect(subjectId).toBe(UID);
    expect(readCount()).toBe(0);
  });

  it('resolves to the tenantId when a client header has valid membership', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });

    const subjectId = await resolveSubjectId({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
      researchConfig: null,
    });

    expect(subjectId).toBe(TENANT_ID);
  });

  it('throws ForbiddenError when the client header has no membership record', async () => {
    const database = new FakeDatabase();
    // Deliberately no clientMembers/{TENANT_ID}/{UID} seed.

    await expect(
      resolveSubjectId({
        database: asDatabase(database),
        uid: UID,
        header: `client:${TENANT_ID}`,
        researchConfig: null,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('throws ForbiddenError on a malformed header (not personal, no client: prefix)', async () => {
    const database = new FakeDatabase();

    await expect(
      resolveSubjectId({
        database: asDatabase(database),
        uid: UID,
        header: 'bogus-value',
        researchConfig: null,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('uses the first element when the header arrives as an array (Fastify may deliver arrays)', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });
    // The plugin flattens `Array.isArray(header) ? header[0] : header` before
    // calling resolveSubjectId — this test exercises resolveSubjectId
    // against the flattened value it would receive, confirming the "first
    // element wins" contract end-to-end via the same flattening logic.
    const headerArray = [`client:${TENANT_ID}`, 'personal'];
    const flattened = Array.isArray(headerArray) ? headerArray[0] : headerArray;

    const subjectId = await resolveSubjectId({
      database: asDatabase(database),
      uid: UID,
      header: flattened,
      researchConfig: null,
    });

    expect(subjectId).toBe(TENANT_ID);
  });
});

describe('resolveSubject (Phase 29: dual gate + tri-state kind)', () => {
  it('performs zero database reads for the personal-header path and leaves subjectKind an own property whose value is undefined', async () => {
    const database = new FakeDatabase();
    const { database: spied, readCount } = countingDatabase(database);

    const resolved = await resolveSubject({
      database: spied,
      uid: UID,
      header: undefined,
      researchConfig: null,
    });

    expect(resolved.subjectId).toBe(UID);
    expect(readCount()).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(resolved, 'subjectKind')).toBe(true);
    expect(resolved.subjectKind).toBeUndefined();
  });

  it("performs zero database reads and yields an undefined kind for the 'personal' header", async () => {
    const database = new FakeDatabase();
    const { database: spied, readCount } = countingDatabase(database);

    const resolved = await resolveSubject({
      database: spied,
      uid: UID,
      header: 'personal',
      researchConfig: null,
    });

    expect(resolved.subjectId).toBe(UID);
    expect(readCount()).toBe(0);
    expect(resolved.subjectKind).toBeUndefined();
  });

  it('raises the malformed-header rejection for a header with no client: prefix, before any read', async () => {
    const database = new FakeDatabase();
    const { database: spied, readCount } = countingDatabase(database);

    await expect(
      resolveSubject({ database: spied, uid: UID, header: 'bogus-value', researchConfig: null }),
    ).rejects.toThrow(ForbiddenError);
    expect(readCount()).toBe(0);
  });

  it('raises the malformed-header rejection for a path-illegal tenant id with ZERO database references constructed', async () => {
    const database = new FakeDatabase();
    const { database: spied, readCount } = countingDatabase(database);

    // '.' is RTDB-path-illegal; a naive implementation would 500 here.
    await expect(
      resolveSubject({
        database: spied,
        uid: UID,
        header: 'client:tenant.illegal',
        researchConfig: null,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(readCount()).toBe(0);
  });

  it('raises the existing non-member rejection for a client header naming a tenant the caller is NOT a member of, with no kind lookup attempted', async () => {
    const database = new FakeDatabase();
    // Deliberately no clientMembers/{TENANT_ID}/{UID} seed and no
    // clientTenants/{TENANT_ID} seed — the tenant-record read must never be
    // attempted before membership passes.
    const { database: spied, readCount } = countingDatabase(database);

    await expect(
      resolveSubject({
        database: spied,
        uid: UID,
        header: `client:${TENANT_ID}`,
        researchConfig: null,
      }),
    ).rejects.toThrow(ForbiddenError);
    // Exactly one ref() call: the membership check itself.
    expect(readCount()).toBe(1);
  });

  it('yields the tenant id and the ordinary resolution for an ordinary tenant the caller is a member of', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });
    database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });

    const resolved = await resolveSubject({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
      researchConfig: null,
    });

    expect(resolved).toEqual({ subjectId: TENANT_ID, subjectKind: 'ordinary' });
  });

  it('yields the tenant id and the research resolution for an allowlisted member of a research tenant', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });
    database.seed(`clientTenants/${TENANT_ID}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
    const researchConfig: ResearchConfig = { adminUids: new Set([UID]) };

    const resolved = await resolveSubject({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
      researchConfig,
    });

    expect(resolved).toEqual({ subjectId: TENANT_ID, subjectKind: 'research' });
  });

  it('raises a rejection deep-equal to the genuine non-member rejection for a research-tenant member who is NOT allowlisted, and for a null research config', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });
    database.seed(`clientTenants/${TENANT_ID}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });

    const nonMemberError = await resolveSubject({
      database: asDatabase(database),
      uid: 'genuine-stranger',
      header: `client:${TENANT_ID}`,
      researchConfig: null,
    }).catch((err: unknown) => err);

    const notAllowlistedError = await resolveSubject({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
      researchConfig: { adminUids: new Set(['someone-else']) },
    }).catch((err: unknown) => err);

    const nullConfigError = await resolveSubject({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
      researchConfig: null,
    }).catch((err: unknown) => err);

    expect(nonMemberError).toBeInstanceOf(ForbiddenError);
    expect(notAllowlistedError).toBeInstanceOf(ForbiddenError);
    expect(nullConfigError).toBeInstanceOf(ForbiddenError);
    expect((notAllowlistedError as Error).message).toBe((nonMemberError as Error).message);
    expect((nullConfigError as Error).message).toBe((nonMemberError as Error).message);
    expect(notAllowlistedError).toEqual(nonMemberError);
    expect(nullConfigError).toEqual(nonMemberError);
  });

  it('raises that same rejection when the kind cannot be resolved (unresolvable/corrupt tenant record)', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });
    // Corrupt/unparseable stored kind value -> readSubjectKind resolves
    // 'unresolved' -> assertTenantAccess throws the non-member rejection.
    database.seed(`clientTenants/${TENANT_ID}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'not-a-real-kind',
    });

    const unresolvedError = await resolveSubject({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
      researchConfig: null,
    }).catch((err: unknown) => err);

    const nonMemberError = await resolveSubject({
      database: asDatabase(database),
      uid: 'genuine-stranger',
      header: `client:${TENANT_ID}`,
      researchConfig: null,
    }).catch((err: unknown) => err);

    expect(unresolvedError).toBeInstanceOf(ForbiddenError);
    expect(unresolvedError).toEqual(nonMemberError);
  });
});
