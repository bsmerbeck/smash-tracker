import type { Database } from 'firebase-admin/database';
import {
  clientHubRowSchema,
  coachClientEntrySchema,
  isResearchKind,
  type ClientHubList,
  type ClientHubRow,
} from '@smash-tracker/shared';
import { createClientCore } from '../coaching/tenants.js';
import { readSubjectKind } from './subjectKind.js';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate): the research
 * tenant service — creation and per-admin listing, built directly on plan
 * 29-01's shared tenancy primitives.
 *
 * This module never fabricates an auth principal (RTEN-07), never writes
 * under the admin's personal content trees (RTEN-06), and never emits
 * (RTEN-04) — creation delegates to `createClientCore`, the
 * telemetry-silent core, and NEVER the emitting `createClient` wrapper.
 *
 * This module performs NO authorization of its own. The route layer's
 * guards (`apps/api/src/research/routeGuards.ts`, Task 2) are the single
 * authorization site for this family — adding a second authorization check
 * here would create two places to keep in sync, and only one of them would
 * ever be exercised by a given call path.
 */

/**
 * Creates a research tenant for `adminUid` with the given `label`. Per D-02,
 * delegates to `createClientCore` with the research member of the tenant-kind
 * union — the SAME uniqueness/cap transaction and tenant/membership/index
 * writes every managed-client tenant gets, with zero telemetry anywhere in
 * the call graph. Never calls the emitting `createClient` coaching wrapper.
 */
export async function createResearchTenant(
  database: Database,
  adminUid: string,
  label: string,
): Promise<{ tenantId: string }> {
  return createClientCore(database, adminUid, label, 'research');
}

/**
 * Lists `adminUid`'s research tenants as `ClientHubRow`s (the same
 * projection shape `listClients` returns, so plan 29-08's badge reads one
 * schema regardless of which listing produced the row).
 *
 * Mirrors `listClients`'s per-coach index-scan shape (D-07,
 * RESEARCH.md Pitfall 4): reads `coachClients/{adminUid}`, then for EACH
 * indexed tenant resolves the kind through `readSubjectKind` and includes the
 * row only when the resolution is research AND `clientMembers/{tenantId}/{adminUid}`
 * exists. The membership check is re-verified explicitly per row even though
 * the index scan already implies it — that explicit re-check is what makes a
 * future cross-admin listing safe by default rather than merely safe today.
 *
 * A tenant whose kind cannot be resolved is OMITTED, never included — an
 * unresolvable tenant is not provably a research tenant, and this listing
 * exists only to enumerate research tenants. A caller with no membership
 * anywhere gets an empty array, not an error that would distinguish "no
 * tenants" from "not permitted" (this function performs no authorization of
 * its own either way — see the module header comment).
 */
export async function listResearchTenants(
  database: Database,
  adminUid: string,
): Promise<ClientHubList> {
  const snapshot = await database.ref(`coachClients/${adminUid}`).get();
  if (!snapshot.exists()) {
    return [];
  }

  const raw = snapshot.val() as Record<string, unknown>;
  const entries = Object.entries(raw).flatMap(([tenantId, value]) => {
    const parsed = coachClientEntrySchema.safeParse(value);
    if (!parsed.success) {
      return [];
    }
    return [{ tenantId, ...parsed.data }];
  });

  const rows = await Promise.all(
    entries.map(
      async ({ tenantId, label, archivedAt, claimedAt }): Promise<ClientHubRow | null> => {
        const kind = await readSubjectKind(database, tenantId);
        if (!isResearchKind(kind)) {
          // Covers BOTH the ordinary resolution (a coaching tenant the same
          // admin owns) and the unresolved resolution (an unreadable/
          // unparseable record) — neither is provably a research tenant.
          return null;
        }

        // Re-check membership explicitly for THIS row, even though the index
        // scan above already implies it (the row came from adminUid's OWN
        // coachClients index) — see the doc comment above.
        const membershipSnapshot = await database
          .ref(`clientMembers/${tenantId}/${adminUid}`)
          .get();
        if (!membershipSnapshot.exists()) {
          return null;
        }

        return clientHubRowSchema.parse({
          clientId: tenantId,
          label,
          lastActivityAt: null,
          draftCount: 0,
          deliveryState: null,
          archivedAt: archivedAt ?? null,
          claimedAt: claimedAt ?? null,
          pendingInvitationExpiresAt: null,
          kind,
        } satisfies ClientHubRow);
      },
    ),
  );

  return rows.filter((row): row is ClientHubRow => row !== null);
}
