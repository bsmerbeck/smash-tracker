import { randomBytes } from 'node:crypto';

/**
 * CSPRNG share bearer token (~256-bit, ~43 base64url chars) — mirrors
 * `parrygg/verificationCode.ts`'s `node:crypto`-based secret generation
 * precedent in this codebase, but uses `randomBytes` (not `randomInt` over
 * a fixed alphabet) per the locked decision: a share token is a bearer
 * credential in a URL, not a human-typed code, so entropy matters far more
 * than typability. Never derived from `matchId`/`uid`/an RTDB push key.
 */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}
