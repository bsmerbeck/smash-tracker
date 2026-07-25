import { CLAIM_CODE_ALPHABET, CLAIM_CODE_GROUP_SIZE } from '@smash-tracker/shared';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, ENTRY-02/CTRL-03): the
 * web-side claim-code display and input-normalisation helper.
 *
 * This module deliberately duplicates the server's claim-code crypto module
 * display grouping and normalisation rules rather than importing that
 * file — it is server-internal (it holds HMAC digest logic keyed by a
 * server secret) and must never reach a browser bundle. The shared constants
 * (`CLAIM_CODE_ALPHABET`, `CLAIM_CODE_LENGTH`, `CLAIM_CODE_GROUP_SIZE`) are
 * the single source of truth for alphabet/length/group size on both sides.
 *
 * Every function here is pure and holds no module-level state — the value
 * these functions operate on is short-lived credential material (a raw claim
 * code) that must not outlive the component that owns it. Nothing in this
 * file persists, logs, or caches its input or output.
 */

/**
 * Uppercases, folds the same Crockford ambiguities the server's
 * `normalizeClaimCode` folds (`O`->`0`, `I`->`1`, `L`->`1`), then drops every
 * character not present in `CLAIM_CODE_ALPHABET` — including `U`, which is
 * excluded from the true-Crockford alphabet the server uses and is not
 * remapped to any other symbol (mirrored exactly from the server's own
 * `normalizeClaimCode`, not reinterpreted).
 *
 * Never truncates and never validates length — length validation client-side
 * would be a shape oracle the server deliberately avoids (CRED-05).
 */
export function normalizeClaimCodeInput(value: string): string {
  const upper = value.toUpperCase().replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1');
  let result = '';
  for (const char of upper) {
    if (CLAIM_CODE_ALPHABET.includes(char)) {
      result += char;
    }
  }
  return result;
}

/** Count of alphabet-significant characters after normalisation. */
export function countSignificantClaimCodeChars(value: string): number {
  return normalizeClaimCodeInput(value).length;
}

/**
 * Normalises, then joins `CLAIM_CODE_GROUP_SIZE`-character chunks with `-`
 * (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X` for a full 26-character code). Used both
 * for the issuance dialog's read-only display and for the redemption input's
 * as-you-type grouping.
 */
export function formatClaimCodeForDisplay(value: string): string {
  const normalized = normalizeClaimCodeInput(value);
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += CLAIM_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(i, i + CLAIM_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}
