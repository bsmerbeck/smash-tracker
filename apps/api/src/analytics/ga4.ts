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
  if (!config) return;
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
    }
  } catch (err) {
    console.error(
      `GA4 Measurement Protocol POST for "${eventName}" failed (non-blocking)`,
      err instanceof Error ? err.message : err,
    );
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

export type ReviewSharedKind = 'review' | 'recap';

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
