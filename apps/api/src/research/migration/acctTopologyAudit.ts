import type { Database } from 'firebase-admin/database';
import { isPathSafeTenantId } from '../subjectKind.js';

/**
 * Phase 30.1 (Demo Account Topology & Migration, ACCT-01/ACCT-03): a READ-ONLY
 * proof that none of the four demo accounts appears as a managed client of the
 * developer's coaching account.
 *
 * WHY THIS EXISTS SEPARATELY FROM `preflightDestinations`. That preflight gates
 * a migration *before* it runs; the production copy already ran (2026-08-11), so
 * a gate cannot produce evidence about it. The ACCT clause is a claim about
 * current production topology, and only a read of the live trees answers it.
 *
 * WHY IT DOES NOT GO THROUGH `readSubjectKind`. A prior report proposed checking
 * this via `readSubjectKind(uid) === 'ordinary'`, on the theory that a
 * `coaching`-kind tenant resolves to `'ordinary'` and would slip through. That
 * mapping is real but unreachable here: `clientTenants` is keyed by
 * `randomUUID()` and never by a uid (`coaching/tenants.ts` — "a fresh,
 * coach-independent tenantId (never derived from ownerUid)"), so
 * `clientTenants/{someUid}` is structurally impossible and `readSubjectKind` of a
 * uid is correctly `'ordinary'`. Changing that predicate would alter Phase-29
 * research-isolation semantics repo-wide and still prove nothing about this
 * clause.
 *
 * The trees that ARE keyed by a real uid are the two this module reads:
 * - `clientMembers/{tenantId}/{uid}` — membership in a coach's client tenant.
 * - `clientOwnedTenants/{uid}/{tenantId}` — the v2.4 claim link, written when a
 *   client account takes ownership of a managed workspace.
 *
 * BOUNDED BY CONSTRUCTION. The membership sweep is scoped to the coach's own
 * `coachClients/{coachUid}` list rather than scanning all of `clientMembers`,
 * which is both unbounded and broader than the clause. That list is capped by
 * `MAX_ACTIVE_CLIENTS_PER_COACH`, so the work is (coach tenants x subjects)
 * point reads plus one read per subject.
 *
 * READS ONLY — this module constructs no write of any kind. It is fixture-tested
 * against `FakeDatabase` (`acctTopologyAudit.test.ts`); the owner-run CLI
 * (`apps/api/scripts/acctTopologyAudit.ts`) is the only caller that ever passes a
 * real `Database`.
 */

/** A demo account under audit. `label` is for human-readable output only. */
export interface AcctTopologySubject {
  label: string;
  uid: string;
}

export type AcctTopologyViolation =
  /** The subject is a member of one of the coach's client tenants. */
  | 'coach-tenant-member'
  /** The subject owns a managed client tenant (v2.4 claim link). */
  | 'owns-managed-tenant';

export interface AcctTopologyFinding {
  /**
   * Deliberately NOT named `code`: `demoMoneyGuards.test.ts` locks the set of
   * files permitted to put a `code` member in a response envelope to exactly
   * one (`src/routes/billing.ts`), and this is an offline audit classifier, not
   * a response surface. Extending that allowlist to accommodate a name would
   * weaken a no-oracle guard for nothing.
   */
  violation: AcctTopologyViolation;
  label: string;
  uid: string;
  tenantId: string;
  detail: string;
}

export interface AcctTopologyAuditResult {
  /** True only when zero findings were produced AND the audit was not vacuous. */
  ok: boolean;
  coachUid: string;
  /** The coach's client tenants, from `coachClients/{coachUid}`. */
  coachTenantIds: string[];
  /**
   * True when the coach has no client tenants at all. The membership half of
   * the audit then proves nothing, because there was nothing to check it
   * against — far more often a mistyped coach uid than a coach with no
   * clients. Callers MUST refuse to read this run as a pass unless the
   * emptiness is explicitly expected. See the CLI's `--allow-empty-coach-tree`.
   */
  vacuousMembershipSweep: boolean;
  /** Membership point reads actually performed: coachTenantIds x subjects. */
  membershipReads: number;
  findings: AcctTopologyFinding[];
}

function assertPathSafe(value: string, what: string): void {
  if (!isPathSafeTenantId(value)) {
    throw new Error(`${what} is not a path-safe id: ${JSON.stringify(value)}`);
  }
}

/**
 * Read-only audit of the ACCT-01/ACCT-03 no-managed-client clause.
 *
 * Throws on a malformed id BEFORE any ref is constructed — a path-unsafe uid
 * interpolated into a ref throws inside firebase-admin anyway, and failing here
 * keeps the error attributable to the input rather than to the SDK.
 */
export async function auditAcctTopology(
  database: Database,
  options: { coachUid: string; subjects: readonly AcctTopologySubject[] },
): Promise<AcctTopologyAuditResult> {
  const { coachUid, subjects } = options;

  assertPathSafe(coachUid, 'coachUid');
  if (subjects.length === 0) {
    throw new Error('at least one subject uid is required — an empty subject set audits nothing');
  }
  for (const subject of subjects) {
    assertPathSafe(subject.uid, `subject uid for ${subject.label}`);
  }

  const findings: AcctTopologyFinding[] = [];

  // --- 1. The coach's own client tenants (bounded by the per-coach cap). ----
  const coachClientsSnapshot = await database.ref(`coachClients/${coachUid}`).get();
  const coachClients = coachClientsSnapshot.val();
  const coachTenantIds =
    coachClients !== null && typeof coachClients === 'object'
      ? Object.keys(coachClients as Record<string, unknown>)
      : [];

  // --- 2. Is any subject a member of one of those tenants? -----------------
  let membershipReads = 0;
  for (const tenantId of coachTenantIds) {
    assertPathSafe(tenantId, `tenantId under coachClients/${coachUid}`);
    for (const subject of subjects) {
      const snapshot = await database.ref(`clientMembers/${tenantId}/${subject.uid}`).get();
      membershipReads += 1;
      const membership = snapshot.val();
      if (membership !== null && membership !== undefined) {
        findings.push({
          violation: 'coach-tenant-member',
          label: subject.label,
          uid: subject.uid,
          tenantId,
          detail: `${subject.label} is a member of the coach's client tenant ${tenantId} (clientMembers/${tenantId}/${subject.uid} exists)`,
        });
      }
    }
  }

  // --- 3. Does any subject OWN a managed tenant, under any coach? ----------
  // Independent of the coach's list and of step 2's vacuousness — this catches
  // a v2.4 claim link even when `coachClients/{coachUid}` is empty or wrong.
  for (const subject of subjects) {
    const snapshot = await database.ref(`clientOwnedTenants/${subject.uid}`).get();
    const owned = snapshot.val();
    if (owned === null || owned === undefined || typeof owned !== 'object') {
      continue;
    }
    for (const tenantId of Object.keys(owned as Record<string, unknown>)) {
      findings.push({
        violation: 'owns-managed-tenant',
        label: subject.label,
        uid: subject.uid,
        tenantId,
        detail: `${subject.label} owns managed client tenant ${tenantId} (clientOwnedTenants/${subject.uid}/${tenantId} exists)`,
      });
    }
  }

  const vacuousMembershipSweep = coachTenantIds.length === 0;

  return {
    ok: findings.length === 0 && !vacuousMembershipSweep,
    coachUid,
    coachTenantIds,
    vacuousMembershipSweep,
    membershipReads,
    findings,
  };
}
