import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_VERSION, type EventEnvelope } from '@smash-tracker/shared';
import { projectEventToGa4 } from './ga4Project.js';

function baseEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const now = 1_700_000_000_000;
  return {
    eventId: 'event-1',
    eventName: 'checkout_completed',
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: now,
    receivedAt: now,
    actorKind: 'authenticated',
    actorId: 'uid-super-secret-123',
    sessionId: 'session-abc',
    source: 'stripe',
    causationId: 'evt_123:checkout_completed',
    consentState: 'granted',
    payload: { packId: 'pack5' },
    ...overrides,
  };
}

describe('projectEventToGa4', () => {
  it('maps an allowlisted event to a GA4 payload with only allowlisted params', () => {
    const projected = projectEventToGa4(baseEnvelope());

    expect(projected).not.toBeNull();
    expect(projected?.eventName).toBe('checkout_completed');
    expect(projected?.params).toEqual({ packId: 'pack5' });
  });

  it('returns null for an eventName not in the GA4 projection allowlist', () => {
    const projected = projectEventToGa4(baseEnvelope({ eventName: 'some_unlisted_event' }));
    expect(projected).toBeNull();
  });

  it('drops payload keys not in the per-event allowlist', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        payload: { packId: 'pack5', internalNote: 'should never reach GA4' },
      }),
    );

    expect(projected?.params).toEqual({ packId: 'pack5' });
    expect(projected?.params).not.toHaveProperty('internalNote');
  });

  it('projects to an empty params object for an event with no allowlisted payload keys', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'signup_completed', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
  });

  it('derives a non-reversible client_id — never the raw actorId or sessionId', () => {
    const envelope = baseEnvelope();
    const projected = projectEventToGa4(envelope);

    expect(projected?.clientId).not.toBe(envelope.actorId);
    expect(projected?.clientId).not.toContain(envelope.actorId);
    expect(projected?.clientId).not.toBe(envelope.sessionId);
  });

  it('derives a stable client_id for the same actorId+sessionId', () => {
    const envelope = baseEnvelope();
    expect(projectEventToGa4(envelope)?.clientId).toBe(projectEventToGa4(envelope)?.clientId);
  });

  it('derives different client_ids for different actors', () => {
    const a = projectEventToGa4(baseEnvelope({ actorId: 'uid-a' }));
    const b = projectEventToGa4(baseEnvelope({ actorId: 'uid-b' }));
    expect(a?.clientId).not.toBe(b?.clientId);
  });

  it('never includes any raw envelope field beyond the allowlisted params and derived clientId', () => {
    const projected = projectEventToGa4(baseEnvelope());
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain('uid-super-secret-123');
    expect(serialized).not.toContain('session-abc');
    expect(serialized).not.toContain('evt_123');
  });

  it('returns null for a coaching-shaped-but-unlisted eventName', () => {
    const projected = projectEventToGa4(baseEnvelope({ eventName: 'coaching_client_selected' }));
    expect(projected).toBeNull();
  });
});

describe('projectEventToGa4 — coaching/onboarding ledger-only events (quick task 260722-lh1)', () => {
  it('projects managed_client_created with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'managed_client_created',
        payload: { onboardingCause: 'coach_clients' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'coach_clients' });
  });

  it('projects client_vod_attached with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'client_vod_attached',
        payload: { onboardingCause: 'coach_clients' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'coach_clients' });
  });

  it('projects client_review_view_loaded with empty params (no payload keys allowlisted)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'client_review_view_loaded', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
  });

  it('projects coach_review_published with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'coach_review_published',
        payload: { onboardingCause: 'coach_clients' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'coach_clients' });
  });

  it('projects review_revision_published with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'review_revision_published',
        payload: { onboardingCause: 'coach_clients' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'coach_clients' });
  });

  it('projects client_review_acknowledged with empty params (no payload keys allowlisted)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'client_review_acknowledged', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
  });

  it('projects onboarding_intent_selected with intent and asked coerced to a string', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'onboarding_intent_selected',
        payload: { intent: 'coach_clients', asked: true },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ intent: 'coach_clients', asked: 'true' });
  });

  it('coerces a false boolean payload value to the string "false"', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'onboarding_intent_selected',
        payload: { intent: 'coach_clients', asked: false },
      }),
    );

    expect(projected?.params).toEqual({ intent: 'coach_clients', asked: 'false' });
  });

  it('projects coaching_mode_enabled with empty params (no payload keys allowlisted)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'coaching_mode_enabled', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
  });

  it('projects analytics_activated with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'analytics_activated',
        payload: { onboardingCause: 'analyze_own_play' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'analyze_own_play' });
  });

  it('projects vod_activated with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'vod_activated',
        payload: { onboardingCause: 'analyze_own_play' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'analyze_own_play' });
  });

  it('projects tournament_prep_activated with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'tournament_prep_activated',
        payload: { onboardingCause: 'analyze_own_play' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'analyze_own_play' });
  });

  it('projects scout_activated with only onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'scout_activated',
        payload: { onboardingCause: 'analyze_own_play' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'analyze_own_play' });
  });

  it('drops a non-allowlisted identifier key alongside a valid onboardingCause', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'managed_client_created',
        payload: { onboardingCause: 'coach_clients', tenantId: 'tenant-secret-456' },
      }),
    );

    expect(projected?.params).toEqual({ onboardingCause: 'coach_clients' });
    expect(projected?.params).not.toHaveProperty('tenantId');
    expect(JSON.stringify(projected)).not.toContain('tenant-secret-456');
  });
});

/**
 * MEAS-06 (Claude's-discretion validation-endpoint test per RESEARCH.md
 * Pattern 7): asserts a projected payload passes GA4's own schema
 * validation via `/debug/mp/collect` — a TEST, never a runtime code path.
 * Requires real GA4 test-stream credentials (`GA4_TEST_MEASUREMENT_ID`/
 * `GA4_TEST_API_SECRET`), so it self-skips in every environment (local dev,
 * CI) that doesn't provide them — no network dependency in the default
 * test run.
 */
const GA4_TEST_MEASUREMENT_ID = process.env.GA4_TEST_MEASUREMENT_ID;
const GA4_TEST_API_SECRET = process.env.GA4_TEST_API_SECRET;

describe.skipIf(!GA4_TEST_MEASUREMENT_ID || !GA4_TEST_API_SECRET)(
  'GA4 /debug/mp/collect validation (dev/CI-only)',
  () => {
    it('projects checkout_completed to a schema GA4 accepts', async () => {
      const projected = projectEventToGa4(baseEnvelope());
      expect(projected).not.toBeNull();

      const response = await fetch(
        `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(GA4_TEST_MEASUREMENT_ID!)}&api_secret=${encodeURIComponent(GA4_TEST_API_SECRET!)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            client_id: projected!.clientId,
            events: [{ name: projected!.eventName, params: projected!.params }],
          }),
        },
      );
      const body = (await response.json()) as { validationMessages: unknown[] };
      expect(body.validationMessages).toEqual([]);
    });
  },
);
