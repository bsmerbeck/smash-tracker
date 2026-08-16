import { describe, expect, it, vi } from 'vitest';
import type { DemoAccountConfig } from '../config/env.js';
import { authHeader, buildTestApp } from '../test-support/testApp.js';
import { readSubjectKind } from './subjectKind.js';

/**
 * Phase 30.3 (Gate 6 corrective, defects A3 + A4): the ACTOR-scoped demo
 * refusals.
 *
 * Every demo guard shipped before this suite keys on the SUBJECT being acted
 * upon — the client tenant, the share owner, the delivery's workspace. None
 * of them could see WHO was acting. That left a real hole, reproduced
 * verbatim in Block 1 below: a demo coach (IzAw) is an ordinary,
 * login-bearing account, so they can create an ordinary fictional client,
 * and delivering that ordinary client's review passed the tenant-scoped
 * check unchallenged and minted a publicly resolvable bearer token. Same
 * story for session deliveries, and for the Client Hub JSON export.
 *
 * The fix adds an actor check on `request.uid` at the top of each of those
 * three handlers. The tenant-scoped checks all STAY — they cover a different
 * threat (an ordinary coach acting on a demo workspace) and neither implies
 * the other. Block 4 proves the pair coexists.
 *
 * Every refusal is paired with a positive control on an ordinary, never-
 * allowlisted coach proving the behavior is demo-scoped rather than a
 * blanket break of coach delivery.
 */

/** The demo coach — an ordinary login-bearing account that happens to be allowlisted. */
const DEMO_COACH_UID = 'demo-izaw-uid-1';
const DEMO_COACH_TOKEN = 'demo-izaw-token';

/** The ordinary coach — never allowlisted anywhere. The positive control for every refusal. */
const ORDINARY_COACH_UID = 'ordinary-coach-uid';
const ORDINARY_COACH_TOKEN = 'ordinary-coach-token';

const DEMO_CONFIG: DemoAccountConfig = { demoUids: new Set([DEMO_COACH_UID]) };

/** Fire-and-forget `void createEvent(...)` needs a macrotask tick before a zero-row assertion is meaningful. */
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

function buildActorApp(overrides: { demo?: DemoAccountConfig | null } = {}) {
  const built = buildTestApp({
    webBaseUrl: 'https://grandfinals.gg',
    demo: 'demo' in overrides ? overrides.demo : DEMO_CONFIG,
  });
  built.auth.registerToken(DEMO_COACH_TOKEN, { uid: DEMO_COACH_UID, email: 'izaw@demo.test' });
  built.auth.registerToken(ORDINARY_COACH_TOKEN, {
    uid: ORDINARY_COACH_UID,
    email: 'coach@test.com',
  });
  return built;
}

type TestApp = ReturnType<typeof buildTestApp>['app'];

async function createClient(app: TestApp, token: string, label = 'Fictional Client') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(token),
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  return response.json().clientId as string;
}

async function createAndPublishReview(app: TestApp, token: string, clientId: string) {
  const createResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews`,
    headers: authHeader(token),
  });
  const { reviewId } = createResponse.json();
  const publishResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
    headers: authHeader(token),
  });
  return { reviewId: reviewId as string, version: publishResponse.json().version as number };
}

async function createSession(app: TestApp, token: string, clientId: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/sessions`,
    headers: authHeader(token),
    payload: { date: 1755302400000, summary: 'Neutral game drills.' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().sessionId as string;
}

/** Every ledger/token tree a refused mint must leave untouched. */
const MINT_TREES = [
  'shareTokens',
  'reviewDeliveries',
  'sessionDeliveries',
  'eventLedger',
  'eventDedup',
  'outboxPending',
] as const;

function treeSnapshot(dump: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(MINT_TREES.map((tree) => [tree, dump[tree] ?? null])));
}

function eventNames(dump: Record<string, unknown>): string[] {
  const ledger = (dump.eventLedger ?? {}) as Record<string, Record<string, { eventName: string }>>;
  return Object.values(ledger).flatMap((day) => Object.values(day).map((row) => row.eventName));
}

