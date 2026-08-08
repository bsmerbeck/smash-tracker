import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { CANONICAL_TENANT_TREES } from '../coaching/tenants.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { createResearchTenant } from './tenants.js';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate): two structural
 * properties, machine-enforced against real paths — mirrors the tree-scan
 * style of `apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts`
 * rather than reinventing it.
 *
 * Block 1 (RTEN-07): no auth principal is ever fabricated for a researched
 * subject. The production auth-principal creation call-site set is EXACTLY
 * the two known integration files (`routes/parryggAuth.ts`,
 * `routes/startgg.ts`) — both verified against the real Admin SDK's
 * `createUser({...})` call shape, source-grounded during replanning at
 * `apps/api/src/routes/parryggAuth.ts:181` and
 * `apps/api/src/routes/startgg.ts:213` (both live under `routes/`, not
 * `parrygg/`).
 *
 * Block 2 (RTEN-06): research content occupies no admin-uid-keyed content
 * tree — proven against the imported `CANONICAL_TENANT_TREES` list, never a
 * re-typed copy of it.
 */

const SRC_ROOT = resolve('src');
const TEST_SUPPORT_DIR = resolve('src/test-support');
const RESEARCH_DIR = resolve('src/research');

/**
 * Matches BOTH a call site (`app.firebase.auth.createUser({...})`) AND the
 * fake's own method DEFINITION (`async createUser(properties...)`) — a
 * leading-dot-only pattern would miss the definition in
 * `test-support/fakeAuth.ts`, silently emptying the exclusion-pinning
 * assertion below.
 */
const AUTH_PRINCIPAL_CREATION_PATTERN = /\bcreateUser\(/;
const FIREBASE_AUTH_IMPORT_PATTERN = /from ['"]firebase-admin\/auth['"]/;

/**
 * Recursively collects every non-test `.ts` source file under `dir`,
 * skipping any directory listed in `excludeDirs` entirely (mirrors
 * `prepStructuralIntegrity.test.ts`'s `collectSourceFiles`).
 */
function collectSourceFiles(dir: string, excludeDirs: string[] = []): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (excludeDirs.includes(fullPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath, excludeDirs));
      continue;
    }
    if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * The production scan: every non-test `.ts` file under `src/`, EXCLUDING
 * `test-support/` (cycle-2 finding C2-MED-5). Excluding only `*.test.ts`
 * would leave `test-support/fakeAuth.ts` in this set — it mirrors
 * `createUser` around its own line 58 and is a non-`.test.ts` SOURCE file —
 * so the exact-set assertion below would fail against a legitimate test
 * double. Written reason: `test-support/` holds doubles that emulate the
 * Admin SDK for tests and NEVER runs in production.
 */
const productionFiles = collectSourceFiles(SRC_ROOT, [TEST_SUPPORT_DIR]);

/** Everything under `test-support/` — used only to PIN the exclusion above. */
const testSupportFiles = collectSourceFiles(TEST_SUPPORT_DIR);

const researchFiles = productionFiles.filter((file) => file.startsWith(`${RESEARCH_DIR}/`));

describe('no fabricated auth principal outside the two known integration sites (RTEN-07)', () => {
  it('anti-vacuous-pass guard: the scan discovers a non-zero number of production files', () => {
    expect(productionFiles.length).toBeGreaterThan(0);
  });

  it('both known auth-principal integration sites resolve to real files (a rename must fail this suite, not silently pass)', () => {
    expect(existsSync(resolve('src/routes/parryggAuth.ts'))).toBe(true);
    expect(existsSync(resolve('src/routes/startgg.ts'))).toBe(true);
  });

  it('the production auth-principal creation set is EXACTLY the two known integration files', () => {
    const matching = new Set(
      productionFiles.filter((file) =>
        AUTH_PRINCIPAL_CREATION_PATTERN.test(readFileSync(file, 'utf-8')),
      ),
    );

    expect(matching).toEqual(
      new Set([resolve('src/routes/parryggAuth.ts'), resolve('src/routes/startgg.ts')]),
    );
  });

  it('`test-support/` is excluded from the production scan (written reason: it holds Admin SDK doubles that never run in production)', () => {
    expect(productionFiles.some((file) => file.startsWith(`${TEST_SUPPORT_DIR}/`))).toBe(false);
  });

  it('pins the exclusion: within test-support/, the auth-principal creation set is EXACTLY fakeAuth.ts (a new production-shaped file there must fail this suite)', () => {
    expect(testSupportFiles.length).toBeGreaterThan(0);
    const matching = testSupportFiles.filter((file) =>
      AUTH_PRINCIPAL_CREATION_PATTERN.test(readFileSync(file, 'utf-8')),
    );

    expect(matching).toEqual([resolve('src/test-support/fakeAuth.ts')]);
  });

  it('no file under src/research/ creates an auth principal', () => {
    expect(researchFiles.length).toBeGreaterThan(0);
    const matching = researchFiles.filter((file) =>
      AUTH_PRINCIPAL_CREATION_PATTERN.test(readFileSync(file, 'utf-8')),
    );

    expect(matching).toEqual([]);
  });

  it('no file under src/research/ imports the Firebase auth client', () => {
    const matching = researchFiles.filter((file) =>
      FIREBASE_AUTH_IMPORT_PATTERN.test(readFileSync(file, 'utf-8')),
    );

    expect(matching).toEqual([]);
  });
});

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

describe('research content lands under tenant-keyed trees only (RTEN-06)', () => {
  it('imports CANONICAL_TENANT_TREES rather than re-typing tree names', () => {
    expect(CANONICAL_TENANT_TREES.length).toBeGreaterThan(0);
  });

  it('no canonical tenant tree contains a key equal to the admin uid after a research tenant is created', async () => {
    const database = new FakeDatabase();
    const adminUid = 'admin-uid-1';

    await createResearchTenant(asDatabase(database), adminUid, 'Hbox snapshot');

    const dump = database.dump() as Record<string, unknown>;
    for (const tree of CANONICAL_TENANT_TREES) {
      const treeNode = dump[tree] as Record<string, unknown> | undefined;
      if (treeNode) {
        expect(Object.prototype.hasOwnProperty.call(treeNode, adminUid)).toBe(false);
      }
    }
  });

  it('the tenant record, membership record, and index entry land at their expected tenant-keyed/index paths', async () => {
    const database = new FakeDatabase();
    const adminUid = 'admin-uid-1';

    const { tenantId } = await createResearchTenant(
      asDatabase(database),
      adminUid,
      'Hbox snapshot',
    );

    const dump = database.dump() as Record<string, unknown>;
    expect((dump.clientTenants as Record<string, unknown> | undefined)?.[tenantId]).toBeDefined();
    expect(
      (dump.clientMembers as Record<string, unknown> | undefined)?.[tenantId] as
        Record<string, unknown> | undefined,
    ).toHaveProperty(adminUid);
    // Documented exception: coachClients/{adminUid}/{tenantId} is membership
    // ROUTING (the per-admin index), not research CONTENT — identical to
    // what the coaching tenancy already writes for every coaching tenant.
    // It is intentionally admin-uid-keyed and is deliberately NOT part of
    // CANONICAL_TENANT_TREES (it isn't a `{tree}/{tenantId}`-shaped tree at
    // all; it's `coachClients/{adminUid}/{tenantId}`).
    expect(
      (dump.coachClients as Record<string, unknown> | undefined)?.[adminUid] as
        Record<string, unknown> | undefined,
    ).toHaveProperty(tenantId);
  });
});
