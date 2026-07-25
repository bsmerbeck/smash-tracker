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
