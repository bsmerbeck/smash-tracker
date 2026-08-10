import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { createClientCore } from '../../coaching/tenants.js';

const IZAW_UID = 'izaw-uid-1';
const DEVELOPER_UID = 'developer-uid-1';
const OTHER_OWNER_UID = 'some-other-owner-uid';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/**
 * Phase 30.1 (Demo Account Topology & Migration, ACCT-03): pure structural
 * proof over the EXISTING `createClientCore` (`apps/api/src/coaching/
 * tenants.ts`) — no new runtime source is added here. Proves the coaching
 * ownership-root property is a structural fact of the `ownerUid` parameter,
 * so IzAw's own uid (never the developer's) is the root for any coaching
 * structure created from IzAw's account. No portfolio content is created
 * (that is Phase 33 / PROOF-01) — this test creates exactly one throwaway
 * tenant per assertion, purely to observe where the write lands.
 */
describe('ACCT-03: coaching ownership root is keyed on the caller-supplied ownerUid', () => {
  it('writes coachClients/{izawUid}/{tenantId} and clientMembers/{tenantId}/{izawUid} custodian for a structure created from IzAw uid', async () => {
    const database = new FakeDatabase();

    const { tenantId } = await createClientCore(
      asDatabase(database),
      IZAW_UID,
      'some label',
      'coaching',
    );

    const dump = database.dump() as Record<string, unknown>;
    expect(dump).toMatchObject({
      coachClients: { [IZAW_UID]: { [tenantId]: { label: 'some label' } } },
      clientMembers: { [tenantId]: { [IZAW_UID]: { role: 'custodian' } } },
    });
  });

  it('never writes coachClients/{developerUid} for a structure created from IzAw uid', async () => {
    const database = new FakeDatabase();

    await createClientCore(asDatabase(database), IZAW_UID, 'some label', 'coaching');

    const dump = database.dump() as { coachClients?: Record<string, unknown> };
    expect(dump.coachClients?.[DEVELOPER_UID]).toBeUndefined();
  });

  it('is parameterized: the coachClients key follows whichever ownerUid is passed, not a hardcoded root', async () => {
    const database = new FakeDatabase();

    const izawResult = await createClientCore(
      asDatabase(database),
      IZAW_UID,
      'izaw label',
      'coaching',
    );
    const otherResult = await createClientCore(
      asDatabase(database),
      OTHER_OWNER_UID,
      'other label',
      'coaching',
    );

    const dump = database.dump() as { coachClients?: Record<string, Record<string, unknown>> };
    expect(dump.coachClients?.[IZAW_UID]?.[izawResult.tenantId]).toBeDefined();
    expect(dump.coachClients?.[OTHER_OWNER_UID]?.[otherResult.tenantId]).toBeDefined();
    // Neither owner's tree contains the other owner's tenantId.
    expect(dump.coachClients?.[IZAW_UID]?.[otherResult.tenantId]).toBeUndefined();
    expect(dump.coachClients?.[OTHER_OWNER_UID]?.[izawResult.tenantId]).toBeUndefined();
    // The developer's uid never appears as a key regardless of who created
    // the structure.
    expect(dump.coachClients?.[DEVELOPER_UID]).toBeUndefined();
  });
});
