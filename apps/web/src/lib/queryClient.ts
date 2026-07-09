import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/** Max automatic retries for transient failures (network blips, 5xx). */
const MAX_RETRIES = 3;

/** How long fetched data stays fresh before a window focus / remount refetches it. */
const STALE_TIME_MS = 60_000;

/**
 * Never retry a 4xx: it's a deterministic answer about THIS request (bad
 * input, missing auth, missing route), not a transient failure — the same
 * request will 4xx again. Incident that bought this rule: a web deploy
 * briefly outran the API deploy carrying /api/gsp-readings, and the default
 * 3-retry exponential backoff on the resulting 404 blocked the GSP page for
 * ~8 seconds — re-triggered on every window focus and route re-entry. (The
 * API attaches a freshly-minted Firebase token per request, so even 401s
 * aren't retryable-transient here.) Network errors and 5xx keep the normal
 * retry budget.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

/**
 * App-wide QueryClient defaults. `staleTime` keeps tab switches from
 * refetching every query on the page (mutations invalidate their queries
 * explicitly throughout the app, so a 60s freshness window is safe); the
 * retry predicate is documented above.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        staleTime: STALE_TIME_MS,
      },
    },
  });
}
