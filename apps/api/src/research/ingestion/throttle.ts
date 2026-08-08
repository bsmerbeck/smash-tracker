import type { Database } from 'firebase-admin/database';

/**
 * Phase 30 Plan 05 (ING-02, D-07, D-18): request throttling for the start.gg
 * research backfill.
 *
 * Two layers, deliberately separate because the constraints they protect
 * are separate (review C-H7):
 *
 * - `createRequestThrottle` is a per-invocation, in-process sliding window.
 *   It bounds ONE invocation's request rate, cheaply, with no I/O.
 * - `createSharedRequestThrottle` is a DURABLE, token-wide budget shared
 *   across every invocation and every tenant, backed by one RTDB node. The
 *   published start.gg limit (80 req/60s) is per API TOKEN, not per
 *   invocation — an admin `advance` and a scheduler `advance` running at the
 *   same time, or two different tenants' backfills, each stay under the
 *   per-invocation window while jointly sending far more in the same
 *   minute. The shared budget node is the only place the two can see each
 *   other.
 *
 * Both throttles take the caller's remaining wait budget as a PER-CALL
 * argument to `acquire`, never a constructor option (review C3-A1) — see
 * the doc comment on `RequestThrottle.acquire` for why a constructor
 * ceiling is a defect, not a simplification.
 */

export const RESEARCH_THROTTLE_MAX_REQUESTS = 60;
export const RESEARCH_THROTTLE_WINDOW_MS = 60_000;

/**
 * `RESEARCH_THROTTLE_BURST` is roughly one invocation's opening pages, so a
 * freshly started backfill is not throttled on its first fetches, and it is
 * small enough that the rolling bound below still clears the published
 * limit. `RESEARCH_THROTTLE_ROLLING_MAX` (= burst + sustained-per-window) is
 * the most requests admissible in ANY rolling 60-second span from the
 * durable token bucket — 70 against a published 80, ten requests of
 * headroom (review C2-A4, D-07/D-18).
 */
export const RESEARCH_THROTTLE_BURST = 10;
export const RESEARCH_THROTTLE_ROLLING_MAX =
  RESEARCH_THROTTLE_BURST + RESEARCH_THROTTLE_MAX_REQUESTS; // 70

/** Milliseconds between one-request's-worth of refill at the sustained rate. */
export const RESEARCH_TOKEN_REFILL_INTERVAL_MS =
  RESEARCH_THROTTLE_WINDOW_MS / RESEARCH_THROTTLE_MAX_REQUESTS; // 1000

export const RESEARCH_TOKEN_BUDGET_PATH = 'researchRateBudget/startgg';

