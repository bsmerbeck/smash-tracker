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
 *
 * D-29 FIX — WITHIN-PROCESS TRANSACTION-LATENCY DRIFT (owner-recorded
 * decision, 36-CONTEXT.md; closes a SEPARATE defect from the cross-process
 * risk above, found live by the Phase 36 Liquipedia spike). The prior
 * version of `acquireOnBudget` stamped `lastGrantedAtMs` from the clock
 * read BEFORE the `.transaction()` round trip started, then returned to
 * the caller as soon as the transaction committed — with no wait to align
 * the RETURN (and therefore the caller's actual HTTP dispatch, which
 * follows immediately) to that stamp. A real RTDB transaction's round-trip
 * latency varies — commonly ~1s on a cold connection, ~10ms once warm —
 * and when latency DROPS between two consecutive acquisitions, the REAL
 * spacing between the two actual request dispatches shrinks by exactly
 * that drop, even though both STAMPS were correctly `>= intervalMs` apart.
 * Observed live: two requests measured 908ms apart (required: >= 2000ms)
 * after a 1100ms-then-10ms transaction-latency profile.
 *
 * The fix, proven in `limiter.test.ts`'s "request-start spacing under
 * variable transaction latency" suite: `acquireOnBudget` now (1) commits a
 * RESERVATION — the earliest legal slot given what it can see, computed
 * the same way as before — UNCONDITIONALLY (never aborts for "too soon";
 * reserving a slot still in the future is always safe, since publishing a
 * LARGER-than-required gap is never a compliance problem, only a smaller
 * one is), then (2) compares the REAL, POST-COMMIT clock against that
 * reserved slot: if the transaction's own latency already carried the
 * clock past the slot, it REPAIRS the stored stamp to the real release
 * time (a monotonic max, safe under concurrent writers) so the NEXT
 * acquisition's floor is accurate rather than a stale underestimate;
 * otherwise it sleeps the remainder so `acquire()` never RESOLVES before
 * its reserved slot. This guarantees — by induction over any sequence of
 * acquisitions, regardless of individual transaction latencies, proven in
 * this file's doc comment on `acquireOnBudget` — that consecutive
 * acquisitions of ONE budget path RESOLVE `>= intervalMs` apart in real
 * time, within one process. It does NOT touch, and does not need to touch,
 * the cross-process clock-skew risk described above — that remains the
 * named follow-up, unaffected by this fix.
 *
 * WR-01-i3 FIX — POISONED DURABLE STAMP (36-REVIEW.md iteration 3). A
 * stored `lastGrantedAtMs` implausibly far in the future (a manual RTDB
 * edit, a bug in some other writer, a client clock that briefly reported a
 * huge epoch value) used to be trusted unconditionally: every subsequent
 * acquisition would compute a floor from it, decline forever
 * (`wait-budget-exceeded`, since no realistic caller's wait budget could
 * ever reach it), and — because a decline still commits a reservation
 * (D-29's "always commit a reservation" design) — the poisoned value would
 * never shrink back down. `acquireOnBudget` now clamps any durable stamp
 * more than `poisonedStampHorizonMs(intervalMs)` ahead of `now()` down to
 * `now() + intervalMs` (see that function's own doc comment for exactly
 * how the horizon is chosen) — still conservative (never earlier than one
 * full interval from now, so it can never under-space a REAL grant) but no
 * longer capable of wedging the budget forever. Surfaced via
 * `LiquipediaAcquireResult.durableStampWasPoisoned`, never via a
 * `console.log` this module has never had — a caller/operator can log it,
 * this module stays silent by default.
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
  /**
   * WR-01-i3: `true` when this acquisition detected a stored durable stamp
   * implausibly far in the future (see `poisonedStampHorizonMs`) and
   * clamped it rather than trusting it — set regardless of whether the
   * acquisition was ultimately granted or declined, so a caller/operator
   * can log or alert on it. This module never logs on its own; `undefined`
   * (never `false`) when no poisoned stamp was seen.
   */
  durableStampWasPoisoned?: true;
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
 * WR-01-i3: the sanity ceiling that distinguishes a legitimately-queued
 * near-future reservation from a corrupted/poisoned durable stamp. Derived
 * from `intervalMs * LIQUIPEDIA_LIMITER_MAX_ATTEMPTS` — proportional to each
 * budget's own interval (so the 30s parse budget tolerates a longer
 * legitimate horizon than the 2s general budget: 20 * 30s = 10 minutes vs
 * 20 * 2s = 40s) and reusing an EXISTING named constant rather than
 * introducing an unrelated magic number. Both horizons are comfortably
 * larger than anything this module's real callers (a single-process
 * enrichment CLI, per the module doc comment's "single-process wall clock"
 * section) could legitimately produce, and comfortably smaller than the
 * kind of corruption this guards against (a manual RTDB edit, a stray
 * far-future epoch value, a client clock glitch).
 */
