import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { classifyReportSubject } from './reportSubject.js';

/**
 * Phase 29 (plan 29-11, review finding 29-10 MEDIUM): the preservation gate
 * for THIS phase's DELIBERATELY narrow report-route subject boundary — the
 * report route's evidence, payload, job, and result storage all stay keyed
 * by the caller's own `request.uid` (D-07), and this test exists so that
 * narrowness is not eroded before Phase 32 (RTEN-05B) generalizes the
 * report route's subject model.
 *
 * This test deliberately does NOT assert that the report route's job/result
 * paths must remain uid-keyed forever — locking that in would cement the
 * subject mismatch this phase's re-scope block explicitly declines to
 * "fix" by waiving on the wrong basis, rather than merely preserving
 * compatibility until the real fix lands. Phase 32 is EXPECTED to change
 * exactly those paths, generalizing the subject model onto
 * `researchEntitlements`'s snapshot contract (plan 29-10), and this test is
 * EXPECTED to be revised then — treat it as a preservation gate with a
 * known expiry, not a permanent contract (review finding 29-10 MEDIUM).
 *
 * Mirrors the discovery/exact-set-equality/anti-vacuous-pass-guard style of
 * `apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts` and
 * this phase's own `tenantAccessEnumeration.test.ts`/
 * `serverEmitterAudit.test.ts` precedents.
 */

const REPORTS_ROUTE_PATH = resolve('src/routes/reports.ts');
const REPORTS_ROUTE_SOURCE = readFileSync(REPORTS_ROUTE_PATH, 'utf-8');

/** Strips `//` line comments and `/* ... *\/` block comments only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const COMMENT_STRIPPED_SOURCE = stripComments(REPORTS_ROUTE_SOURCE);

// ---------------------------------------------------------------------------
// Structural scan of the report route file itself.
// ---------------------------------------------------------------------------

describe('reportsSubjectBoundary: structural scan of the report route (RTEN-05A)', () => {
  it('anti-vacuous-pass guard: discovers a non-trivial amount of source to scan (a silently-empty/missing-file read would make every case below vacuously pass)', () => {
    expect(REPORTS_ROUTE_SOURCE.length).toBeGreaterThan(1000);
    expect(COMMENT_STRIPPED_SOURCE.length).toBeGreaterThan(1000);
  });

  it('never opts into the shared subject preHandler (app.resolveSubject)', () => {
    expect(COMMENT_STRIPPED_SOURCE).not.toMatch(/app\.resolveSubject/);
  });

  it('never reads the tenant membership tree or the tenant metadata tree directly — its only path to tenant context is the classifier', () => {
    expect(COMMENT_STRIPPED_SOURCE).not.toMatch(/clientMembers/);
    expect(COMMENT_STRIPPED_SOURCE).not.toMatch(/clientTenants/);
  });

  it('imports the classifier from research/reportSubject — the ONE tenant-context entry point this route uses', () => {
    expect(COMMENT_STRIPPED_SOURCE).toMatch(/classifyReportSubject/);
    expect(COMMENT_STRIPPED_SOURCE).toMatch(/from ['"]\.\.\/research\/reportSubject\.js['"]/);
  });
});

// ---------------------------------------------------------------------------
// Behavioral exercise of the classifier's five ordered checks — deleting or
// reordering any one of them must fail one of the cases below, not merely
// this file's prose.
// ---------------------------------------------------------------------------

const UID = 'boundary-caller-uid-1';
const RESEARCH_TENANT_ID = 'boundary-research-tenant-1';
const ORDINARY_TENANT_ID = 'boundary-ordinary-tenant-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** Wraps a `Database`, counting every `.ref(...)` call — a proxy for "was a database reference constructed". */
function countingDatabase(database: Database): { database: Database; refCount: () => number } {
  let refCount = 0;
  const spied = {
    ref: (path?: string) => {
      refCount += 1;
      return database.ref(path);
    },
  } as unknown as Database;
  return { database: spied, refCount: () => refCount };
}

/** A `Database` whose `.ref(path).get()` throws for any path starting with `throwOnPrefix`, delegating everything else to `base`. */
function selectiveThrowDatabase(base: FakeDatabase, throwOnPrefix: string): Database {
  return {
    ref: (path?: string) => {
      if (path !== undefined && path.startsWith(throwOnPrefix)) {
        return {
          get: async () => {
            throw new Error('simulated read failure');
          },
        };
      }
      return base.ref(path);
    },
  } as unknown as Database;
}

function seedResearchTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'research' });
}

function seedOrdinaryTenant(database: FakeDatabase, tenantId: string): void {
  database.seed(`clientTenants/${tenantId}`, { createdAt: 1, archivedAt: null, kind: 'coaching' });
}

function seedMembership(database: FakeDatabase, tenantId: string, uid: string): void {
  database.seed(`clientMembers/${tenantId}/${uid}`, { role: 'custodian', joinedAt: 1 });
}

