import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Chunk-load hardening for React.lazy factories.
 *
 * Incident that bought this module (P1, 2026-08-12): right after a deploy, a
 * cold CDN edge (`x-cache: MISS`) served boot-path chunks in 26–103s and the
 * app rendered nothing until the slowest landed. A dynamic import has no
 * timeout, no retry, and no fallback of its own: a hung request pins the
 * route's Suspense fallback forever, and a REJECTED factory (chunk 404 after
 * a deploy replaces hashed filenames) throws during render with no
 * ErrorBoundary above it. This wrapper gives every lazy component:
 *
 *   1. a per-attempt timeout,
 *   2. retries with backoff — re-calling import() latches onto a
 *      still-pending module request (a timed-out-but-alive fetch gets
 *      another window) or re-issues the fetch after a network failure,
 *   3. a final recovery location.reload(), rate-limited by a sessionStorage
 *      cooldown — the deploy-skew escape hatch: reloading fetches fresh
 *      HTML whose module graph points at the new hashed chunk URLs.
 */

/** Per-attempt budget before the attempt is abandoned and retried. */
const CHUNK_LOAD_TIMEOUT_MS = 10_000;

/** Retries after the initial attempt (3 attempts total, ~33s worst case). */
const MAX_CHUNK_LOAD_RETRIES = 2;

/** First retry waits this long; each later retry doubles it (1s, 2s). */
const CHUNK_RETRY_BACKOFF_BASE_MS = 1_000;

/**
 * sessionStorage key holding the epoch-ms timestamp of the last automatic
 * recovery reload. A reload is allowed only when no reload happened within
 * RELOAD_COOLDOWN_MS — a cooldown, not a clearable boolean, because ANY
 * "clear on success" scheme re-arms itself across reloads (boot succeeds →
 * cleared → broken route chunk fails → reload → boot succeeds → cleared →
 * …an infinite ~4s reload loop for a deterministically failing chunk, e.g.
 * an asset missing from a botched deploy or one blocked by an ad-blocker).
 * Session-scoped so a fresh tab after the next deploy gets its own budget.
 * The key literal and cooldown are DUPLICATED in index.html's inline boot
 * watchdog (which cannot import modules) — keep the three sites in sync:
 * here, main.tsx's vite:preloadError listener, and index.html.
 */
export const CHUNK_RELOAD_STAMP_KEY = 'smash-tracker.chunkReloadAt';

/** Minimum spacing between automatic recovery reloads. */
export const RELOAD_COOLDOWN_MS = 5 * 60_000;

/** Options exist for tests; production call sites pass none. */
export interface LoadWithRetryOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Injectable because jsdom's location.reload is non-configurable. */
  reload?: () => void;
}

export function isReloadOnCooldown(now = Date.now()): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stamp = Number(window.sessionStorage.getItem(CHUNK_RELOAD_STAMP_KEY));
    return Number.isFinite(stamp) && stamp > 0 && now - stamp < RELOAD_COOLDOWN_MS;
  } catch {
    // Storage unavailable (private browsing etc.) — treat as on cooldown so
    // a broken chunk can never trigger an unbounded reload loop.
    return true;
  }
}

export function stampReload(now = Date.now()): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_STAMP_KEY, String(now));
  } catch {
    // Ignore storage failures — worst case we skip the reload.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<M>(promise: Promise<M>, timeoutMs: number): Promise<M> {
  return new Promise<M>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Chunk load timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Exported for direct unit testing (no React render needed). Runs the
 * timeout/backoff/reload state machine described in the module doc.
 */
export async function loadWithRetry<M>(
  factory: () => Promise<M>,
  options: LoadWithRetryOptions = {},
): Promise<M> {
  const {
    timeoutMs = CHUNK_LOAD_TIMEOUT_MS,
    maxRetries = MAX_CHUNK_LOAD_RETRIES,
    backoffBaseMs = CHUNK_RETRY_BACKOFF_BASE_MS,
    reload = () => window.location.reload(),
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await delay(backoffBaseMs * 2 ** (attempt - 1));
    }
    try {
      return await withTimeout(factory(), timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }

  if (!isReloadOnCooldown()) {
    stampReload();
    reload();
    // The page is being torn down; keep Suspense pending instead of
    // flashing an error during the reload.
    return new Promise<never>(() => {});
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Chunk load failed after retries and a recovery reload');
}

/**
 * Drop-in replacement for React.lazy with the retry/timeout/reload behavior
 * above. Mirrors React.lazy's own signature (its `ComponentType<any>`
 * constraint is what LazyExoticComponent requires); call sites resolve
 * `{ default: <named page export> }` exactly as with bare lazy().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function retryableLazy<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => loadWithRetry(factory));
}
