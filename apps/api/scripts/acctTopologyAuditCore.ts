import type { Database } from 'firebase-admin/database';
import { isPathSafeTenantId } from '../src/research/subjectKind.js';
import {
  createGate6Monitor,
  createGate6Reader,
  GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
  GATE6_DEFAULT_MAX_STALL_MS,
} from './gate6AuditCore.js';

/**
 * Phase 30.1 (Demo Account Topology & Migration, ACCT-01/ACCT-03): a READ-ONLY
 * proof of the clause "none of the four is a managed client of the developer's
 * coaching account".
 *
 * TWO HALVES, AND THE SECOND ONE IS THE POINT. An earlier revision of this
 * operator checked only whether each destination demo UID was a member or owner
 * of a managed tenant. Codex's hard gate at `fb9a3930` rejected that as P0: it
 * misses the exact topology the owner correction was written to eliminate. The
 * four player-named SOURCE research tenants are still present as
 * `coachClients/{developerUid}/{sourceTenantId}` rows with the developer as
 * custodian, labelled "Hungrybox", "MkLeo", "Sparg0", "IzAw". Those rows render
 * in the developer's Client Hub whenever `archivedAt` is null — and the
 * destination UIDs need not be members of them, so a UID-only audit returns PASS
 * while the rejected topology is plainly visible. Both halves run here:
 *
 * 1. SUBJECT half — is a destination UID a member of one of the coach's tenants
 *    (`clientMembers/{tenantId}/{uid}`), or the owner of a managed tenant
 *    (`clientOwnedTenants/{uid}/{tenantId}`, the v2.4 claim link)?
 * 2. SOURCE half — is any of the four canonical source tenants still VISIBLE as
 *    a player-named managed client? Visible means the `coachClients` row exists
 *    with `archivedAt == null`, which is exactly `listClients`'s own filter
 *    (`coaching/tenants.ts` — `!includeArchived && archivedAt != null` drops it).
 *
 * WHY NOT `readSubjectKind`. A prior report proposed gating on
 * `readSubjectKind(uid) === 'ordinary'`, reasoning that a `coaching`-kind tenant
 * resolves to `'ordinary'` and would slip through. The mapping is real but
 * unreachable: `clientTenants` is keyed by `randomUUID()` and never by a uid
 * (`coaching/tenants.ts` — "a fresh, coach-independent tenantId (never derived
 * from ownerUid)"), so `clientTenants/{someUid}` is structurally impossible and
 * `readSubjectKind` of a uid is correctly `'ordinary'`. Changing that predicate
 * would alter Phase-29 research-isolation semantics repo-wide and prove nothing
 * about this clause.
 *
 * BOUNDEDNESS — STATED HONESTLY. The membership sweep enumerates the whole
 * `coachClients/{coachUid}` node. That is NOT capped at
 * `MAX_ACTIVE_CLIENTS_PER_COACH`: that constant limits ACTIVE clients, while
 * archived rows keep their `coachClients` entry (`archiveClient` sets
 * `archivedAt`, it does not remove the row), so the node grows without a hard
 * ceiling. The real bound is the per-read deadline plus the no-progress watchdog
 * supplied by the shared Gate-6 reader/monitor, not a row-count constant.
 *
 * READS ONLY — constructs no write of any kind. Fixture-tested against
 * `FakeDatabase` (`acctTopologyAuditCore.test.ts`) and driven under a real
 * lifecycle by `acctTopologyAuditHarness.ts`; the owner-run CLI
 * (`acctTopologyAudit.ts`) is the only caller that ever passes a real
 * `Database`.
 */

/** A destination demo account under audit. */
export interface AcctTopologySubject {
  label: string;
  uid: string;
}

/** One canonical source tenant, from the migration manifest's `sourceToDestMap`. */
export interface AcctTopologySourceTenant {
  sourceId: string;
  destUid: string;
  label: string;
}

export type AcctTopologyViolation =
  /** A destination UID is a member of one of the coach's client tenants. */
  | 'coach-tenant-member'
  /** A destination UID owns a managed client tenant (v2.4 claim link). */
  | 'owns-managed-tenant'
  /** A player-named source tenant is still visible in the developer's Client Hub. */
  | 'source-tenant-visible';

