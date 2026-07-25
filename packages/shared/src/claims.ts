import { z } from 'zod';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CRED-01/CRED-02/
 * CLAIM-02/CLAIM-04): the shared contract for the claim-code credential and
 * the digest-at-rest RTDB records it unlocks. RTDB layout:
 *
 * - `claimInvitations/{hmacDigestHex}`        -> ClaimInvitationRecord (the
 *   HMAC digest of the raw code is the RTDB KEY, never a stored field)
 * - `activeClaimInvitationByTenant/{tenantId}` -> ActiveClaimInvitationPointer
 *
 * The raw claim code is NEVER a stored field anywhere in this module. The
 * digest is the RTDB key; the record itself holds no credential material —
 * only lifecycle metadata (who issued it, when, and its consumption state).
 * `issuedClaimInvitationSchema` is the sole exception: it is the wire
 * response returned exactly once, at issuance, and is never persisted.
 */

/**
 * True Crockford base32 alphabet: excludes `I`, `L`, `O`, `U` (visually
 * ambiguous / accidental-word characters), keeps `0` and `1`. Deliberately
 * DISTINCT from the group-invite-code alphabet constant in `groups.ts`,
 * which is NOT Crockford (it excludes `I`/`O` but keeps `L`/`U` and drops
 * `0`/`1`). Do not import or re-export that alphabet here — the two
 * constants coexist and serve different features.
 */
export const CLAIM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26 symbols x 5 bits/symbol = 130 bits of entropy (CONTEXT.md Area 1). */
export const CLAIM_CODE_LENGTH = 26;

/** Display grouping is `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X`. */
export const CLAIM_CODE_GROUP_SIZE = 5;

/** 72 hours from issuance, per CONTEXT.md Area 1. */
export const CLAIM_CODE_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * `claimInvitations/{hmacDigestHex}` — the digest-at-rest invitation record.
 * `revokedAt` mirrors `shareTokenSchema.revokedAt`'s soft-revoke convention
 * (absent/null means active). `consumedAt`/`consumedByUid` are written
 * together, atomically, by the winning redemption's transaction, and are
 * what distinguishes a same-client idempotent replay (consumedByUid matches
 * the requester) from a foreign account's attempt.
 */
export const claimInvitationRecordSchema = z.object({
  tenantId: z.string().min(1),
  issuerUid: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  /** Soft-revoke timestamp (epoch ms); absent/null means the invitation is active. */
  revokedAt: z.number().int().nonnegative().nullish(),
  /** Epoch ms the winning redemption committed; absent/null means unconsumed. */
  consumedAt: z.number().int().nonnegative().nullish(),
  /** The uid that won redemption; written atomically with consumedAt. */
  consumedByUid: z.string().min(1).nullish(),
});
export type ClaimInvitationRecord = z.infer<typeof claimInvitationRecordSchema>;

/**
 * `activeClaimInvitationByTenant/{tenantId}` — the pointer that makes "one
 * active code per client workspace" enforceable. Reissuing a code swaps
 * this pointer and revokes the digest it displaced.
 */
export const activeClaimInvitationPointerSchema = z.object({
  digest: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
});
export type ActiveClaimInvitationPointer = z.infer<typeof activeClaimInvitationPointerSchema>;

/**
 * POST redeem-claim request body. The bound is deliberately generous
 * because normalization (separator stripping, case folding, Crockford
 * ambiguity folding) happens server-side AFTER validation — a wrong-length
 * code must reach the same code path as a valid one rather than being
 * short-circuited by a stricter schema, since a per-length rejection would
 * be an oracle.
 */
export const redeemClaimRequestSchema = z.object({
  code: z.string().trim().min(1).max(64),
});
export type RedeemClaimRequest = z.infer<typeof redeemClaimRequestSchema>;

/**
 * POST redeem-claim 200 response. Authored explicitly — NOT derived from
 * any record schema with `.pick()`/`.omit()` (redaction-by-shape rule, see
 * `packages/shared/src/shares.ts`'s module doc).
 */
export const claimRedeemedResponseSchema = z.object({
  tenantId: z.string().min(1),
});
export type ClaimRedeemedResponse = z.infer<typeof claimRedeemedResponseSchema>;

/**
 * The ONLY place in the entire system where a raw claim code appears —
 * returned exactly once at issuance and never persisted.
 */
export const issuedClaimInvitationSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type IssuedClaimInvitation = z.infer<typeof issuedClaimInvitationSchema>;

/**
 * Deliberately carries no digest and no code — a coach needs to know only
 * whether an outstanding invitation exists and when it lapses.
 */
export const claimInvitationStatusSchema = z.object({
  outstanding: z.boolean(),
  expiresAt: z.number().int().nonnegative().nullish(),
});
export type ClaimInvitationStatus = z.infer<typeof claimInvitationStatusSchema>;

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01/CTRL-02): the
 * client-side mirror of the established `coachClients/{coachUid}/{tenantId}`
 * idiom. `flipTenantOwnership` (`apps/api/src/claims/redemption.ts`) writes
 * `clientOwnedTenants/{clientUid}/{tenantId}` as a 7th path inside the SAME
 * atomic multi-path `update()` that performs the ownership flip — the
 * reverse index a claimed client needs to rediscover their workspace after
 * the one-time redemption response is gone. `label` is a SNAPSHOT of the
 * coach's `coachClients/{coachUid}/{tenantId}.label` value taken at flip
 * time — immutable in v2.4 because client-side renaming is deferred to
 * backlog. No credential material (raw code, digest, or anything
 * code-derived) is present in this record.
 */
export const clientOwnedTenantEntrySchema = z.object({
  label: z.string().trim().min(1).max(40),
  claimedAt: z.number().int().nonnegative(),
});
export type ClientOwnedTenantEntry = z.infer<typeof clientOwnedTenantEntrySchema>;

/**
 * `GET /api/client-workspaces` row shape. Authored by EXPLICIT field
 * selection — never `.pick()`/`.omit()` off `clientOwnedTenantEntrySchema` or
 * any other record schema (redaction-by-shape rule, see this module's own
 * doc comment above). `delegateCoachUid` uses the nullish modifier, never the
 * bare-optional one (RTDB conditional-spread + nullish write discipline, per
 * `.planning/codebase/CONCERNS.md`) — `null` when the client has revoked the
 * coach's delegated access and no `clientMembers/{tenantId}` child currently
 * holds the `'delegate'` role. Carries no coach identity beyond the delegate
 * uid the owner already has revoke authority over.
 */
export const ownedWorkspaceSchema = z.object({
  tenantId: z.string().min(1),
  label: z.string().min(1),
  claimedAt: z.number().int().nonnegative(),
  delegateCoachUid: z.string().min(1).nullish(),
});
export type OwnedWorkspace = z.infer<typeof ownedWorkspaceSchema>;

/** `GET /api/client-workspaces` 200 response. */
export const ownedWorkspaceListSchema = ownedWorkspaceSchema.array();
export type OwnedWorkspaceList = z.infer<typeof ownedWorkspaceListSchema>;
