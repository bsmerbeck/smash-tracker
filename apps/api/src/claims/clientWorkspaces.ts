import type { Database } from 'firebase-admin/database';
import {
  clientMembershipSchema,
  clientOwnedTenantEntrySchema,
  ownedWorkspaceSchema,
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

  return Promise.all(
    entries.map(async ({ tenantId, label, claimedAt }) => {
      const membersSnapshot = await database.ref(`clientMembers/${tenantId}`).get();
      let delegateCoachUid: string | null = null;
      if (membersSnapshot.exists()) {
        const members = membersSnapshot.val() as Record<string, unknown>;
        for (const [memberUid, memberValue] of Object.entries(members)) {
          const parsedMember = clientMembershipSchema.safeParse(memberValue);
          if (parsedMember.success && parsedMember.data.role === 'delegate') {
            delegateCoachUid = memberUid;
            break;
          }
        }
      }
      return ownedWorkspaceSchema.parse({ tenantId, label, claimedAt, delegateCoachUid });
    }),
  );
}
