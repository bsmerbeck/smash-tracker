import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp } from '../test-support/testApp.js';

/** Registers a managed client (coach = TEST_UID from `testApp.ts`) and returns its tenantId. */
async function createClient(
  app: ReturnType<typeof buildTestApp>['app'],
  label = 'Alex',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(),
    payload: { label },
  });
  return response.json().clientId as string;
}

/** Starts a new review for `clientId` — the draft begins with the four default (non-empty-editable) sections at revision 1. */
async function startReview(
  app: ReturnType<typeof buildTestApp>['app'],
  clientId: string,
): Promise<{ reviewId: string; revision: number }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews`,
    headers: authHeader(),
  });
  const body = response.json();
  return { reviewId: body.reviewId as string, revision: body.revision as number };
}

/** Autosaves the `summary` section's body (and, optionally, `coachPrivateNotes`) — the other three default sections are carried through untouched. */
async function patchSummaryBody(
  app: ReturnType<typeof buildTestApp>['app'],
  clientId: string,
  reviewId: string,
  expectedRevision: number,
  summaryBody: string,
  coachPrivateNotes?: string,
): Promise<{ revision: number }> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/draft`,
    headers: authHeader(),
    payload: {
      expectedRevision,
      sections: [
        { id: 'summary', kind: 'summary', hidden: false, title: null, body: summaryBody },
        { id: 'strengths', kind: 'strengths', hidden: false, title: null, body: '' },
        { id: 'priorities', kind: 'priorities', hidden: false, title: null, body: '' },
        { id: 'practicePlan', kind: 'practicePlan', hidden: false, title: null, body: '' },
      ],
      ...(coachPrivateNotes !== undefined ? { coachPrivateNotes } : {}),
    },
  });
  return response.json();
}

/** Publishes the current draft, returning its new version number. */
async function publish(
  app: ReturnType<typeof buildTestApp>['app'],
  clientId: string,
  reviewId: string,
): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
    headers: authHeader(),
  });
  return (response.json() as { version: number }).version;
}

/** Mints a delivery for a published version, returning its token (and deliveryId). */
async function createDelivery(
  app: ReturnType<typeof buildTestApp>['app'],
  clientId: string,
  reviewId: string,
  version: number,
  expiresAt?: number,
): Promise<{ deliveryId: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
    headers: authHeader(),
    payload: { version, ...(expiresAt !== undefined ? { expiresAt } : {}) },
  });
  const body = response.json();
  return { deliveryId: body.deliveryId as string, token: body.token as string };
}

async function revokeDelivery(
  app: ReturnType<typeof buildTestApp>['app'],
  clientId: string,
  reviewId: string,
  deliveryId: string,
): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries/${deliveryId}/revoke`,
    headers: authHeader(),
  });
}

/** A full happy-path setup: a published v1 delivery whose summary section body is `V1_TEXT`. */
async function seedDeliveredReview(
  app: ReturnType<typeof buildTestApp>['app'],
): Promise<{ clientId: string; reviewId: string; deliveryId: string; token: string }> {
  const clientId = await createClient(app);
  const { reviewId, revision } = await startReview(app, clientId);
  await patchSummaryBody(app, clientId, reviewId, revision, 'V1_TEXT', 'SECRET_COACH_NOTES');
  const version = await publish(app, clientId, reviewId);
  const { deliveryId, token } = await createDelivery(app, clientId, reviewId, version);
  return { clientId, reviewId, deliveryId, token };
}

function eventRows(dump: unknown): Array<{
  eventName: string;
  actorKind: string;
  actorId: string;
  payload: unknown;
}> {
  const typed = dump as { eventLedger?: Record<string, Record<string, unknown>> };
  return Object.values(typed.eventLedger ?? {}).flatMap((day) => Object.values(day)) as Array<{
    eventName: string;
    actorKind: string;
    actorId: string;
    payload: unknown;
  }>;
}

/** Reads the raw `reviewDeliveries/{tenantId}/{reviewId}/{deliveryId}` record straight out of `database.dump()`. */
function dumpDeliveryRecord(
  dump: unknown,
  tenantId: string,
  reviewId: string,
  deliveryId: string,
): Record<string, unknown> {
  const typed = dump as {
    reviewDeliveries?: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  };
  return typed.reviewDeliveries![tenantId]![reviewId]![deliveryId]!;
}

describe('GET /api/review-deliveries/:token', () => {
  it('returns the pinned published-version snapshot for a live delivery token, no-store', async () => {
    const { app } = buildTestApp();
    const { token } = await seedDeliveredReview(app);

    const response = await app.inject({ method: 'GET', url: `/api/review-deliveries/${token}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.kind).toBe('coachReview');
    expect(body.coachDisplayName).toBeTruthy();
    expect(typeof body.reviewPublishedAt).toBe('number');
    expect(body.sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'summary', body: 'V1_TEXT' })]),
    );
  });

  it('returns the identical unavailable body for an unknown token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/review-deliveries/noSuchTokenAtAll-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
  });

  it('returns the identical unavailable body for a revoked token', async () => {
    const { app } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);
    await revokeDelivery(app, clientId, reviewId, deliveryId);

    const response = await app.inject({ method: 'GET', url: `/api/review-deliveries/${token}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
  });

  it('returns the identical unavailable body for an expired token', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, revision } = await startReview(app, clientId);
    await patchSummaryBody(app, clientId, reviewId, revision, 'V1_TEXT');
    const version = await publish(app, clientId, reviewId);
    const { token } = await createDelivery(app, clientId, reviewId, version, Date.now() - 1000);

    const response = await app.inject({ method: 'GET', url: `/api/review-deliveries/${token}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
  });

  it('never sets ackAt/viewedAt on the stored delivery record — GET must not mark Viewed (D-09/Pitfall 4)', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);

    await app.inject({ method: 'GET', url: `/api/review-deliveries/${token}` });
    await app.inject({ method: 'GET', url: `/api/review-deliveries/${token}` });

    const record = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(record.ackAt).toBeNull();
    expect(record.viewedAt).toBeNull();
    expect(record.status).toBe('delivered');
  });
});

