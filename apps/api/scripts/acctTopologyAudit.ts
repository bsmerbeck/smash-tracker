/**
 * ACCT TOPOLOGY AUDIT — Phase 30.1 ACCT-01/ACCT-03 (READ-ONLY).
 *
 * Proves against LIVE production that none of the four demo accounts appears as
 * a managed client of the developer's coaching account. This is the evidence
 * half of the clause: the production copy already ran (2026-08-11), so
 * `preflightDestinations` — which gates a migration before it starts — cannot
 * say anything about it. Only a read of the current trees can.
 *
 * Two violation classes, both keyed by a real Firebase uid:
 *   - `coach-tenant-member`   clientMembers/{tenantId}/{uid} under one of the
 *                             coach's own tenants.
 *   - `owns-managed-tenant`   clientOwnedTenants/{uid}/{tenantId} — the v2.4
 *                             claim link, checked against ANY coach.
 *
 * NOT checked via `readSubjectKind`: `clientTenants` is keyed by `randomUUID()`
 * and never by a uid, so `clientTenants/{demoUid}` is structurally impossible
 * and that predicate is correctly `'ordinary'` for any uid. See the core module
 * (`apps/api/src/research/migration/acctTopologyAudit.ts`) for the full note.
 *
 * USAGE (no `--help` is implemented — this docstring is the interface, matching
 * the other operators in this directory):
 *
 *   pnpm --filter @smash-tracker/api exec tsx scripts/acctTopologyAudit.ts \
 *     --coach-uid "$COACH_UID" \
 *     --hbox-uid "$HBOX_UID" --mkleo-uid "$MKLEO_UID" \
 *     --sparg0-uid "$SPARG0_UID" --izaw-uid "$IZAW_UID" \
 *     --out ./acct-topology-audit.json
 *
 * FLAGS
 *   --coach-uid <uid>           REQUIRED. The developer's coaching account.
 *   --hbox-uid / --mkleo-uid / --sparg0-uid / --izaw-uid   REQUIRED, all four.
 *   --out <path>                Optional JSON receipt.
 *   --allow-empty-coach-tree    Opt in to a PASS when the coach has zero client
 *                               tenants. Without it, an empty tree exits nonzero
 *                               (`coach-tree-empty`): the membership sweep then
 *                               checked nothing, and a mistyped coach uid is far
 *                               likelier than a coach with no clients. Never set
 *                               this to make a red run go green.
 *
 * EXIT CODES: 0 only when zero findings AND the sweep was not vacuous (or its
 * vacuousness was explicitly acknowledged). Any finding, any malformed input, or
 * an unacknowledged empty coach tree exits 1.
 *
 * This script performs READS ONLY — it constructs no write of any kind. Its only
 * output side effect is the optional `--out` file.
 */
import { writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import {
  auditAcctTopology,
  type AcctTopologySubject,
} from '../src/research/migration/acctTopologyAudit.js';

interface Args {
  coachUid: string;
  subjects: AcctTopologySubject[];
  outPath: string | null;
  allowEmptyCoachTree: boolean;
}

const SUBJECT_FLAGS: readonly { flag: string; label: string }[] = [
  { flag: '--hbox-uid', label: 'hbox' },
  { flag: '--mkleo-uid', label: 'mkleo' },
  { flag: '--sparg0-uid', label: 'sparg0' },
  { flag: '--izaw-uid', label: 'izaw' },
];

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let allowEmptyCoachTree = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (token === '--allow-empty-coach-tree') {
      allowEmptyCoachTree = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token, value);
    i += 1;
  }

  const coachUid = values.get('--coach-uid');
  if (!coachUid) {
    throw new Error('--coach-uid is required (the developer coaching account under audit)');
  }

  const subjects: AcctTopologySubject[] = [];
  const missing: string[] = [];
  for (const { flag, label } of SUBJECT_FLAGS) {
    const uid = values.get(flag);
    if (!uid) {
      missing.push(flag);
      continue;
    }
    subjects.push({ label, uid });
  }
  if (missing.length > 0) {
    throw new Error(
      `all four demo uids are required — missing ${missing.join(', ')}. ` +
        'This is a four-account clause; a partial run is not a reduced form of it.',
    );
  }

  return { coachUid, subjects, outPath: values.get('--out') ?? null, allowEmptyCoachTree };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const { app, database } = initFirebase(env);

  let exitCode = 0;
  try {
    const result = await auditAcctTopology(database, {
      coachUid: args.coachUid,
      subjects: args.subjects,
    });

    console.log(`coach tenants: ${result.coachTenantIds.length}`);
    console.log(`membership reads: ${result.membershipReads} (tenants x 4 subjects)`);

    if (result.findings.length > 0) {
      for (const finding of result.findings) {
        console.error(`FINDING [${finding.violation}] ${finding.detail}`);
      }
      console.error(
        'FAIL: ACCT-01/ACCT-03 no-managed-client clause is VIOLATED in production. ' +
          'Do not close the clause; escalate — this is a topology defect, not an audit bug.',
      );
      exitCode = 1;
    } else if (result.vacuousMembershipSweep && !args.allowEmptyCoachTree) {
      console.error(
        `FAIL [coach-tree-empty]: coachClients/${args.coachUid} is empty, so the membership ` +
          'sweep checked nothing and this run proves nothing about the coach tree. ' +
          'Confirm the coach uid is correct. If the coach genuinely has zero clients, ' +
          're-run with --allow-empty-coach-tree to record that deliberately.',
      );
      exitCode = 1;
    } else {
      if (result.vacuousMembershipSweep) {
        console.log(
          'NOTE: coach tree is empty; the membership sweep was vacuous and was explicitly ' +
            'acknowledged via --allow-empty-coach-tree. The ownership check still ran.',
        );
      }
      console.log(
        'PASS: none of the four demo accounts is a member of a coach client tenant or owns a managed tenant.',
      );
    }

    if (args.outPath) {
      const receipt = {
        receiptVersion: 1,
        audit: 'acct-topology',
        requirement: ['ACCT-01', 'ACCT-03'],
        databaseHost: new URL(env.FIREBASE_DATABASE_URL).host,
        allowEmptyCoachTree: args.allowEmptyCoachTree,
        exitCode,
        ...result,
      };
      await writeFile(args.outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      console.log(`[receipt] acct-topology: path=${args.outPath}`);
    }
  } finally {
    database.goOffline();
    await deleteApp(app);
  }

  process.exit(exitCode);
}

void main().then(undefined, (error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
