import type { Database } from 'firebase-admin/database';
import type { ResearchConfig } from '../config/env.js';
import { assertTenantAccess } from './access.js';
import { isPathSafeTenantId } from './subjectKind.js';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, review finding
 * 29-04 HIGH): TWO separately-scoped guards, not one.
 *
 * A collection route (`POST/GET /research/tenants`) names no tenant, so
 * there is nothing to check membership against — the ONLY question is
 * "is this caller a research admin at all". A tenant-addressed route (the
 * first of which is plan 29-10's entitlement routes) names a tenant in its
 * URL and must additionally prove the caller is a MEMBER of that specific
 * tenant, and that the tenant IS a research tenant. Folding both into one
 * guard would force it to accept an optional tenant id — silently
 * degrading to the weaker collection-only check whenever a caller forgot
 * to pass one — which would make the stronger contract impossible to rely
 * on. Splitting them makes the weaker contract explicit at every call site
 * and separately unit-testable, which is exactly what this file does.
 */

/**
 * The ONE rejection value used for EVERY negative outcome in BOTH guards —
 * same status, same body, byte for byte — so nothing in a response
 * distinguishes "capability disabled" from "you are not an admin" from
 * "that tenant does not exist" from "you are not a member of it" from
 * "that is not a research tenant". Exported so plan 29-10's routes and
 * plan 29-12's suite compare against this ONE definition rather than
 * re-typing it.
 *
 * Scoped honestly (cycle-2 finding C2-MED-4): this is NOT claimed, and must
 * NEVER be asserted, to be byte-identical to what an UNREGISTERED route
 * returns. Fastify's default not-found handler embeds the request method
 * and URL in its body (`"Route GET:/api/whatever not found"`), so no single
 * fixed value can match it across every possible route. The property this
 * phase actually needs is narrower and IS what's proven: (a) every negative
 * reason WITHIN this family returns this exact status and this exact body,
 * and (b) this status equals the status an unregistered path returns (404),
 * so a probe cannot tell from the status line alone that the family exists.
 * Closing the body gap too would require a custom application-wide
 * not-found handler — deliberately out of scope for this phase.
 */
export const RESEARCH_FAMILY_REJECTION = {
  statusCode: 404,
  body: {
    error: 'Not Found',
    message: 'Not Found',
    statusCode: 404,
  },
} as const;

export type ResearchFamilyRejection = typeof RESEARCH_FAMILY_REJECTION;

/** The minimal request shape both guards need — satisfied structurally by `FastifyRequest`. */
export interface ResearchGuardRequest {
  uid: string;
  server: {
    researchConfig: ResearchConfig | null;
    firebase: { database: Database };
  };
}

/**
 * The COLLECTION-route guard. Rejects when the research config is null
 * (D-04, fail-closed) or when the caller's uid is absent from the
 * allowlist. Takes NO tenant identifier and performs NO database read — a
 * collection route has no target to authorize against. Synchronous:
 * nothing here can fail asynchronously.
 *
 * Never consults the reports allowlist — the two are structurally
 * independent (D-04) and are never unioned, substituted, or layered.
 */
export function requireResearchAdmin(
  request: Pick<ResearchGuardRequest, 'uid' | 'server'>,
): ResearchFamilyRejection | null {
  const { researchConfig } = request.server;
  if (researchConfig === null) {
    return RESEARCH_FAMILY_REJECTION;
  }
  if (!researchConfig.adminUids.has(request.uid)) {
    return RESEARCH_FAMILY_REJECTION;
  }
  return null;
}

/**
 * The TENANT-ADDRESSED guard. Applies the collection guard's checks, then
 * requires `clientMembers/{tenantId}/{callerUid}` to exist, then delegates
 * the kind decision to `assertTenantAccess` (plan 29-01) and additionally
 * rejects when the resolved kind is not research — this family serves only
 * research tenants, so a caller who is a legitimate coaching-tenant member
 * is still rejected here.
 *
 * Step ZERO (cycle-3 finding): `tenantId` is validated with the shared
 * `isPathSafeTenantId` predicate BEFORE any membership reference is
 * constructed — a path-illegal id raises the family's uniform rejection,
 * never a 500. Because plan 29-10's entitlement routes reuse this guard,
 * they inherit the check for free.
 */
export async function requireResearchTenantAdmin(
  request: Pick<ResearchGuardRequest, 'uid' | 'server'>,
  tenantId: string,
): Promise<ResearchFamilyRejection | null> {
  if (!isPathSafeTenantId(tenantId)) {
    return RESEARCH_FAMILY_REJECTION;
  }

  const collectionRejection = requireResearchAdmin(request);
  if (collectionRejection) {
    return collectionRejection;
  }

  const { researchConfig, firebase } = request.server;

  const membershipSnapshot = await firebase.database
    .ref(`clientMembers/${tenantId}/${request.uid}`)
    .get();
  if (!membershipSnapshot.exists()) {
    return RESEARCH_FAMILY_REJECTION;
  }

  try {
    const kind = await assertTenantAccess({
      database: firebase.database,
      researchConfig,
      uid: request.uid,
      tenantId,
    });
    if (kind !== 'research') {
      // A legitimate member of a COACHING tenant is still rejected here —
      // this family serves only research tenants.
      return RESEARCH_FAMILY_REJECTION;
    }
  } catch {
    // `assertTenantAccess` throws for the denied/indeterminate outcomes —
    // both fail closed with the SAME uniform rejection, never a
    // distinguishable one.
    return RESEARCH_FAMILY_REJECTION;
  }

  return null;
}
