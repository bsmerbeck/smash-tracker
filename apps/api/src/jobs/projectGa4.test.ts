import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_SCHEMA_VERSION, type EventEnvelope } from '@smash-tracker/shared';
import type { Ga4Config } from '../config/env.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { runProjectGa4 } from './projectGa4.js';

const GA4_CONFIG: Ga4Config = { measurementId: 'G-TEST123', apiSecret: 'shh-secret' };

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return vi.fn(impl) as unknown as typeof fetch;
}

function todayShard(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

const FIXED_NOW = 1_700_000_000_000;

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'event-1',
    eventName: 'checkout_completed',
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: FIXED_NOW,
    receivedAt: FIXED_NOW,
    actorKind: 'authenticated',
    actorId: 'uid-1',
    sessionId: 'session-1',
    source: 'stripe',
    causationId: 'evt_1:checkout_completed',
    consentState: 'granted',
    payload: { packId: 'pack5' },
    ...overrides,
  };
}

/** Seeds one paired eventLedger + outboxPending row for a given day-shard. */
function seedPending(
  database: FakeDatabase,
  day: string,
  key: string,
  env: EventEnvelope,
  outbox: { attempt: number; nextRetryAt: number | null } = { attempt: 0, nextRetryAt: null },
): void {
  database.seed(`eventLedger/${day}/${key}`, env);
  database.seed(`outboxPending/${day}/${key}`, outbox);
}

describe('runProjectGa4', () => {
  it('returns all-zero counts when there is nothing pending', async () => {
    const database = new FakeDatabase();
    const result = await runProjectGa4(database as never, GA4_CONFIG);
    expect(result).toEqual({ projected: 0, skipped: 0, failed: 0 });
  });

  it('projects a consent-granted event via GA4 and removes the outbox key on success', async () => {
    const database = new FakeDatabase();
    const day = todayShard();
    seedPending(database, day, 'key-1', envelope());
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    expect(result).toEqual({ projected: 1, skipped: 0, failed: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const outboxDay = database.dump().outboxPending as Record<string, unknown> | undefined;
    expect((outboxDay?.[day] as Record<string, unknown> | undefined)?.['key-1']).toBeUndefined();
    // eventLedger is untouched.
    const ledgerDay = database.dump().eventLedger as Record<string, unknown>;
    expect((ledgerDay[day] as Record<string, unknown>)['key-1']).toEqual(envelope());
  });

  it("does NOT call GA4 for a consentState !== 'granted' event, and resolves it as skipped", async () => {
    const database = new FakeDatabase();
    const day = todayShard();
    seedPending(database, day, 'key-unknown', envelope({ consentState: 'unknown' }));
    seedPending(database, day, 'key-denied', envelope({ eventId: 'e2', consentState: 'denied' }));
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ projected: 0, skipped: 2, failed: 0 });
    const outboxDay = database.dump().outboxPending as Record<string, unknown> | undefined;
    expect((outboxDay?.[day] as Record<string, unknown> | undefined) ?? {}).toEqual({});
  });

  it('increments attempt and sets nextRetryAt on a failed GA4 POST, WITHOUT mutating the ledger row', async () => {
    const database = new FakeDatabase();
    const day = todayShard();
    seedPending(database, day, 'key-1', envelope());
    const mockFetch = fakeFetch(() => new Response(null, { status: 500 }));

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    expect(result).toEqual({ projected: 0, skipped: 0, failed: 1 });
    const outboxDay = database.dump().outboxPending as Record<string, Record<string, unknown>>;
    const entry = outboxDay[day]?.['key-1'] as { attempt: number; nextRetryAt: number | null };
    expect(entry.attempt).toBe(1);
    expect(entry.nextRetryAt).not.toBeNull();

    const ledgerDay = database.dump().eventLedger as Record<string, Record<string, unknown>>;
    expect(ledgerDay[day]?.['key-1']).toEqual(envelope());
  });

  it('a simulated full GA4 outage never mutates eventLedger — only outbox attempt values increase', async () => {
    const database = new FakeDatabase();
    const day = todayShard();
    seedPending(database, day, 'key-1', envelope({ eventId: 'e1' }));
    seedPending(database, day, 'key-2', envelope({ eventId: 'e2' }));
    seedPending(database, day, 'key-3', envelope({ eventId: 'e3' }));
    const mockFetch = fakeFetch(() => Promise.reject(new Error('network partition')));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const ledgerChildCountBefore = Object.keys(
      (database.dump().eventLedger as Record<string, Record<string, unknown>>)[day] ?? {},
    ).length;

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    const ledgerDay = database.dump().eventLedger as Record<string, Record<string, unknown>>;
    expect(Object.keys(ledgerDay[day] ?? {})).toHaveLength(ledgerChildCountBefore);
    expect(ledgerDay[day]?.['key-1']).toEqual(envelope({ eventId: 'e1' }));
    expect(ledgerDay[day]?.['key-2']).toEqual(envelope({ eventId: 'e2' }));
    expect(ledgerDay[day]?.['key-3']).toEqual(envelope({ eventId: 'e3' }));

    expect(result).toEqual({ projected: 0, skipped: 0, failed: 3 });
    const outboxDay = database.dump().outboxPending as Record<string, Record<string, unknown>>;
    for (const key of ['key-1', 'key-2', 'key-3']) {
      const entry = outboxDay[day]?.[key] as { attempt: number };
      expect(entry.attempt).toBe(1);
    }

    consoleSpy.mockRestore();
  });

  it('processes the yesterday day-shard as well as today (short lookback)', async () => {
    const database = new FakeDatabase();
    const today = todayShard();
    const yesterdayDate = new Date();
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterday = yesterdayDate.toISOString().slice(0, 10).replace(/-/g, '');
    seedPending(database, yesterday, 'stale-key', envelope({ eventId: 'stale' }));
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    expect(result).toEqual({ projected: 1, skipped: 0, failed: 0 });
    expect(today).not.toBe(yesterday);
  });

  it('drops an orphaned outbox key with no matching ledger row, without calling GA4', async () => {
    const database = new FakeDatabase();
    const day = todayShard();
    database.seed(`outboxPending/${day}/orphan-key`, { attempt: 0, nextRetryAt: null });
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ projected: 0, skipped: 1, failed: 0 });
  });

  it('processes a bounded batch per day-shard — never more than the configured max', async () => {
    const database = new FakeDatabase();
    const day = todayShard();
    const total = 501;
    for (let i = 0; i < total; i += 1) {
      seedPending(database, day, `key-${i}`, envelope({ eventId: `e${i}` }));
    }
    const mockFetch = fakeFetch(() => new Response(null, { status: 200 }));

    const result = await runProjectGa4(database as never, GA4_CONFIG, mockFetch);

    expect(result.projected).toBe(500);
    const outboxDay = database.dump().outboxPending as Record<string, Record<string, unknown>>;
    expect(Object.keys(outboxDay[day] ?? {})).toHaveLength(total - 500);
  });
});
