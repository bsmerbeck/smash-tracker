import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashClaimCode, normalizeClaimCode } from './crypto.js';
import { authHeader, buildTestApp, registerUser } from '../test-support/testApp.js';

/**
 * Phase 23 Plan 05 (Claim Credential & Atomic Ownership Transition, CRED-02,
 * success criterion 1): the runtime proof behind "the raw claim code must
 * never appear in URLs, logs, analytics, or audit payloads — grep-verifiable
 * across the write path." A runtime capture-and-assert test was chosen over
 * static source grepping because static analysis of this property is
 * heuristic — it produces both false positives (a string that merely LOOKS
 * like a claim code) and false negatives (a code concatenated, templated, or
 * passed through an unindexed helper would slip past a naive grep). Driving
 * a real HTTP issuance and a real HTTP redemption through a capturing
 * logger and inspecting the full RTDB dump proves the property for real,
 * not just for however the source happens to be written today.
 */

const HMAC_SECRET = 'test-claim-secret';
const COACH_TOKEN = 'iso-coach-token';
const COACH_UID = 'iso-coach-uid';
const CLIENT_TOKEN = 'iso-client-token';
const CLIENT_UID = 'iso-client-uid';
const TENANT_ID = 'iso-tenant-1';

/**
 * Fastify's own request-lifecycle logging (`'incoming request'`/`'request
 * completed'`, `apps/api` never calls these directly) hands the RAW
 * `req`/`res` objects to whatever logger is configured — in production this
 * is a real pino instance, and pino is configured (via Fastify's default
 * `logger: true`) with `req`/`res` SERIALIZERS that project those objects
 * down to `{method, url, host}`/`{statusCode}` before anything is ever
 * written out, specifically so a request body (which could hold anything,
 * including a raw claim code) never reaches a log line. A bare passthrough
 * logger — the obvious first thing to reach for here — skips that
 * projection entirely and would flag Fastify's own generic boilerplate
 * logging as a "leak" on every route in this app, not just this one. This
 * mirrors the exact fields Fastify's default serializers keep (see
 * `fastify/lib/logger-pino.js`) so the captured surface matches what a real
 * production logger actually emits.
 */
function projectRequestLifecycleFields(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const projected: Record<string, unknown> = { ...obj };
  if (obj.req && typeof obj.req === 'object') {
    const req = obj.req as Record<string, unknown>;
    projected.req = { method: req.method, url: req.url, host: req.host };
  }
  if (obj.res && typeof obj.res === 'object') {
    const res = obj.res as Record<string, unknown>;
    projected.res = { statusCode: res.statusCode };
  }
  return projected;
}

function createCapturingLogger(): { logger: FastifyBaseLogger; lines: string[] } {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(JSON.stringify(args.map(projectRequestLifecycleFields)));
  };
  const logger = {
    level: 'info',
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    silent: record,
    child: () => logger,
  };
  return { logger: logger as unknown as FastifyBaseLogger, lines };
}

describe('raw claim-code isolation across the write path', () => {
  it('appears exactly once (the issuance response body) and nowhere in logs, RTDB, or the event ledger, on a successful redemption', async () => {
    const { logger, lines } = createCapturingLogger();
    const { app, database, auth } = buildTestApp({
      claimCode: { hmacSecret: HMAC_SECRET },
      logger,
    });
    registerUser(auth, COACH_TOKEN, { uid: COACH_UID, email: 'iso-coach@test.com' });
    registerUser(auth, CLIENT_TOKEN, { uid: CLIENT_UID, email: 'iso-client@test.com' });

    database.seed(`clientTenants/${TENANT_ID}`, { createdAt: 1, archivedAt: null });
    database.seed(`coachClients/${COACH_UID}/${TENANT_ID}`, {
      label: 'Iso Client',
      createdAt: 1,
      archivedAt: null,
    });
    database.seed(`clientMembers/${TENANT_ID}/${COACH_UID}`, { role: 'custodian', joinedAt: 1 });

    const issueResponse = await app.inject({
      method: 'POST',
      url: `/api/coaching/clients/${TENANT_ID}/claim-invitations`,
      headers: authHeader(COACH_TOKEN),
    });
    expect(issueResponse.statusCode).toBe(201);
    const rawCode = issueResponse.json().code as string;
    const normalized = normalizeClaimCode(rawCode);
    const digest = hashClaimCode(HMAC_SECRET, normalized);

    const redeemResponse = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(CLIENT_TOKEN),
      payload: { code: rawCode },
    });
    expect(redeemResponse.statusCode).toBe(200);

    const logLinesContainingRaw = lines.filter((line) => line.includes(rawCode));
    const logLinesContainingNormalized = lines.filter((line) => line.includes(normalized));
    expect(logLinesContainingRaw).toHaveLength(0);
    expect(logLinesContainingNormalized).toHaveLength(0);

    const dumped = JSON.stringify(database.dump());
    expect(dumped).not.toContain(rawCode);
    expect(dumped).not.toContain(normalized);

    const eventLedgerDumped = JSON.stringify(
      (database.dump() as Record<string, unknown>).eventLedger ?? {},
    );
    expect(eventLedgerDumped).not.toContain(rawCode);
    expect(eventLedgerDumped).not.toContain(normalized);
    expect(eventLedgerDumped).not.toContain(digest);

    expect(redeemResponse.body).not.toContain(rawCode);
    expect(redeemResponse.body).not.toContain(normalized);
  });

  it('a failed redemption with a garbage code appears in no log line and nowhere in the database dump', async () => {
    const { logger, lines } = createCapturingLogger();
    const { app, database, auth } = buildTestApp({
      claimCode: { hmacSecret: HMAC_SECRET },
      logger,
    });
    registerUser(auth, CLIENT_TOKEN, { uid: CLIENT_UID, email: 'iso-client@test.com' });

    const garbageCode = 'TOTALLY-FAKE-NEVER-ISSUED-CODE';
    const normalizedGarbage = normalizeClaimCode(garbageCode);

    const response = await app.inject({
      method: 'POST',
      url: '/api/claims/redeem',
      headers: authHeader(CLIENT_TOKEN),
      payload: { code: garbageCode },
    });
    expect(response.statusCode).toBe(400);

    const logLinesContainingGarbage = lines.filter((line) => line.includes(garbageCode));
    expect(logLinesContainingGarbage).toHaveLength(0);

    const dumped = JSON.stringify(database.dump());
    expect(dumped).not.toContain(garbageCode);
    expect(dumped).not.toContain(normalizedGarbage);

    expect(response.body).not.toContain(garbageCode);
    expect(response.body).not.toContain(normalizedGarbage);
  });
});
