import { createHmac, randomInt } from 'node:crypto';
import {
  CLAIM_CODE_ALPHABET,
  CLAIM_CODE_GROUP_SIZE,
  CLAIM_CODE_LENGTH,
  CLAIM_CODE_TTL_MS,
} from '@smash-tracker/shared';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CRED-01/CRED-02):
 * claim-code crypto — CSPRNG generation, display grouping, normalization,
 * and HMAC digest.
 *
 * (a) This module is pure — it takes and returns strings and numbers, holds
 *     no state, and must never import a database client, a logger, or
 *     anything that could persist or emit its inputs. The raw claim code
 *     exists in exactly two places for exactly two moments: the return
 *     value of `generateClaimCode` on the issuance path, and the request
 *     body of the redemption route.
 * (b) The alphabet is true Crockford base32 from `packages/shared/src/claims.ts`,
 *     deliberately not the (non-Crockford) group-invite alphabet from
 *     `groups.ts`.
 * (c) There is no `timingSafeEqual` call in this file. The HMAC digest is
 *     used as the RTDB KEY (`claimInvitations/{digest}`), so verification is
 *     an O(1) key lookup, not a byte-by-byte comparison of a submitted
 *     secret against a stored one. There is no secret-dependent comparison
 *     branch to leak timing from. CONTEXT.md's "constant-time comparison on
 *     redeem" requirement is satisfied structurally rather than by an
 *     explicit compare; the alternative design (digest stored as a value,
 *     resolved then compared with a length-checked `timingSafeEqual` per
 *     `apps/api/src/startgg/oauth.ts`) remains available if a future review
 *     prefers the literal form.
 * (d) Rotating `CLAIM_CODE_HMAC_SECRET` invalidates every outstanding code,
 *     by design.
 */

/**
 * Generates a fresh claim code. 26 symbols over a 32-symbol alphabet is 130
 * bits of entropy; `randomInt` is unbiased via rejection sampling. Returns
 * the canonical (ungrouped, uppercase) form.
 */
export function generateClaimCode(): string {
  let code = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i += 1) {
    code += CLAIM_CODE_ALPHABET[randomInt(CLAIM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Display-only grouping (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X`), for the coach's
 * copy-and-hand-off surface in Phase 24; the canonical (ungrouped) form is
 * what gets hashed.
 */
export function formatClaimCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += CLAIM_CODE_GROUP_SIZE) {
    groups.push(code.slice(i, i + CLAIM_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Uppercases, folds Crockford ambiguities (`O`->`0`, `I`->`1`, `L`->`1`),
 * then strips every character not present in `CLAIM_CODE_ALPHABET` (this is
 * what removes hyphens, spaces, and any stray `U`).
 *
 * Never throws and never validates length, because the redemption path
 * deliberately hashes and looks up whatever this produces — rejecting a
 * wrong-length input earlier would create a distinguishable fast path and
 * become the exact oracle CRED-05 forbids.
 */
export function normalizeClaimCode(input: string): string {
  const upper = input.toUpperCase().replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1');
  let result = '';
  for (const char of upper) {
    if (CLAIM_CODE_ALPHABET.includes(char)) {
      result += char;
    }
  }
  return result;
}

/**
 * HMAC-SHA-256 hex digest of the NORMALIZED claim code, keyed by the server
 * secret. The caller must pass the NORMALIZED form — issuance normalizes
 * its own freshly generated code before hashing, so the two paths cannot
 * drift. The returned hex digest is what becomes the RTDB key.
 */
export function hashClaimCode(hmacSecret: string, normalizedCode: string): string {
  return createHmac('sha256', hmacSecret).update(normalizedCode).digest('hex');
}

/** Claim codes expire `CLAIM_CODE_TTL_MS` (72 hours) after issuance. */
export function claimCodeExpiresAt(nowMs: number): number {
  return nowMs + CLAIM_CODE_TTL_MS;
}