function poisonedStampHorizonMs(intervalMs: number): number {
  return intervalMs * LIQUIPEDIA_LIMITER_MAX_ATTEMPTS;
}

/**
 * WR-01-i3: resolves the durable floor a reservation should use for
 * `current`, clamping a poisoned (implausibly-far-future) stamp down to
 * `nowMs + intervalMs` instead of trusting it — still conservative (never
 * earlier than one full interval from now) but no longer capable of
 * wedging the budget on a corrupt value forever.
 */
function resolveDurableFloor(
  current: StoredIntervalBudget | null,
  intervalMs: number,
  nowMs: number,
): { floor: number; poisoned: boolean } {
  if (current === null) {
    return { floor: -Infinity, poisoned: false };
  }
  if (current.lastGrantedAtMs - nowMs > poisonedStampHorizonMs(intervalMs)) {
    return { floor: nowMs + intervalMs, poisoned: true };
  }
  return { floor: current.lastGrantedAtMs + intervalMs, poisoned: false };
}

/**
 * D-29: best-effort correction, called only when a reservation's own
 * transaction latency already carried the real clock PAST the slot it
 * reserved. Raises the stored stamp to `atLeastMs` — a monotonic max, never
 * a decrease — so the NEXT acquisition's `current.lastGrantedAtMs +
 * intervalMs` floor reflects the ACTUAL release time, not the
 * now-outdated original reservation. A no-op abort (returning `undefined`)
 * when the stored value is already `>= atLeastMs` is an intentional,
 * unremarkable outcome (e.g. a concurrent acquisition already raised it
 * further) — never retried: this is a best-effort tightening on top of a
 * reservation that is already safe (never too early) even if the repair is
 * skipped, so failing to land it costs at most a slightly wider gap than
 * strictly necessary for the NEXT acquisition, never a violation.
 */
async function repairStampAtLeast(
  database: Database,
  budgetPath: string,
  atLeastMs: number,
): Promise<void> {
  await database.ref(budgetPath).transaction((raw) => {
    // CR-01 parity: the null-first-run pass must not be trusted as "genuinely
    // empty" — but writing `atLeastMs` on that pass is safe either way,
    // because if real data turns out to already be >= atLeastMs, the SDK's
    // second, real-data pass re-invokes this function and takes the abort
    // branch instead.
    const current = parseIntervalBudget(raw);
    if (current !== null && current.lastGrantedAtMs >= atLeastMs) {
      return undefined;
    }
    return { lastGrantedAtMs: atLeastMs } satisfies StoredIntervalBudget;
  });
}

/**
 * D-29: per-(limiter-instance, budget-path) precision cache. `null` (no
 * grant released yet by THIS instance).
 *
 * WHY THIS EXISTS (the repair mechanism alone is not enough): the natural
 * first fix — reserve a slot, and if a transaction's own latency carries
 * the clock past it, REPAIR the stored stamp to the real post-commit clock
 * reading — has a subtle non-convergence problem. The repair itself is
 * ANOTHER `.transaction()` call, which ALSO takes real, possibly nonzero
 * time; the value it writes was necessarily read BEFORE that write's own
 * latency elapsed, so it under-states the instant `acquire()` actually
 * returns by exactly the repair transaction's own latency. Chasing that
 * gap with a second repair reproduces the identical problem one level
 * deeper — under a constant per-transaction latency (measured live: this
 * is not a contrived edge case) the chase never converges.
 *
 * The fix: track the ACTUAL release instant of every grant THIS instance
 * hands out in a plain local variable — no transaction latency is possible
 * for a synchronous variable write, so it is exact. `acquireOnBudget`
 * folds `lastReleaseAtMs + intervalMs` into the SAME `max(...)` reservation
 * floor as the durable RTDB stamp. For the sequential-same-instance case
 * (the ONLY way every real caller in this codebase uses this limiter —
 * `liqSpikeProbe.ts`/`enrichDemoAccounts.ts` each construct ONE instance
 * and call `.acquire()` repeatedly), this local floor is provably exact
 * regardless of transaction latency, and the durable RTDB stamp remains
 * the ONLY coordination mechanism across separate instances/processes
 * (the "two independently constructed limiter instances sharing one
 * database" contract, unaffected by this cache — see its own test, which
 * injects no transaction latency and passes via the durable stamp alone,
 * exactly as before). The repair mechanism (`repairStampAtLeast`) is kept
 * as a best-effort SECONDARY correction for that cross-instance case
 * (better durable data beats none, even if not perfectly precise) — never
 * relied upon alone for the property this fix proves.
 */
