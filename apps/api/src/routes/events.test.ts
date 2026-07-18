import { describe, expect, it } from 'vitest';
import { X_EVENT_ALLOWLIST } from '@smash-tracker/shared';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const EVENT_NAME = X_EVENT_ALLOWLIST[0];

function eventPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: 'client-event-1',
    eventName: EVENT_NAME,
    occurredAt: Date.now(),
    ...overrides,
  };
}

function allLedgerRows(database: ReturnType<typeof buildTestApp>['database']): unknown[] {
  const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
  const days = dump.eventLedger ?? {};
  return Object.values(days).flatMap((day) => Object.values(day));
}

describe('POST /api/events', () => {
  it('ingests a valid allowlisted X event and writes exactly one eventLedger row', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: eventPayload(),
    });

    expect(response.statusCode).toBe(200);
    const rows = allLedgerRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventName: EVENT_NAME,
      eventId: 'client-event-1',
      causationId: 'client-event-1',
      source: 'web',
      actorKind: 'anonymous',
      consentState: 'unknown',
    });
  });

  it('rejects an eventName not in X_EVENT_ALLOWLIST with 400 and writes no ledger row', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: eventPayload({ eventName: 'signup_completed' }),
    });

    expect(response.statusCode).toBe(400);
    expect(allLedgerRows(database)).toHaveLength(0);
  });

  it('rejects an occurredAt outside the +/-5 minute window with 400', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: eventPayload({ occurredAt: Date.now() - 6 * 60 * 1000 }),
    });

    expect(response.statusCode).toBe(400);
    expect(allLedgerRows(database)).toHaveLength(0);
  });

  it('dedups a second POST with the same eventId + eventName to a single ledger row', async () => {
    const { app, database } = buildTestApp();

    const first = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: eventPayload(),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: eventPayload(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(allLedgerRows(database)).toHaveLength(1);
  });

  it('attributes to the authenticated uid when a valid bearer token is present', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authHeader(),
      payload: eventPayload(),
    });

    expect(response.statusCode).toBe(200);
    const rows = allLedgerRows(database);
    expect(rows[0]).toMatchObject({ actorKind: 'authenticated', actorId: TEST_UID });
  });

  it('falls back to anonymous attribution on an invalid bearer token, rather than rejecting the event', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: eventPayload(),
    });

    expect(response.statusCode).toBe(200);
    const rows = allLedgerRows(database);
    expect(rows[0]).toMatchObject({ actorKind: 'anonymous' });
  });

  it('rate-limits to 60 req/min per IP', async () => {
    const { app } = buildTestApp();

    let lastStatus = 200;
    for (let i = 0; i < 60; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        payload: eventPayload({ eventId: `event-${i}` }),
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(200);

    const sixtyFirst = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-forwarded-for': '9.9.9.9' },
      payload: eventPayload({ eventId: 'event-60' }),
    });
    expect(sixtyFirst.statusCode).toBe(429);
  });
});
