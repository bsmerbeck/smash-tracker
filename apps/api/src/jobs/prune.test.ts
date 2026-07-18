import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { dayShardKey } from '../events/ledger.js';
import { runPrune } from './prune.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Noon UTC, well clear of any day-boundary rounding edge cases.
const FIXED_NOW = Date.UTC(2026, 0, 31, 12, 0, 0);

const LEDGER_FAMILY_TREES = [
  'eventLedger',
  'outboxPending',
  'creditLedgerByDay',
  'processedStripeEventsByDay',
  'reportJobsByDay',
] as const;

const EXPIRED_LEDGER_DAY = dayShardKey(FIXED_NOW - 31 * ONE_DAY_MS);
const WITHIN_WINDOW_LEDGER_DAY = dayShardKey(FIXED_NOW - 1 * ONE_DAY_MS);
const EXPIRED_EXCEPTION_DAY = dayShardKey(FIXED_NOW - 91 * ONE_DAY_MS);
const WITHIN_WINDOW_EXCEPTION_DAY = dayShardKey(FIXED_NOW - 10 * ONE_DAY_MS);

describe('runPrune', () => {
  it('removes whole expired day-nodes for every ledger-family tree, and retains a within-window day', async () => {
    const database = new FakeDatabase();
    for (const tree of LEDGER_FAMILY_TREES) {
      database.seed(`${tree}/${EXPIRED_LEDGER_DAY}/some-key`, { placeholder: true });
      database.seed(`${tree}/${WITHIN_WINDOW_LEDGER_DAY}/some-key`, { placeholder: true });
    }

    const result = await runPrune(database as never, { now: FIXED_NOW });

    expect(result.prunedLedgerDays).toContain(EXPIRED_LEDGER_DAY);
    expect(result.prunedLedgerDays).not.toContain(WITHIN_WINDOW_LEDGER_DAY);

    const dump = database.dump() as Record<string, unknown>;
    for (const tree of LEDGER_FAMILY_TREES) {
      const treeDump = dump[tree] as Record<string, unknown> | undefined;
      expect(treeDump?.[EXPIRED_LEDGER_DAY]).toBeUndefined();
      expect(treeDump?.[WITHIN_WINDOW_LEDGER_DAY]).toEqual({ 'some-key': { placeholder: true } });
    }
  });

  it('removes an expired reconciliationExceptions day-node on its own 90-day window, retains a within-window day', async () => {
    const database = new FakeDatabase();
    database.seed(`reconciliationExceptions/${EXPIRED_EXCEPTION_DAY}/some-key`, {
      kind: 'missing_event',
    });
    database.seed(`reconciliationExceptions/${WITHIN_WINDOW_EXCEPTION_DAY}/some-key`, {
      kind: 'missing_event',
    });

    const result = await runPrune(database as never, { now: FIXED_NOW });

    expect(result.prunedExceptionDays).toContain(EXPIRED_EXCEPTION_DAY);
    expect(result.prunedExceptionDays).not.toContain(WITHIN_WINDOW_EXCEPTION_DAY);

    const dump = database.dump() as Record<string, unknown>;
    const exceptions = dump.reconciliationExceptions as Record<string, unknown> | undefined;
    expect(exceptions?.[EXPIRED_EXCEPTION_DAY]).toBeUndefined();
    expect(exceptions?.[WITHIN_WINDOW_EXCEPTION_DAY]).toEqual({
      'some-key': { kind: 'missing_event' },
    });
  });

  it('a second run over the same (already-pruned) state is a safe no-op', async () => {
    const database = new FakeDatabase();
    database.seed(`eventLedger/${EXPIRED_LEDGER_DAY}/some-key`, { placeholder: true });

    const first = await runPrune(database as never, { now: FIXED_NOW });
    const second = await runPrune(database as never, { now: FIXED_NOW });

    expect(second.prunedLedgerDays).toEqual(first.prunedLedgerDays);
    expect(second.prunedExceptionDays).toEqual(first.prunedExceptionDays);
    const dump = database.dump() as Record<string, unknown>;
    const eventLedger = dump.eventLedger as Record<string, unknown> | undefined;
    expect(eventLedger?.[EXPIRED_LEDGER_DAY]).toBeUndefined();
  });

  it('respects custom retention windows when provided', async () => {
    const database = new FakeDatabase();
    const customExpiredDay = dayShardKey(FIXED_NOW - 8 * ONE_DAY_MS);
    database.seed(`eventLedger/${customExpiredDay}/some-key`, { placeholder: true });

    const result = await runPrune(database as never, { now: FIXED_NOW, ledgerDays: 7 });

    expect(result.prunedLedgerDays).toContain(customExpiredDay);
    const dump = database.dump() as Record<string, unknown>;
    const eventLedger = dump.eventLedger as Record<string, unknown> | undefined;
    expect(eventLedger?.[customExpiredDay]).toBeUndefined();
  });

  it('never reads a tree before removing it — no .get() call anywhere in prune.ts (no per-record enumeration)', () => {
    const source = readFileSync(new URL('./prune.ts', import.meta.url), 'utf-8');
    // Strip comments (JSDoc/line) so prose that MENTIONS `.get()` (explaining
    // why the code never calls it) doesn't false-positive this assertion.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('.get(');
    expect(code).toContain('.remove()');
  });
});
