import { randomUUID } from 'node:crypto';
import {
  CANONICAL_SCHEMA_VERSION,
  eventEnvelopeSchema,
  type ConsentState,
  type EventActorKind,
  type EventEnvelope,
} from '@smash-tracker/shared';

/**
 * Typed against the shared `EventActorKind` union (not a bare string
 * literal) so a future rename/removal of `'anonymous'` from
 * `EVENT_ACTOR_KINDS` fails this file's typecheck instead of silently
 * drifting.
 */
const ANONYMOUS_ACTOR_KIND: EventActorKind = 'anonymous';

/**
 * MEAS-02: builds a D-class (domain) event envelope — fired by an API route
 * AFTER its own durable RTDB write has already committed, never before. Both
 * timestamps are stamped from the same `Date.now()` call since D events are
 * always emitted synchronously in the request that caused them.
 */
export function buildDomainEnvelope(params: {
  eventName: string;
  actorId: string;
  sessionId: string;
  causationId: string;
  consentState: ConsentState;
  artifactKind?: string;
  payload?: Record<string, string | number | boolean>;
}): EventEnvelope {
  const now = Date.now();
  return eventEnvelopeSchema.parse({
    eventId: randomUUID(),
    eventName: params.eventName,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: now,
    receivedAt: now,
    actorKind: 'authenticated',
    actorId: params.actorId,
    sessionId: params.sessionId,
    source: 'api',
    artifactKind: params.artifactKind,
    causationId: params.causationId,
    consentState: params.consentState,
    payload: params.payload ?? {},
  });
}

/**
 * Phase 12 (Coach Reviews & Delivery, D-09/DLV-04, RESEARCH.md Open
 * Question 2): builds a D-class envelope for a durable server-side write
 * caused by an UNAUTHENTICATED actor — e.g. `client_review_acknowledged`,
 * fired when a no-account delivery-link holder clicks Acknowledge.
 * `buildDomainEnvelope` above hardcodes `actorKind: 'authenticated'`, which
 * would mislabel a link-holder's action as an authenticated one (a
 * Repudiation risk, T-12-04) — this sibling helper sets `actorKind:
 * 'anonymous'` (reusing the shared `EVENT_ACTOR_KINDS` value rather than a
 * hardcoded string literal, so the two never drift) and is otherwise
 * identical: same required fields, same "call after the durable write
 * commits" discipline. `buildDomainEnvelope` itself is NOT modified — every
 * existing authenticated call site keeps its exact current behavior.
 */
export function buildAnonymousDomainEnvelope(params: {
  eventName: string;
  actorId: string;
  sessionId: string;
  causationId: string;
  consentState: ConsentState;
  artifactKind?: string;
  payload?: Record<string, string | number | boolean>;
}): EventEnvelope {
  const now = Date.now();
  return eventEnvelopeSchema.parse({
    eventId: randomUUID(),
    eventName: params.eventName,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: now,
    receivedAt: now,
    actorKind: ANONYMOUS_ACTOR_KIND,
    actorId: params.actorId,
    sessionId: params.sessionId,
    source: 'api',
    artifactKind: params.artifactKind,
    causationId: params.causationId,
    consentState: params.consentState,
    payload: params.payload ?? {},
  });
}

/**
 * MEAS-03: builds a B-class (billing/report) event envelope — fired only
 * from verified Stripe webhook fulfillment (`source: 'stripe'`) or a
 * scheduled/report-job transition (`source: 'job'`), never from an
 * unauthenticated request path.
 */
export function buildBillingEnvelope(params: {
  eventName: string;
  source: 'stripe' | 'job';
  actorId: string;
  sessionId: string;
  causationId: string;
  consentState: ConsentState;
  artifactKind?: string;
  payload?: Record<string, string | number | boolean>;
}): EventEnvelope {
  const now = Date.now();
  return eventEnvelopeSchema.parse({
    eventId: randomUUID(),
    eventName: params.eventName,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: now,
    receivedAt: now,
    actorKind: 'authenticated',
    actorId: params.actorId,
    sessionId: params.sessionId,
    source: params.source,
    artifactKind: params.artifactKind,
    causationId: params.causationId,
    consentState: params.consentState,
    payload: params.payload ?? {},
  });
}
