import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import {
  assertFourDistinctSubjects,
  auditAcctTopology,
  type AcctTopologySourceTenant,
  type AcctTopologySubject,
} from './acctTopologyAuditCore.js';

const COACH_UID = 'dev-coach-uid-1';

// The four canonical source tenants, shaped like the real migration manifest's
// sourceToDestMap — player-named, which is precisely why a visible row is a
// violation rather than a curiosity.
const SOURCES: AcctTopologySourceTenant[] = [
  {
    sourceId: '0f0443e4-c637-4dd4-9c3a-c8365c1f7ad6',
    destUid: 'hbox-uid-000000000000000001',
    label: 'Hungrybox',
  },
  {
    sourceId: 'd4c17fdc-1111-4111-8111-111111111111',
    destUid: 'mkleo-uid-00000000000000001',
    label: 'MkLeo',
  },
  {
    sourceId: 'e5d9f25d-2222-4222-8222-222222222222',
    destUid: 'sparg0-uid-0000000000000001',
    label: 'Sparg0',
  },
  {
    sourceId: '1438981f-3333-4333-8333-333333333333',
    destUid: 'izaw-uid-000000000000000001',
    label: 'IzAw',
  },
];

const FOUR: AcctTopologySubject[] = SOURCES.map((s) => ({
  label: s.label.toLowerCase(),
  uid: s.destUid,
}));

