import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { dayShardKey } from '../events/ledger.js';

/**
 * CRED-04: the first RTDB-backed rate limiter in this codebase.
 * `@fastify/rate-limit` (registered in `apps/api/src/app.ts`) is in-memory
 * and per-process, so it cannot enforce a cross-instance cap on a
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
