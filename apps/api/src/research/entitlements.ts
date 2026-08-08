import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  researchEntitlementRecordSchema,
  type ActiveGrant,
  type ResearchEntitlementRecord,
} from '@smash-tracker/shared';
import { ForbiddenError } from '../services/rtdb.js';
import { isResearchTenant } from './subjectKind.js';

/**
 * Phase 29 Plan 10 (Research Tenancy, Isolation & Governance Gate, RTEN-05A):
 * the tenant-scoped, history-preserving, replay-safe pilot entitlement
 * store — grant, revoke, and a read-only resolver. See
 * `packages/shared/src/researchEntitlement.ts` for the record shape, the
 * operations-index rationale (cycle-2 finding C2-HIGH-11), and the
 * money-safety charge-snapshot contract this plan ships but does not yet
 * attach anywhere — Phase 32 owns that attachment (plan 29-11's re-scope).
 *
 * D-11: this module imports NO event machinery and emits NOTHING anywhere
 * in its call graph — grant and revoke are telemetry-silent by
 * construction, not by a branch guard.
 *
 * This module performs exactly ONE authorization-adjacent check of its own:
 * refusing to grant onto a tenant that is not (or cannot be proven to be) a
 * research tenant (T-29-10-02). This is a DOMAIN invariant, not a duplicate
 * of the route guard's caller-authorization — by the time a request reaches
 * these functions through `apps/api/src/routes/research.ts`,
 * `requireResearchTenantAdmin` has already proven both "the caller is an
 * allowlisted admin who is a member of this tenant" AND "this tenant is a
 * research tenant". This check is defense in depth against that invariant
 * ever being violated by a future caller that reaches this module some
 * other way; it is exercised directly (bypassing the route/guard layer) by
 * this file's own unit tests. The read-only resolver below performs NO
 * authorization of any kind — see its own doc comment.
 */

function entitlementRef(database: Database, tenantId: string) {
  return database.ref(`researchEntitlements/${tenantId}`);
}

/**
 * Builds the exact object a transaction callback returns for one commit —
 * conditional spread only (house constraint 1): a field that is null/absent
 * is OMITTED from the returned object entirely, never written as a bare
 * `null`. Since a `.transaction()` return value replaces the WHOLE node,
 * omitting a key here is exactly equivalent to deleting that key — this is
 * how `activeGrant` is cleared on revoke without ever writing `activeGrant:
 * null` onto the wire.
 */
function buildStoredRecord(record: ResearchEntitlementRecord): Record<string, unknown> {
  const hasHistory = record.history != null && Object.keys(record.history).length > 0;
  const hasOperations = record.operations != null && Object.keys(record.operations).length > 0;
  return {
    ...(record.activeGrant != null ? { activeGrant: record.activeGrant } : {}),
    ...(hasHistory ? { history: record.history } : {}),
    ...(hasOperations ? { operations: record.operations } : {}),
  };
}

/**
 * A malformed/unparseable node degrades to an empty record rather than
 * throwing inside a transaction callback — the callback must be a pure,
 * total function of its input (CR-01). An unparseable node holds no active
 * grant either way, so degrading to empty is the fail-SAFE direction: an
 * operator can always recover by granting again.
 */
