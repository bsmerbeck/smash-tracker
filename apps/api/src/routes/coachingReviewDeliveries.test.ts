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

async function createAndPublishReview(
  app: ReturnType<typeof buildTestApp>['app'],
  clientId: string,
) {
  const createResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews`,
    headers: authHeader(),
  });
  const { reviewId } = createResponse.json();

  const publishResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
    headers: authHeader(),
  });
  const { version } = publishResponse.json();

  return { reviewId, version: version as number };
}

function eventRows(dump: unknown): Array<{ eventName: string; payload: unknown }> {
  const typed = dump as { eventLedger?: Record<string, Record<string, unknown>> };
  return Object.values(typed.eventLedger ?? {}).flatMap((day) => Object.values(day)) as Array<{
    eventName: string;
    payload: unknown;
  }>;
}

describe('/api/coaching/clients/:clientId/reviews/:reviewId/deliveries', () => {
  it('creates a delivery pinned to the published version and fires review_delivery_created', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, version } = await createAndPublishReview(app, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveProperty('deliveryId');
    expect(body).toHaveProperty('token');
    expect(body.url).toContain(body.token);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const created = rows.find((row) => row.eventName === 'review_delivery_created');
    expect(created).toBeDefined();
    expect(created?.payload).toEqual({});
  });

  it('404s when the version has never been published', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: authHeader(),
    });
    const { reviewId } = createResponse.json();

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version: 1 },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lists every delivery for the review', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, version } = await createAndPublishReview(app, clientId);

    await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
    });

    expect(listResponse.statusCode).toBe(200);
    const rows = listResponse.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'delivered', version, revokedAt: null });
  });

  it('revokes a delivery, fires review_delivery_revoked once, and a second revoke does not re-fire it', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, version } = await createAndPublishReview(app, clientId);
    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version },
    });
    const { deliveryId } = createResponse.json();

    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries/${deliveryId}/revoke`,
      headers: authHeader(),
    });
    expect(revokeResponse.statusCode).toBe(204);

    const secondRevokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries/${deliveryId}/revoke`,
      headers: authHeader(),
    });
    expect(secondRevokeResponse.statusCode).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const revokedEvents = rows.filter((row) => row.eventName === 'review_delivery_revoked');
    expect(revokedEvents).toHaveLength(1);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
    });
    expect(listResponse.json()[0]).toMatchObject({ status: 'revoked' });
  });

  it('404s revoking an unknown deliveryId', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId } = await createAndPublishReview(app, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries/no-such-delivery/revoke`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });
});