const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** An unrelated, legitimately-managed client — the coach tree must not be empty. */
function seedRealCoachClient(database: FakeDatabase): void {
  database.seed(`coachClients/${COACH_UID}/${OTHER_TENANT}`, {
    label: 'A real human client',
    createdAt: 1,
    archivedAt: null,
  });
  database.seed(`clientMembers/${OTHER_TENANT}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });
}

/** All four source tenants archived — the post-owner-correction end state. */
function seedArchivedSources(database: FakeDatabase): void {
  for (const source of SOURCES) {
    database.seed(`coachClients/${COACH_UID}/${source.sourceId}`, {
      label: source.label,
      createdAt: 1,
      archivedAt: 1_700_000_000_000,
    });
    database.seed(`clientTenants/${source.sourceId}`, {
      createdAt: 1,
      archivedAt: 1_700_000_000_000,
      kind: 'research',
    });
  }
}

/** All four source tenants ACTIVE — today's production state. */
function seedVisibleSources(database: FakeDatabase): void {
  for (const source of SOURCES) {
    database.seed(`coachClients/${COACH_UID}/${source.sourceId}`, {
      label: source.label,
      createdAt: 1,
      archivedAt: null,
    });
    database.seed(`clientTenants/${source.sourceId}`, {
      createdAt: 1,
      archivedAt: null,
      kind: 'research',
    });
  }
}

function run(database: FakeDatabase, subjects: readonly AcctTopologySubject[] = FOUR) {
  return auditAcctTopology(asDatabase(database), {
    coachUid: COACH_UID,
    subjects,
    sourceTenants: SOURCES,
    heartbeatIntervalMs: 60_000,
    maxStallMs: 60_000,
  });
}

describe('auditAcctTopology — SOURCE half (Codex hard gate fb9a3930, P0)', () => {
  it('RED: four visible player-named source tenants each produce a finding', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedVisibleSources(database);

    const result = await run(database);

    expect(result.ok).toBe(false);
    expect(result.visibleSourceTenantCount).toBe(4);
    const visible = result.findings.filter((f) => f.violation === 'source-tenant-visible');
    expect(visible).toHaveLength(4);
    expect(visible.map((f) => f.label).sort()).toEqual(['Hungrybox', 'IzAw', 'MkLeo', 'Sparg0']);
    // A source finding names a tenant, not a uid.
    expect(visible.every((f) => f.uid === null)).toBe(true);
  });

  it('GREEN: the same tree passes once every source tenant is archived', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);

    const result = await run(database);

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.visibleSourceTenantCount).toBe(0);
  });

  it('a UID-only-clean tree still FAILS while a source row is visible (the P0 regression)', async () => {
    // No demo uid is a member or an owner anywhere — the exact state the
    // previous revision of this audit reported as PASS.
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedVisibleSources(database);

    const result = await run(database);

    expect(result.findings.some((f) => f.violation === 'coach-tenant-member')).toBe(false);
    expect(result.findings.some((f) => f.violation === 'owns-managed-tenant')).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('reports disposition for every source tenant, including one absent entirely', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);
    // Hard-deleted rather than archived: absent from both trees.
    const gone = SOURCES[0]!;
    database.seed(`coachClients/${COACH_UID}/${gone.sourceId}`, null);
    database.seed(`clientTenants/${gone.sourceId}`, null);

    const result = await run(database);

    expect(result.sourceDispositions).toHaveLength(4);
    const absent = result.sourceDispositions.find((d) => d.sourceId === gone.sourceId);
    expect(absent).toMatchObject({
      inCoachClients: false,
      clientTenantPresent: false,
      visibleInClientHub: false,
    });
    expect(result.ok).toBe(true);
  });

  it('a source archived in clientTenants but still ACTIVE in coachClients is VISIBLE', async () => {
    // Half-archived: the Client Hub reads coachClients, so this still renders.
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);
    const half = SOURCES[2]!;
    database.seed(`coachClients/${COACH_UID}/${half.sourceId}/archivedAt`, null);

    const result = await run(database);

    expect(result.visibleSourceTenantCount).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatchObject({
      violation: 'source-tenant-visible',
      label: half.label,
    });
  });
});

describe('auditAcctTopology — SUBJECT half', () => {
  it('FAILS when a demo account is a member of one of the coach client tenants', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);
    database.seed(`clientMembers/${OTHER_TENANT}/${FOUR[2]!.uid}`, { role: 'viewer', joinedAt: 9 });

    const result = await run(database);

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      violation: 'coach-tenant-member',
      label: 'sparg0',
      tenantId: OTHER_TENANT,
    });
  });

  it('FAILS when a demo account OWNS a managed tenant (the v2.4 claim link)', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);
    database.seed(`clientOwnedTenants/${FOUR[3]!.uid}/${OTHER_TENANT}`, true);

    const result = await run(database);

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      violation: 'owns-managed-tenant',
      label: 'izaw',
    });
  });

  it('reports ALL THREE violation classes together rather than stopping at the first', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedVisibleSources(database);
    database.seed(`clientMembers/${OTHER_TENANT}/${FOUR[0]!.uid}`, { role: 'viewer', joinedAt: 3 });
    database.seed(`clientOwnedTenants/${FOUR[1]!.uid}/${OTHER_TENANT}`, true);

    const result = await run(database);

    expect(new Set(result.findings.map((f) => f.violation))).toEqual(
      new Set(['coach-tenant-member', 'owns-managed-tenant', 'source-tenant-visible']),
    );
  });

  it('proves the membership sweep actually ran (reads = tenants x subjects)', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);

    const result = await run(database);

    // 1 unrelated client + 4 archived source rows are all still coachClients rows.
    expect(result.coachTenantIds).toHaveLength(5);
    expect(result.membershipReads).toBe(20);
  });
});

describe('auditAcctTopology input sealing (Codex hard gate fb9a3930, P1)', () => {
  it('seals the complete label->uid map into the result', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);

    const result = await run(database);

    expect(result.subjects).toEqual(FOUR);
    expect(result.coachUid).toBe(COACH_UID);
  });

  it('rejects the SAME uid supplied four times (duplicate substitution)', () => {
    const dup = FOUR.map((s) => ({ ...s, uid: FOUR[0]!.uid }));
    expect(() => assertFourDistinctSubjects(COACH_UID, dup)).toThrow(/duplicate destination uid/);
  });

  it('rejects a destination uid equal to the coach uid', async () => {
    const collide = [...FOUR.slice(0, 3), { label: 'izaw', uid: COACH_UID }];
    expect(() => assertFourDistinctSubjects(COACH_UID, collide)).toThrow(/same uid as --coach-uid/);
  });

  it('rejects fewer than four subjects rather than auditing a subset', async () => {
    expect(() => assertFourDistinctSubjects(COACH_UID, FOUR.slice(0, 3))).toThrow(
      /exactly 4 destination uids/,
    );
  });

  it('rejects more than four subjects', async () => {
    expect(() =>
      assertFourDistinctSubjects(COACH_UID, [...FOUR, { label: 'extra', uid: 'extra-uid-1' }]),
    ).toThrow(/exactly 4 destination uids/);
  });

  it('rejects a malformed coach uid before any read', async () => {
    expect(() => assertFourDistinctSubjects('bad/uid', FOUR)).toThrow(/path-safe/);
  });

  it('rejects a malformed subject uid before any read', async () => {
    const bad = [...FOUR.slice(0, 3), { label: 'izaw', uid: 'has.a.dot' }];
    expect(() => assertFourDistinctSubjects(COACH_UID, bad)).toThrow(/path-safe/);
  });

  it('rejects a source-tenant list that is not exactly four', async () => {
    const database = new FakeDatabase();
    await expect(
      auditAcctTopology(asDatabase(database), {
        coachUid: COACH_UID,
        subjects: FOUR,
        sourceTenants: SOURCES.slice(0, 2),
      }),
    ).rejects.toThrow(/exactly 4 source tenants/);
  });
});

describe('auditAcctTopology is read-only', () => {
  it('writes nothing — the tree is byte-identical after a run', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedVisibleSources(database);
    database.seed(`clientOwnedTenants/${FOUR[1]!.uid}/${OTHER_TENANT}`, true);
    const before = JSON.stringify(database.dump());

    await run(database);

    expect(JSON.stringify(database.dump())).toBe(before);
  });

  it('a coaching-kind clientTenants row is not by itself a finding', async () => {
    const database = new FakeDatabase();
    seedRealCoachClient(database);
    seedArchivedSources(database);
    database.seed(`clientTenants/${OTHER_TENANT}`, { createdAt: 1, archivedAt: null });

    const result = await run(database);

    expect(result.ok).toBe(true);
  });
});