interface LocalReleaseTracker {
  lastReleaseAtMs: number | null;
}

/**
 * Acquires a single interval-spaced budget slot on `budgetPath`.
 *
 * ALGORITHM (D-29 — see this file's module doc comment for the incident,
 * and `LocalReleaseTracker`'s doc comment above for why a local precision
 * cache is necessary alongside the durable repair below):
 *
 * 1. RESERVE. Compute the earliest legal slot given every floor this
 *    attempt can see — `nowBefore`, the durable `current.lastGrantedAtMs +
 *    intervalMs` (if any prior grant is recorded), and THIS instance's own
 *    `localTracker.lastReleaseAtMs + intervalMs` (if any) — and commit the
 *    max of the three UNCONDITIONALLY. Never abort for "too soon": a
 *    reservation still in the future is always safe to claim, because
 *    publishing a LARGER gap than required is never a compliance problem —
 *    only a SMALLER one is, which is exactly what the pre-fix "abort now,
 *    decide based on a stale pre-transaction clock" pattern could produce.
 *    WR-01-i3: an implausibly-far-future durable stamp is clamped down
 *    (see `resolveDurableFloor`) rather than trusted, so it can never wedge
 *    every future acquisition forever.
 * 2. RELEASE. Read the clock again, now that the commit has actually
 *    happened (`postCommitNow`):
 *    - If `postCommitNow > reservedSlot` (the transaction's own round-trip
 *      latency alone carried the clock past the slot), best-effort REPAIR
 *      the durable stamp to `postCommitNow` (see `repairStampAtLeast`) and
 *      proceed to release immediately — no sleep needed; we are already
 *      past our own reserved slot.
 *    - Otherwise, sleep the remainder so `acquire()` never RESOLVES before
 *      `reservedSlot`. If that remainder would exceed
 *      `remainingWaitBudgetMs`, decline (`wait-budget-exceeded`) WITHOUT
 *      sleeping past it and WITHOUT updating `localTracker` (nothing was
 *      actually released) — the durable reservation itself stays
 *      committed regardless (a declined acquisition never dispatches a
 *      request, so a slightly wider gap for whoever acquires next is a
 *      safe, not a violating, outcome).
 * 3. On every granted release, stamp `localTracker.lastReleaseAtMs =
 *    now()` — read AFTER any sleep/repair, so it is the exact real instant
 *    control returns to the caller.
 *
 * A `result.committed === false` from step 1 is therefore NEVER our own
 * voluntary choice anymore — the update function always returns a value.
 * It can only mean genuine RTDB-level contention on the write itself, which
 * `LIQUIPEDIA_LIMITER_MAX_ATTEMPTS` bounds defensively, exactly as before.
 */