function parseRecord(raw: unknown): ResearchEntitlementRecord {
  const parsed = researchEntitlementRecordSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export interface GrantEntitlementResult {
  grantId: string;
  idempotencyKey: string;
}

/**
 * Grants (or, replay-safely, no-ops) an entitlement for `tenantId`.
 * REPLAY-idempotent (review finding 29-09 HIGH), not merely
 * consecutive-idempotent: a duplicate arriving after a revoke, and a
 * concurrently-losing attempt replayed after the winner is later revoked,
 * both create nothing — see the operations-index doc comment in
 * `packages/shared/src/researchEntitlement.ts`.
 *
 * The whole record — active grant, history, and operations index together
 * — is ONE RTDB node, and this is a single `transaction()` on that node
 * (house constraint 2 / cycle-2 finding C2-HIGH-11): a second node could
 * not be atomic with the grant decision, so the operations index MUST live
 * on this same node rather than a sibling tree.
 */
export async function grantEntitlement(
  database: Database,
  tenantId: string,
  grantedByUid: string,
  idempotencyKey: string,
): Promise<GrantEntitlementResult> {
  if (!(await isResearchTenant(database, tenantId))) {
    // Covers both "ordinary tenant" (T-29-10-02) and "unresolved kind"
    // (fail-closed) — see the module header.
    throw new ForbiddenError('Not a member of this client tenant');
  }

  // CR-01 (review 29-09 MEDIUM): generated ONCE, outside the transaction
  // callback, and closed over — the callback can run more than once and
  // must be a pure function of its input plus these pre-generated
  // constants.
  const grantId = randomUUID();
  const grantedAt = Date.now();

  const result = await entitlementRef(database, tenantId).transaction((raw) => {
    const current = parseRecord(raw);

    const existingOperation = current.operations?.[idempotencyKey];
    if (existingOperation) {
      // This exact key has already been recorded — no-op, record
      // unchanged. This is what makes a duplicate arriving AFTER a revoke
      // (the key stays in `operations` forever, even once the grant it
      // named has since moved into `history`) a no-op rather than a
      // resurrection.
      return buildStoredRecord(current);
    }

    if (!current.activeGrant) {
      // No active grant — this attempt creates one.
      const nextActiveGrant: ActiveGrant = {
        grantId,
        grantedByUid,
        grantedAt,
        idempotencyKey,
      };
      return buildStoredRecord({
        activeGrant: nextActiveGrant,
        history: current.history,
        operations: {
          ...current.operations,
          [idempotencyKey]: { grantId, outcome: 'created', recordedAt: grantedAt },
        },
      });
    }

    // An active grant already exists and this key is new — cycle-2 finding
    // C2-HIGH-11: record THIS attempt's key against the EXISTING grant's
    // identifier, so it can never later be replayed into a fresh grant.
    // This is exactly the branch a losing concurrent attempt takes when the
    // transaction SDK re-invokes this same callback against the winner's
    // committed value — the loser's key lands here, never nowhere.
    return buildStoredRecord({
      activeGrant: current.activeGrant,
      history: current.history,
      operations: {
        ...current.operations,
        [idempotencyKey]: {
          grantId: current.activeGrant.grantId,
          outcome: 'observed-existing',
          recordedAt: grantedAt,
        },
      },
    });
  });

  // Derive the response from the COMMITTED snapshot (review 29-09 MEDIUM),
  // never from the values this call merely intended to write — a losing
  // concurrent attempt must report the WINNER's identifier, not its own.
  const committed = parseRecord(result.snapshot.val());
  const resolvedGrantId = committed.operations?.[idempotencyKey]?.grantId ?? grantId;
  return { grantId: resolvedGrantId, idempotencyKey };
}

export interface RevokeEntitlementResult {
  ok: true;
}

/**
 * Revokes the active grant identified by `expectedGrantId`, replay-safely:
 * a mismatch (a stale or wrong expected identifier — the grant that was
 * active when this revoke was issued has since been replaced) or an
 * already-inactive record is a no-op, never an error, and returns the SAME
 * response shape as an effective revoke — so a delayed or repeated revoke
 * can neither terminate a grant it does not name nor be distinguished from
 * a fresh, effective one.
 */
export async function revokeEntitlement(
  database: Database,
  tenantId: string,
  expectedGrantId: string,
): Promise<RevokeEntitlementResult> {
  // CR-01: pre-generated once, outside the callback.
  const revokedAt = Date.now();

  await entitlementRef(database, tenantId).transaction((raw) => {
    const current = parseRecord(raw);

    if (!current.activeGrant || current.activeGrant.grantId !== expectedGrantId) {
      // Nothing active, or a stale/mismatched expected identifier — no-op.
      return buildStoredRecord(current);
    }

    // T-29-10-04: moved into history rather than deleted — revoking never
    // erases the fact that a grant existed. Keyed here by the grant's own
    // id (already a unique, deterministic value available to every retry of
    // this callback) — history keys are opaque; consumers sort by
    // `grantedAt`, never by key (see researchEntitlement.ts's module
    // header).
    const revokedEntry = { ...current.activeGrant, revokedAt };
    return buildStoredRecord({
      activeGrant: null,
      history: { ...current.history, [current.activeGrant.grantId]: revokedEntry },
      operations: current.operations,
    });
  });

  return { ok: true };
}

export interface EntitlementResolution {
  active: boolean;
  grantId: string | null;
}

/**
 * Read-only: does `tenantId` currently hold an active entitlement, and if
 * so, which grant authorizes it? Performs NO authorization of its own — the
 * calling route (or, from Phase 32 onward, the charge-flow seam) is the
 * single place authorization happens. Reports an entitlement ONLY for the
 * exact tenant it was granted to; any other tenant id and any personal uid
 * — which has no `researchEntitlements/{uid}` node at all — resolve to
 * `{ active: false, grantId: null }`.
 */
export async function resolveEntitlement(
  database: Database,
  tenantId: string,
): Promise<EntitlementResolution> {
  const snapshot = await entitlementRef(database, tenantId).get();
  const record = parseRecord(snapshot.val());
  if (!record.activeGrant) {
    return { active: false, grantId: null };
  }
  return { active: true, grantId: record.activeGrant.grantId };
}