describe('POST /api/review-deliveries/:token/ack', () => {
  it('sets ackAt once, fires client_review_acknowledged (anonymous, content-free), and returns acknowledged: true', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/ack`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ acknowledged: true });

    const record = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(typeof record.ackAt).toBe('number');
    expect(record.status).toBe('acknowledged');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const acked = eventRows(database.dump()).filter(
      (row) => row.eventName === 'client_review_acknowledged',
    );
    expect(acked).toHaveLength(1);
    expect(acked[0]?.actorKind).toBe('anonymous');
    expect(acked[0]?.actorId).toBe(deliveryId);
    expect(acked[0]?.payload).toEqual({});
  });

  it('is idempotent — a second ack does not change ackAt or double-fire the event', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);

    await app.inject({ method: 'POST', url: `/api/review-deliveries/${token}/ack` });
    const firstRecord = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    const firstAckAt = firstRecord.ackAt;

    const second = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/ack`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ acknowledged: true });

    const secondRecord = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(secondRecord.ackAt).toBe(firstAckAt);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const acked = eventRows(database.dump()).filter(
      (row) => row.eventName === 'client_review_acknowledged',
    );
    expect(acked).toHaveLength(1);
  });

  it('returns the identical unavailable body for a revoked token, and never sets ackAt', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);
    await revokeDelivery(app, clientId, reviewId, deliveryId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/ack`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
    const record = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(record.ackAt).toBeNull();
  });

  it('returns the identical unavailable body for an unknown token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/review-deliveries/noSuchTokenAtAll-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ack',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
  });
});

describe('POST /api/review-deliveries/:token/viewed', () => {
  it('sets viewedAt once, advances status to viewed, fires client_review_view_loaded, and returns viewed: true', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/viewed`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ viewed: true });

    const record = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(typeof record.viewedAt).toBe('number');
    expect(record.status).toBe('viewed');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const viewed = eventRows(database.dump()).filter(
      (row) => row.eventName === 'client_review_view_loaded',
    );
    expect(viewed).toHaveLength(1);
    expect(viewed[0]?.actorKind).toBe('anonymous');
    expect(viewed[0]?.actorId).toBe(deliveryId);
    expect(viewed[0]?.payload).toEqual({});
  });

  it('is idempotent — a second view does not change viewedAt or double-fire the event', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);

    await app.inject({ method: 'POST', url: `/api/review-deliveries/${token}/viewed` });
    const firstRecord = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    const firstViewedAt = firstRecord.viewedAt;

    const second = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/viewed`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ viewed: true });

    const secondRecord = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(secondRecord.viewedAt).toBe(firstViewedAt);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const viewed = eventRows(database.dump()).filter(
      (row) => row.eventName === 'client_review_view_loaded',
    );
    expect(viewed).toHaveLength(1);
  });

  it('never regresses an already-acknowledged delivery back to viewed status, but still stamps viewedAt', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);

    await app.inject({ method: 'POST', url: `/api/review-deliveries/${token}/ack` });
    await app.inject({ method: 'POST', url: `/api/review-deliveries/${token}/viewed` });

    const record = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(record.status).toBe('acknowledged');
    expect(typeof record.viewedAt).toBe('number');
  });

  it('returns the identical unavailable body for a revoked token, and never sets viewedAt', async () => {
    const { app, database } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);
    await revokeDelivery(app, clientId, reviewId, deliveryId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/viewed`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
    const record = dumpDeliveryRecord(database.dump(), clientId, reviewId, deliveryId);
    expect(record.viewedAt).toBeNull();
  });

  it('returns the identical unavailable body for an unknown token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/review-deliveries/noSuchTokenAtAll-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/viewed',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'This delivery is no longer available',
      statusCode: 404,
    });
  });
});

