import { createHash } from 'node:crypto';
import type { EventEnvelope } from '@smash-tracker/shared';

/**
 * MEAS-06/T-10-05-05: allowlisted-field re-selection from a canonical
 * envelope to a GA4 Measurement Protocol payload — NEVER the raw envelope.
 * `clientId` is a non-reversible hash derived from `actorId`+`sessionId`
 * (same sha256-slice technique `reviewSharedClientId` in analytics/ga4.ts
 * already uses for the raw uid), so no raw Firebase uid/session id ever
 * reaches GA4. `params` is built from a small per-`eventName` allowlist of
 * scalar payload keys below — anything not explicitly listed is dropped,
 * so a payload field added to the envelope schema later never leaks to GA4
 * by default. An `eventName` with no defined GA4 projection returns null;
 * the caller (`jobs/projectGa4.ts`) treats that as "skip, don't send."
 */
export interface Ga4ProjectedEvent {
  clientId: string;
  eventName: string;
  params: Record<string, string | number>;
}

/**
 * Per-eventName allowlist of payload keys safe to forward to GA4. An entry
 * with an empty array still projects (client_id + event name only, no
 * params) — only an eventName ABSENT from this map has no GA4 projection at
 * all. Covers the full `EVENT_CATALOG` in packages/shared, including the
 * coaching/onboarding events wired up in quick task 260722-lh1: only
 * enum-like keys (e.g. `onboardingCause`, `intent`) and booleans (e.g.
 * `asked`, projected as their string form — see `String(value)` below) are
 * ever listed; identifier-bearing events (view/ack/coaching_mode_enabled)
 * map to an empty list.
 */
const GA4_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  signup_completed: [],
  checkout_started: ['packId'],
  checkout_completed: ['packId'],
  credits_granted: ['packId'],
  credit_spent: [],
  credit_refunded: [],
  report_started: [],
  report_completed: [],
  report_failed: [],
  share_view_loaded: ['kind'],
  signup_cta_clicked: [],
  managed_client_created: ['onboardingCause'],
  client_vod_attached: ['onboardingCause'],
  client_review_view_loaded: [],
  coach_review_published: ['onboardingCause'],
  review_revision_published: ['onboardingCause'],
  client_review_acknowledged: [],
  onboarding_intent_selected: ['intent', 'asked'],
  coaching_mode_enabled: [],
  analytics_activated: ['onboardingCause'],
  vod_activated: ['onboardingCause'],
  tournament_prep_activated: ['onboardingCause'],
  scout_activated: ['onboardingCause'],
  // Phase 20 Plan 03 (SESS-01/02, T-20-12): content-free — no summary/
  // homework/token keys ever reach GA4. review_delivery_created/
  // review_delivery_revoked were emitted since Phase 12 but never
  // catalogued/projected until now (parity fix, mirroring the earlier
  // coach_review_published/review_revision_published/
  // client_review_acknowledged additions above).
  session_delivery_created: [],
  review_delivery_created: [],
  review_delivery_revoked: [],
};

function ga4ClientId(actorId: string, sessionId: string): string {
  return createHash('sha256').update(`${actorId}:${sessionId}`).digest('hex').slice(0, 32);
}

export function projectEventToGa4(envelope: EventEnvelope): Ga4ProjectedEvent | null {
  const allowedKeys = GA4_PAYLOAD_ALLOWLIST[envelope.eventName];
  if (!allowedKeys) {
    return null;
  }

  const params: Record<string, string | number> = {};
  for (const key of allowedKeys) {
    const value = envelope.payload[key];
    if (typeof value === 'string' || typeof value === 'number') {
      params[key] = value;
    } else if (typeof value === 'boolean') {
      params[key] = String(value);
    }
  }

  return {
    clientId: ga4ClientId(envelope.actorId, envelope.sessionId),
    eventName: envelope.eventName,
    params,
  };
}
