import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { dayShardKey } from '../events/ledger.js';

/**
 * CRED-04: the first RTDB-backed rate limiter in this codebase.
 * The existing rate-limit plugin registered in `apps/api/src/app.ts` is
 * in-memory and per-process, so it cannot enforce a cross-instance cap on a
 * horizontally-scaled Cloud Run deployment — a second instance simply has
 * its own independent counter. This module's counters live at RTDB paths
 * and are mutated via a single `.transaction()` call, so every instance
 * observes and contends for the same count (CONTEXT.md Area 3: "RTDB
 * sharded counters ... never in-memory-only").
 *
 * Retention: `claimRedemptionAttempts*` and `claimIssuanceAttempts` trees
 * are deliberately NOT added to `apps/api/src/jobs/prune.ts` in Phase 23.
 * These are single-number nodes under hour/day shards at very low write
 * volume for this project's scale — leaving them unpruned for the v2.4
 * timeframe is an accepted backlog item, not a success criterion.
 */

/**
 * Hourly sibling of `dayShardKey` (`apps/api/src/events/ledger.ts`): UTC
 * `YYYYMMDDHH`, no separators. The shard key doubles as the window
 * boundary — a counter node simply becomes irrelevant once the hour rolls
 * over, so no reset job is needed for the hourly limits this module
 * enforces.
 */
export function hourShardKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13).replace(/-/g, '').replace('T', '');
}

/**
 * Hashes a rate-limit key segment (e.g. a client IP) before it becomes an
 * RTDB path segment. This is NOT primarily privacy hygiene (though it is
 * that too) — a raw IPv4 address contains `.`, which is an ILLEGAL RTDB
 * path character. Real RTDB and `FakeDatabase.ref()`
 * (`apps/api/src/test-support/fakeDatabase.ts`) both throw synchronously on
 * a path segment containing `.`, `#`, `$`, `[`, or `]`. Same sha256-hex-slice
 * technique as `ga4ClientId` in `apps/api/src/events/ga4Project.ts`.
 */
export function hashRateLimitSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** CRED-04 / CONTEXT.md Area 3: 5 redemption attempts per account per hour. */
export const CLAIM_REDEMPTION_PER_ACCOUNT_HOURLY_LIMIT = 5;

/** CRED-04 / CONTEXT.md Area 3: 20 redemption attempts per network signal (IP) per hour. */
export const CLAIM_REDEMPTION_PER_IP_HOURLY_LIMIT = 20;

/** CRED-04 / CONTEXT.md Area 3: 20 claim-code issuances per issuing coach per day (rotations count toward this). */
export const MAX_CLAIM_ISSUANCES_PER_DAY = 20;

/**
 * Path builders return plain strings, never `Reference`s, so callers cannot
 * bypass the hashing step by grabbing a ref and reusing a raw IP elsewhere.
 */

export function claimRedemptionAccountPath(uid: string, nowMs: number): string {
  return `claimRedemptionAttempts/${uid}/${hourShardKey(nowMs)}`;
}

/**
 * The hashing happens INSIDE this function — the raw IP must never leave
 * it. See `hashRateLimitSegment` for why a raw IP is illegal as a path
 * segment.
 */
export function claimRedemptionIpPath(clientIp: string, nowMs: number): string {
  return `claimRedemptionAttemptsByIp/${hashRateLimitSegment(clientIp)}/${hourShardKey(nowMs)}`;
}

export function claimIssuancePath(coachUid: string, nowMs: number): string {
  return `claimIssuanceAttempts/${coachUid}/${dayShardKey(nowMs)}`;
}

/**
 * Runs a single RTDB transaction that increments the counter at `path` and
 * caps it at `limit`. Returns `true` when the attempt was recorded and is
 * within the cap, `false` when the counter is verified at or above `limit`.
 *
 * CR-01 correctness (this is where an earlier research draft was wrong, and
 * a reviewer must be able to see the fix): the admin SDK always invokes the
 * update function against its LOCAL CACHE first, which is `null` on a
 * listener-less server process even when server data already exists at this
 * path. A shape that returns the UNCHANGED input on that null first run
 * (the `spendCredit`-style "read, don't decrement" shape in
 * `apps/api/src/billing/credits.ts`) would commit a literal `null` here —
 * this counter has no read/no-op branch, so that shape would mean the
 * counter NEVER starts incrementing and every request looks "under limit"
 * forever.
 *
 * Instead, `null`/non-number is coerced to a count of `0` and the function
 * returns `count + 1`. This is correct AND CR-01-safe by construction:
 * because an absent node always yields a count of 0, and 0 is below every
 * limit this module defines (as long as `limit >= 1`), the `undefined`
 * abort branch below is only ever reachable after a retry against REAL
 * stored data (`FakeDatabase.transaction()` re-runs the update function
 * with the real value on a hash mismatch — see
 * `apps/api/src/test-support/fakeDatabase.ts` lines 213-237). A `limit` of
 * 0 would break this invariant (it would abort on the null first run and
 * permanently abort in production), so every caller in this codebase must
 * pass `limit >= 1`.
 *
 * Mirrors the write-on-empty-node shape of `markStripeEventProcessed` in
 * `apps/api/src/billing/credits.ts`, not the read-then-decrement shape of
 * `spendCredit` in the same file.
 */
export async function checkAndIncrement(
  database: Database,
  path: string,
  limit: number,
): Promise<boolean> {
  const result = await database.ref(path).transaction((current) => {
    const count = typeof current === 'number' ? current : 0;
    if (count >= limit) {
      // Verified, real-data abort — the ONLY abort branch. Unreachable on
      // the null first run because 0 < limit for every limit >= 1.
      return undefined;
    }
    return count + 1;
  });

  return result.committed;
}