// ---------------------------------------------------------------------------
// Anti-vacuous guard: the tenant a demo coach creates really is ORDINARY, so
// every refusal below is proven to come from the ACTOR check and not from a
// tenant-scoped or research-kind gate that happened to fire first.
// ---------------------------------------------------------------------------

describe('demoActorGuards: anti-vacuous guard', () => {
  it("a demo coach's own client tenant resolves 'ordinary' — the tenant-scoped guards do NOT cover it", async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);

    expect(await readSubjectKind(database as never, clientId)).toBe('ordinary');
    // …and the tenant id is not itself the demo uid, which is the only thing
    // the pre-existing tenant-scoped demo check looks at.
    expect(clientId).not.toBe(DEMO_COACH_UID);
  });
});

// ---------------------------------------------------------------------------
// Block 1 (defect A3): review-delivery creation — the exact hole.
// ---------------------------------------------------------------------------

describe('demoActorGuards: review delivery refuses a DEMO ACTOR on an ORDINARY client tenant', () => {
  it('refuses with no token, no write, and no event', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);
    const { reviewId, version } = await createAndPublishReview(app, DEMO_COACH_TOKEN, clientId);
    await flush();
    const before = treeSnapshot(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(DEMO_COACH_TOKEN),
      payload: { version },
    });
    await flush();

    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('token');
    expect(treeSnapshot(database.dump())).toBe(before);
    expect(eventNames(database.dump())).not.toContain('review_delivery_created');
  });

  it('ORDERING: refuses before reading the review, the tenant kind, or any delivery record', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);
    const { reviewId, version } = await createAndPublishReview(app, DEMO_COACH_TOKEN, clientId);
    await flush();

    // Spy installed AFTER setup so it observes only the refused request.
    const refSpy = vi.spyOn(database, 'ref');
    await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(DEMO_COACH_TOKEN),
      payload: { version },
    });
    await flush();

    const touched = refSpy.mock.calls.map(([path]) => path ?? '(root)');
    refSpy.mockRestore();

    // The `requireMembership` preHandler's two reads are the ONLY thing that
    // runs. They are the route's pre-existing authorization gate — they fire
    // for every method on this plugin, refusal or not, and they run before
    // any handler. The HANDLER itself performs zero reads.
    expect(touched).toEqual([
      `clientMembers/${clientId}/${DEMO_COACH_UID}`,
      `clientTenants/${clientId}/kind`,
    ]);
    // Named explicitly so a future reordering that reintroduces any of these
    // handler-side reads before the refusal fails loudly rather than silently.
    for (const prefix of ['reviewVersions/', 'reviewDeliveries/', 'shareTokens']) {
      expect(touched.some((path) => path.startsWith(prefix))).toBe(false);
    }
  });

  it('ORDERING contrast: the same request by an ORDINARY coach reads and writes strictly more', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, ORDINARY_COACH_TOKEN);
    const { reviewId, version } = await createAndPublishReview(app, ORDINARY_COACH_TOKEN, clientId);
    await flush();

    const refSpy = vi.spyOn(database, 'ref');
    await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(ORDINARY_COACH_TOKEN),
      payload: { version },
    });
    await flush();

    const touched = refSpy.mock.calls.map(([path]) => path ?? '(root)');
    refSpy.mockRestore();

    // Proves the two-path result above is a genuine short-circuit, not an
    // artifact of the spy missing the work this route normally does.
    expect(touched.length).toBeGreaterThan(2);
    expect(touched.some((path) => path.startsWith('reviewVersions/'))).toBe(true);
    expect(touched.some((path) => path.startsWith('reviewDeliveries/'))).toBe(true);
  });

  it('positive control: an ORDINARY coach on an ordinary client still mints a delivery', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, ORDINARY_COACH_TOKEN);
    const { reviewId, version } = await createAndPublishReview(app, ORDINARY_COACH_TOKEN, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(ORDINARY_COACH_TOKEN),
      payload: { version },
    });
    await flush();

    expect(response.statusCode).toBe(201);
    expect(response.json().token).toEqual(expect.any(String));
    expect(eventNames(database.dump())).toContain('review_delivery_created');
  });

  it('null-config control: the SAME demo uid mints normally when no allowlist is configured', async () => {
    const { app } = buildActorApp({ demo: null });
    const clientId = await createClient(app, DEMO_COACH_TOKEN);
    const { reviewId, version } = await createAndPublishReview(app, DEMO_COACH_TOKEN, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(DEMO_COACH_TOKEN),
      payload: { version },
    });

    expect(response.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Block 2 (defect A3): session-delivery creation — the same hole.
// ---------------------------------------------------------------------------

describe('demoActorGuards: session delivery refuses a DEMO ACTOR on an ORDINARY client tenant', () => {
  it('refuses with no token, no write, and no event', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);
    const sessionId = await createSession(app, DEMO_COACH_TOKEN, clientId);
    await flush();
    const before = treeSnapshot(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(DEMO_COACH_TOKEN),
    });
    await flush();

    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('token');
    expect(treeSnapshot(database.dump())).toBe(before);
    expect(eventNames(database.dump())).not.toContain('session_delivery_created');
  });

  it('ORDERING: refuses before reading the session, the tenant kind, or any delivery record', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);
    const sessionId = await createSession(app, DEMO_COACH_TOKEN, clientId);
    await flush();

    const refSpy = vi.spyOn(database, 'ref');
    await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(DEMO_COACH_TOKEN),
    });
    await flush();

    const touched = refSpy.mock.calls.map(([path]) => path ?? '(root)');
    refSpy.mockRestore();

    // Only the `requireMembership` preHandler's pre-existing authorization
    // reads; the handler itself performs none.
    expect(touched).toEqual([
      `clientMembers/${clientId}/${DEMO_COACH_UID}`,
      `clientTenants/${clientId}/kind`,
    ]);
    for (const prefix of ['trainingSessions/', 'sessionDeliveries/', 'shareTokens']) {
      expect(touched.some((path) => path.startsWith(prefix))).toBe(false);
    }
  });

  it('ORDERING contrast: the same request by an ORDINARY coach reads and writes strictly more', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, ORDINARY_COACH_TOKEN);
    const sessionId = await createSession(app, ORDINARY_COACH_TOKEN, clientId);
    await flush();

    const refSpy = vi.spyOn(database, 'ref');
    await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(ORDINARY_COACH_TOKEN),
    });
    await flush();

    const touched = refSpy.mock.calls.map(([path]) => path ?? '(root)');
    refSpy.mockRestore();

    expect(touched.length).toBeGreaterThan(2);
    expect(touched.some((path) => path.startsWith('trainingSessions/'))).toBe(true);
    expect(touched.some((path) => path.startsWith('sessionDeliveries/'))).toBe(true);
  });

  it('positive control: an ORDINARY coach on an ordinary client still mints a delivery', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, ORDINARY_COACH_TOKEN);
    const sessionId = await createSession(app, ORDINARY_COACH_TOKEN, clientId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
      headers: authHeader(ORDINARY_COACH_TOKEN),
    });
    await flush();

    expect(response.statusCode).toBe(201);
    expect(response.json().token).toEqual(expect.any(String));
    expect(eventNames(database.dump())).toContain('session_delivery_created');
  });
});

