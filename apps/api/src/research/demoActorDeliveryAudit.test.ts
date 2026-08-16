import { describe, expect, it } from 'vitest';
import type { DemoAccountConfig } from '../config/env.js';
import { authHeader, buildTestApp } from '../test-support/testApp.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { auditDemoActorDeliveries, describeFindings } from './demoActorDeliveryAudit.js';

/**
 * Phase 30.3 (Gate 6 corrective, defect A3): proves the read-only detection
 * helper actually finds a delivery minted through the actor-versus-client
 * hole — and finds nothing when there is nothing to find.
 *
 * The fixture is not hand-seeded. It is produced by driving the REAL routes
 * with the demo allowlist UNCONFIGURED, which is byte-for-byte how the
 * pre-fix code path behaved for an allowlisted coach: the tenant-scoped
 * guard saw an ordinary tenant and waved the mint through. The audit is then
 * run WITH the allowlist configured, exactly as a maintainer would run it
 * against production.
 */

const DEMO_COACH_UID = 'demo-izaw-uid-1';
const DEMO_COACH_TOKEN = 'demo-izaw-token';
const ORDINARY_COACH_UID = 'ordinary-coach-uid';
const ORDINARY_COACH_TOKEN = 'ordinary-coach-token';

const DEMO_CONFIG: DemoAccountConfig = { demoUids: new Set([DEMO_COACH_UID]) };

function flush(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

/** Enforcement DELIBERATELY inactive — this reproduces the pre-fix mint path. */
function buildPreFixApp() {
  const built = buildTestApp({ webBaseUrl: 'https://grandfinals.gg', demo: null });
  built.auth.registerToken(DEMO_COACH_TOKEN, { uid: DEMO_COACH_UID, email: 'izaw@demo.test' });
  built.auth.registerToken(ORDINARY_COACH_TOKEN, {
    uid: ORDINARY_COACH_UID,
    email: 'coach@test.com',
  });
  return built;
}

type TestApp = ReturnType<typeof buildTestApp>['app'];

async function mintReviewDelivery(app: TestApp, token: string) {
  const clientResponse = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(token),
    payload: { label: 'Fictional Client' },
  });
  const clientId = clientResponse.json().clientId as string;

  const reviewResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews`,
    headers: authHeader(token),
  });
  const reviewId = reviewResponse.json().reviewId as string;

  const publishResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/publish`,
    headers: authHeader(token),
  });
  const version = publishResponse.json().version as number;

  const deliveryResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/reviews/${reviewId}/deliveries`,
    headers: authHeader(token),
    payload: { version },
  });
  expect(deliveryResponse.statusCode).toBe(201);
  await flush();

  const delivery = deliveryResponse.json() as { deliveryId: string; token: string };
  return { clientId, reviewId, deliveryId: delivery.deliveryId, token: delivery.token };
}

async function mintSessionDelivery(app: TestApp, token: string) {
  const clientResponse = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(token),
    payload: { label: 'Fictional Session Client' },
  });
  const clientId = clientResponse.json().clientId as string;

  const sessionResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/sessions`,
    headers: authHeader(token),
    payload: { date: 1755302400000, summary: 'Neutral game drills.' },
  });
  const sessionId = sessionResponse.json().sessionId as string;

  const deliveryResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${clientId}/sessions/${sessionId}/deliveries`,
    headers: authHeader(token),
  });
  expect(deliveryResponse.statusCode).toBe(201);
  await flush();

  const delivery = deliveryResponse.json() as { deliveryId: string; token: string };
  return { clientId, sessionId, deliveryId: delivery.deliveryId, token: delivery.token };
}

describe('demoActorDeliveryAudit: detects a review delivery minted by a demo actor', () => {
  it('channel 1 (ledger) names the exact delivery', async () => {
    const { app, database } = buildPreFixApp();
    const minted = await mintReviewDelivery(app, DEMO_COACH_TOKEN);

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings.enforcementConfigured).toBe(true);
    expect(findings.ledgerHits).toHaveLength(1);
    expect(findings.ledgerHits[0]).toMatchObject({
      eventName: 'review_delivery_created',
      actorId: DEMO_COACH_UID,
      causationId: `${minted.reviewId}:${minted.deliveryId}`,
      parentId: minted.reviewId,
      deliveryId: minted.deliveryId,
    });
  });

  it('channel 2 (membership) names the tenant and the still-LIVE delivery path', async () => {
    const { app, database } = buildPreFixApp();
    const minted = await mintReviewDelivery(app, DEMO_COACH_TOKEN);

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings.tenantExposures).toHaveLength(1);
    const exposure = findings.tenantExposures[0]!;
    expect(exposure.tenantId).toBe(minted.clientId);
    expect(exposure.demoMemberUids).toEqual([DEMO_COACH_UID]);
    expect(exposure.deliveries).toEqual([
      {
        kind: 'review',
        path: `reviewDeliveries/${minted.clientId}/${minted.reviewId}/${minted.deliveryId}`,
        parentId: minted.reviewId,
        deliveryId: minted.deliveryId,
        status: 'delivered',
        live: true,
      },
    ]);
  });

  it('a revoked delivery is reported but marked not-live (nothing to act on)', async () => {
    const { app, database } = buildPreFixApp();
    const minted = await mintReviewDelivery(app, DEMO_COACH_TOKEN);
    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${minted.clientId}/reviews/${minted.reviewId}/deliveries/${minted.deliveryId}/revoke`,
      headers: authHeader(DEMO_COACH_TOKEN),
    });
    expect(revokeResponse.statusCode).toBe(204);

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings.tenantExposures[0]!.deliveries[0]).toMatchObject({ live: false });
  });

  it('the audit is READ-ONLY — the tree is byte-identical afterwards', async () => {
    const { app, database } = buildPreFixApp();
    await mintReviewDelivery(app, DEMO_COACH_TOKEN);
    const before = JSON.stringify(database.dump());

    await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(JSON.stringify(database.dump())).toBe(before);
  });
});

