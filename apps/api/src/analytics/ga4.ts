import { createHash } from 'node:crypto';
import type { Ga4Config } from '../config/env.js';

const GA4_MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

/**
 * Phase 7 (Recap Cards & Share-Loop Analytics): server-authoritative GA4
 * Measurement Protocol delivery. `null` config (GA4 unconfigured) is an
 * instant, silent no-op — never a throw, never a fetch. A rejecting/erroring
 * fetch is swallowed by the internal try/catch so this function's returned
 * promise ALWAYS resolves — callers must still invoke it with `void` (never
 * `await`) so a GA4 outage/partition can never slow or fail the caller's own
 * response (Pitfall 5). The catch logs ONLY the event name + outcome, never
 * the request URL, which embeds `api_secret` as a query param (Security
 * Domain: T-07-07-01).
 */
export async function sendMeasurementProtocolEvent(
  config: Ga4Config | null,
  clientId: string,
  eventName: string,
  params: Record<string, string | number>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await sendMeasurementProtocolEventResult(config, clientId, eventName, params, fetchImpl);
}

/**
 * Phase 10 Plan 5 (Canonical Measurement & Money Safety): same POST as
 * `sendMeasurementProtocolEvent` above (identical URL-building, identical
 * "never log the URL — it embeds api_secret" discipline), but resolves to
 * whether the projection actually succeeded instead of always resolving to
 * void. `jobs/projectGa4.ts` needs this to know whether to remove an outbox
 * key (success) or increment its retry `attempt` (failure) — a distinction
 * `sendMeasurementProtocolEvent`'s fire-and-forget contract deliberately
 * never surfaces to its own (route-triggered) callers. Extracting the
 * shared transport here keeps `sendMeasurementProtocolEvent`'s signature and
 * behavior (always resolves, never throws) completely unchanged for
 * `reviewShared`'s existing callers.
 */
export async function sendMeasurementProtocolEventResult(
  config: Ga4Config | null,
  clientId: string,
  eventName: string,
  params: Record<string, string | number>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config) return false;
  const url = `${GA4_MP_ENDPOINT}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId, events: [{ name: eventName, params }] }),
    });
    if (!response.ok) {
      console.error(
        `GA4 Measurement Protocol POST for "${eventName}" returned status ${response.status} (non-blocking)`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `GA4 Measurement Protocol POST for "${eventName}" failed (non-blocking)`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Deterministic, non-reversible client_id derived from the share-creating
 * uid — GA4's own reports then group a user's repeat `review_shared` hits
 * together, without pushing the raw Firebase uid to a third-party analytics
 * vendor (RESEARCH.md Pattern 4 / Assumption A2).
 */
export function reviewSharedClientId(uid: string): string {
  return createHash('sha256').update(uid).digest('hex').slice(0, 32);
}

/**
 * Phase 12 (Coach Reviews & Delivery): widened to include 'coachReview' so
 * this type stays in lockstep with `createShareInputSchema.kind`'s literal
 * union in `packages/shared/src/shares.ts` — `reviewShared`'s call site in
 * `vodShares.ts` passes `request.body.kind` straight through, so this type
 * must accept every value that schema can validly produce.
 */
export type ReviewSharedKind = 'review' | 'recap' | 'coachReview';

/**
 * Fires the `review_shared` server event (param `kind: review|recap`) for a
 * just-created share. Fire-and-forget: call as `void reviewShared(...)`,
 * never `await`, at the point in the route handler where the share is
 * already durably written (Pattern 5).
 */
export function reviewShared(
  config: Ga4Config | null,
  uid: string,
  kind: ReviewSharedKind,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendMeasurementProtocolEvent(
    config,
    reviewSharedClientId(uid),
    'review_shared',
    { kind },
    fetchImpl,
  );
}
