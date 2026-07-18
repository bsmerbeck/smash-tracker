import { z } from 'zod';

/**
 * MEAS-01: the canonical first-party event envelope. Every D/B/X emitter in
 * apps/api (and, for X-class events, the same-origin ingestion route) builds
 * one of these and hands it to `createEvent()` (apps/api/src/events/ledger.ts)
 * — the sole writer of the `eventLedger` RTDB tree. GA4 is a best-effort
 * downstream projection built FROM a committed envelope; it is never the
 * source of truth and never receives fields this schema doesn't carry.
 *
 * `payload` is intentionally a small allowlisted bag of primitive values
 * (string, number, or boolean) — never a nested object or array, and never a
 * place to put anything that identifies a person or an account beyond the
 * envelope's own `actorId`. In practice that means no email addresses, no
 * raw start.gg/parry.gg/Stripe identifiers, no capability tokens or share
 * secrets, no IP addresses or other network identifiers, and no free-text
 * content a user typed (notes, review text, display names). `actorId` itself
 * must be a privacy-safe identifier (the app's own uid, or a derived hash) —
 * never a raw email or an external platform's account id. Keeping payload
 * values to primitives is also what keeps a malformed or hostile envelope
 * from ever landing a nested/attacker-shaped object in RTDB.
 *
 * `receivedAt` is always stamped by the server at the moment the envelope is
 * committed — D/B emitters set it themselves right before calling
 * `createEvent()`, and the X-class ingestion route overwrites whatever a
 * caller sent with its own server clock. A client-supplied `receivedAt` must
 * never be trusted or persisted as-is.
 */
export const EVENT_ACTOR_KINDS = ['authenticated', 'anonymous'] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

export const EVENT_SOURCES = ['api', 'stripe', 'job', 'web'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const CONSENT_STATES = ['granted', 'denied', 'unknown'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  occurredAt: z.number(),
  receivedAt: z.number(),
  actorKind: z.enum(EVENT_ACTOR_KINDS),
  actorId: z.string().min(1),
  sessionId: z.string().min(1),
  source: z.enum(EVENT_SOURCES),
  artifactKind: z.string().optional(),
  causationId: z.string().min(1),
  consentState: z.enum(CONSENT_STATES),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** MEAS-01: the current canonical envelope schema version — bump on any breaking field change. */
export const CANONICAL_SCHEMA_VERSION = 1;

/**
 * MEAS-04: the fixed allowlist for the same-origin X-ingestion route
 * (`POST /api/events`) — grows only as new X events are explicitly approved.
 * `prep_offer_viewed` is deferred: its canonical surface (a tournament-prep
 * offer) does not exist yet this phase (see RESEARCH Assumption A2).
 */
export const X_EVENT_ALLOWLIST = ['share_view_loaded', 'signup_cta_clicked'] as const;
export type XEventName = (typeof X_EVENT_ALLOWLIST)[number];

/**
 * MEAS-02/03/04: every event name shippable this phase, mapped to its
 * emitter class — D (domain, emitted by the API after a durable commit), B
 * (billing/report, emitted from verified Stripe fulfillment or report-job
 * transitions), or X (same-origin experience ingestion, allowlisted above).
 */
export const EVENT_CATALOG = {
  signup_completed: 'D',
  checkout_started: 'D',
  checkout_completed: 'B',
  credits_granted: 'B',
  credit_spent: 'B',
  credit_refunded: 'B',
  report_started: 'B',
  report_completed: 'B',
  report_failed: 'B',
  share_view_loaded: 'X',
  signup_cta_clicked: 'X',
} as const;
export type EventCatalogName = keyof typeof EVENT_CATALOG;
export type EventClass = (typeof EVENT_CATALOG)[EventCatalogName];
