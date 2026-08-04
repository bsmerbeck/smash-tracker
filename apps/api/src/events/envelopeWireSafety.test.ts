import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'firebase-admin/database';
import {
  buildAnonymousDomainEnvelope,
  buildBillingEnvelope,
  buildDomainEnvelope,
} from './envelope.js';
import { createEvent } from './ledger.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';

/**
 * Regression battery for the 2026-07-30 production incident: every D/B-class
 * event write failed on the real RTDB SDK from 2026-07-19 to 2026-07-30
 * because the envelope builders passed `artifactKind: undefined` through as
 * an own property (Zod's .optional() preserves it; JSON.stringify hides it),
 * the real SDK rejects undefined in update() payloads, and the dedup marker
 * had already committed — permanently swallowing each event while 527
 * FakeDatabase-backed tests stayed green.
 *
 * Three defenses are locked here:
 *  1. Builders never emit undefined own-properties (root cause).
 *  2. FakeDatabase now rejects undefined exactly like the real SDK, so this
 *     bug class fails in tests instead of only in production.
 *  3. createEvent is total past its schema parse — an eventLedger I/O
 *     failure logs and returns instead of rejecting, so the 30
 *     `void createEvent(...)` fire-and-forget sites can never turn a
 *     telemetry failure into an unhandled rejection that kills the process
 *     (e.g. between a credit debit and its refund).
 */

function deepFindUndefined(value: unknown, path: string[] = []): string[] {
  if (value === undefined) {
    return [path.join('.')];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const hits: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    hits.push(...deepFindUndefined(child, [...path, key]));
  }
  return hits;
}

const asDatabase = (fake: FakeDatabase) => fake as unknown as Database;

describe('envelope builders emit no undefined own-properties (incident root cause)', () => {
  it('buildDomainEnvelope without artifactKind omits the key entirely', () => {
    const env = buildDomainEnvelope({
      eventName: 'prep_brief_activated',
      actorId: 'uid-1',
      sessionId: 'sess-1',
      causationId: 'uid-1:entry-1',
      consentState: 'unknown',
      payload: {},
    });
    expect(Object.prototype.hasOwnProperty.call(env, 'artifactKind')).toBe(false);
    expect(deepFindUndefined(env)).toEqual([]);
  });

  it('buildAnonymousDomainEnvelope without artifactKind omits the key entirely', () => {
    const env = buildAnonymousDomainEnvelope({
      eventName: 'client_review_acknowledged',
      actorId: 'anon-1',
      sessionId: 'sess-1',
      causationId: 'delivery-1',
      consentState: 'unknown',
    });
    expect(Object.prototype.hasOwnProperty.call(env, 'artifactKind')).toBe(false);
    expect(deepFindUndefined(env)).toEqual([]);
  });

  it('buildBillingEnvelope without artifactKind omits the key entirely', () => {
    const env = buildBillingEnvelope({
      eventName: 'credit_spent',
      source: 'job',
      actorId: 'uid-1',
      sessionId: 'uid-1',
      causationId: 'job-1:credit_spent',
      consentState: 'unknown',
      payload: { amount: -1 },
    });
    expect(Object.prototype.hasOwnProperty.call(env, 'artifactKind')).toBe(false);
    expect(deepFindUndefined(env)).toEqual([]);
  });

  it('an explicitly provided artifactKind still round-trips', () => {
    const env = buildDomainEnvelope({
      eventName: 'review_delivery_created',
      actorId: 'uid-1',
      sessionId: 'sess-1',
      causationId: 'delivery-2',
      consentState: 'unknown',
      artifactKind: 'review',
    });
    expect(env.artifactKind).toBe('review');
  });

  /**
   * Phase 28 (28-04): both new post-event-review envelopes carry empty
   * payloads and no `artifactKind` — the same shape as
   * `prep_brief_activated` above — so this is a direct regression case for
   * the exact incident class this file guards.
   */
  it('post_event_review_started emits no undefined own-properties', () => {
    const env = buildDomainEnvelope({
      eventName: 'post_event_review_started',
      actorId: 'uid-1',
      sessionId: 'sess-1',
      causationId: 'uid-1:entry-1',
      consentState: 'unknown',
      payload: {},
    });
    expect(Object.prototype.hasOwnProperty.call(env, 'artifactKind')).toBe(false);
    expect(deepFindUndefined(env)).toEqual([]);
  });

  it('post_event_review_completed emits no undefined own-properties', () => {
    const env = buildDomainEnvelope({
      eventName: 'post_event_review_completed',
      actorId: 'uid-1',
      sessionId: 'sess-1',
      causationId: 'uid-1:entry-1',
      consentState: 'unknown',
      payload: {},
    });
    expect(Object.prototype.hasOwnProperty.call(env, 'artifactKind')).toBe(false);
    expect(deepFindUndefined(env)).toEqual([]);
  });
});

