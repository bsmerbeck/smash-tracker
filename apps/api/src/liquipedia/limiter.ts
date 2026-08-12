import type { Database } from 'firebase-admin/database';

/**
 * Phase 30.2 Plan 03 (ENR-01): the durable, GLOBAL two-budget limiter for
 * every outbound Liquipedia MediaWiki API call.
 *
 * Modelled member-for-member on `createSharedRequestThrottle` in
 * `apps/api/src/research/ingestion/throttle.ts`, with one structural
 * difference the owner's locked access contract demands: Liquipedia's
 * published terms are a MINIMUM SPACING contract (>=1 general request per
 * 2s, >=1 `action=parse` request per 30s), not a token-bucket rolling-rate
 * contract like start.gg's. A token bucket answers "how many requests in
 * this window" — the wrong question here. This limiter instead stores a
 * single `lastGrantedAtMs` timestamp per budget and enforces the interval
 * directly: a grant may only occur at or after `lastGrantedAtMs + intervalMs`.
 * That is the durable, global equivalent of a "wait 2 seconds since the last
 * request" rule, shared across every invocation and every process because
 * the timestamp lives on one RTDB node, never in local memory.
 *
 * Two SEPARATE budget nodes exist — `LIQUIPEDIA_GENERAL_BUDGET_PATH` and
 * `LIQUIPEDIA_PARSE_BUDGET_PATH` — because the two published intervals are
 * independent constraints, not one constraint at two granularities: a
 * general request must never be closer than 2s to the PRIOR GENERAL
 * request, and a parse-class request must never be closer than 30s to the
 * PRIOR PARSE-CLASS request. A parse-class request is ALSO a general
 * request against the same API endpoint, so it must additionally respect
 * the 2s general spacing — hence a parse-class acquisition consumes BOTH
 * budgets. The ORDER matters: parse-first, then general. A parse-class
 * request that acquired the general budget first but then had to wait 30s
 * on the parse budget would leave the general budget's `lastGrantedAtMs`
 * stamped 30 real seconds stale relative to when the request actually
 * fires, silently under-spacing the very next general-only request that
 * lands right after it. Acquiring parse first, then general, makes the
 * general timestamp accurate to the moment the request is actually about
 * to go out.
 *
 * The wait budget is a PER-CALL argument to `acquire`, never a constructor
 * option — see `throttle.ts` lines 56-77 for the reasoning, which applies
 * identically here: a ceiling fixed at construction would be re-honored in
 * full by every subsequent acquisition, letting N acquisitions inside one
 * invocation each sleep up to the whole budget and jointly blow through it.
 *
 * `now`/`sleep` are injected and default to `Date.now`/a promise-wrapped
 * `setTimeout`. This pair is what makes ENR-01's fake-clock proof possible:
 * every test in `limiter.test.ts` drives a virtual clock and a
 * synchronously-resolving `sleep`, so the whole suite — which proves over a
 * minute of enforced spacing — finishes in well under two REAL seconds. CI
 * never sleeps on a wall clock for this module.
 *
 * ACCEPTED RISK — SINGLE-PROCESS WALL CLOCK (Codex checkpoint-3 risk,
 * accepted for this phase; stated here so nobody has to rediscover it).
 * What the durable budget guarantees unconditionally is SERIALISATION: the
 * `lastGrantedAtMs` timestamp lives on one RTDB node and every grant moves
 * it through a `.transaction()`, so two concurrent processes can never both
 * believe they hold the same grant. What it does NOT guarantee is that the
 * REAL-TIME SPACING between two grants issued by two DIFFERENT processes is
 * at least the published interval, because each process compares that
 * shared timestamp against its OWN `now()`. A machine whose clock runs
 * ahead of its peer's by more than the skew between them can therefore see
 * an interval as already elapsed when, by the peer's clock, it has not.
 *
 * This is out of contract for wave 9 by construction, not by hope: the
 * enrichment fetch path runs from ONE process — the wave-9 CLI — so there
 * is exactly one clock, and the published term is enforced per-client
 * against it. The moment a second concurrent fetcher is introduced (a
 * scheduled job alongside the CLI, or a horizontally-scaled service), this
 * assumption is void and the fix is a SERVER-RELATIVE clock: derive the
 * comparison instant from the database's own time (an RTDB server-timestamp
 * write read back, or an explicit offset measured against it) instead of
 * each process's local `Date.now`, so all participants compare against one
 * authority. Adopting that is the named follow-up; until then, do not add a
 * second concurrent Liquipedia fetcher.
 */

export const LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS = 2000;
export const LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS = 30_000;
export const LIQUIPEDIA_GENERAL_BUDGET_PATH = 'researchRateBudget/liquipedia';
export const LIQUIPEDIA_PARSE_BUDGET_PATH = 'researchRateBudget/liquipediaParse';

/**
 * Bounds the retry loop inside a single `acquire` transaction contest. At 20
 * attempts against two independent budget nodes this is far beyond any
 * realistic contention level (the shared start.gg throttle this is modelled
 * on has no such cap because its token math cannot infinite-loop; this one
 * is a defensive belt-and-braces bound against a pathological transaction
 * hash-mismatch storm, not an expected code path).
 */
export const LIQUIPEDIA_LIMITER_MAX_ATTEMPTS = 20;

export type LiquipediaRequestClass = 'general' | 'parse-class';

export interface LiquipediaLimiterOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LiquipediaAcquireResult {
  granted: boolean;
  waitedMs: number;
  reason?: string;
}

export interface LiquipediaLimiter {
  acquire(
    requestClass: LiquipediaRequestClass,
    remainingWaitBudgetMs: number,
  ): Promise<LiquipediaAcquireResult>;
}

