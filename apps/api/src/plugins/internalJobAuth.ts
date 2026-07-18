import { timingSafeEqual } from 'node:crypto';

/**
 * T-10-05-01/V6: constant-time comparison for the `/internal/jobs/*`
 * shared-secret header (`X-Internal-Jobs-Secret`). Deliberately NEVER a
 * plain `===` string compare — that leaks timing information proportional
 * to the number of matching leading bytes, letting an attacker recover the
 * secret byte-by-byte. `timingSafeEqual` itself throws on unequal-length
 * buffers, so the length check MUST happen before calling it (also closes
 * the timing side-channel a length-dependent throw would otherwise open).
 * Returns false — never throws — for a missing header or any length/value
 * mismatch; only an exact-length, exact-match header succeeds.
 */
export function checkInternalJobSecret(header: string | undefined, expected: string): boolean {
  if (!header) {
    return false;
  }

  const headerBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);

  if (headerBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(headerBuffer, expectedBuffer);
}
