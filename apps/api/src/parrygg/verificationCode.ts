import { randomInt } from 'node:crypto';
import { INVITE_CODE_ALPHABET } from '@smash-tracker/shared';

/**
 * Shared bio-text challenge code generator. Used by both the linked-account
 * verification flow (`parryggVerifications/{uid}`, routes/parrygg.ts) and
 * the login flow (`parryggLoginVerifications/{parryUserId}`,
 * routes/parryggAuth.ts) — same `ST-XXXXXX` shape, same 10-minute TTL, same
 * "sole proof of ownership" trust model, just keyed differently.
 */
export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_TTL_MS = 10 * 60 * 1000;

export interface VerificationRecord {
  code: string;
  expiresAt: number;
}

/** Generates an `ST-XXXXXX` verification code from the unambiguous invite-code alphabet (CSPRNG). */
export function generateVerificationCode(): string {
  let suffix = '';
  for (let i = 0; i < VERIFICATION_CODE_LENGTH; i += 1) {
    suffix += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return `ST-${suffix}`;
}
