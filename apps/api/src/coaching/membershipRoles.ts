import type { Database } from 'firebase-admin/database';
import { clientMembershipSchema, type ClientTenantRole } from '@smash-tracker/shared';
import type { ResearchConfig } from '../config/env.js';
import { assertTenantAccess } from '../research/access.js';
import { ForbiddenError } from '../services/rtdb.js';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition): Phase 11's two
 * authorization checkpoints (`resolveSubjectId` in `subject.ts` and
 * `requireMembership` in `tenants.ts`) check membership EXISTENCE only,
 * which was correct while `'custodian'` was the only role. Phase 23 widens
 * the role space at the same membership node, so a check that is blind to
 * role would let a post-claim `'delegate'` coach keep acting like a
 * custodian. This module adds the role-aware variant.
 *
 * It deliberately does NOT modify `resolveSubjectId` — every same-subject
 * content route (`/api/matches`, `/api/playlists`, and siblings) must stay
 * role-blind, because a delegate coach reading and writing the client's
 * workspace IS the coaching relationship and gating it would regress Phase
 * 11/12/20 behavior. Owner decision, recorded verbatim: gate destructive
 * routes only.
 */

/**
 * Reads the caller's role at `clientMembers/{tenantId}/{uid}`. Returns
 * `null` when no record exists, or when the stored record fails
 * `clientMembershipSchema` — a corrupt membership record grants nothing
 * (fail-closed), mirroring the list-route safeParse-and-skip convention
 * (CONCERNS.md guardrail 3) but with the opposite default.
 */
export async function readMembershipRole(
  database: Database,
  uid: string,
  tenantId: string,
): Promise<ClientTenantRole | null> {
  const snapshot = await database.ref(`clientMembers/${tenantId}/${uid}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const parsed = clientMembershipSchema.safeParse(snapshot.val());
  if (!parsed.success) {
    return null;
  }
  return parsed.data.role;
}

/**
 * Resolves the caller's role, throwing `ForbiddenError` when it is absent or
 * not in `allowed`. The thrown message is the EXACT same string
 * `requireMembership` already throws in `apps/api/src/coaching/tenants.ts` —
 * a distinct message or status for "member but wrong role" would tell a
 * demoted coach that the workspace still exists and that they still hold a
 * membership record, a small but real information leak, and the same
 * no-oracle reasoning `requireMembership`'s own comment already applies to
 * foreign versus nonexistent tenants.
 *
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, review consensus
 * finding 1): the pre-existing role check runs FIRST, unchanged, and ONLY
 * THEN does this function call `assertTenantAccess` — the ONE shared
 * research-authorization decision site — before returning. `researchConfig`
 * is a REQUIRED trailing parameter (not optional-with-a-default): a required
 * parameter is what makes the compiler enumerate every call site; a default
 * of `null` would silently make every research tenant unreachable rather
 * than correctly gated. Removing this second check breaks allowlist
 * revocation for every destructive/URL-param route this function guards.
 */
export async function requireTenantRole(
  database: Database,
  uid: string,
  tenantId: string,
  allowed: readonly ClientTenantRole[],
  researchConfig: ResearchConfig | null,
): Promise<ClientTenantRole> {
  const role = await readMembershipRole(database, uid, tenantId);
  if (!role || !allowed.includes(role)) {
    throw new ForbiddenError('Not a member of this client tenant');
  }
  // Research gate — throws the SAME rejection above for `denied` and
  // `indeterminate` alike (no-oracle).
  await assertTenantAccess({ database, researchConfig, uid, tenantId });
  return role;
}
