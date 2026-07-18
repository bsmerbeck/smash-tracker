import { randomUUID } from 'node:crypto';
import {
  CANONICAL_SCHEMA_VERSION,
  eventEnvelopeSchema,
  type ConsentState,
  type EventEnvelope,
} from '@smash-tracker/shared';

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
