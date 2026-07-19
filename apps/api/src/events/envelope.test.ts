import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema } from '@smash-tracker/shared';
import { buildAnonymousDomainEnvelope, buildDomainEnvelope } from './envelope.js';

function baseParams() {
  return {
    eventName: 'client_review_acknowledged',
    actorId: 'delivery-abc123',
    sessionId: 'session-1',
    causationId: 'review-1:delivery-abc123',
    consentState: 'unknown' as const,
  };
}

describe('buildAnonymousDomainEnvelope', () => {
  it('sets actorKind to anonymous', () => {
    const envelope = buildAnonymousDomainEnvelope(baseParams());
    expect(envelope.actorKind).toBe('anonymous');
  });

  it('validates against the shared canonical-event envelope schema', () => {
    const envelope = buildAnonymousDomainEnvelope(baseParams());
    expect(() => eventEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('sets the same required fields buildDomainEnvelope sets, aside from actorKind', () => {
    const params = baseParams();
    const anonymous = buildAnonymousDomainEnvelope(params);
    const authenticated = buildDomainEnvelope(params);

    expect(anonymous.eventId).toBeTruthy();
    expect(anonymous.eventName).toBe(params.eventName);
    expect(anonymous.schemaVersion).toBe(authenticated.schemaVersion);
    expect(typeof anonymous.occurredAt).toBe('number');
    expect(anonymous.actorId).toBe(params.actorId);
    expect(anonymous.sessionId).toBe(params.sessionId);
    expect(anonymous.causationId).toBe(params.causationId);
    expect(anonymous.consentState).toBe(params.consentState);
    expect(anonymous.source).toBe('api');
    expect(anonymous.actorKind).toBe('anonymous');
    // The only intentional difference from the authenticated builder.
    expect(authenticated.actorKind).toBe('authenticated');
  });

  it('does not alter buildDomainEnvelope — the authenticated builder keeps its existing default', () => {
    const envelope = buildDomainEnvelope(baseParams());
    expect(envelope.actorKind).toBe('authenticated');
  });
});