describe('FakeDatabase rejects undefined like the real SDK (test-double parity)', () => {
  it('set() with a nested undefined property throws the SDK-shaped error', async () => {
    const db = new FakeDatabase();
    await expect(db.ref('a/b').set({ ok: 1, bad: undefined })).rejects.toThrow(
      /set failed: value argument contains undefined in property 'a\.b\.bad'/,
    );
  });

  it('update() with an undefined value throws instead of deleting', async () => {
    const db = new FakeDatabase();
    db.seed('t', { keep: 1 });
    await expect(db.ref('t').update({ keep: undefined })).rejects.toThrow(
      /update failed: values argument contains undefined in property/,
    );
    // The old lenient behavior deleted the key; the real SDK rejects the
    // whole call and leaves data untouched.
    const snap = await db.ref('t/keep').get();
    expect(snap.val()).toBe(1);
  });

  it('a committed transaction result containing undefined throws', async () => {
    const db = new FakeDatabase();
    await expect(db.ref('x').transaction(() => ({ a: 1, b: undefined }))).rejects.toThrow(
      /transaction failed: value argument contains undefined/,
    );
  });

  it('transaction abort (returning undefined) is still the abort signal, not a data error', async () => {
    const db = new FakeDatabase();
    const result = await db.ref('x').transaction(() => undefined);
    expect(result.committed).toBe(false);
  });
});

describe('createEvent under the strict fake (end-to-end incident closure)', () => {
  it('a builder-produced D envelope lands both the ledger row and the outbox row', async () => {
    const db = new FakeDatabase();
    await createEvent(
      asDatabase(db),
      buildDomainEnvelope({
        eventName: 'prep_brief_activated',
        actorId: 'uid-1',
        sessionId: 'sess-1',
        causationId: 'uid-1:entry-1',
        consentState: 'unknown',
        payload: {},
      }),
    );
    const dump = db.dump();
    const ledgerDays = Object.keys((dump.eventLedger as Record<string, unknown>) ?? {});
    expect(ledgerDays).toHaveLength(1);
    const day = ledgerDays[0]!;
    const rows = Object.values(
      (dump.eventLedger as Record<string, Record<string, { eventName: string }>>)[day]!,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventName).toBe('prep_brief_activated');
    expect(Object.keys((dump.outboxPending as Record<string, object>)[day]!)).toHaveLength(1);
    // Dedup marker AND ledger row exist together — never the orphaned-marker
    // state the incident produced.
    expect(dump.eventDedup).toBeDefined();
  });

  it('an eventLedger I/O failure logs and resolves — it never rejects (fire-and-forget safety)', async () => {
    const db = new FakeDatabase();
    const database = asDatabase(db);
    const realRef = database.ref.bind(database);
    const failing = {
      ref: (path?: string) => {
        const ref = realRef(path as string);
        if (path === undefined) {
          return {
            ...ref,
            update: () => {
              throw new Error('update failed: simulated SDK rejection');
            },
          };
        }
        return ref;
      },
    } as unknown as Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        createEvent(
          failing,
          buildDomainEnvelope({
            eventName: 'prep_brief_reopened',
            actorId: 'uid-1',
            sessionId: 'sess-1',
            causationId: 'open-1',
            consentState: 'unknown',
            payload: {},
          }),
        ),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('eventLedger write failed (best-effort emission)'),
        expect.stringContaining('simulated SDK rejection'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
