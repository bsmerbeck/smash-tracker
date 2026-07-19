import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ForbiddenError } from '../services/rtdb.js';
import { resolveSubjectId } from './subject.js';

const UID = 'coach-uid-1';
const TENANT_ID = 'tenant-abc';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

describe('resolveSubjectId', () => {
  it('resolves to the caller uid with zero RTDB reads when the header is absent', async () => {
    const database = new FakeDatabase();
    let readCount = 0;
    const spied = {
      ref: (path?: string) => {
        readCount += 1;
        return database.ref(path);
      },
    } as unknown as Database;

    const subjectId = await resolveSubjectId({ database: spied, uid: UID, header: undefined });

    expect(subjectId).toBe(UID);
    expect(readCount).toBe(0);
  });

  it("resolves to the caller uid with zero RTDB reads when the header is 'personal'", async () => {
    const database = new FakeDatabase();
    let readCount = 0;
    const spied = {
      ref: (path?: string) => {
        readCount += 1;
        return database.ref(path);
      },
    } as unknown as Database;

    const subjectId = await resolveSubjectId({ database: spied, uid: UID, header: 'personal' });

    expect(subjectId).toBe(UID);
    expect(readCount).toBe(0);
  });

  it('resolves to the tenantId when a client header has valid membership', async () => {
    const database = new FakeDatabase();
    database.seed(`clientMembers/${TENANT_ID}/${UID}`, { role: 'custodian', joinedAt: 1 });

    const subjectId = await resolveSubjectId({
      database: asDatabase(database),
      uid: UID,
      header: `client:${TENANT_ID}`,
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
    });

    expect(subjectId).toBe(TENANT_ID);
  });
});
