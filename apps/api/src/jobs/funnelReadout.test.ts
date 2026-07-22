import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { dayShardKey } from '../events/ledger.js';
import { runFunnelReadout } from './funnelReadout.js';

const NOW = new Date('2026-07-22T12:00:00.000Z').getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function dayKeyFor(offset: number): string {
  return dayShardKey(NOW - offset * ONE_DAY_MS);
}

describe('runFunnelReadout', () => {
  it('aggregates eventLedger rows by eventName per day and sums matching totals', async () => {
    const database = new FakeDatabase();
    const today = dayKeyFor(0);
    const yesterday = dayKeyFor(1);

    database.seed(`eventLedger/${today}/key1`, { eventName: 'signup_completed' });
    database.seed(`eventLedger/${today}/key2`, { eventName: 'signup_completed' });
    database.seed(`eventLedger/${today}/key3`, { eventName: 'checkout_completed' });
    database.seed(`eventLedger/${yesterday}/key1`, { eventName: 'signup_completed' });

    const result = await runFunnelReadout(database as never, { now: NOW, days: 2 });

    const todayEntry = result.days.find((d) => d.day === today);
    const yesterdayEntry = result.days.find((d) => d.day === yesterday);

    expect(todayEntry?.eventCounts).toEqual({ signup_completed: 2, checkout_completed: 1 });
    expect(yesterdayEntry?.eventCounts).toEqual({ signup_completed: 1 });
    expect(result.totals.eventCounts).toEqual({ signup_completed: 3, checkout_completed: 1 });
  });

  it('counts reconciliationExceptions by kind only, never leaking subjectRef/expected/actual/detectedAt', async () => {
    const database = new FakeDatabase();
    const today = dayKeyFor(0);

    database.seed(`reconciliationExceptions/${today}/exc1`, {
      kind: 'missing_event',
      subjectRef: 'some-user-uid',
      expected: { eventName: 'credits_granted' },
      actual: 'absent',
      detectedAt: NOW,
    });
    database.seed(`reconciliationExceptions/${today}/exc2`, {
      kind: 'missing_event',
      subjectRef: 'another-user-uid',
      expected: { eventName: 'checkout_completed' },
      actual: 'absent',
      detectedAt: NOW,
    });
    database.seed(`reconciliationExceptions/${today}/exc3`, {
      kind: 'phantom_event',
      subjectRef: 'yet-another-uid',
      expected: 'domain_transition',
      actual: { eventName: 'credit_spent', causationId: 'foo:credit_spent' },
      detectedAt: NOW,
    });

    const result = await runFunnelReadout(database as never, { now: NOW, days: 1 });

    expect(result.days[0]?.exceptionCounts).toEqual({ missing_event: 2, phantom_event: 1 });
    expect(result.totals.exceptionCounts).toEqual({ missing_event: 2, phantom_event: 1 });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('subjectRef');
    expect(serialized).not.toContain('actorId');
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('detectedAt');
    expect(serialized).not.toContain('some-user-uid');
  });

  it('counts pendingProjection as the per-day outboxPending key count and sums into totals', async () => {
    const database = new FakeDatabase();
    const today = dayKeyFor(0);
    const yesterday = dayKeyFor(1);

    database.seed(`outboxPending/${today}/key1`, { attempt: 0, nextRetryAt: null });
    database.seed(`outboxPending/${today}/key2`, { attempt: 0, nextRetryAt: null });
    database.seed(`outboxPending/${yesterday}/key1`, { attempt: 1, nextRetryAt: NOW });

    const result = await runFunnelReadout(database as never, { now: NOW, days: 2 });

    const todayEntry = result.days.find((d) => d.day === today);
    const yesterdayEntry = result.days.find((d) => d.day === yesterday);

    expect(todayEntry?.pendingProjection).toBe(2);
    expect(yesterdayEntry?.pendingProjection).toBe(1);
    expect(result.totals.pendingProjection).toBe(3);
  });

  it('lists a day-shard with no data as an entry with empty count maps and pendingProjection 0', async () => {
    const database = new FakeDatabase();

    const result = await runFunnelReadout(database as never, { now: NOW, days: 3 });

    expect(result.days).toHaveLength(3);
    for (const entry of result.days) {
      expect(entry.eventCounts).toEqual({});
      expect(entry.exceptionCounts).toEqual({});
      expect(entry.pendingProjection).toBe(0);
    }
  });

  it('clamps the requested window to [1, 14] and defaults to 7 when days is undefined', async () => {
    const database = new FakeDatabase();

    const clampedHigh = await runFunnelReadout(database as never, { now: NOW, days: 100 });
    expect(clampedHigh.days).toHaveLength(14);

    const clampedLow = await runFunnelReadout(database as never, { now: NOW, days: 0 });
    expect(clampedLow.days).toHaveLength(1);

    const defaulted = await runFunnelReadout(database as never, { now: NOW });
    expect(defaulted.days).toHaveLength(7);
  });

  it('sets generatedAt to the injected now as an epoch-ms number', async () => {
    const database = new FakeDatabase();

    const result = await runFunnelReadout(database as never, { now: NOW, days: 1 });

    expect(result.generatedAt).toBe(NOW);
    expect(typeof result.generatedAt).toBe('number');
  });

  it('never reads a tree-root path for eventLedger/outboxPending/reconciliationExceptions', async () => {
    const database = new FakeDatabase();
    const seenPaths: string[] = [];
    const originalRef = database.ref.bind(database);
    database.ref = ((path?: string) => {
      if (path !== undefined) {
        seenPaths.push(path);
      }
      return originalRef(path);
    }) as typeof database.ref;

    await runFunnelReadout(database as never, { now: NOW, days: 2 });

    expect(seenPaths).not.toContain('eventLedger');
    expect(seenPaths).not.toContain('outboxPending');
    expect(seenPaths).not.toContain('reconciliationExceptions');
    for (const path of seenPaths) {
      expect(path).toMatch(/^(eventLedger|reconciliationExceptions|outboxPending)\/\d{8}$/);
    }
  });
});
