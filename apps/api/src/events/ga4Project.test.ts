import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SCHEMA_VERSION,
  CHECKOUT_PREP_REASON,
  type EventEnvelope,
} from '@smash-tracker/shared';
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

  it('projects session_delivery_created with empty params (no payload keys allowlisted, T-20-12)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'session_delivery_created', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
  });

  it('projects review_delivery_created with empty params (no payload keys allowlisted)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'review_delivery_created', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
  });

  it('projects review_delivery_revoked with empty params (no payload keys allowlisted)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({ eventName: 'review_delivery_revoked', payload: {} }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({});
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
 * Phase 23 (Claim Credential & Atomic Ownership Transition, T-23-02): all
 * six claim/delegation events are catalogued in EVENT_CATALOG but
 * deliberately absent from GA4_PAYLOAD_ALLOWLIST — this locks the omission
 * in so a future casual allowlist edit fails CI.
 */
describe('projectEventToGa4 — Phase 23 claim/delegation events deliberately omitted from GA4', () => {
  it.each([
    'claim_invitation_created',
    'claim_invitation_revoked',
    'claim_completed',
    'claim_conflict_detected',
    'coach_delegation_granted',
    'coach_delegation_revoked',
  ])('returns null for %s', (eventName) => {
    const projected = projectEventToGa4(baseEnvelope({ eventName }));
    expect(projected).toBeNull();
  });

  it('still projects an existing allowlisted event (no regression)', () => {
    const projected = projectEventToGa4(baseEnvelope({ eventName: 'checkout_completed' }));
    expect(projected).not.toBeNull();
  });
});

/**
 * Phase 26 (Free Tournament Prep Brief, D-10): all three of Phase 26's prep
 * events are catalogued in the shared EVENT_CATALOG but deliberately absent
 * from GA4_PAYLOAD_ALLOWLIST for the duration of the canonical-measurement
 * reconciliation soak (STATE.md release rail, ~2026-08-02) — the RTDB
 * eventLedger remains the source of truth during the soak, and re-adding
 * any of them to the GA4 allowlist is a separately-reviewed decision, not a
 * casual allowlist edit. This locks the omission in so that edit fails CI.
 * The paired case below re-asserts Phase 13's `tournament_prep_activated`
 * still projects unchanged (with its `onboardingCause` param intact),
 * catching an accidental edit to that existing allowlist row (D-11).
 */
describe('projectEventToGa4 — Phase 26 prep events deliberately omitted from GA4', () => {
  it.each(['prep_brief_activated', 'prep_brief_reopened', 'prep_offer_viewed'])(
    'returns null for %s',
    (eventName) => {
      const projected = projectEventToGa4(baseEnvelope({ eventName }));
      expect(projected).toBeNull();
    },
  );

  it('still projects the Phase 13 tournament_prep_activated event unchanged (no regression)', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'tournament_prep_activated',
        payload: { onboardingCause: 'manual_entry' },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ onboardingCause: 'manual_entry' });
  });
});

/**
 * Phase 28 (28-04, EVT-06): `post_event_review_started` and
 * `post_event_review_completed` are catalogued in the shared EVENT_CATALOG
 * (D-class) but deliberately absent from GA4_PAYLOAD_ALLOWLIST for the
 * duration of the canonical-measurement reconciliation soak — the RTDB
 * eventLedger remains the source of truth during the soak, and re-adding
 * either to the GA4 allowlist is a separately-reviewed decision, not a
 * casual allowlist edit. This locks the omission in so that edit fails CI.
 */
describe('projectEventToGa4 — Phase 28 post-event review events deliberately omitted from GA4', () => {
  it.each(['post_event_review_started', 'post_event_review_completed'])(
    'returns null for %s',
    (eventName) => {
      const projected = projectEventToGa4(baseEnvelope({ eventName }));
      expect(projected).toBeNull();
    },
  );
});

/**
 * Phase 27 (EVT-05, 27-RESEARCH.md Pitfall 5): the `prepReason` enum marker
 * added to the `checkout_started`/`checkout_completed` payloads by 27-05
 * (`apps/api/src/routes/billing.ts`) is attribution data that belongs in
 * the first-party RTDB `eventLedger` (the source of truth) — it is
 * DELIBERATELY absent from the GA4 payload allowlist for the duration of
 * the ~2026-08-02 canonical-measurement reconciliation soak (STATE.md
 * "Blockers/Concerns"), mirroring exactly how Phase 26's prep event names
 * were deliberately excluded from GA4 above. The activation gate (27-04)
 * that ships this whole feature OFF is conditioned on that soak's
 * `GET /internal/jobs/funnel-readout` showing ≥98% reconcile and <0.5%
 * dupes — adding a new payload key to an already-allowlisted event family
 * mid-soak would perturb exactly the measurement window the gate depends
 * on. This is a deliberate, tested non-add, not an oversight: re-adding
 * `prepReason` to the allowlist is a separately-reviewed decision, and this
 * lock makes a casual future edit fail CI.
 */
describe('Phase 27 prep attribution stays out of GA4 during the soak', () => {
  it('projecting a checkout_started event whose payload carries the prep marker yields no prep-marker key in the GA4 payload', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'checkout_started',
        payload: { packId: 'pack5', prepReason: CHECKOUT_PREP_REASON },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ packId: 'pack5' });
    expect(projected?.params).not.toHaveProperty('prepReason');
  });

  it('projecting a checkout_completed event whose payload carries the prep marker yields no prep-marker key in the GA4 payload', () => {
    const projected = projectEventToGa4(
      baseEnvelope({
        eventName: 'checkout_completed',
        payload: { packId: 'pack15', prepReason: CHECKOUT_PREP_REASON },
      }),
    );

    expect(projected).not.toBeNull();
    expect(projected?.params).toEqual({ packId: 'pack15' });
    expect(projected?.params).not.toHaveProperty('prepReason');
  });

  // A deliberate lock, not an accident: the checkout/credit event family's
  // allowlisted params are asserted unchanged in size and content from
  // what they hold today, so a future "helpful" addition of `prepReason`
  // (or any other new key) to any of these five rows fails CI and has to
  // be argued for explicitly, exactly as the Phase 23/26 locks above do.
  it.each([
    ['checkout_started', ['packId']],
    ['checkout_completed', ['packId']],
    ['credits_granted', ['packId']],
    ['credit_spent', []],
    ['credit_refunded', []],
  ] as const)('the %s allowlist projects exactly %j and nothing else', (eventName, keys) => {
    const fullPayload = {
      packId: 'pack5',
      prepReason: CHECKOUT_PREP_REASON,
      reason: 'prep_bundle',
      entryKey: 'tournament-secret-42',
      bundleId: 'bundle-secret-1',
    };
    const projected = projectEventToGa4(baseEnvelope({ eventName, payload: fullPayload }));

    expect(projected).not.toBeNull();
    const expectedParams: Record<string, string> = {};
    for (const key of keys) {
      expectedParams[key] = fullPayload[key as keyof typeof fullPayload] as string;
    }
    expect(projected?.params).toEqual(expectedParams);
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
