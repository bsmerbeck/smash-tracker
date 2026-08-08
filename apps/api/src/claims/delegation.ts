import type { Database } from 'firebase-admin/database';
import { isResearchKind } from '@smash-tracker/shared';
import { readMembershipRole, requireTenantRole } from '../coaching/membershipRoles.js';
import type { ResearchConfig } from '../config/env.js';
import { readSubjectKind } from '../research/subjectKind.js';
import { ForbiddenError } from '../services/rtdb.js';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CTRL-02): the
 * revoke primitive backing the client-owner-facing delegation-revoke route.
 * Its UI lands in Phase 24 — this module and the route it backs are live and
 * testable now.
 *
 * CLAIM-03 finding: both existing authorization checkpoints
 * (`resolveSubjectId` in `apps/api/src/coaching/subject.ts` and
 * `requireMembership`/`requireTenantRole` in `apps/api/src/coaching/`) read
 * `clientMembers/{tenantId}/{uid}` live, uncached, on every single request.
 * There is therefore no cache, session, or token to invalidate — nulling the
 * membership record IS the complete revocation, and the very next request
 * through either checkpoint 403s.
 */

/**
 * Revokes a `delegate` coach's access to a claimed client tenant. Callable
 * only by the tenant's `owner`. Removes `clientMembers/{tenantId}/{delegateUid}`
 * and `coachClients/{delegateUid}/{tenantId}` in one root-level update — the
 * owner's own membership record and every content subtree are untouched.
 *
 * Phase 29 (review consensus finding 2): refused for a research tenant
 * UNCONDITIONALLY — even for an allowlisted admin who happens to hold the
 * `owner` role, which `requireTenantRole`'s allowlist gate alone would
 * permit. A research tenant cannot be claimed at all (see
 * `apps/api/src/claims/redemption.ts`/`invitations.ts`), so there is no
 * legitimate `owner` role to revoke a delegation from in the first place;
 * this explicit refusal is defense in depth, not a new capability.
 */
export async function revokeCoachDelegation(
  database: Database,
  ownerUid: string,
  tenantId: string,
  delegateUid: string,
  options: { sessionId: string },
  researchConfig: ResearchConfig | null,
): Promise<void> {
  // A self-revoke is nonsensical (an owner cannot revoke their own
  // membership through this path) and must be rejected before any role
  // lookup, with the same shared no-oracle denial message every other
  // branch below uses.
  if (delegateUid === ownerUid) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  await requireTenantRole(database, ownerUid, tenantId, ['owner'], researchConfig);

  const kind = await readSubjectKind(database, tenantId);
  if (isResearchKind(kind)) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  // A `custodian` is not a delegation and an absent member is nothing at
  // all; both must be indistinguishable from a wrong-role denial, for the
  // same no-oracle reason `requireMembership`'s own comment gives — a
  // distinct message or status here would tell the caller whether some
  // OTHER role exists at this uid.
  const targetRole = await readMembershipRole(database, delegateUid, tenantId);
  if (targetRole !== 'delegate') {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  // Access is governed solely by `clientMembers`; the `coachClients` index
  // entry is nulled too so the coach's Client Hub does not keep rendering a
  // row whose every read now 403s.
  await database.ref().update({
    [`clientMembers/${tenantId}/${delegateUid}`]: null,
    [`coachClients/${delegateUid}/${tenantId}`]: null,
  });

  // The causationId is stable per (tenant, delegate) pair, which is correct
  // for v2.4 because Phase 23 grants a delegation exactly once, at claim
  // time, and provides no re-grant path; if a future phase adds re-granting,
  // this id needs a timestamp component or `createEvent`'s dedup gate will
  // swallow the second revoke.
  void createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'coach_delegation_revoked',
      actorId: ownerUid,
      sessionId: options.sessionId,
      causationId: `${tenantId}:${delegateUid}:revoked`,
      consentState: 'unknown',
      payload: { reason: 'client_initiated' },
    }),
  );
}