export interface AcctTopologyFinding {
  /**
   * Deliberately NOT named `code`: `demoMoneyGuards.test.ts` locks the files
   * permitted to put a `code` member in a response envelope to exactly one
   * (`src/routes/billing.ts`). This is an offline audit classifier, not a
   * response surface, and extending that allowlist for a name would weaken a
   * no-oracle guard.
   */
  violation: AcctTopologyViolation;
  label: string;
  /** The destination UID, or `null` for a source-tenant finding (a tenant, not a uid). */
  uid: string | null;
  tenantId: string;
  detail: string;
}

/** The live disposition of one canonical source tenant. */
export interface AcctTopologySourceDisposition {
  sourceId: string;
  label: string;
  destUid: string;
  /** A `coachClients/{coachUid}/{sourceId}` row exists. */
  inCoachClients: boolean;
  coachClientsArchivedAt: number | null;
  /** A `clientTenants/{sourceId}` row exists. */
  clientTenantPresent: boolean;
  clientTenantArchivedAt: number | null;
  /** Exactly `listClients`'s filter: present under coachClients AND not archived. */
  visibleInClientHub: boolean;
}

export interface AcctTopologyAuditResult {
  ok: boolean;
  coachUid: string;
  /** The SEALED label->uid map actually audited — a receipt must never claim "four" without naming which four. */
  subjects: AcctTopologySubject[];
  coachTenantIds: string[];
  membershipReads: number;
  sourceDispositions: AcctTopologySourceDisposition[];
  visibleSourceTenantCount: number;
  findings: AcctTopologyFinding[];
}

export interface AcctTopologyAuditOptions {
  coachUid: string;
  /** Exactly four, all distinct, none equal to `coachUid`. */
  subjects: readonly AcctTopologySubject[];
  /** Exactly four, from the validated migration manifest. */
  sourceTenants: readonly AcctTopologySourceTenant[];
  requestTimeoutMs?: number;
  maxStallMs?: number;
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  clock?: () => number;
}

export const ACCT_TOPOLOGY_EXPECTED_SUBJECTS = 4;

function assertPathSafe(value: string, what: string): void {
  if (!isPathSafeTenantId(value)) {
    throw new Error(`${what} is not a path-safe id: ${JSON.stringify(value)}`);
  }
}

function readArchivedAt(node: unknown): number | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const value = (node as Record<string, unknown>).archivedAt;
  return typeof value === 'number' ? value : null;
}

/**
 * Validates the subject set BEFORE any read: exactly four, all path-safe, all
 * distinct, and none equal to the coach. Without the distinctness rules the
 * same uid supplied four times produces a receipt that reads as four-account
 * coverage while proving one (Codex hard gate at `fb9a3930`, P1).
 */
export function assertFourDistinctSubjects(
  coachUid: string,
  subjects: readonly AcctTopologySubject[],
): void {
  assertPathSafe(coachUid, 'coachUid');

  if (subjects.length !== ACCT_TOPOLOGY_EXPECTED_SUBJECTS) {
    throw new Error(
      `exactly ${ACCT_TOPOLOGY_EXPECTED_SUBJECTS} destination uids are required, received ${subjects.length} — ` +
        'this is a four-account clause and has no reduced form',
    );
  }

  const seen = new Map<string, string>();
  for (const subject of subjects) {
    assertPathSafe(subject.uid, `subject uid for ${subject.label}`);
    if (subject.uid === coachUid) {
      throw new Error(
        `subject ${subject.label} has the same uid as --coach-uid; a destination account cannot be the coach`,
      );
    }
    const previous = seen.get(subject.uid);
    if (previous !== undefined) {
      throw new Error(
        `duplicate destination uid: ${subject.label} and ${previous} resolve to the same uid — ` +
          'four distinct accounts are required, not the same account four times',
      );
    }
    seen.set(subject.uid, subject.label);
  }
}