async function acquireOnBudget(
  database: Database,
  budgetPath: string,
  intervalMs: number,
  remainingWaitBudgetMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  localTracker: LocalReleaseTracker,
): Promise<LiquipediaAcquireResult> {
  if (remainingWaitBudgetMs <= 0) {
    return { granted: false, waitedMs: 0, reason: 'no-wait-budget' };
  }

  let reservedSlot: number | undefined;
  let poisonedStampDetected = false;

  for (let attempt = 0; attempt < LIQUIPEDIA_LIMITER_MAX_ATTEMPTS; attempt += 1) {
    const nowBefore = now();
    const localFloor =
      localTracker.lastReleaseAtMs !== null ? localTracker.lastReleaseAtMs + intervalMs : -Infinity;
    let committedSlot = nowBefore;
    let poisonedThisAttempt = false;

    const result = await database.ref(budgetPath).transaction((raw) => {
      // The FIRST invocation of this function within a given `.transaction()`
      // call is ALWAYS run against `null` (the SDK's local-cache emulation),
      // even when real server data exists (review CR-01). A stored budget
      // must therefore never be trusted on that first pass; `parseIntervalBudget`
      // already treats `null`/malformed input as "no prior grant", which is
      // exactly the behavior we want here too.
      const current = parseIntervalBudget(raw);
      // WR-01-i3: clamps an implausibly-far-future stamp rather than
      // trusting it — see `resolveDurableFloor`'s doc comment.
      const { floor: durableFloor, poisoned } = resolveDurableFloor(current, intervalMs, nowBefore);
      poisonedThisAttempt = poisoned;
      const slot = Math.max(nowBefore, durableFloor, localFloor);
      committedSlot = slot;
      // Always commit a reservation — see the function doc comment above
      // for why this never needs to abort for timing reasons anymore.
      return { lastGrantedAtMs: slot } satisfies StoredIntervalBudget;
    });

    if (result.committed) {
      reservedSlot = committedSlot;
      poisonedStampDetected = poisonedThisAttempt;
      break;
    }
    // Genuine infra-level contention on the write itself (never our own
    // timing decision now) — retry with a fresh `now()` read, bounded by
    // the attempt cap.
  }

  if (reservedSlot === undefined) {
    return { granted: false, waitedMs: 0, reason: 'max-attempts-exceeded' };
  }

  const release = (waitedMs: number): LiquipediaAcquireResult => {
    localTracker.lastReleaseAtMs = now();
    return {
      granted: true,
      waitedMs,
      ...(poisonedStampDetected ? { durableStampWasPoisoned: true as const } : {}),
    };
  };

  const postCommitNow = now();
  if (postCommitNow > reservedSlot) {
    // The transaction round trip alone already carried the clock past our
    // own reserved slot — best-effort repair the durable stamp toward
    // reality (see `LocalReleaseTracker`'s doc comment for why this alone
    // would not be enough) and release immediately; nothing to sleep for.
    await repairStampAtLeast(database, budgetPath, postCommitNow);
    return release(0);
  }

  const sleepMs = reservedSlot - postCommitNow;
  if (sleepMs > remainingWaitBudgetMs) {
    return {
      granted: false,
      waitedMs: 0,
      reason: 'wait-budget-exceeded',
      ...(poisonedStampDetected ? { durableStampWasPoisoned: true as const } : {}),
    };
  }
  if (sleepMs > 0) {
    await sleep(sleepMs);
  }
  return release(sleepMs);
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

  // D-29: one precision cache per budget path, scoped to THIS instance —
  // see `LocalReleaseTracker`'s doc comment for why this is required
  // alongside the durable RTDB stamp, not a redundant optimization.
  const generalTracker: LocalReleaseTracker = { lastReleaseAtMs: null };
  const parseTracker: LocalReleaseTracker = { lastReleaseAtMs: null };

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
          generalTracker,
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
        parseTracker,
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
        generalTracker,
      );

      if (generalResult.granted) {
        // D-29: a parse-class ACQUISITION only actually dispatches once
        // BOTH sub-budgets are granted — the caller (`client.ts`) fires the
        // real request only after this whole composed call resolves, not
        // after the parse sub-call alone. `parseTracker.lastReleaseAtMs`
        // (set by the parse sub-call above) therefore understates the true
        // release instant by however long the trailing general sub-call
        // ITSELF took — re-stamp it here, AFTER the general sub-call, with
        // the exact composed-release instant, so the NEXT parse-class
        // acquisition's floor is accurate. A `now()` read is exact (no
        // transaction latency), so this is a correction, not a guess.
        parseTracker.lastReleaseAtMs = now();
      }

      return {
        granted: generalResult.granted,
        waitedMs: parseResult.waitedMs + generalResult.waitedMs,
        reason: generalResult.reason,
        ...(parseResult.durableStampWasPoisoned || generalResult.durableStampWasPoisoned
          ? { durableStampWasPoisoned: true as const }
          : {}),
      };
    },
  };
}