describe('demoActorDeliveryAudit: detects a session delivery minted by a demo actor', () => {
  it('finds the session mint on both channels', async () => {
    const { app, database } = buildPreFixApp();
    const minted = await mintSessionDelivery(app, DEMO_COACH_TOKEN);

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings.ledgerHits).toHaveLength(1);
    expect(findings.ledgerHits[0]).toMatchObject({
      eventName: 'session_delivery_created',
      actorId: DEMO_COACH_UID,
      parentId: minted.sessionId,
      deliveryId: minted.deliveryId,
    });
    expect(findings.tenantExposures[0]!.deliveries).toEqual([
      {
        kind: 'session',
        path: `sessionDeliveries/${minted.clientId}/${minted.sessionId}/${minted.deliveryId}`,
        parentId: minted.sessionId,
        deliveryId: minted.deliveryId,
        status: 'delivered',
        live: true,
      },
    ]);
  });
});

describe('demoActorDeliveryAudit: negative controls', () => {
  it('an ORDINARY coach doing exactly the same thing produces no findings', async () => {
    const { app, database } = buildPreFixApp();
    await mintReviewDelivery(app, ORDINARY_COACH_TOKEN);
    await mintSessionDelivery(app, ORDINARY_COACH_TOKEN);

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings.ledgerHits).toEqual([]);
    expect(findings.tenantExposures).toEqual([]);
  });

  it('an empty database produces no findings and does not throw', async () => {
    const database = new FakeDatabase();

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings).toEqual({
      enforcementConfigured: true,
      ledgerHits: [],
      tenantExposures: [],
    });
  });

  it('reports honestly when no allowlist is configured rather than claiming a clean bill of health', async () => {
    const { app, database } = buildPreFixApp();
    await mintReviewDelivery(app, DEMO_COACH_TOKEN);

    const findings = await auditDemoActorDeliveries(database as never, null);

    expect(findings.enforcementConfigured).toBe(false);
    expect(describeFindings(findings)).toContain('No demo allowlist is configured');
  });

  it('tolerates a malformed ledger row instead of hiding every other finding', async () => {
    const { app, database } = buildPreFixApp();
    const minted = await mintReviewDelivery(app, DEMO_COACH_TOKEN);
    database.seed('eventLedger/20260101/junk-row', 'not-an-object');

    const findings = await auditDemoActorDeliveries(database as never, DEMO_CONFIG);

    expect(findings.ledgerHits).toHaveLength(1);
    expect(findings.ledgerHits[0]!.deliveryId).toBe(minted.deliveryId);
  });
});

describe('demoActorDeliveryAudit: the report is descriptive, never destructive', () => {
  it('lists the findings and hands remediation to the maintainer', async () => {
    const { app, database } = buildPreFixApp();
    const minted = await mintReviewDelivery(app, DEMO_COACH_TOKEN);

    const report = describeFindings(await auditDemoActorDeliveries(database as never, DEMO_CONFIG));

    expect(report).toContain('READ-ONLY — nothing was modified');
    expect(report).toContain(`${minted.reviewId}:${minted.deliveryId}`);
    expect(report).toContain(
      `reviewDeliveries/${minted.clientId}/${minted.reviewId}/${minted.deliveryId}`,
    );
    expect(report).toContain('LIVE');
    expect(report).toContain('MAINTAINER decision');
    expect(report).toContain('Do not delete records directly');
  });
});