/** Read-only audit of the ACCT-01/ACCT-03 no-managed-client clause. */
export async function auditAcctTopology(
  database: Database,
  options: AcctTopologyAuditOptions,
): Promise<AcctTopologyAuditResult> {
  const { coachUid, subjects, sourceTenants } = options;

  assertFourDistinctSubjects(coachUid, subjects);
  if (sourceTenants.length !== ACCT_TOPOLOGY_EXPECTED_SUBJECTS) {
    throw new Error(
      `exactly ${ACCT_TOPOLOGY_EXPECTED_SUBJECTS} source tenants are required (from the migration manifest), received ${sourceTenants.length}`,
    );
  }
  for (const source of sourceTenants) {
    assertPathSafe(source.sourceId, `sourceId for ${source.label}`);
  }

  const monitor = createGate6Monitor(
    {
      signal: options.signal,
      maxStallMs: options.maxStallMs ?? GATE6_DEFAULT_MAX_STALL_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
      log: options.log,
      clock: options.clock,
    },
    'acct-topology',
  );

  try {
    const reader = createGate6Reader(database, {
      requestTimeoutMs: options.requestTimeoutMs,
      signal: monitor.signal,
      onRead: (path) => monitor.onProgress(path),
    });

    const run = async (): Promise<AcctTopologyAuditResult> => {
      const findings: AcctTopologyFinding[] = [];

      // --- 1. The coach's client tenants. Not row-count bounded; see header. --
      const coachClients = await reader.children(`coachClients/${coachUid}`);
      const coachTenantIds = coachClients.map(([tenantId]) => tenantId);

      // --- 2. Subject half: membership in one of the coach's tenants. --------
      let membershipReads = 0;
      for (const tenantId of coachTenantIds) {
        assertPathSafe(tenantId, `tenantId under coachClients/${coachUid}`);
        for (const subject of subjects) {
          const membership = await reader.raw(`clientMembers/${tenantId}/${subject.uid}`);
          membershipReads += 1;
          if (membership !== null) {
            findings.push({
              violation: 'coach-tenant-member',
              label: subject.label,
              uid: subject.uid,
              tenantId,
              detail: `${subject.label} is a member of the coach's client tenant ${tenantId}`,
            });
          }
        }
      }

      // --- 3. Subject half: ownership of a managed tenant, under ANY coach. --
      for (const subject of subjects) {
        const owned = await reader.children(`clientOwnedTenants/${subject.uid}`);
        for (const [tenantId] of owned) {
          findings.push({
            violation: 'owns-managed-tenant',
            label: subject.label,
            uid: subject.uid,
            tenantId,
            detail: `${subject.label} owns managed client tenant ${tenantId}`,
          });
        }
      }

      // --- 4. SOURCE half: is a player-named source tenant still visible? ----
      const sourceDispositions: AcctTopologySourceDisposition[] = [];
      for (const source of sourceTenants) {
        const coachRow = await reader.raw(`coachClients/${coachUid}/${source.sourceId}`);
        const tenantRow = await reader.raw(`clientTenants/${source.sourceId}`);

        const inCoachClients = coachRow !== null;
        const coachClientsArchivedAt = readArchivedAt(coachRow);
        const visibleInClientHub = inCoachClients && coachClientsArchivedAt === null;

        sourceDispositions.push({
          sourceId: source.sourceId,
          label: source.label,
          destUid: source.destUid,
          inCoachClients,
          coachClientsArchivedAt,
          clientTenantPresent: tenantRow !== null,
          clientTenantArchivedAt: readArchivedAt(tenantRow),
          visibleInClientHub,
        });

        if (visibleInClientHub) {
          findings.push({
            violation: 'source-tenant-visible',
            label: source.label,
            uid: null,
            tenantId: source.sourceId,
            detail:
              `source tenant ${source.sourceId} is still an ACTIVE managed client of the developer ` +
              `(coachClients/${coachUid}/${source.sourceId}, archivedAt=null) and renders in the ` +
              `Client Hub labelled "${source.label}" — the exact topology the owner correction removes`,
          });
        }
      }

      const visibleSourceTenantCount = sourceDispositions.filter(
        (d) => d.visibleInClientHub,
      ).length;

      return {
        ok: findings.length === 0,
        coachUid,
        subjects: subjects.map((s) => ({ ...s })),
        coachTenantIds,
        membershipReads,
        sourceDispositions,
        visibleSourceTenantCount,
        findings,
      };
    };

    // Raced against the watchdog so a stall fails the run even when nothing
    // abortable is in flight.
    return await Promise.race([run(), monitor.stallPromise]);
  } finally {
    monitor.dispose();
  }
}
