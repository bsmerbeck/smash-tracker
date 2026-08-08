import { describe, expect, it, vi } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';

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

/** Records the ORDER of every `.ref(path)` call against `database`, without disturbing behavior. */
function recordRefCalls(database: FakeDatabase): { paths: string[] } {
  const paths: string[] = [];
  const originalRef = database.ref.bind(database);
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    paths.push(path ?? '(root)');
    return originalRef(path);
  });
  return { paths };
}

/**
 * RTEN-04 (D-06). `createReviewDelivery` (plan 29-06, `coaching/reviewDeliveries.ts`)
 * already refuses to MINT a delivery for a research/unresolved subject
 * BEFORE any write (RTEN-03's own D-05 contract) — so `review_delivery_created`
 * is `unreachable-by-construction` for those subjects regardless of this
 * plan's own route-level guard: the mint refusal throws first, and this
 * guard's `createEvent` call is never reached. `requireMembership` (plan
 * 29-04) additionally fails closed on an unresolvable-kind tenant before
 * the route handler runs at all. The FIRST block below locks that observed
 * behavior; the guard itself stays in place as defensive layering (never
 * dead weight if a future change to the mint writer ever let a research
 * subject's mint succeed).
 *
 * `review_delivery_revoked` is DIFFERENT: `revokeReviewDelivery` has no
 * subject-kind check of its own, so a delivery minted while the tenant was
 * still ordinary and revoked AFTER the tenant became research IS reachable
 * — the exact "token minted before this phase" scenario `publicReviewDeliveries.test.ts`
 * (plan 29-06) already covers for resolution; the SECOND block below covers
 * the symmetric case for this plan's own revoke-emission guard.
 */
describe('RTEN-04 (D-06): review_delivery_created / review_delivery_revoked telemetry suppression', () => {
  it('review_delivery_created: minting against a research tenant is refused entirely (unreachable-by-construction, plan 29-06 D-05) — zero rows, zero delivery', async () => {
    const { app, database } = buildTestApp({ research: { adminUids: new Set([TEST_UID]) } });
    const clientId = await createClient(app);
    const { reviewId, version } = await createAndPublishReview(app, clientId);
    database.seed(`clientTenants/${clientId}/kind`, 'research');

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version },
    });

    expect(response.statusCode).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'review_delivery_created')).toHaveLength(0);
  });

  it('review_delivery_revoked: an allowlisted admin revoking a delivery minted BEFORE the tenant became research — zero rows, and the revoke still succeeds', async () => {
    const { app, database } = buildTestApp({ research: { adminUids: new Set([TEST_UID]) } });
    const clientId = await createClient(app);
    const { reviewId, version } = await createAndPublishReview(app, clientId);
    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version },
    });
    const { deliveryId } = createResponse.json();

    // The tenant becomes research AFTER the delivery was minted.
    database.seed(`clientTenants/${clientId}/kind`, 'research');

    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries/${deliveryId}/revoke`,
      headers: authHeader(),
    });
    expect(revokeResponse.statusCode).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'review_delivery_revoked')).toHaveLength(0);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
    });
    expect(listResponse.json()[0]).toMatchObject({ status: 'revoked' });
  });

  it('resolves the subject kind BEFORE the revoke mutation — review finding 29-06 MEDIUM', async () => {
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

    const { paths } = recordRefCalls(database);
    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries/${deliveryId}/revoke`,
      headers: authHeader(),
    });
    expect(revokeResponse.statusCode).toBe(204);

    const kindReadIndex = paths.indexOf(`clientTenants/${clientId}/kind`);
    const revokeWriteIndex = paths.indexOf('(root)');
    expect(kindReadIndex).toBeGreaterThanOrEqual(0);
    expect(revokeWriteIndex).toBeGreaterThanOrEqual(0);
    expect(kindReadIndex).toBeLessThan(revokeWriteIndex);
  });

  it('resolves the subject kind BEFORE the mint mutation runs, for the ordinary (reachable) create case', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, version } = await createAndPublishReview(app, clientId);

    const { paths } = recordRefCalls(database);
    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(),
      payload: { version },
    });
    expect(response.statusCode).toBe(201);

    const kindReadIndex = paths.indexOf(`clientTenants/${clientId}/kind`);
    const mintWriteIndex = paths.indexOf(`reviewDeliveries/${clientId}/${reviewId}`);
    expect(kindReadIndex).toBeGreaterThanOrEqual(0);
    expect(mintWriteIndex).toBeGreaterThanOrEqual(0);
    expect(kindReadIndex).toBeLessThan(mintWriteIndex);
  });
});
