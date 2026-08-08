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
 * RTEN-04 (D-06). `createSessionDelivery` (plan 29-06, `coaching/sessionDeliveries.ts`)
 * already refuses to MINT a delivery for a research/unresolved subject
 * BEFORE any write (RTEN-03's own D-05 contract) — so `session_delivery_created`
 * is `unreachable-by-construction` for those subjects regardless of this
 * plan's own route-level guard: the mint refusal throws first, and this
 * guard's `createEvent` call is never reached. `requireMembership` (plan
 * 29-04) additionally fails closed on an unresolvable-kind tenant before
 * the route handler runs at all. This file's revoke handler fires NO event
 * of its own (see the pre-existing "revokes a delivery idempotently" test
 * above) — unlike `coachingReviewDeliveries.ts`, there is no symmetric
 * revoke-emission scenario to prove reachable here. The guard added by
 * this plan stays in place as defensive layering only.
 */
describe('RTEN-04 (D-06): session_delivery_created telemetry suppression', () => {
  it('minting against a research tenant is refused entirely (unreachable-by-construction, plan 29-06 D-05) — zero rows, zero delivery', async () => {
    const { app, database } = buildTestApp({ research: { adminUids: new Set([TEST_UID]) } });
    const clientId = await createClient(app);
    const sessionId = await createSession(app, clientId);
    database.seed(`clientTenants/${clientId}/kind`, 'research');

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'session_delivery_created')).toHaveLength(0);
  });

  it('resolves the subject kind BEFORE the mint mutation runs, for the ordinary (reachable) create case — review finding 29-06 MEDIUM', async () => {
    const { app, database } = buildTestApp();
    const clientId = await createClient(app);
    const sessionId = await createSession(app, clientId);

    const { paths } = recordRefCalls(database);
    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(201);

    const kindReadIndex = paths.indexOf(`clientTenants/${clientId}/kind`);
    const mintWriteIndex = paths.indexOf(`sessionDeliveries/${clientId}/${sessionId}`);
    expect(kindReadIndex).toBeGreaterThanOrEqual(0);
    expect(mintWriteIndex).toBeGreaterThanOrEqual(0);
    expect(kindReadIndex).toBeLessThan(mintWriteIndex);
  });
});
