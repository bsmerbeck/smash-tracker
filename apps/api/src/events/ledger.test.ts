import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_VERSION } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { buildBillingEnvelope, buildDomainEnvelope } from './envelope.js';
import { createEvent, dayShardKey } from './ledger.js';

function baseEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
  const now = 1_700_000_000_000; // fixed epoch ms so day-shard assertions are deterministic
  return {
    eventId: 'event-1',
    eventName: 'signup_completed',
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: now,
    receivedAt: now,
    actorKind: 'authenticated' as const,
    actorId: 'uid-1',
    sessionId: 'session-1',
    source: 'api' as const,
    causationId: 'uid-1',
    consentState: 'unknown' as const,
    payload: {},
    ...overrides,
  };
}

describe('dayShardKey', () => {
  it('returns the UTC yyyymmdd derived from an epoch-ms input', () => {
    // 2023-11-14T22:13:20.000Z
    expect(dayShardKey(1_700_000_000_000)).toBe('20231114');
  });
});

describe('createEvent', () => {
  it('commits the dedup transaction and writes one eventLedger row + one outboxPending row on a fresh event', async () => {
    const database = new FakeDatabase();
    const envelope = baseEnvelope();

    await createEvent(database as never, envelope);

    const day = dayShardKey(envelope.occurredAt);
    const ledgerDay = database.dump().eventLedger as Record<string, unknown> | undefined;
    const ledgerEntries = (ledgerDay?.[day] ?? {}) as Record<string, unknown>;
    expect(Object.keys(ledgerEntries)).toHaveLength(1);
    const [ledgerKey] = Object.keys(ledgerEntries);
    expect(ledgerEntries[ledgerKey!]).toEqual(envelope);

    const outboxDay = database.dump().outboxPending as Record<string, unknown> | undefined;
    const outboxEntries = (outboxDay?.[day] ?? {}) as Record<string, unknown>;
    expect(Object.keys(outboxEntries)).toEqual([ledgerKey]);
    expect(outboxEntries[ledgerKey!]).toEqual({ attempt: 0, nextRetryAt: null });
  });

  it('is a no-op on a second call with the same (eventName, schemaVersion, causationId)', async () => {
    const database = new FakeDatabase();
    const envelope = baseEnvelope();

    await createEvent(database as never, envelope);
    await createEvent(database as never, { ...envelope, eventId: 'event-2' });

    const day = dayShardKey(envelope.occurredAt);
    const ledgerDay = database.dump().eventLedger as Record<string, unknown> | undefined;
    const ledgerEntries = (ledgerDay?.[day] ?? {}) as Record<string, unknown>;
    expect(Object.keys(ledgerEntries)).toHaveLength(1);

    const outboxDay = database.dump().outboxPending as Record<string, unknown> | undefined;
    const outboxEntries = (outboxDay?.[day] ?? {}) as Record<string, unknown>;
    expect(Object.keys(outboxEntries)).toHaveLength(1);
  });

  it('parses the envelope first, throwing before any write on an invalid envelope', async () => {
    const database = new FakeDatabase();
    const invalid = baseEnvelope({ causationId: undefined });

    await expect(createEvent(database as never, invalid as never)).rejects.toThrow();
    expect(database.dump()).toEqual({});
  });

  it('a different causationId for the same eventName does not collide with the dedup guard', async () => {
    const database = new FakeDatabase();
    const first = baseEnvelope({ eventId: 'event-1', causationId: 'uid-1' });
    const second = baseEnvelope({ eventId: 'event-2', causationId: 'uid-2' });

    await createEvent(database as never, first);
    await createEvent(database as never, second);

    const day = dayShardKey(first.occurredAt);
    const ledgerDay = database.dump().eventLedger as Record<string, unknown> | undefined;
    const ledgerEntries = (ledgerDay?.[day] ?? {}) as Record<string, unknown>;
    expect(Object.keys(ledgerEntries)).toHaveLength(2);
  });
});

describe('buildDomainEnvelope', () => {
  it('fills eventId, source, actorKind, matching occurredAt/receivedAt, and CANONICAL_SCHEMA_VERSION', () => {
    const envelope = buildDomainEnvelope({
      eventName: 'signup_completed',
      actorId: 'uid-1',
      sessionId: 'session-1',
      causationId: 'uid-1',
      consentState: 'unknown',
    });

    expect(envelope.eventId).toBeTruthy();
    expect(envelope.source).toBe('api');
    expect(envelope.actorKind).toBe('authenticated');
    expect(envelope.occurredAt).toBe(envelope.receivedAt);
    expect(envelope.schemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
  });
});

describe('buildBillingEnvelope', () => {
  it('fills source per param and actorKind authenticated', () => {
    const stripeEnvelope = buildBillingEnvelope({
      eventName: 'checkout_completed',
      source: 'stripe',
      actorId: 'uid-1',
      sessionId: 'session-1',
      causationId: 'evt_123',
      consentState: 'unknown',
    });
    expect(stripeEnvelope.source).toBe('stripe');
    expect(stripeEnvelope.actorKind).toBe('authenticated');

    const jobEnvelope = buildBillingEnvelope({
      eventName: 'report_failed',
      source: 'job',
      actorId: 'uid-1',
      sessionId: 'session-1',
      causationId: 'job-1:failed',
      consentState: 'unknown',
    });
    expect(jobEnvelope.source).toBe('job');
  });
});