interface StoredIntervalBudget {
  lastGrantedAtMs: number;
}

function parseIntervalBudget(raw: unknown): StoredIntervalBudget | null {
  if (
    raw != null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>).lastGrantedAtMs === 'number' &&
    Number.isFinite((raw as Record<string, unknown>).lastGrantedAtMs)
  ) {
    return { lastGrantedAtMs: (raw as StoredIntervalBudget).lastGrantedAtMs };
  }
  // No stored node (or malformed): treated as "no prior grant" — see
  // `acquireOnBudget`'s null-first-run handling below, which must NOT abort
  // on this shape (FakeDatabase and the real Admin SDK both invoke the
  // transaction update function with `null` on its first run regardless of
  // whether server data exists — review CR-01 parity).
  return null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquires a single interval-spaced budget on `budgetPath`, sleeping through
 * the injected `sleep` as needed, bounded by `remainingWaitBudgetMs` and
 * `LIQUIPEDIA_LIMITER_MAX_ATTEMPTS`. Returns the sub-result for THIS budget
 * only — callers composing multiple budgets (see `createLiquipediaLimiter`
 * below) combine sub-results themselves.
 */
async function acquireOnBudget(
  database: Database,
  budgetPath: string,
  intervalMs: number,
  remainingWaitBudgetMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<LiquipediaAcquireResult> {
  if (remainingWaitBudgetMs <= 0) {
    return { granted: false, waitedMs: 0, reason: 'no-wait-budget' };
  }

  let waitedMs = 0;

  for (let attempt = 0; attempt < LIQUIPEDIA_LIMITER_MAX_ATTEMPTS; attempt += 1) {
    const nowMs = now();
    const result = await database.ref(budgetPath).transaction((raw) => {
      // The FIRST invocation of this function within a given `.transaction()`
      // call is ALWAYS run against `null` (the SDK's local-cache emulation),
      // even when real server data exists (review CR-01). A stored budget
      // must therefore never be trusted on that first pass; `parseIntervalBudget`
      // already treats `null`/malformed input as "no prior grant", which is
      // exactly the behavior we want here too: never abort on `null`, only on
      // a genuine too-soon condition against REAL stored data.
      const current = parseIntervalBudget(raw);
      if (current === null) {
        // No prior grant recorded (or this is the null-first-run pass) — grant
        // immediately, stamping the current clock.
        return { lastGrantedAtMs: nowMs } satisfies StoredIntervalBudget;
      }
      const elapsedMs = nowMs - current.lastGrantedAtMs;
      if (elapsedMs < intervalMs) {
        // Too soon — ABORT (return undefined) rather than granting early.
        // The caller computes the residual wait, checks it against the
        // remaining budget, sleeps, and retries.
        return undefined;
      }
      // Grant. Stamp the GREATER of the current clock and the previous
      // grant plus the interval, so a burst of concurrent acquisitions
      // serializes onto the interval grid rather than clustering just
      // inside it.
      return {
        lastGrantedAtMs: Math.max(nowMs, current.lastGrantedAtMs + intervalMs),
      } satisfies StoredIntervalBudget;
    });

    if (result.committed) {
      return { granted: true, waitedMs };
    }

    const stored = parseIntervalBudget(result.snapshot.val());
    const elapsedMs = stored === null ? intervalMs : now() - stored.lastGrantedAtMs;
    const residualWaitMs = Math.max(1, intervalMs - elapsedMs);

    if (waitedMs + residualWaitMs > remainingWaitBudgetMs) {
      return { granted: false, waitedMs, reason: 'wait-budget-exceeded' };
    }

    await sleep(residualWaitMs);
    waitedMs += residualWaitMs;
  }

  return { granted: false, waitedMs, reason: 'max-attempts-exceeded' };
}

/**
 * Creates the durable, GLOBAL two-budget Liquipedia limiter. `database` is
 * the same Firebase RTDB `Database` every other durable node in this
 * codebase shares — the budget nodes are NEVER tenant-keyed (this is a
 * property of the shared Liquipedia API endpoint, not of any research
 * tenant), so they do NOT belong in `TENANT_DELETION_TREES`.
 */
export function createLiquipediaLimiter(
  database: Database,
  options: LiquipediaLimiterOptions = {},
): LiquipediaLimiter {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async acquire(
      requestClass: LiquipediaRequestClass,
      remainingWaitBudgetMs: number,
    ): Promise<LiquipediaAcquireResult> {
      if (remainingWaitBudgetMs <= 0) {
        return { granted: false, waitedMs: 0, reason: 'no-wait-budget' };
      }

      if (requestClass === 'general') {
        return acquireOnBudget(
          database,
          LIQUIPEDIA_GENERAL_BUDGET_PATH,
          LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
          remainingWaitBudgetMs,
          now,
          sleep,
        );
      }

      // parse-class: acquire the PARSE budget first, then the GENERAL
      // budget — see the module header for why this order matters.
      const parseResult = await acquireOnBudget(
        database,
        LIQUIPEDIA_PARSE_BUDGET_PATH,
        LIQUIPEDIA_PARSE_CLASS_MIN_INTERVAL_MS,
        remainingWaitBudgetMs,
        now,
        sleep,
      );
      if (!parseResult.granted) {
        return parseResult;
      }

      const generalRemaining = remainingWaitBudgetMs - parseResult.waitedMs;
      const generalResult = await acquireOnBudget(
        database,
        LIQUIPEDIA_GENERAL_BUDGET_PATH,
        LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
        generalRemaining,
        now,
        sleep,
      );

      return {
        granted: generalResult.granted,
        waitedMs: parseResult.waitedMs + generalResult.waitedMs,
        reason: generalResult.reason,
      };
    },
  };
}
