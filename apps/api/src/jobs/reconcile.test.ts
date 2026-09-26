import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_VERSION, type EventEnvelope } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { RECONCILED_EVENT_NAMES, RECONCILE_EXCEPTION_KINDS, runReconcile } from './reconcile.js';

const DAY = '20260101';
const FIXED_NOW = 1_700_000_000_000;

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'event-1',
    eventName: 'credits_granted',
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    occurredAt: FIXED_NOW,
    receivedAt: FIXED_NOW,
    actorKind: 'authenticated',
    actorId: 'uid-1',
    sessionId: 'uid-1',
    source: 'stripe',
    causationId: 'evt_1:credits_granted',
    consentState: 'unknown',
    payload: {},
    ...overrides,
  };
}

function seedEvent(database: FakeDatabase, day: string, key: string, env: EventEnvelope): void {
  database.seed(`eventLedger/${day}/${key}`, env);
}

function exceptionRowsFor(database: FakeDatabase, day: string): unknown[] {
  const dump = database.dump() as Record<string, unknown>;
  const exceptionsForDay =
    ((dump.reconciliationExceptions as Record<string, Record<string, unknown>> | undefined)?.[
      day
    ] as Record<string, unknown> | undefined) ?? {};
  return Object.values(exceptionsForDay);
}

