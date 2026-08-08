import type { Database } from 'firebase-admin/database';
import {
  activeClaimInvitationPointerSchema,
  claimInvitationRecordSchema,
  isResearchKind,
  type ClaimInvitationStatus,
  type IssuedClaimInvitation,
} from '@smash-tracker/shared';
import type { ResearchConfig } from '../config/env.js';
import {
  claimCodeExpiresAt,
  formatClaimCode,
  generateClaimCode,
  hashClaimCode,
  normalizeClaimCode,
} from './crypto.js';
import { checkAndIncrement, claimIssuancePath, MAX_CLAIM_ISSUANCES_PER_DAY } from './rateLimits.js';
import { requireTenantRole } from '../coaching/membershipRoles.js';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { readSubjectKind } from '../research/subjectKind.js';
import { ForbiddenError } from '../services/rtdb.js';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CRED-01/CRED-02/
 * CRED-03/EVT-01): the coach-side credential lifecycle — mint, rotate,
 * revoke, and read status for a client workspace's claim code. RTDB layout:
 *
 * - `claimInvitations/{hmacDigestHex}` — the digest-at-rest invitation
 *   record (`packages/shared/src/claims.ts`); the HMAC digest is the RTDB
 *   KEY, never a stored field.
 * - `activeClaimInvitationByTenant/{tenantId}` — the pointer that makes "one
 *   active code per client workspace" an invariant rather than a
 *   convention. Issuing a new code atomically repoints this and revokes the
 *   digest it previously named.
 *
 * The raw claim code exists ONLY as the return value of
 * `issueClaimInvitation` — it is never persisted, logged, or placed in an
 * event payload anywhere in this module.
 */

/**
 * Deliberately a local class the route maps to 429 itself, rather than one
 * of the three classes `apps/api/src/app.ts`'s global handler maps — the
 * global handler has no 429 branch and adding one would change behavior for
 * unrelated routes.
 */
export class ClaimIssuanceRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimIssuanceRateLimitError';
  }
}

export const CLAIM_CODE_COLLISION_RETRIES = 5;

/**
 * Mints a fresh claim code for a client workspace. Order of operations
 * matters:
 *
 * 1. Require the caller hold `'custodian'` membership on `tenantId` — a
 *    post-claim `'delegate'` coach and the claiming `'owner'` are both
 *    denied.
 * 2. Check-and-increment the per-coach daily issuance counter; a cap hit
 *    throws `ClaimIssuanceRateLimitError` and writes nothing else.
 * 3. Collision-retried mint: generate a code, hash its normalized form, and
 *    write it to `claimInvitations/{digest}` via a write-on-empty
 *    transaction that aborts (and retries with a fresh code) only when the
 *    digest is already occupied by real stored data.
 * 4. Atomically swap `activeClaimInvitationByTenant/{tenantId}` to the new
 *    digest, capturing whichever digest it previously pointed at.
 * 5. If a previous digest was displaced, revoke it with a targeted field
 *    write (`revokedAt`) so the rest of its record survives.
 * 6. Emit `claim_invitation_created` (and, on rotation,
 *    `claim_invitation_revoked` with reason `rotated`) after the writes
 *    commit.
 * 7. Return the formatted code and its expiry — the only moment the raw
 *    code is observable.
 *
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, review consensus
 * finding 2): a research tenant is refused OUTRIGHT here — not merely
 * gated by the allowlist `requireTenantRole` now also checks — because a
 * research tenant must not be claimable at ALL before Phase 34, even by its
 * own allowlisted admin. The refusal sits strictly BEFORE any code
 * generation, HMAC digest computation, transaction, or write (step 2
 * below), so a refused issuance leaves the database byte-unchanged.
 */
