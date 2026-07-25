import { describe, expect, it } from 'vitest';
import { hashClaimCode, normalizeClaimCode } from '../claims/crypto.js';
import { authHeader, buildTestApp, registerUser, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import type { FakeAuth } from '../test-support/fakeAuth.js';

const HMAC_SECRET = 'test-claim-secret';
const CLIENT_TOKEN = 'client-token';
const CLIENT_UID = 'client-uid';
const FOREIGN_CLIENT_TOKEN = 'foreign-client-token';
const FOREIGN_CLIENT_UID = 'foreign-client-uid';

const INVALID_CLAIM_CODE_BODY = {
  error: 'Bad Request',
  message: 'invalid_claim_code',
  statusCode: 400,
};

/** Issues a real claim code through the coach-side HTTP route, so the redemption
 * tests below drive the whole write path rather than reaching into RTDB directly. */
async function setupTenantWithCode(
  app: ReturnType<typeof buildTestApp>['app'],
  auth: FakeAuth,
): Promise<{ tenantId: string; code: string }> {
  registerUser(auth, CLIENT_TOKEN, { uid: CLIENT_UID, email: 'client@test.com' });

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(),
    payload: { label: 'Test Client' },
  });
  const tenantId = createResponse.json().clientId as string;

  const issueResponse = await app.inject({
    method: 'POST',
    url: `/api/coaching/clients/${tenantId}/claim-invitations`,
    headers: authHeader(),
  });
  const code = issueResponse.json().code as string;

  return { tenantId, code };
}

/** Seeds an ineligible `claimInvitations/{digest}` record directly, for failure
 * classes that can't be reached through the normal issuance route (expiry, revocation). */
function seedIneligibleCode(
  database: FakeDatabase,
  overrides: Record<string, unknown>,
  rawCode: string,
): void {
  const digest = hashClaimCode(HMAC_SECRET, normalizeClaimCode(rawCode));
  database.seed(`claimInvitations/${digest}`, {
    tenantId: 'some-tenant',
    issuerUid: TEST_UID,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 1000 * 60 * 60,
    ...overrides,
  });
}

describe('POST /api/claims/redeem', () => {
  it('returns 503 when claim codes are not configured on this server', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(),
      payload: { code: 'ANYTHING' },
    });

    expect(response.statusCode).toBe(503);
  });

  it('returns 200 with { tenantId } for a valid unconsumed code', async () => {
    const { app, auth } = buildTestApp({ claimCode: { hmacSecret: HMAC_SECRET } });
    const { tenantId, code } = await setupTenantWithCode(app, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(CLIENT_TOKEN),
      payload: { code },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantId });
  });

  it('returns 400 with the exact invalid_claim_code body for an expired code', async () => {
    const { app, database, auth } = buildTestApp({ claimCode: { hmacSecret: HMAC_SECRET } });
    registerUser(auth, CLIENT_TOKEN, { uid: CLIENT_UID, email: 'client@test.com' });
    const rawCode = 'EXPIRED-CODE-0001';
    seedIneligibleCode(database, { expiresAt: Date.now() - 1000 }, rawCode);

    const response = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(CLIENT_TOKEN),
      payload: { code: rawCode },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(INVALID_CLAIM_CODE_BODY);
  });

  it('returns a pairwise-identical statusCode and body across expired, revoked, consumed-by-another-account, never-issued, and malformed-input codes', async () => {
    const { app, database, auth } = buildTestApp({ claimCode: { hmacSecret: HMAC_SECRET } });
    registerUser(auth, CLIENT_TOKEN, { uid: CLIENT_UID, email: 'client@test.com' });

    const expiredCode = 'EXPIRED-CASE-0001';
    seedIneligibleCode(database, { expiresAt: Date.now() - 1000 }, expiredCode);

    const revokedCode = 'REVOKED-CASE-0001';
    seedIneligibleCode(database, { revokedAt: Date.now() - 1000 }, revokedCode);

    const consumedCode = 'CONSUMED-CASE-0001';
    seedIneligibleCode(
      database,
      { consumedAt: Date.now() - 1000, consumedByUid: 'someone-else' },
      consumedCode,
    );

    const neverIssuedCode = 'NEVER-ISSUED-CASE-0001';
    const malformedCode = '!!!not-a-real-code!!!';

    const responses = await Promise.all(
      [expiredCode, revokedCode, consumedCode, neverIssuedCode, malformedCode].map((code) =>
        app.inject({
          method: 'POST',
          url: '/api/claims/redeem',
          headers: authHeader(CLIENT_TOKEN),
          payload: { code },
        }),
      ),
    );

    const [first, ...rest] = responses;
    for (const response of rest) {
      expect(response.statusCode).toBe(first!.statusCode);
      expect(response.body).toBe(first!.body);
    }
    expect(first!.statusCode).toBe(400);
    expect(first!.json()).toEqual(INVALID_CLAIM_CODE_BODY);
  });

  it('returns 429 with an identical body once the per-account limit is exceeded, whether the submitted code is valid or garbage', async () => {
    const { app, auth } = buildTestApp({ claimCode: { hmacSecret: HMAC_SECRET } });
    registerUser(auth, FOREIGN_CLIENT_TOKEN, {
      uid: FOREIGN_CLIENT_UID,
      email: 'foreign@test.com',
    });

    // Exhaust the 5/hour per-account cap with garbage codes.
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/claims/redeem',
        headers: authHeader(FOREIGN_CLIENT_TOKEN),
        payload: { code: `GARBAGE-${i}` },
      });
    }

    const garbageOverCap = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(FOREIGN_CLIENT_TOKEN),
      payload: { code: 'ANOTHER-GARBAGE-CODE' },
    });

    expect(garbageOverCap.statusCode).toBe(429);
    expect(garbageOverCap.json()).toEqual({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
      statusCode: 429,
    });
  });

  it('applies at least a 200ms floor to both a failure response and a success response', async () => {
    const { app, auth } = buildTestApp({ claimCode: { hmacSecret: HMAC_SECRET } });
    const { code } = await setupTenantWithCode(app, auth);

    const failureStart = Date.now();
    const failureResponse = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(CLIENT_TOKEN),
      payload: { code: 'NEVER-ISSUED-TIMING-CODE' },
    });
    const failureElapsed = Date.now() - failureStart;

    const successStart = Date.now();
    const successResponse = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(CLIENT_TOKEN),
      payload: { code },
    });
    const successElapsed = Date.now() - successStart;

    expect(failureResponse.statusCode).toBe(400);
    expect(successResponse.statusCode).toBe(200);
    expect(failureElapsed).toBeGreaterThanOrEqual(200);
    expect(successElapsed).toBeGreaterThanOrEqual(200);
  });
});