// ---------------------------------------------------------------------------
// Block 3 (defect A4): Client Hub JSON export.
// ---------------------------------------------------------------------------

describe('demoActorGuards: Client Hub export refuses a DEMO ACTOR on an ORDINARY client tenant', () => {
  it('refuses with 403 and returns no workspace payload', async () => {
    const { app } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/export`,
      headers: authHeader(DEMO_COACH_TOKEN),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).not.toHaveProperty('matches');
    expect(body).not.toHaveProperty('opponents');
    expect(body).not.toHaveProperty('fighterSelection');
  });

  it('ORDERING: refuses before reading any of the workspace trees', async () => {
    const { app, database } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);

    const refSpy = vi.spyOn(database, 'ref');
    await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/export`,
      headers: authHeader(DEMO_COACH_TOKEN),
    });
    const touched = refSpy.mock.calls.map(([path]) => path ?? '(root)');
    refSpy.mockRestore();

    // This route has no membership preHandler of its own — `exportClient`
    // does its own access resolution — so a refused export reads NOTHING.
    expect(touched).toEqual([]);
  });

  it('positive control: an ORDINARY coach still exports the same client shape', async () => {
    const { app } = buildActorApp();
    const clientId = await createClient(app, ORDINARY_COACH_TOKEN);

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/export`,
      headers: authHeader(ORDINARY_COACH_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ clientId, matches: [] });
  });

  it('null-config control: the SAME demo uid exports normally when no allowlist is configured', async () => {
    const { app } = buildActorApp({ demo: null });
    const clientId = await createClient(app, DEMO_COACH_TOKEN);

    const response = await app.inject({
      method: 'GET',
      url: `/api/coaching/clients/${clientId}/export`,
      headers: authHeader(DEMO_COACH_TOKEN),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Block 4: the pre-existing TENANT-scoped refusals still hold. The actor
// check is ADDITIVE — it must not have replaced the older guard, which
// covers the opposite topology (an ordinary coach acting on a demo subject).
// ---------------------------------------------------------------------------

describe('demoActorGuards: the tenant-scoped refusals coexist with the new actor-scoped ones', () => {
  it('createReviewDelivery still refuses when the TENANT is a demo subject, actor aside', async () => {
    const { createReviewDelivery } = await import('../coaching/reviewDeliveries.js');
    const { FakeDatabase } = await import('../test-support/fakeDatabase.js');
    const database = new FakeDatabase();

    await expect(
      createReviewDelivery(
        database as never,
        DEMO_COACH_UID,
        'review-1',
        1,
        'https://grandfinals.gg',
        {},
        DEMO_CONFIG,
      ),
    ).rejects.toThrow('Review review-1 has no published version 1');
    expect(database.dump()).toEqual({});
  });

  it('createSessionDelivery still refuses when the TENANT is a demo subject, actor aside', async () => {
    const { createSessionDelivery } = await import('../coaching/sessionDeliveries.js');
    const { FakeDatabase } = await import('../test-support/fakeDatabase.js');
    const database = new FakeDatabase();

    await expect(
      createSessionDelivery(
        database as never,
        DEMO_COACH_UID,
        'session-1',
        'https://grandfinals.gg',
        {},
        DEMO_CONFIG,
      ),
    ).rejects.toThrow('Training session session-1 not found');
    expect(database.dump()).toEqual({});
  });

  it('the actor refusal is byte-identical to the tenant refusal (no-oracle: neither names which guard fired)', async () => {
    const { app } = buildActorApp();
    const clientId = await createClient(app, DEMO_COACH_TOKEN);
    const { reviewId, version } = await createAndPublishReview(app, DEMO_COACH_TOKEN, clientId);

    const actorRefusal = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
      headers: authHeader(DEMO_COACH_TOKEN),
      payload: { version },
    });

    // The same route, same shape, refused by the pre-existing
    // never-published branch — an ORDINARY coach asking for a version that
    // does not exist.
    const ordinaryClientId = await createClient(app, ORDINARY_COACH_TOKEN);
    const ordinary = await createAndPublishReview(app, ORDINARY_COACH_TOKEN, ordinaryClientId);
    const unpublishedRefusal = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${ordinaryClientId}/reviews/${ordinary.reviewId}/deliveries`,
      headers: authHeader(ORDINARY_COACH_TOKEN),
      payload: { version: ordinary.version + 99 },
    });

    expect(actorRefusal.statusCode).toBe(unpublishedRefusal.statusCode);
    expect(actorRefusal.json().error).toBe(unpublishedRefusal.json().error);
  });
});