describe('runReconcile', () => {
  it('returns all-zero counts and writes no exceptions when there is nothing to reconcile', async () => {
    const database = new FakeDatabase();
    const result = await runReconcile(database as never, { day: DAY });
    expect(result).toEqual({ checked: 0, missing: 0, phantom: 0, duplicate: 0 });
    expect(exceptionRowsFor(database, DAY)).toHaveLength(0);
  });

  it('defaults to reconciling yesterday (UTC) when no day is provided', async () => {
    const database = new FakeDatabase();
    const result = await runReconcile(database as never);
    expect(result).toEqual({ checked: 0, missing: 0, phantom: 0, duplicate: 0 });
  });

  it('flags a missing_event exception for a credit-ledger spend with no matching credit_spent event', async () => {
    const database = new FakeDatabase();
    database.seed(`creditLedgerByDay/${DAY}/uid-1/key-1`, {
      type: 'spend',
      amount: -1,
      createdAt: FIXED_NOW,
      ref: 'job-1',
    });

    const result = await runReconcile(database as never, { day: DAY });

    expect(result.missing).toBe(1);
    expect(result.phantom).toBe(0);
    expect(result.duplicate).toBe(0);

    const rows = exceptionRowsFor(database, DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'missing_event',
      subjectRef: 'job-1',
      expected: { eventName: 'credit_spent', causationId: 'job-1:credit_spent' },
      actual: 'absent',
    });
  });

  it('flags a missing_event exception for a report job that reached succeeded with no report_completed event', async () => {
    const database = new FakeDatabase();
    database.seed(`reportJobsByDay/${DAY}/job-2`, { uid: 'uid-1', status: 'succeeded' });

    const result = await runReconcile(database as never, { day: DAY });

    expect(result.missing).toBe(1);
    const rows = exceptionRowsFor(database, DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'missing_event', subjectRef: 'job-2' });
  });

  it('does NOT flag missing_event for a failed report job whose report_failed came from the stuck-job sweep', async () => {
    const database = new FakeDatabase();
    database.seed(`reportJobsByDay/${DAY}/job-3`, { uid: 'uid-1', status: 'failed' });
    seedEvent(
      database,
      DAY,
      'key-1',
      envelope({
        eventId: 'event-sweep',
        eventName: 'report_failed',
        causationId: 'job-3:report_failed:sweep',
        source: 'job',
      }),
    );

    const result = await runReconcile(database as never, { day: DAY });

    expect(result.missing).toBe(0);
  });

  it('flags a phantom_event exception for a canonical event with no matching durable transition', async () => {
    const database = new FakeDatabase();
    seedEvent(
      database,
      DAY,
      'key-1',
      envelope({ eventName: 'credit_refunded', causationId: 'job-orphan:credit_refunded' }),
    );

    const result = await runReconcile(database as never, { day: DAY });

    expect(result.phantom).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.duplicate).toBe(0);

    const rows = exceptionRowsFor(database, DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'phantom_event',
      subjectRef: 'job-orphan',
      expected: 'domain_transition',
      actual: { eventName: 'credit_refunded', causationId: 'job-orphan:credit_refunded' },
    });
  });

  it('flags a duplicate_event exception for two ledger rows sharing eventName+causationId+schemaVersion', async () => {
    const database = new FakeDatabase();
    database.seed(`processedStripeEventsByDay/${DAY}/evt_1`, true);
    seedEvent(
      database,
      DAY,
      'key-1',
      envelope({ eventName: 'credits_granted', causationId: 'evt_1:credits_granted' }),
    );
    seedEvent(
      database,
      DAY,
      'key-2',
      envelope({
        eventId: 'event-2',
        eventName: 'credits_granted',
        causationId: 'evt_1:credits_granted',
      }),
    );
    seedEvent(
      database,
      DAY,
      'key-3',
      envelope({
        eventId: 'event-3',
        eventName: 'checkout_completed',
        causationId: 'evt_1:checkout_completed',
      }),
    );

    const result = await runReconcile(database as never, { day: DAY });

    expect(result.duplicate).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.phantom).toBe(0);

    const rows = exceptionRowsFor(database, DAY);
    const duplicateRow = rows.find((row) => (row as { kind: string }).kind === 'duplicate_event');
    expect(duplicateRow).toMatchObject({ expected: 1, actual: 2 });
  });

  it('never mutates eventLedger or a domain record during a run', async () => {
    const database = new FakeDatabase();
    database.seed(`processedStripeEventsByDay/${DAY}/evt_1`, true);
    const grantEnvelope = envelope({
      eventName: 'credits_granted',
      causationId: 'evt_1:credits_granted',
    });
    const completedEnvelope = envelope({
      eventId: 'event-2',
      eventName: 'checkout_completed',
      causationId: 'evt_1:checkout_completed',
    });
    seedEvent(database, DAY, 'key-1', grantEnvelope);
    seedEvent(database, DAY, 'key-2', completedEnvelope);
    database.seed('credits/uid-1/balance', 5);

    await runReconcile(database as never, { day: DAY });

    const dump = database.dump() as Record<string, unknown>;
    const ledgerDay = (dump.eventLedger as Record<string, Record<string, unknown>>)[DAY];
    expect(ledgerDay?.['key-1']).toEqual(grantEnvelope);
    expect(ledgerDay?.['key-2']).toEqual(completedEnvelope);
    expect(dump.credits).toEqual({ 'uid-1': { balance: 5 } });
  });

  it('skips a corrupt stored eventLedger row via safe-parse-and-skip, and the run still completes', async () => {
    const database = new FakeDatabase();
    database.seed(`eventLedger/${DAY}/corrupt-key`, { eventName: 'credits_granted' });
    seedEvent(
      database,
      DAY,
      'valid-key',
      envelope({ eventName: 'credit_refunded', causationId: 'job-orphan:credit_refunded' }),
    );

    const result = await runReconcile(database as never, { day: DAY });

    // Only the valid row is evaluated (and flagged phantom); the corrupt row
    // never throws and is simply excluded from every pass.
    expect(result.phantom).toBe(1);
  });

  it('skips a corrupt creditLedgerByDay entry via safe-parse-and-skip', async () => {
    const database = new FakeDatabase();
    database.seed(`creditLedgerByDay/${DAY}/uid-1/corrupt-key`, { type: 'not-a-real-type' });

    const result = await runReconcile(database as never, { day: DAY });

    expect(result).toEqual({ checked: 0, missing: 0, phantom: 0, duplicate: 0 });
  });

  it('exports RECONCILED_EVENT_NAMES with exactly its seven pre-existing members (C1-M7 sibling pin)', () => {
    expect([...RECONCILED_EVENT_NAMES].sort()).toEqual(
      [
        'credits_granted',
        'checkout_completed',
        'credit_spent',
        'credit_refunded',
        'report_started',
        'report_completed',
        'report_failed',
      ].sort(),
    );
  });

  it('exports RECONCILE_EXCEPTION_KINDS with exactly the kinds the four writeException call sites use (C1-M7)', () => {
    expect([...RECONCILE_EXCEPTION_KINDS].sort()).toEqual(
      ['missing_event', 'phantom_event', 'duplicate_event'].sort(),
    );
  });

  it('persists a counts-only summary to reconcileSummaries/{day} after a run (D-19)', async () => {
    const database = new FakeDatabase();
    database.seed(`creditLedgerByDay/${DAY}/uid-1/key-1`, {
      type: 'spend',
      amount: -1,
      createdAt: FIXED_NOW,
      ref: 'job-1',
    });

    const result = await runReconcile(database as never, { day: DAY });

    const dump = database.dump() as Record<string, unknown>;
    const summariesForDay = (dump.reconcileSummaries as Record<string, unknown> | undefined)?.[
      DAY
    ] as Record<string, unknown> | undefined;
    expect(summariesForDay).toEqual({
      checked: result.checked,
      missing: result.missing,
      phantom: result.phantom,
      duplicate: result.duplicate,
      // Code review API-WR-06: the units actually reconciled, and the
      // outbox-pending rows `checked` also counts, are persisted apart.
      reconciledUnits: result.checked,
      outboxPending: 0,
      generatedAt: expect.any(Number),
    });
  });

  it('API-WR-06: persists reconciledUnits = checked minus the outbox-pending rows no exception class evaluates', async () => {
    const database = new FakeDatabase();
    database.seed(`creditLedgerByDay/${DAY}/uid-1/key-1`, {
      type: 'spend',
      amount: -1,
      createdAt: FIXED_NOW,
      ref: 'job-1',
    });
    database.seed(`outboxPending/${DAY}/row-a`, { eventId: 'a' });
    database.seed(`outboxPending/${DAY}/row-b`, { eventId: 'b' });

    const result = await runReconcile(database as never, { day: DAY });

    const dump = database.dump() as Record<string, unknown>;
    const summary = (dump.reconcileSummaries as Record<string, Record<string, unknown>>)[DAY]!;
    expect(summary.outboxPending).toBe(2);
    expect(summary.reconciledUnits).toBe(result.checked - 2);
    expect(summary.checked).toBe(result.checked);
    // The pinned ReconcileResult shape is untouched.
    expect(Object.keys(result).sort()).toEqual(['checked', 'duplicate', 'missing', 'phantom']);
  });

  it('replaces rather than appends the summary on a second run for the same day (D-19)', async () => {
    const database = new FakeDatabase();
    const first = await runReconcile(database as never, { day: DAY });
    expect(first).toEqual({ checked: 0, missing: 0, phantom: 0, duplicate: 0 });

    database.seed(`creditLedgerByDay/${DAY}/uid-1/key-1`, {
      type: 'spend',
      amount: -1,
      createdAt: FIXED_NOW,
      ref: 'job-1',
    });
    const second = await runReconcile(database as never, { day: DAY });
    expect(second.checked).toBeGreaterThan(0);

    const dump = database.dump() as Record<string, unknown>;
    const summariesForDay = (dump.reconcileSummaries as Record<string, unknown> | undefined)?.[
      DAY
    ] as Record<string, unknown> | undefined;
    // The stored summary reflects ONLY the second run's counts — never a
    // merge/accumulation across runs.
    expect(summariesForDay).toMatchObject({
      checked: second.checked,
      missing: second.missing,
      phantom: second.phantom,
      duplicate: second.duplicate,
    });
  });

  it('the persisted summary write survives the fake database undefined-rejection guard', async () => {
    const database = new FakeDatabase();
    // No seeded data at all — proves the write payload never carries an
    // `undefined` field even in the all-zero case (the fake database throws
    // synchronously on any undefined value reaching set()).
    await expect(runReconcile(database as never, { day: DAY })).resolves.toEqual({
      checked: 0,
      missing: 0,
      phantom: 0,
      duplicate: 0,
    });
  });

  it('reads only day-sharded nodes — never a bare full-tree get() call', () => {
    const source = readFileSync(new URL('./reconcile.ts', import.meta.url), 'utf-8');
    for (const tree of [
      'eventLedger',
      'creditLedgerByDay',
      'processedStripeEventsByDay',
      'reportJobsByDay',
      'outboxPending',
    ]) {
      expect(source).not.toContain(`ref('${tree}')`);
      expect(source).not.toContain(`ref(\`${tree}\`)`);
    }
    // Pitfall 2 (RESEARCH.md): reconcile must never import the sole
    // eventLedger writer — only doc-comment PROSE may mention it.
    expect(source).not.toMatch(/import\s*\{[^}]*createEvent/);
    expect(source).not.toMatch(/void createEvent\(/);
  });
});