export interface RequestThrottleOptions {
  maxRequests?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ThrottleAcquireResult {
  acquired: boolean;
  sleptMs: number;
}

export interface RequestThrottle {
  /**
   * @param remainingWaitBudgetMs the CALLER's remaining synchronous-sleep
   * allowance, re-supplied on every call (review C3-A1). THIS IS DELIBERATE
   * AND NOT A CONSTRUCTOR OPTION: a ceiling fixed at construction is
   * re-honored in FULL by every subsequent acquisition, so N acquisitions
   * inside one invocation could each sleep up to the whole budget and
   * jointly blow through it long before the caller sees any `sleptMs` back.
   * Passing the CURRENT remainder makes the allowance cumulative by
   * construction, and keeps the arithmetic in the one place that knows the
   * total — the invocation. A zero or negative remainder returns
   * immediately with `acquired: false`, never a sleep of zero and never a
   * throw.
   */
  acquire(remainingWaitBudgetMs: number): Promise<ThrottleAcquireResult>;
  requestsInWindow(): number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A per-invocation, in-process sliding window over recorded request
 * timestamps. Bounds ONE invocation's request rate; does NOT bound
 * concurrency across invocations or tenants — see `createSharedRequestThrottle`
 * for that.
 */
export function createRequestThrottle(options: RequestThrottleOptions = {}): RequestThrottle {
  const maxRequests = options.maxRequests ?? RESEARCH_THROTTLE_MAX_REQUESTS;
  const windowMs = options.windowMs ?? RESEARCH_THROTTLE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  let timestamps: number[] = [];

  function pruneWindow(): void {
    const cutoff = now() - windowMs;
    timestamps = timestamps.filter((t) => t > cutoff);
  }

  return {
    async acquire(remainingWaitBudgetMs: number): Promise<ThrottleAcquireResult> {
      if (remainingWaitBudgetMs <= 0) {
        return { acquired: false, sleptMs: 0 };
      }

      let sleptMs = 0;
      pruneWindow();

      while (timestamps.length >= maxRequests) {
        const oldest = timestamps[0]!;
        const waitMs = Math.max(0, oldest + windowMs - now());
        if (waitMs === 0) {
          pruneWindow();
          continue;
        }
        if (sleptMs + waitMs > remainingWaitBudgetMs) {
          return { acquired: false, sleptMs };
        }
        await sleep(waitMs);
        sleptMs += waitMs;
        pruneWindow();
      }

      timestamps.push(now());
      return { acquired: true, sleptMs };
    },
    requestsInWindow(): number {
      pruneWindow();
      return timestamps.length;
    },
  };
}

export interface SharedThrottleOptions extends RequestThrottleOptions {
  budgetPath?: string;
  burst?: number;
}

interface StoredTokenBudget {
  tokensMilli: number;
  lastRefillAtMs: number;
}

function parseTokenBudget(raw: unknown, freshNowMs: number, capMilli: number): StoredTokenBudget {
  if (
    raw != null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>).tokensMilli === 'number' &&
    typeof (raw as Record<string, unknown>).lastRefillAtMs === 'number' &&
    Number.isFinite((raw as Record<string, unknown>).tokensMilli) &&
    Number.isFinite((raw as Record<string, unknown>).lastRefillAtMs)
  ) {
    const stored = raw as { tokensMilli: number; lastRefillAtMs: number };
    return {
      tokensMilli: Math.min(capMilli, Math.max(0, stored.tokensMilli)),
      lastRefillAtMs: stored.lastRefillAtMs,
    };
  }
  // No stored node (or malformed): the bucket starts FULL, as of now.
  return { tokensMilli: capMilli, lastRefillAtMs: freshNowMs };
}

/**
 * The DURABLE, token-wide budget the in-process throttle structurally
 * cannot provide (review C-H7), implemented as a TOKEN BUCKET rather than a
 * fixed window (review C2-A4).
 *
 * Why a bucket and not a window: a fixed `{ windowStartedAtMs, count }`
 * window admits its full allowance immediately before a boundary and its
 * full allowance immediately after, so two adjacent windows can deliver
 * 120 requests inside one ROLLING 60 seconds against a published 80 — the
 * bound it appeared to enforce was never the bound that matters. A token
 * bucket has no boundary: the most requests admissible in ANY rolling
 * 60-second span is the bucket's capacity plus one window's worth of
 * refill, `RESEARCH_THROTTLE_BURST + RESEARCH_THROTTLE_MAX_REQUESTS = 70`,
 * under the published 80 with ten requests of headroom.
 *
 * Why the node is NOT tenant-keyed: it describes the shared start.gg API
 * token, not a tenant, and stores only a token balance and a refill
 * timestamp — it therefore does NOT belong in `TENANT_DELETION_TREES`.
 *
 * Why a transaction and not a plain read-modify-write counter: two
 * invocations reserving a token is exactly the race CR-01 exists for.
 *
 * The stored node is `{ tokensMilli, lastRefillAtMs }` — MILLI-tokens (1000
 * milli-tokens = one request) stored as integers so repeated fractional
 * refills cannot drift, capped at `burst * 1000`.
 */
export function createSharedRequestThrottle(
  database: Database,
  options: SharedThrottleOptions = {},
): RequestThrottle {
  const maxRequests = options.maxRequests ?? RESEARCH_THROTTLE_MAX_REQUESTS;
  const windowMs = options.windowMs ?? RESEARCH_THROTTLE_WINDOW_MS;
  const burst = options.burst ?? RESEARCH_THROTTLE_BURST;
  const budgetPath = options.budgetPath ?? RESEARCH_TOKEN_BUDGET_PATH;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const capMilli = burst * 1000;
  // Milli-tokens refilled per millisecond at the sustained rate.
  const refillRateMilliPerMs = (1000 * maxRequests) / windowMs;

  return {
    async acquire(remainingWaitBudgetMs: number): Promise<ThrottleAcquireResult> {
      if (remainingWaitBudgetMs <= 0) {
        return { acquired: false, sleptMs: 0 };
      }

      let sleptMs = 0;

      for (;;) {
        const nowMs = now();
        const result = await database.ref(budgetPath).transaction((raw) => {
          const current = parseTokenBudget(raw, nowMs, capMilli);
          const elapsedMs = Math.max(0, nowMs - current.lastRefillAtMs);
          const refilled = Math.min(
            capMilli,
            current.tokensMilli + elapsedMs * refillRateMilliPerMs,
          );
          if (refilled >= 1000) {
            return { tokensMilli: refilled - 1000, lastRefillAtMs: nowMs };
          }
          // Insufficient balance — leave the node UNCHANGED. This is safe
          // even under the null-first-run emulation: a genuinely empty node
          // parses to a FULL bucket (see `parseTokenBudget`), which always
          // clears the >= 1000 check above, so this branch is only ever
          // reached against real, previously-committed data.
          return undefined;
        });

        if (result.committed) {
          return { acquired: true, sleptMs };
        }

        const stored = parseTokenBudget(result.snapshot.val(), nowMs, capMilli);
        const elapsedMs = Math.max(0, nowMs - stored.lastRefillAtMs);
        const currentMilli = Math.min(
          capMilli,
          stored.tokensMilli + elapsedMs * refillRateMilliPerMs,
        );
        const deficitMilli = Math.max(0, 1000 - currentMilli);
        const waitMs = Math.max(1, Math.ceil(deficitMilli / refillRateMilliPerMs));

        if (sleptMs + waitMs > remainingWaitBudgetMs) {
          return { acquired: false, sleptMs };
        }

        await sleep(waitMs);
        sleptMs += waitMs;
      }
    },
    requestsInWindow(): number {
      // No local window is tracked by the shared throttle — it is purely a
      // durable token bucket. Callers that need a local count use
      // `createRequestThrottle` alongside this one.
      return 0;
    },
  };
}
