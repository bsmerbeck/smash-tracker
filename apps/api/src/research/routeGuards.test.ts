import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { createClientCore } from '../coaching/tenants.js';
import type { ResearchConfig } from '../config/env.js';
import {
  RESEARCH_FAMILY_REJECTION,
  requireResearchAdmin,
  requireResearchTenantAdmin,
  type ResearchGuardRequest,
} from './routeGuards.js';

const ADMIN_UID = 'admin-1';
const OTHER_UID = 'not-an-admin';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeRequest(
  database: FakeDatabase,
  researchConfig: ResearchConfig | null,
  uid: string,
): ResearchGuardRequest {
  return {
    uid,
    server: {
      researchConfig,
      firebase: { database: asDatabase(database) },
    },
  };
}

const CONFIGURED: ResearchConfig = { adminUids: new Set([ADMIN_UID]) };

describe('requireResearchAdmin (collection guard)', () => {
  it('rejects when the research config is null', () => {
    const database = new FakeDatabase();
    const request = makeRequest(database, null, ADMIN_UID);

    expect(requireResearchAdmin(request)).toEqual(RESEARCH_FAMILY_REJECTION);
  });

  it("rejects when the caller's uid is not in the allowlist", () => {
    const database = new FakeDatabase();
    const request = makeRequest(database, CONFIGURED, OTHER_UID);

    expect(requireResearchAdmin(request)).toEqual(RESEARCH_FAMILY_REJECTION);
  });

  it('authorizes an allowlisted caller with a non-null config', () => {
    const database = new FakeDatabase();
    const request = makeRequest(database, CONFIGURED, ADMIN_UID);

    expect(requireResearchAdmin(request)).toBeNull();
  });
});

describe('requireResearchTenantAdmin (tenant-addressed guard)', () => {
  it('rejects a path-illegal tenant id BEFORE any membership reference is constructed', async () => {
    const database = new FakeDatabase();
    const request = makeRequest(database, CONFIGURED, ADMIN_UID);

    for (const illegalId of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b']) {
      await expect(requireResearchTenantAdmin(request, illegalId)).resolves.toEqual(
        RESEARCH_FAMILY_REJECTION,
      );
    }
    // No membership ref was ever constructed for these ids — the FakeDatabase
    // synchronously throws on illegal path characters at ref() construction
    // time (mirroring the real Admin SDK), so a passing test here already
    // proves no ref was built with the illegal id baked in.
  });

  it('rejects when the research config is null', async () => {
    const database = new FakeDatabase();
    const request = makeRequest(database, null, ADMIN_UID);

    await expect(requireResearchTenantAdmin(request, 'tenant-1')).resolves.toEqual(
      RESEARCH_FAMILY_REJECTION,
    );
  });

  it("rejects when the caller's uid is not in the allowlist", async () => {
    const database = new FakeDatabase();
    const request = makeRequest(database, CONFIGURED, OTHER_UID);

    await expect(requireResearchTenantAdmin(request, 'tenant-1')).resolves.toEqual(
      RESEARCH_FAMILY_REJECTION,
    );
  });

  it('rejects an allowlisted caller with no membership record on the named tenant', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClientCore(
      asDatabase(database),
      'someone-else',
      'Research tenant',
      'research',
    );
    const request = makeRequest(database, CONFIGURED, ADMIN_UID);

    await expect(requireResearchTenantAdmin(request, tenantId)).resolves.toEqual(
      RESEARCH_FAMILY_REJECTION,
    );
  });

  it('rejects an allowlisted member whose tenant is an ordinary (coaching) tenant', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Coaching tenant',
      'coaching',
    );
    const request = makeRequest(database, CONFIGURED, ADMIN_UID);

    await expect(requireResearchTenantAdmin(request, tenantId)).resolves.toEqual(
      RESEARCH_FAMILY_REJECTION,
    );
  });

  it('rejects an allowlisted member whose tenant kind cannot be resolved', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Unresolvable tenant',
      'research',
    );
    database.seed(`clientTenants/${tenantId}/kind`, 12345);
    const request = makeRequest(database, CONFIGURED, ADMIN_UID);

    await expect(requireResearchTenantAdmin(request, tenantId)).resolves.toEqual(
      RESEARCH_FAMILY_REJECTION,
    );
  });

  it('authorizes an allowlisted member of a genuine research tenant', async () => {
    const database = new FakeDatabase();
    const { tenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Research tenant',
      'research',
    );
    const request = makeRequest(database, CONFIGURED, ADMIN_UID);

    await expect(requireResearchTenantAdmin(request, tenantId)).resolves.toBeNull();
  });

  it('every negative reason produces the SAME rejection value (deep equality, not independent assertions)', async () => {
    const database = new FakeDatabase();
    const { tenantId: coachingTenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Coaching tenant',
      'coaching',
    );
    const { tenantId: unresolvableTenantId } = await createClientCore(
      asDatabase(database),
      ADMIN_UID,
      'Unresolvable tenant',
      'research',
    );
    database.seed(`clientTenants/${unresolvableTenantId}/kind`, 12345);
    const { tenantId: foreignTenantId } = await createClientCore(
      asDatabase(database),
      'someone-else',
      'Foreign research tenant',
      'research',
    );

    const nullConfigRejection = await requireResearchTenantAdmin(
      makeRequest(database, null, ADMIN_UID),
      coachingTenantId,
    );
    const nonAllowlistedRejection = await requireResearchTenantAdmin(
      makeRequest(database, CONFIGURED, OTHER_UID),
      coachingTenantId,
    );
    const nonMemberRejection = await requireResearchTenantAdmin(
      makeRequest(database, CONFIGURED, ADMIN_UID),
      foreignTenantId,
    );
    const ordinaryTenantRejection = await requireResearchTenantAdmin(
      makeRequest(database, CONFIGURED, ADMIN_UID),
      coachingTenantId,
    );
    const unresolvableKindRejection = await requireResearchTenantAdmin(
      makeRequest(database, CONFIGURED, ADMIN_UID),
      unresolvableTenantId,
    );

    expect(nullConfigRejection).toEqual(RESEARCH_FAMILY_REJECTION);
    expect(nonAllowlistedRejection).toEqual(RESEARCH_FAMILY_REJECTION);
    expect(nonMemberRejection).toEqual(RESEARCH_FAMILY_REJECTION);
    expect(ordinaryTenantRejection).toEqual(RESEARCH_FAMILY_REJECTION);
    expect(unresolvableKindRejection).toEqual(RESEARCH_FAMILY_REJECTION);

    expect(nullConfigRejection).toEqual(nonAllowlistedRejection);
    expect(nonAllowlistedRejection).toEqual(nonMemberRejection);
    expect(nonMemberRejection).toEqual(ordinaryTenantRejection);
    expect(ordinaryTenantRejection).toEqual(unresolvableKindRejection);
  });
});
