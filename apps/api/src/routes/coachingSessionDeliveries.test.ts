import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp } from '../test-support/testApp.js';

async function createClient(app: ReturnType<typeof buildTestApp>['app'], label = 'Alex') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(),
    payload: { label },
  });
  return response.json().clientId as string;
}

async function createSession(app: ReturnType<typeof buildTestApp>['app'], clientId: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/sessions`,
    headers: authHeader(),
    payload: {
      date: 1_700_000_000_000,
      characterTags: [1, 2],
      summary: 'Worked on shield pressure.',
      homework: [{ text: 'Practice out-of-shield options' }],
    },
  });
  return response.json().sessionId as string;
}

function eventRows(dump: unknown): Array<{ eventName: string; payload: unknown }> {
  const typed = dump as { eventLedger?: Record<string, Record<string, unknown>> };
  return Object.values(typed.eventLedger ?? {}).flatMap((day) => Object.values(day)) as Array<{
    eventName: string;
    payload: unknown;
  }>;
}

describe('/api/coaching/clients/:clientId/sessions/:sessionId/deliveries', () => {
  it('creates a delivery embedding a frozen snapshot and fires session_delivery_created (content-free)', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);
    const sessionId = await createSession(app, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveProperty('deliveryId');
    expect(body).toHaveProperty('token');
    expect(body.url).toContain(body.token);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const created = rows.find((row) => row.eventName === 'session_delivery_created');
    expect(created).toBeDefined();
    expect(created?.payload).toEqual({});
  });

  it('404s creating a delivery for an unknown sessionId', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/no-such-session/deliveries`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('lists every delivery for the session, most-recent-first', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const sessionId = await createSession(app, clientId);

    await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });

    expect(listResponse.statusCode).toBe(200);
    const rows = listResponse.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'delivered', revokedAt: null });
  });

  it('revokes a delivery idempotently — no event is fired for the revoke (rides the token lifecycle)', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);
    const sessionId = await createSession(app, clientId);
    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });
    const { deliveryId } = createResponse.json();

    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries/${deliveryId}/revoke`,
      headers: authHeader(),
    });
    expect(revokeResponse.statusCode).toBe(204);

    const secondRevokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries/${deliveryId}/revoke`,
      headers: authHeader(),
    });
    expect(secondRevokeResponse.statusCode).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    // Exactly one session_delivery_created (from create) — revoke rides the
    // existing token lifecycle and fires no dedicated event of its own.
    expect(rows.filter((row) => row.eventName === 'session_delivery_created')).toHaveLength(1);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });
    expect(listResponse.json()[0]).toMatchObject({ status: 'revoked' });
  });

  it('404s revoking an unknown deliveryId', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const sessionId = await createSession(app, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries/no-such-delivery/revoke`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });
});
