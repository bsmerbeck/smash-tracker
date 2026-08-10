/**
 * Phase 30.1 Task 2.6 freeze-baseline probe (owner-run, READ-ONLY).
 *
 * Prints the frozen migration baseline for the four source research tenants:
 * per-tree record counts for every `copy` descriptor — counted via the
 * migration module's own `enumerateRecords`, so the numbers are
 * definitionally comparable to the per-tree source counts the `copy`
 * manifest reports later (step 9 reconciles against THIS table) — plus each
 * tenant's `activeRunId` (must be absent) and published coverage `asOfMs`,
 * and an existence check for every `assert-empty` tree.
 *
 * Zero writes. Exits non-zero if any tenant still has an active run or any
 * assert-empty tree is non-empty, so a dirty freeze cannot look clean.
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/freezeBaselineProbe.ts
 *
 * Bootstrap mirrors uatResearchDrive.ts (ADC + known prod URL); no start.gg
 * token is needed — this probe never talks to the provider.
 */
import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import {
  enumerateRecords,
  isAssertEmptyDescriptor,
  isCopyDescriptor,
  TREE_DESCRIPTORS,
} from '../src/research/migration/manifest.js';
import { readTenantIngestionState } from '../src/research/ingestion/backfillRun.js';
import { readCoverageSnapshot } from '../src/research/ingestion/rollup.js';
import { isPathSafeTenantId } from '../src/research/subjectKind.js';

const DATABASE_URL = 'https://smash-tracker-f97b7.firebaseio.com';

const SOURCE_WORKSPACES = [
  { label: 'hungrybox', tenantId: '0f0443e4-c637-4dd4-9c3a-c8365c1f7ad6' },
  { label: 'mkleo', tenantId: 'd4c17fdc-be36-49a1-8223-e0a3ab16a40c' },
  { label: 'sparg0', tenantId: 'e5d9f25d-929d-4884-875d-67cfab05d5c1' },
  { label: 'izaw', tenantId: '1438981f-2830-469d-ac96-cca1ee8cc75b' },
] as const;

const app = initializeApp({
  credential: applicationDefault(),
  databaseURL: DATABASE_URL,
});
const db = getDatabase(app);

async function main(): Promise<void> {
  const copyDescriptors = TREE_DESCRIPTORS.filter(isCopyDescriptor);
  const assertEmptyDescriptors = TREE_DESCRIPTORS.filter(isAssertEmptyDescriptor);

  console.log('## Task 2.6 Frozen Baseline (read-only probe)');
  console.log('');
  console.log(`Probed ${new Date().toISOString()} against \`${DATABASE_URL}\`.`);
  console.log('');

  const treeNames = copyDescriptors.map((descriptor) => descriptor.tree);
  console.log(
    `| Workspace | activeRunId | Coverage asOf | ${treeNames.join(' | ')} | Assert-empty violations |`,
  );
  console.log(`|---|---|---|${treeNames.map(() => '---').join('|')}|---|`);

  let dirty = false;

  for (const workspace of SOURCE_WORKSPACES) {
    if (!isPathSafeTenantId(workspace.tenantId)) {
      throw new Error(`Unsafe tenantId: ${workspace.tenantId}`);
    }

    const state = await readTenantIngestionState(db, workspace.tenantId);
    const activeRunId = state?.activeRunId ?? null;
    if (activeRunId !== null) {
      dirty = true;
    }

    const coverage = await readCoverageSnapshot(db, workspace.tenantId);
    const asOf =
      coverage === null ? 'NO PUBLISHED COVERAGE' : new Date(coverage.asOfMs).toISOString();
    if (coverage === null) {
      dirty = true;
    }

    const counts: number[] = [];
    for (const descriptor of copyDescriptors) {
      const records = await enumerateRecords(db, descriptor, workspace.tenantId);
      counts.push(records.size);
    }

    const violations: string[] = [];
    for (const descriptor of assertEmptyDescriptors) {
      const snapshot = await db.ref(`${descriptor.tree}/${workspace.tenantId}`).get();
      if (snapshot.exists()) {
        violations.push(descriptor.tree);
      }
    }
    if (violations.length > 0) {
      dirty = true;
    }

    console.log(
      `| ${workspace.label} | ${activeRunId ?? 'none'} | ${asOf} | ${counts.join(' | ')} | ${
        violations.length > 0 ? violations.join(', ') : 'none'
      } |`,
    );
  }

  console.log('');
  if (dirty) {
    console.log(
      'NOT FREEZABLE: an active run, missing coverage snapshot, or assert-empty violation was found above.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      'Freezable: zero active runs, published coverage on all four tenants, all assert-empty trees empty.',
    );
    console.log('Paste the table above into 30.1-04-SUMMARY.md as the Task 2.6 frozen baseline.');
  }
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void deleteApp(app);
  });