describe('reportsSubjectBoundary: the classifier still contains all five ordered checks', () => {
  it('check 1 (personal/absent header): absent header -> not-applicable with zero reads', async () => {
    const { database, refCount } = countingDatabase(asDatabase(new FakeDatabase()));
    await expect(classifyReportSubject({ database, uid: UID, header: undefined })).resolves.toBe(
      'not-applicable',
    );
    expect(refCount()).toBe(0);
  });

  it("check 2 (malformed prefix / empty tenant id): a header lacking the 'client:' prefix -> not-applicable, never throws", async () => {
    const database = asDatabase(new FakeDatabase());
    await expect(
      classifyReportSubject({ database, uid: UID, header: 'not-a-client-header' }),
    ).resolves.toBe('not-applicable');
  });

  it('check 3 / key-shape-ordering guard: a path-illegal tenant id -> not-applicable with ZERO database references constructed. If this ever fails, the shape check has been moved below the membership interpolation and a caller-supplied id can crash the route', async () => {
    const { database, refCount } = countingDatabase(asDatabase(new FakeDatabase()));
    await expect(
      classifyReportSubject({ database, uid: UID, header: 'client:tenant.with.dots' }),
    ).resolves.toBe('not-applicable');
    expect(refCount()).toBe(0);
  });

  it('malformed-versus-infrastructure classification guard: a path-illegal id yields not-applicable while a rejecting membership read yields indeterminate', async () => {
    const shapeDatabase = asDatabase(new FakeDatabase());
    await expect(
      classifyReportSubject({
        database: shapeDatabase,
        uid: UID,
        header: 'client:tenant.with.dots',
      }),
    ).resolves.toBe('not-applicable');

    const fake = new FakeDatabase();
    seedResearchTenant(fake, RESEARCH_TENANT_ID);
    const throwingDatabase = selectiveThrowDatabase(fake, `clientMembers/${RESEARCH_TENANT_ID}`);
    await expect(
      classifyReportSubject({
        database: throwingDatabase,
        uid: UID,
        header: `client:${RESEARCH_TENANT_ID}`,
      }),
    ).resolves.toBe('indeterminate');
  });

  it('check 4 / ordering/no-oracle guard: a non-member naming a real research tenant receives not-applicable. If this ever fails, membership has been reordered after kind and the route has become an enumeration oracle', async () => {
    const fake = new FakeDatabase();
    seedResearchTenant(fake, RESEARCH_TENANT_ID);
    // Deliberately no membership record for UID.
    await expect(
      classifyReportSubject({
        database: asDatabase(fake),
        uid: UID,
        header: `client:${RESEARCH_TENANT_ID}`,
      }),
    ).resolves.toBe('not-applicable');
  });

  it('check 5 (kind resolution): a MEMBER of a research tenant receives research; a MEMBER of an ordinary tenant receives not-applicable', async () => {
    const researchDb = new FakeDatabase();
    seedResearchTenant(researchDb, RESEARCH_TENANT_ID);
    seedMembership(researchDb, RESEARCH_TENANT_ID, UID);
    await expect(
      classifyReportSubject({
        database: asDatabase(researchDb),
        uid: UID,
        header: `client:${RESEARCH_TENANT_ID}`,
      }),
    ).resolves.toBe('research');

    const ordinaryDb = new FakeDatabase();
    seedOrdinaryTenant(ordinaryDb, ORDINARY_TENANT_ID);
    seedMembership(ordinaryDb, ORDINARY_TENANT_ID, UID);
    await expect(
      classifyReportSubject({
        database: asDatabase(ordinaryDb),
        uid: UID,
        header: `client:${ORDINARY_TENANT_ID}`,
      }),
    ).resolves.toBe('not-applicable');
  });
});

// ---------------------------------------------------------------------------
// Behavioral unreachability proof: a research-subject submission produces
// no job, so the stale-job sweep has nothing to sweep. See
// `serverEmitterAudit.test.ts` for the emission-side half of this proof.
// ---------------------------------------------------------------------------

describe('reportsSubjectBoundary: a refused research-subject submission leaves nothing for the stale-job sweep', () => {
  it("the classifier alone (the route's only gate) refuses BEFORE any job write could occur, for both the research and indeterminate outcomes", async () => {
    const researchDb = new FakeDatabase();
    seedResearchTenant(researchDb, RESEARCH_TENANT_ID);
    seedMembership(researchDb, RESEARCH_TENANT_ID, UID);
    const researchResult = await classifyReportSubject({
      database: asDatabase(researchDb),
      uid: UID,
      header: `client:${RESEARCH_TENANT_ID}`,
    });
    expect(researchResult).not.toBe('not-applicable');

    const throwingDb = new FakeDatabase();
    seedResearchTenant(throwingDb, RESEARCH_TENANT_ID);
    const indeterminateResult = await classifyReportSubject({
      database: selectiveThrowDatabase(throwingDb, `clientMembers/${RESEARCH_TENANT_ID}`),
      uid: UID,
      header: `client:${RESEARCH_TENANT_ID}`,
    });
    expect(indeterminateResult).not.toBe('not-applicable');

    // Neither database gained a reportJobs entry — the route's refusal
    // (proven end-to-end in reports.test.ts) is what keeps it that way;
    // this asserts the classifier's own contract that makes the refusal
    // possible in the first place.
    expect((researchDb.dump() as Record<string, unknown>).reportJobs).toBeUndefined();
    expect((throwingDb.dump() as Record<string, unknown>).reportJobs).toBeUndefined();
  });
});
