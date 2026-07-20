import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, X_EVENT_ALLOWLIST, eventEnvelopeSchema } from './events.js';

function validEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: 'event-1',
    eventName: 'signup_completed',
    schemaVersion: 1,
    occurredAt: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    actorKind: 'authenticated',
    actorId: 'uid-1',
    sessionId: 'session-1',
    source: 'api',
    causationId: 'uid-1',
    consentState: 'unknown',
    ...overrides,
  };
}

describe('eventEnvelopeSchema', () => {
  it('rejects a payload containing an object value', () => {
    const result = eventEnvelopeSchema.safeParse(
      validEnvelope({ payload: { nested: { bad: true } } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a payload containing an array value', () => {
    const result = eventEnvelopeSchema.safeParse(validEnvelope({ payload: { list: [1, 2] } }));
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field (causationId)', () => {
    const envelope = validEnvelope();
    delete (envelope as Record<string, unknown>).causationId;
    const result = eventEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('accepts a minimal valid envelope and defaults payload to {}', () => {
    const result = eventEnvelopeSchema.safeParse(validEnvelope());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({});
    }
  });
});

describe('X_EVENT_ALLOWLIST', () => {
  it('contains exactly share_view_loaded and signup_cta_clicked', () => {
    expect(X_EVENT_ALLOWLIST).toHaveLength(2);
    expect(X_EVENT_ALLOWLIST).toContain('share_view_loaded');
    expect(X_EVENT_ALLOWLIST).toContain('signup_cta_clicked');
    expect(X_EVENT_ALLOWLIST).not.toContain('prep_offer_viewed');
  });
});

describe('EVENT_CATALOG', () => {
  it('maps each shippable event name to its class', () => {
    expect(EVENT_CATALOG).toEqual({
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
      managed_client_created: 'D',
      client_vod_attached: 'D',
      client_review_view_loaded: 'D',
      onboarding_intent_selected: 'D',
      coaching_mode_enabled: 'D',
      analytics_activated: 'D',
      vod_activated: 'D',
      tournament_prep_activated: 'D',
      scout_activated: 'D',
    });
  });

  it('classifies client_review_view_loaded (Phase 12 Plan 08) as D — emitted via its own dedicated route, not the generic X-ingestion route', () => {
    expect(EVENT_CATALOG.client_review_view_loaded).toBe('D');
    expect(X_EVENT_ALLOWLIST).not.toContain('client_review_view_loaded');
  });

  it('maps the two new Phase 11 coaching-lifecycle events to class D', () => {
    expect(EVENT_CATALOG.managed_client_created).toBe('D');
    expect(EVENT_CATALOG.client_vod_attached).toBe('D');
  });

  it('does not ship coaching_client_selected (still deferred — pure route state, no durable server transition)', () => {
    expect(EVENT_CATALOG).not.toHaveProperty('coaching_client_selected');
  });

  // Phase 13 (ONBD-02/ONBD-05, RESEARCH Pitfall 2): coaching_mode_enabled
  // was deliberately NOT wired in Phase 11 (see the comment above this
  // block in events.ts) — the PUT /users/me coaching-mode flip IS a durable
  // RTDB transition, so Phase 13 adds it as a proper D event alongside the
  // five onboarding/activation events, all newly catalogued this phase.
  it('maps the six new Phase 13 onboarding/activation events to class D', () => {
    expect(EVENT_CATALOG.onboarding_intent_selected).toBe('D');
    expect(EVENT_CATALOG.coaching_mode_enabled).toBe('D');
    expect(EVENT_CATALOG.analytics_activated).toBe('D');
    expect(EVENT_CATALOG.vod_activated).toBe('D');
    expect(EVENT_CATALOG.tournament_prep_activated).toBe('D');
    expect(EVENT_CATALOG.scout_activated).toBe('D');
  });
});