/**
 * DLV-03: a delivery token grants access to EXACTLY ONE published version —
 * no draft, no coach-private content, no other version, no other review,
 * and no workspace/coach-side route. Named explicit test cases (per the
 * plan's own instruction) so this gate is unambiguous.
 */
describe('DLV-03 boundary: a delivery token grants no other access', () => {
  it('the GET response never carries coachPrivateNotes or any draft-only field', async () => {
    const { app } = buildTestApp();
    const { token } = await seedDeliveredReview(app);

    const response = await app.inject({ method: 'GET', url: `/api/review-deliveries/${token}` });

    const body = response.json();
    expect('coachPrivateNotes' in body).toBe(false);
    expect('revision' in body).toBe(false);
    expect('lastAutosavedAt' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('SECRET_COACH_NOTES');
  });

  it('a token pinned to version N never returns version N-1 or N+1 content — publishing v2 leaves the v1 delivery pinned at v1', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, revision: rev1 } = await startReview(app, clientId);
    await patchSummaryBody(app, clientId, reviewId, rev1, 'V1_TEXT');
    const v1 = await publish(app, clientId, reviewId);
    const { token: v1Token } = await createDelivery(app, clientId, reviewId, v1);

    // Edit and publish a second version AFTER the v1 delivery already exists.
    await patchSummaryBody(app, clientId, reviewId, rev1 + 1, 'V2_TEXT');
    const v2 = await publish(app, clientId, reviewId);
    expect(v2).toBe(v1 + 1);
    const { token: v2Token } = await createDelivery(app, clientId, reviewId, v2);

    const v1Response = await app.inject({
      method: 'GET',
      url: `/api/review-deliveries/${v1Token}`,
    });
    const v2Response = await app.inject({
      method: 'GET',
      url: `/api/review-deliveries/${v2Token}`,
    });

    expect(v1Response.json().sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'summary', body: 'V1_TEXT' })]),
    );
    expect(v2Response.json().sections).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'summary', body: 'V2_TEXT' })]),
    );
    // The v1 delivery's OWN token must still resolve to v1 content, never v2.
    expect(JSON.stringify(v1Response.json())).not.toContain('V2_TEXT');
    expect(JSON.stringify(v2Response.json())).not.toContain('V1_TEXT');
  });

  it('the token cannot be used to read another review, or another client tenant, at all', async () => {
    const { app } = buildTestApp();
    const { token: reviewAToken } = await seedDeliveredReview(app);

    const clientB = await createClient(app, 'Sam');
    const { reviewId: reviewBId, revision } = await startReview(app, clientB);
    await patchSummaryBody(app, clientB, reviewBId, revision, 'REVIEW_B_TEXT');
    const versionB = await publish(app, clientB, reviewBId);
    const { token: reviewBToken } = await createDelivery(app, clientB, reviewBId, versionB);

    const responseA = await app.inject({
      method: 'GET',
      url: `/api/review-deliveries/${reviewAToken}`,
    });
    const responseB = await app.inject({
      method: 'GET',
      url: `/api/review-deliveries/${reviewBToken}`,
    });

    expect(JSON.stringify(responseA.json())).not.toContain('REVIEW_B_TEXT');
    expect(JSON.stringify(responseB.json())).not.toContain('V1_TEXT');
  });

  it('the token grants no access to any authenticated coach-side route (it is not a bearer auth token)', async () => {
    const { app } = buildTestApp();
    const { clientId, token } = await seedDeliveredReview(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/reviews`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('after revoke, GET and ack both return the identical no-oracle unavailable result', async () => {
    const { app } = buildTestApp();
    const { clientId, reviewId, deliveryId, token } = await seedDeliveredReview(app);
    await revokeDelivery(app, clientId, reviewId, deliveryId);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/review-deliveries/${token}`,
    });
    const ackResponse = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/ack`,
    });

    expect(getResponse.statusCode).toBe(404);
    expect(ackResponse.statusCode).toBe(404);
    expect(getResponse.json()).toEqual(ackResponse.json());
  });

  it('an expired token behaves identically to an unknown one for both GET and ack', async () => {
    const { app } = buildTestApp();
    const clientId = await createClient(app);
    const { reviewId, revision } = await startReview(app, clientId);
    await patchSummaryBody(app, clientId, reviewId, revision, 'V1_TEXT');
    const version = await publish(app, clientId, reviewId);
    const { token } = await createDelivery(app, clientId, reviewId, version, Date.now() - 1000);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/review-deliveries/${token}`,
    });
    const ackResponse = await app.inject({
      method: 'POST',
      url: `/api/review-deliveries/${token}/ack`,
    });
    const unknownGetResponse = await app.inject({
      method: 'GET',
      url: '/api/review-deliveries/noSuchTokenAtAll-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(getResponse.statusCode).toBe(404);
    expect(ackResponse.statusCode).toBe(404);
    expect(getResponse.json()).toEqual(unknownGetResponse.json());
  });
});
