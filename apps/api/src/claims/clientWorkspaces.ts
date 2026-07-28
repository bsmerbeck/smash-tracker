import type { Database } from 'firebase-admin/database';
import {
  clientMembershipSchema,
  clientOwnedTenantEntrySchema,
  ownedWorkspaceSchema,
  type OwnedWorkspace,
  type OwnedWorkspaceList,
} from '@smash-tracker/shared';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01/CTRL-02): reads
 * the client-owner reverse index `flipTenantOwnership` writes as its 7th
 * atomic path (`apps/api/src/claims/redemption.ts`), joined with each owned
 * tenant's `clientMembers/{tenantId}` membership record to surface the
 * currently-delegated coach (if any).
 *
 * ACCESS CONTROL (V4, ASVS): `clientUid` MUST always be the caller's own
 * verified uid, supplied by the route from `request.uid` — never a value
 * taken from a request body, query string, or path segment. This function
 * has no way to enforce that itself (it trusts its caller completely), so
 * `apps/api/src/routes/clientWorkspaces.ts` deliberately declares no params
 * or querystring schema — there is no identifier for a caller to spoof. This
 * mirrors `apps/api/src/coaching/tenants.ts`'s `listClients`, which reads
 * `coachClients/{coachUid}` the same request.uid-direct way.
 *
 * Quick 260726-r7 (P0 self-heal): `deleteClient`
 * (`apps/api/src/coaching/tenants.ts`) now nulls this index's row on hard
 * delete going forward, but the fix cannot retroactively repair rows written
 * by every PRIOR delete (production currently has two). Every owned entry is
 * therefore verified live here: a claimed workspace's tenant ALWAYS still
 * has at least the owner's own `clientMembers/{tenantId}` row while it
 * exists (`flipTenantOwnership` writes it, and only a hard delete removes
 * the whole `clientMembers/{tenantId}` node) — so zero SURVIVING
 * (safeParse-passing) members means the tenant was hard-deleted out from
 * under this index entry. Such rows are excluded from the response AND
 * best-effort pruned so the client stops seeing dead workspaces without
 * requiring any manual data repair. A prune failure degrades to "just
 * exclude it, try again on the next read" rather than failing the whole
 * list (CONCERNS.md guardrail 3's safeParse-and-skip spirit, applied to a
 * write instead of a parse).
 */
export async function listOwnedWorkspaces(
  database: Database,
  clientUid: string,
): Promise<OwnedWorkspaceList> {
  const snapshot = await database.ref(`clientOwnedTenants/${clientUid}`).get();
  if (!snapshot.exists()) {
    return [];
  }

  const raw = snapshot.val() as Record<string, unknown>;
  const entries = Object.entries(raw).flatMap(([tenantId, value]) => {
    const parsed = clientOwnedTenantEntrySchema.safeParse(value);
    if (!parsed.success) {
      // Index children that fail the schema are skipped, not thrown on — the
      // same safeParse-and-skip convention `listClients` uses (CONCERNS.md
      // guardrail 3), so one corrupt entry can never 500 the whole list.
      return [];
    }
    return [{ tenantId, label: parsed.data.label, claimedAt: parsed.data.claimedAt }];
  });

  const rows = await Promise.all(
    entries.map(async ({ tenantId, label, claimedAt }): Promise<OwnedWorkspace | null> => {
      const membersSnapshot = await database.ref(`clientMembers/${tenantId}`).get();
      const rawMembers = membersSnapshot.exists()
        ? (membersSnapshot.val() as Record<string, unknown>)
        : {};
      const survivingMembers = Object.entries(rawMembers).flatMap(([memberUid, memberValue]) => {
        const parsedMember = clientMembershipSchema.safeParse(memberValue);
        return parsedMember.success ? [{ uid: memberUid, ...parsedMember.data }] : [];
      });

      if (survivingMembers.length === 0) {
        // Self-heal: the tenant no longer exists (hard-deleted). Best-effort
        // prune — a failure here must never fail the read, it just leaves
        // the orphan for the next read to retry.
        try {
          await database.ref(`clientOwnedTenants/${clientUid}/${tenantId}`).remove();
        } catch (err) {
          console.warn(
            `listOwnedWorkspaces: failed to prune orphaned clientOwnedTenants row for tenant ${tenantId}`,
            err,
          );
        }
        return null;
      }

      const delegate = survivingMembers.find((member) => member.role === 'delegate');
      return ownedWorkspaceSchema.parse({
        tenantId,
        label,
        claimedAt,
        delegateCoachUid: delegate?.uid ?? null,
      });
    }),
  );

  return rows.filter((row): row is OwnedWorkspace => row !== null);
}