export async function issueClaimInvitation(
  database: Database,
  coachUid: string,
  tenantId: string,
  options: { sessionId: string; hmacSecret: string },
  researchConfig: ResearchConfig | null,
): Promise<IssuedClaimInvitation> {
  await requireTenantRole(database, coachUid, tenantId, ['custodian'], researchConfig);

  const kind = await readSubjectKind(database, tenantId);
  if (isResearchKind(kind)) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  const now = Date.now();
  const withinLimit = await checkAndIncrement(
    database,
    claimIssuancePath(coachUid, now),
    MAX_CLAIM_ISSUANCES_PER_DAY,
  );
  if (!withinLimit) {
    // Nothing has been written for this attempt beyond the counter itself.
    throw new ClaimIssuanceRateLimitError('Claim code issuance limit reached for today');
  }

  const expiresAt = claimCodeExpiresAt(now);
  let rawCode = '';
  let digest = '';
  let minted = false;

  for (let attempt = 0; attempt < CLAIM_CODE_COLLISION_RETRIES; attempt += 1) {
    const candidateCode = generateClaimCode();
    const candidateDigest = hashClaimCode(options.hmacSecret, normalizeClaimCode(candidateCode));

    // Write-on-empty transaction (markStripeEventProcessed shape,
    // apps/api/src/billing/credits.ts): the abort branch below is only
    // reachable after a retry against REAL stored data, never on the
    // null-local-cache first run — the same digest can never be minted
    // twice as a live record.
    const result = await database
      .ref(`claimInvitations/${candidateDigest}`)
      .transaction((current) => {
        if (current !== null && current !== undefined) {
          return undefined;
        }
        return {
          tenantId,
          issuerUid: coachUid,
          createdAt: now,
          expiresAt,
        };
      });

    if (result.committed) {
      rawCode = candidateCode;
      digest = candidateDigest;
      minted = true;
      break;
    }
  }

  if (!minted) {
    throw new Error('Failed to allocate a unique claim code');
  }

  let previousDigest: string | null = null;
  await database.ref(`activeClaimInvitationByTenant/${tenantId}`).transaction((current) => {
    // Reset per run (CR-01 Pattern 3): a flag captured during a DISCARDED
    // (hash-mismatch) run must never leak into the final outcome.
    previousDigest = null;
    const parsed = activeClaimInvitationPointerSchema.safeParse(current);
    if (parsed.success) {
      previousDigest = parsed.data.digest;
    }
    // Never aborts — the pointer always ends up naming the freshly minted
    // digest, whatever it previously held.
    return { digest, issuedAt: now };
  });

  const displacedDigest: string | null =
    previousDigest !== null && previousDigest !== digest ? previousDigest : null;

  if (displacedDigest) {
    // Targeted field write — the displaced record's other fields survive.
    await database.ref().update({
      [`claimInvitations/${displacedDigest}/revokedAt`]: now,
    });
  }

  void createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'claim_invitation_created',
      actorId: coachUid,
      sessionId: options.sessionId,
      causationId: `${tenantId}:${now}:created`,
      consentState: 'unknown',
      payload: {},
    }),
  );
  if (displacedDigest) {
    void createEvent(
      database,
      buildDomainEnvelope({
        eventName: 'claim_invitation_revoked',
        actorId: coachUid,
        sessionId: options.sessionId,
        causationId: `${tenantId}:${now}:revoked`,
        consentState: 'unknown',
        payload: { reason: 'rotated' },
      }),
    );
  }

  // This is the only moment the raw code is observable — it must not be
  // logged, echoed, or stored by any caller.
  return { code: formatClaimCode(rawCode), expiresAt };
}

/**
 * Revokes the tenant's outstanding claim code, if any. Idempotent: when
 * nothing is outstanding, resolves without throwing and writes nothing.
 *
 * Phase 29 (review consensus finding 2): refuses a research tenant the same
 * way issuance does, before any write. Revocation is naturally a defensive
 * no-op for a research tenant in practice (issuance already refuses to mint
 * a code for one), but the guard is unconditional here too, so a
 * pre-Phase-29 invitation somehow outstanding on a tenant later marked
 * research cannot be revoked (or, symmetrically, redeemed) through this
 * path either.
 */
export async function revokeClaimInvitation(
  database: Database,
  coachUid: string,
  tenantId: string,
  options: { sessionId: string },
  researchConfig: ResearchConfig | null,
): Promise<void> {
  await requireTenantRole(database, coachUid, tenantId, ['custodian'], researchConfig);

  const kind = await readSubjectKind(database, tenantId);
  if (isResearchKind(kind)) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  const pointerSnapshot = await database.ref(`activeClaimInvitationByTenant/${tenantId}`).get();
  const pointer = activeClaimInvitationPointerSchema.safeParse(pointerSnapshot.val());
  if (!pointer.success) {
    return;
  }

  const now = Date.now();
  await database.ref().update({
    [`claimInvitations/${pointer.data.digest}/revokedAt`]: now,
    [`activeClaimInvitationByTenant/${tenantId}`]: null,
  });

  void createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'claim_invitation_revoked',
      actorId: coachUid,
      sessionId: options.sessionId,
      causationId: `${tenantId}:${now}:revoked`,
      consentState: 'unknown',
      payload: { reason: 'coach_revoked' },
    }),
  );
}

/**
 * Reads whether a tenant currently has a live, redeemable claim code — never
 * the digest itself. `outstanding` is `false` for an absent pointer, an
 * unparseable pointer/record, a revoked or consumed record, or one whose
 * `expiresAt` has passed.
 */
export async function getClaimInvitationStatus(
  database: Database,
  coachUid: string,
  tenantId: string,
  researchConfig: ResearchConfig | null,
): Promise<ClaimInvitationStatus> {
  await requireTenantRole(database, coachUid, tenantId, ['custodian'], researchConfig);

  const pointerSnapshot = await database.ref(`activeClaimInvitationByTenant/${tenantId}`).get();
  const pointer = activeClaimInvitationPointerSchema.safeParse(pointerSnapshot.val());
  if (!pointer.success) {
    return { outstanding: false, expiresAt: null };
  }

  const recordSnapshot = await database.ref(`claimInvitations/${pointer.data.digest}`).get();
  const record = claimInvitationRecordSchema.safeParse(recordSnapshot.val());
  if (!record.success) {
    return { outstanding: false, expiresAt: null };
  }

  if (
    record.data.revokedAt != null ||
    record.data.consumedAt != null ||
    record.data.expiresAt <= Date.now()
  ) {
    return { outstanding: false, expiresAt: null };
  }

  return { outstanding: true, expiresAt: record.data.expiresAt };
}
