import { StartggApiError } from '../../startgg/client.js';

/**
 * Phase 30 Plan 05 (ING-02): deterministic backoff for start.gg 429s.
 *
 * start.gg's published rate-limit documentation
 * (`29-STARTGG-POLICY.md` Topic 8, re-confirmed by `30-RESEARCH.md` Pitfall
 * 4) names exactly two rejection bodies — a rate-limit rejection and a
 * query-complexity rejection — and NEVER mentions a `Retry-After` header.
 * The header is therefore treated as opportunistic evidence only: every
 * branch below falls through to the exponential-with-jitter mechanism when
 * the header is absent or unparseable, so a real 429 with no header never
 * hangs and never crashes. Whichever branch actually fires is reported
 * upward (see `assessStartggFailure` below and `RunStatePatch`'s
 * `retryAfterObserved`/`lastRetryAfterValue` in `backfillRun.ts`) so plan
 * 30-07 can stamp it on the run record and plan 30-08 can quote it as A-29-08
 * runtime evidence — recorded from observed behavior, never provoked
 * (D-19).
 */

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_JITTER_RATIO = 0.2;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
  now?: () => number;
}

function clampToMax(value: number, maxMs: number): number {
  if (!Number.isFinite(value)) {
    return maxMs;
  }
  return Math.min(Math.max(0, Math.round(value)), maxMs);
}

/**
 * Deterministic, exactly-testable backoff delay. If a `Retry-After` header
 * is present, tries the RFC 9110 delta-seconds form first, then the
 * HTTP-date form (both clamped to `maxMs`, both floored at zero) — an
 * unparseable header falls THROUGH to the exponential branch rather than
 * throwing or returning NaN. Otherwise computes an exponential-with-jitter
 * delay keyed off `attempt`.
 *
 * The exponential is computed with an INTERMEDIATE clamp (so a huge
 * `attempt` cannot reach Infinity), jitter is added AFTER that, and the
 * FINAL clamp runs last (review C-L4) — clamping before adding jitter would
 * let a returned delay exceed `BACKOFF_MAX_MS` by up to the jitter ratio,
 * making the constant's name a lie. Every path returns a finite,
 * non-negative integer no greater than `maxMs`.
 */
export function resolveBackoffDelayMs(
  retryAfterHeader: string | null | undefined,
  attempt: number,
  options?: BackoffOptions,
): number {
  const baseMs = options?.baseMs ?? BACKOFF_BASE_MS;
  const maxMs = options?.maxMs ?? BACKOFF_MAX_MS;
  const random = options?.random ?? Math.random;
  const now = options?.now ?? Date.now;

  if (retryAfterHeader != null) {
    const asSeconds = Number(retryAfterHeader);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return clampToMax(asSeconds * 1000, maxMs);
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      return clampToMax(Math.max(0, asDate - now()), maxMs);
    }
    // Unparseable header — fall through to the exponential branch.
  }

  const safeAttempt = Math.max(0, attempt);
  // Intermediate clamp: bounds the doubling before it can reach Infinity.
  const exponential = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  const jitter = random() * exponential * BACKOFF_JITTER_RATIO;
  // Final clamp — last operation, after jitter (review C-L4).
  return clampToMax(exponential + jitter, maxMs);
}

export interface RateLimitAssessment {
  isRateLimited: boolean;
  retryAfter: string | null;
  complexityRejected: boolean;
}

/**
 * start.gg's documented rejection message fragments
 * (`29-STARTGG-POLICY.md` Topic 8 / `30-RESEARCH.md` Code Examples).
 */
const RATE_LIMIT_TEXT = 'Rate limit exceeded';
const COMPLEXITY_TEXT = 'Query complexity too high';

/**
 * Classifies an error thrown by `startgg/client.ts`'s `gql()` helper as a
 * rate-limit rejection, a query-complexity rejection, both, or neither.
 * `complexityRejected` is a DISTINCT condition from `isRateLimited` — no
 * amount of backoff can fix an oversized query, so a caller must fail the
 * run with a specific reason rather than retry it forever.
 *
 * Searches BOTH `error.message` and `error.responseBody` (review C-H10):
 * start.gg returns its complexity rejection as a non-2xx, and the
 * transport's thrown message for a non-2xx is only the status text (see
 * `startgg/client.ts`'s `gql()`) — before `responseBody` existed, a
 * message-only check could never fire for exactly the case it was written
 * for, so a complexity failure would have been misreported as a generic
 * provider error and, at some statuses, retried under backoff that cannot
 * possibly help.
 */
export function assessStartggFailure(error: unknown): RateLimitAssessment {
  if (!(error instanceof StartggApiError)) {
    return { isRateLimited: false, retryAfter: null, complexityRejected: false };
  }

  const haystack = `${error.message} ${error.responseBody ?? ''}`;
  const isRateLimited = error.status === 429 || haystack.includes(RATE_LIMIT_TEXT);
  const complexityRejected = haystack.includes(COMPLEXITY_TEXT);

  return {
    isRateLimited,
    retryAfter: error.retryAfter ?? null,
    complexityRejected,
  };
}
