import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import {
  runGate6Audit,
  type Gate6AssertionId,
  type Gate6AuditReceipt,
  type Gate6RejectedOperationProbe,
  type Gate6UidMap,
} from './gate6AuditCore.js';
import {
  API_RELEASE_SHA_HEADER,
  API_REVISION_HEADER,
  DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
} from '@smash-tracker/shared';
import { GATE6_ORIGIN_BOUND_RESPONSES } from './gate6AuditCore.js';
import {
  GATE6_DEPLOYMENT_IDENTITY_PATH,
  GATE6_IDENTITY_PATH,
  GATE6_REFUSED_OPERATION,
  Gate6CaptureRefusal,
  redactAuthorization,
  resolveApiBaseUrl,
  runGate6ProbeCapture,
  type Gate6CaptureDeps,
  type Gate6HttpRequest,
  type Gate6HttpResponse,
} from './gate6CaptureProbeCore.js';

/**
 * The probe-capture operator's own proof.
 *
 * THE DEFECT THIS SUITE GUARDS. B5's assertion was correct and completely
 * inert: nothing in production ever produced a probe, so
 * `rejected-operation-no-trace` could only ever be SKIPPED. The round-trip
 * test below is therefore the load-bearing one — capture a probe with this
 * operator, feed it to the real audit, and require the assertion to actually
 * be CHECKED and to pass.
 *
 * THE SECOND DEFECT, which is worse and which most of these tests are about: a
 * probe built around an operation that was not actually refused. Sealing a
 * SUCCESS as a refusal would make the audit attest "this refused call wrote
 * nothing" about a call that was never refused. Every non-403 outcome must
 * abort before anything is written.
 *
 * Zero network, zero Firebase: `FakeDatabase` plus an injected transport.
 */

const UIDS: Gate6UidMap = {
  hbox: 'gate6-hbox-uid-000001',
  mkleo: 'gate6-mkleo-uid-00001',
  sparg0: 'gate6-sparg0-uid-0001',
  izaw: 'gate6-izaw-uid-000001',
};
const HOST = 'gate6-capture-test.firebaseio.com';
const API_BASE = 'https://grandfinals.example/api';
const OUT_PATH = '/work/gate6-probe-hbox.json';
/** Stands in for a real Firebase ID token. Asserted ABSENT from every log line and the probe file. */
const FAKE_ID_TOKEN = 'fake.id.token-DO-NOT-LOG-1234567890';

interface Harness {
  fake: FakeDatabase;
  logs: string[];
  files: Map<string, string>;
  requests: Gate6HttpRequest[];
  deps: Gate6CaptureDeps;
}

interface TransportScript {
  /** Response to `GET /deployment-identity`. */
  deployment?: Gate6HttpResponse;
  /** Response to `GET /users/me`. */
  identity?: Gate6HttpResponse;
  /** Response to the refused operation. */
  operation?: Gate6HttpResponse;
  /** Runs when the refused operation is issued — stands in for a server that WROTE something. */
  onOperation?: (fake: FakeDatabase) => void;
  /** Makes every request hang forever. */
  hang?: boolean;
}

/**
 * A JSON response, with the content type AND the per-response origin headers a
 * real authenticated Fastify reply carries (see the `onSend` hook in
 * `apps/api/src/app.ts`). Every response the deployed API returns to an
 * authenticated request states which build served it, which is what makes a
 * mixed-revision capture detectable at all.
 */
function jsonResponse(
  status: number,
  body: unknown,
  origin: { revision?: string | null; releaseSha?: string | null } = {},
): Gate6HttpResponse {
  const revision = origin.revision === undefined ? API_REVISION : origin.revision;
  const releaseSha = origin.releaseSha === undefined ? API_RELEASE_SHA : origin.releaseSha;
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(revision === null ? {} : { [API_REVISION_HEADER]: revision }),
      ...(releaseSha === null ? {} : { [API_RELEASE_SHA_HEADER]: releaseSha }),
    },
    bodyText: JSON.stringify(body),
  };
}

function identityBody(
  uid: string,
  isDemoAccount = true,
  origin: { revision?: string | null; releaseSha?: string | null } = {},
): Gate6HttpResponse {
  return jsonResponse(
    200,
    { uid, email: 'demo@example.test', fighters: [], isDemoAccount },
    origin,
  );
}

/** The deployment identity of an API correctly bound to the operator's own database. */
const API_REVISION = 'smash-tracker-api-00042-xyz';
const API_RELEASE_SHA = 'deadbeefcafe';
const API_ENVIRONMENT = 'production';
const LOCAL_PROJECT_ID = 'smash-tracker-f97b7';

function deploymentBody(
  overrides: Record<string, unknown> = {},
  origin: { revision?: string | null; releaseSha?: string | null } = {},
): Gate6HttpResponse {
  return jsonResponse(
    200,
    {
      identityVersion: 1,
      environment: API_ENVIRONMENT,
      service: 'smash-tracker-api',
      revision: API_REVISION,
      releaseSha: API_RELEASE_SHA,
      firebaseProjectId: LOCAL_PROJECT_ID,
      // The API's OWN answer names the very database the operator snapshots.
      databaseHost: HOST,
      databaseEmulatorHost: null,
      ...overrides,
    },
    origin,
  );
}

/** The demo checkout guard's real refusal, as the deployed API sends it. */
function demoRefusal(
  overrides: Record<string, unknown> = {},
  origin: { revision?: string | null; releaseSha?: string | null } = {},
): Gate6HttpResponse {
  return jsonResponse(
    403,
    {
      error: 'Forbidden',
      message: 'Credit purchases are not available for this account',
      statusCode: 403,
      code: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
      ...overrides,
    },
    origin,
  );
}

function makeHarness(
  script: TransportScript = {},
  overrides: Partial<Gate6CaptureDeps> = {},
): Harness {
  const fake = new FakeDatabase();
  // A non-empty starting state, so "nothing changed" is a claim about a real
  // population rather than about two empty reads.
  fake.seed(`credits/${UIDS.hbox}`, { balance: 0 });
  fake.seed(`reportJobs/${UIDS.hbox}/existing`, { status: 'succeeded' });

  const logs: string[] = [];
  const files = new Map<string, string>();
  const requests: Gate6HttpRequest[] = [];

  const deps: Gate6CaptureDeps = {
    database: fake as unknown as Database,
    databaseHost: HOST,
    databaseProjectId: LOCAL_PROJECT_ID,
    databaseEmulatorHost: null,
    now: () => Date.now(),
    log: (line) => logs.push(line),
    writeFileText: async (path, content) => {
      files.set(path, content);
    },
    idToken: FAKE_ID_TOKEN,
    httpRequest: async (request) => {
      requests.push(request);
      if (script.hang) {
        return new Promise<Gate6HttpResponse>(() => undefined);
      }
      if (request.url.endsWith(GATE6_DEPLOYMENT_IDENTITY_PATH)) {
        return script.deployment ?? deploymentBody();
      }
      if (request.url.endsWith(GATE6_IDENTITY_PATH)) {
        return script.identity ?? identityBody(UIDS.hbox);
      }
      script.onOperation?.(fake);
      return script.operation ?? demoRefusal();
    },
    ...overrides,
  };
  return { fake, logs, files, requests, deps };
}

function baseArgs(extra: string[] = []): string[] {
  return [
    '--account',
    'hbox',
    '--hbox-uid',
    UIDS.hbox,
    '--mkleo-uid',
    UIDS.mkleo,
    '--sparg0-uid',
    UIDS.sparg0,
    '--izaw-uid',
    UIDS.izaw,
    '--api-base-url',
    API_BASE,
    '--expected-api-environment',
    API_ENVIRONMENT,
    '--expected-api-revision',
    API_REVISION,
    '--expected-api-release-sha',
    API_RELEASE_SHA,
    '--out',
    OUT_PATH,
    ...extra,
  ];
}

/** `baseArgs` with one flag (and its value) removed — for the omission tests. */
function withoutFlag(name: string): string[] {
  const args = baseArgs();
  const index = args.indexOf(name);
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function sealedProbeFrom(harness: Harness): Gate6RejectedOperationProbe {
  const content = harness.files.get(OUT_PATH);
  if (content === undefined) {
    throw new Error('no probe was written');
  }
  return JSON.parse(content) as Gate6RejectedOperationProbe;
}

function assertionOf(receipt: Gate6AuditReceipt, id: Gate6AssertionId) {
  const found = receipt.assertions.find((assertion) => assertion.id === id);
  if (!found) {
    throw new Error(`no assertion ${id}`);
  }
  return found;
}

/** Feeds a captured probe to the REAL audit and returns its assertion-10 result. */
async function auditWith(
  harness: Harness,
  probe: unknown,
  overrides: { nowMs?: number; expectedDatabaseHost?: string | null } = {},
) {
  const receipt = await runGate6Audit(harness.fake as unknown as Database, {
    uids: UIDS,
    nowMs: overrides.nowMs ?? Date.now(),
    expectedDatabaseHost:
      overrides.expectedDatabaseHost === undefined ? HOST : overrides.expectedDatabaseHost,
    rejectedOperationProbes: [{ path: OUT_PATH, raw: probe }],
  });
  return { receipt, assertion: assertionOf(receipt, 'rejected-operation-no-trace') };
}

// ---------------------------------------------------------------------------

describe('the refused operation is the right one, pinned in committed source', () => {
  it('drives POST /billing/checkout with a REAL pack id and expects exactly 403', () => {
    expect(GATE6_REFUSED_OPERATION).toMatchObject({
      method: 'POST',
      path: '/billing/checkout',
      expectedStatus: 403,
    });
    // A body that failed `checkoutRequestSchema` would 400 at the Fastify
    // boundary and never reach the demo guard, making the probe evidence about
    // the validator instead of the refusal.
    expect(GATE6_REFUSED_OPERATION.body.packId).toBe('pack5');
  });
});

describe('capture -> consume round trip', () => {
  it('seals a probe the REAL audit then CHECKS and passes — the assertion is no longer inert', async () => {
    const harness = makeHarness();
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);

    const probe = sealedProbeFrom(harness);
    expect(probe).toMatchObject({
      workspace: 'hbox',
      uid: UIDS.hbox,
      databaseHost: HOST,
      refusal: `403 ${DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE} from POST /billing/checkout`,
    });
    expect(probe.operation).toContain('billing-checkout');

    const { assertion } = await auditWith(harness, probe);
    // The whole point: CHECKED, not skipped.
    expect(assertion.status).toBe('passed');
    expect(assertion.skipReason).toBeNull();
    expect(assertion.inspected).toBeGreaterThan(0);
  });

  it('produces snapshots that satisfy the audit’s window and shard invariants by construction', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    const probe = sealedProbeFrom(harness);

    expect(probe.before.capturedAtMs).toBeLessThanOrEqual(probe.startedAtMs);
    expect(probe.startedAtMs).toBeLessThanOrEqual(probe.finishedAtMs);
    expect(probe.finishedAtMs).toBeLessThanOrEqual(probe.after.capturedAtMs);
    expect(probe.before.dayShards).toEqual(probe.after.dayShards);
  });

  it('binds, then checks identity, then refuses — exactly three requests, in order', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(harness.requests).toHaveLength(3);
    expect(harness.requests[0]!.url).toBe(`${API_BASE}${GATE6_DEPLOYMENT_IDENTITY_PATH}`);
    expect(harness.requests[1]!.url).toBe(`${API_BASE}${GATE6_IDENTITY_PATH}`);
    expect(harness.requests[2]!.url).toBe(`${API_BASE}${GATE6_REFUSED_OPERATION.path}`);
    expect(harness.requests[2]!.method).toBe('POST');
  });

  it('is READ-ONLY with respect to RTDB: the tree is byte-identical afterwards', async () => {
    const harness = makeHarness();
    const before = JSON.stringify(harness.fake.dump());
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(JSON.stringify(harness.fake.dump())).toBe(before);
    // The only artifact written is the probe.
    expect([...harness.files.keys()]).toEqual([OUT_PATH]);
  });
});

describe('the refusal must be PROVEN before anything is sealed', () => {
  it('ABORTS, loudly, when the operation SUCCEEDED — the worst possible false green', async () => {
    const harness = makeHarness({ operation: jsonResponse(200, { url: 'https://pay' }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toThrow(
      /SUCCEEDED \(200\)/,
    );
    expect(harness.files.size).toBe(0);
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      name: 'Gate6CaptureRefusal',
      code: 'refused-operation-succeeded',
    });
  });

  it('ABORTS on a 401: the call never reached the guard, so "nothing written" would be vacuous', async () => {
    const harness = makeHarness({ operation: jsonResponse(401, {}) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-unexpected-status',
    });
    expect(harness.files.size).toBe(0);
  });

  it.each([[400], [404], [500]])('ABORTS on an unexpected %i without sealing', async (status) => {
    const harness = makeHarness({ operation: jsonResponse(status, {}) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toBeInstanceOf(
      Gate6CaptureRefusal,
    );
    expect(harness.files.size).toBe(0);
  });

  it('SEALS a probe whose refused operation nevertheless WROTE — and the audit then fails it', async () => {
    // The server returned its 403 but something wrote anyway. Suppressing this
    // artifact would hide exactly the evidence the gate exists to surface, so
    // the probe is still sealed — and must go red downstream.
    const harness = makeHarness({
      onOperation: (fake) => fake.seed(`creditLedger/${UIDS.hbox}/leaked`, { delta: 5 }),
    });
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    expect(harness.logs.join('\n')).toMatch(
      /WARNING: the refused operation appears to have CHANGED/,
    );

    const { receipt, assertion } = await auditWith(harness, sealedProbeFrom(harness));
    expect(assertion.status).toBe('failed');
    expect(assertion.findings.map((finding) => finding.code)).toContain(
      'rejected-operation-trace-written',
    );
    expect(assertion.findings.some((finding) => finding.path === `creditLedger/${UIDS.hbox}`)).toBe(
      true,
    );
    expect(receipt.ok).toBe(false);
  });
});

/**
 * Phase 30.3 capture-evidence item 2 — THE GENERIC-403 HOLE.
 *
 * These cases were first written against the PRE-FIX operator and all three
 * PASSED in their inverted form: a generic JSON 403, a CloudFront HTML 403,
 * and an empty-bodied 403 each sealed a probe. Every one of them leaves the
 * RTDB untouched, so the audit would then have attested "the refused
 * operation wrote nothing" about a call that never reached the application.
 * The hole was real; these are its headstone.
 */
describe('the refusal must be the APPLICATION’s, not merely a 403', () => {
  it('REFUSES a generic JSON 403 carrying no application code', async () => {
    const harness = makeHarness({
      operation: jsonResponse(403, { error: 'Forbidden', message: 'nope', statusCode: 403 }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      name: 'Gate6CaptureRefusal',
      code: 'refused-operation-code-missing',
    });
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES an HTML/CDN 403 that never reached the application at all', async () => {
    const harness = makeHarness({
      operation: {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        bodyText: '<html><head><title>403 Forbidden</title></head><body>cloudfront</body></html>',
      },
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-not-json',
    });
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES a 403 with no content type at all', async () => {
    const harness = makeHarness({ operation: { status: 403, headers: {}, bodyText: '' } });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-not-json',
    });
    expect(harness.files.size).toBe(0);
  });

  it.each([
    ['an empty body', ''],
    ['a truncated body', '{"error":"Forbid'],
    ['a bare string', '"forbidden"'],
    ['an array', '[]'],
  ])('REFUSES a JSON-typed 403 with %s', async (_label, bodyText) => {
    const harness = makeHarness({
      operation: { status: 403, headers: { 'content-type': 'application/json' }, bodyText },
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-body-unparseable',
    });
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES a body that parses but carries a DIFFERENT code — the wrong guard', async () => {
    const harness = makeHarness({ operation: demoRefusal({ code: 'some_other_guard' }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-code-unexpected',
    });
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES an envelope missing its error/message members', async () => {
    const harness = makeHarness({
      operation: jsonResponse(403, {
        statusCode: 403,
        code: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
      }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-body-unparseable',
    });
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES an envelope whose own statusCode disagrees with the HTTP status', async () => {
    const harness = makeHarness({ operation: demoRefusal({ statusCode: 401 }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-body-unparseable',
    });
    expect(harness.files.size).toBe(0);
  });

  it('SEALS the verified envelope, so the audit can re-derive the proof', async () => {
    const harness = makeHarness();
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    expect(sealedProbeFrom(harness).refusalEnvelope).toEqual({
      status: 403,
      contentType: 'application/json; charset=utf-8',
      code: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
      error: 'Forbidden',
      message: 'Credit purchases are not available for this account',
      statusCode: 403,
    });
  });

  it('accepts the content type with or without charset, case-insensitively', async () => {
    for (const contentType of ['application/json', 'APPLICATION/JSON; charset=utf-8']) {
      const harness = makeHarness({
        operation: {
          status: 403,
          headers: {
            'content-type': contentType,
            // The origin headers are orthogonal to the content type and are
            // required on every response, so a real reply still carries them.
            [API_REVISION_HEADER]: API_REVISION,
            [API_RELEASE_SHA_HEADER]: API_RELEASE_SHA,
          },
          bodyText: demoRefusal().bodyText,
        },
      });
      expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    }
  });

  it('REFUSES a content type that merely STARTS like JSON', async () => {
    // `application/jsonp` is a different media type; a prefix match without
    // the word boundary would wave it through.
    const harness = makeHarness({
      operation: {
        status: 403,
        headers: { 'content-type': 'application/jsonp' },
        bodyText: demoRefusal().bodyText,
      },
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-not-json',
    });
  });
});

/**
 * Phase 30.3 capture-evidence item 3 — BINDING THE API TO THE DATABASE.
 *
 * The operator drives a deployed API and snapshots a locally configured RTDB.
 * Before this, nothing tied them together: it sealed a `databaseHost` read
 * from the same local `.env` as the snapshot, so the value agreed with itself.
 */
describe('the API must be bound to the database being snapshotted', () => {
  it('asks the API who it is FIRST — before the identity check and any snapshot', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(harness.requests.map((request) => request.url)).toEqual([
      `${API_BASE}${GATE6_DEPLOYMENT_IDENTITY_PATH}`,
      `${API_BASE}${GATE6_IDENTITY_PATH}`,
      `${API_BASE}${GATE6_REFUSED_OPERATION.path}`,
    ]);
  });

  it.each([
    ['503 — deployed without an identity', 503],
    ['404 — an API predating the endpoint', 404],
    ['401 — an expired credential', 401],
  ])('ABORTS on %s, before any other request', async (_label, status) => {
    const harness = makeHarness({ deployment: jsonResponse(status, { statusCode: status }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-identity-unavailable',
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS on an identity body that does not match the contract', async () => {
    const harness = makeHarness({ deployment: jsonResponse(200, { identityVersion: 1 }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-identity-unavailable',
    });
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS on an HTML identity response rather than reading undefined members', async () => {
    const harness = makeHarness({
      deployment: { status: 200, headers: {}, bodyText: '<html>nope</html>' },
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-identity-unavailable',
    });
  });

  it('ABORTS when the API uses a DIFFERENT database than the one being snapshotted', async () => {
    // THE case this whole mechanism exists for. Everything else about this
    // run is healthy: the credential resolves, the account is a demo account,
    // the guard refuses correctly. The evidence would still be worthless.
    const harness = makeHarness({
      deployment: deploymentBody({ databaseHost: 'staging-rtdb.firebaseio.com' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-database-mismatch',
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS on an emulator mismatch even when the host string matches', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ databaseEmulatorHost: '127.0.0.1:9000' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-database-mismatch',
    });
  });

  it('ABORTS on a Firebase project mismatch when both sides state one', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ firebaseProjectId: 'some-other-project' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-database-mismatch',
    });
  });

  it('marks the project axis UNCHECKED — never agreed — when a side states none', async () => {
    const harness = makeHarness({ deployment: deploymentBody({ firebaseProjectId: null }) });
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    const environment = sealedProbeFrom(harness).environment;
    expect(environment.projectIdChecked).toBe(false);
    expect(environment.apiFirebaseProjectId).toBeNull();
    // The honest record must be visible to a human reading the log, too.
    expect(harness.logs.join('\n')).toMatch(/Firebase project id UNCHECKED/);
  });

  it('ABORTS on an UNEXPECTED environment', async () => {
    const harness = makeHarness({ deployment: deploymentBody({ environment: 'development' }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-environment-unexpected',
    });
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS on the WRONG revision — a probe of an unreviewed build is not evidence', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ revision: 'smash-tracker-api-00099-old' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-revision-unexpected',
    });
    expect(harness.files.size).toBe(0);
  });

  /**
   * THE FALSE GREEN THIS CLOSES (owner/Codex hard-gate re-review, item 2).
   *
   * Cloud Run ALWAYS supplies `K_REVISION`, so the old
   * `observedBuild = revision ?? releaseSha` never consulted the release SHA
   * at all and the `API_RELEASE_SHA` build arg was decorative. An image built
   * from the WRONG SOURCE and deployed as the expected new revision therefore
   * passed the binding: the revision names the deploy SLOT, the SHA names the
   * SOURCE, and only the pair pins the reviewed build.
   */
  it('ABORTS on the right revision but the WRONG release SHA — the deploy slot is not the source', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ releaseSha: 'facefeed00000000' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-release-sha-unexpected',
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.files.size).toBe(0);
  });

  /**
   * THE NULL-RELEASE-SHA DECISION, pinned. A deployment that publishes no
   * release SHA can name the SLOT it runs in but not the SOURCE it was built
   * from — and the slot alone is satisfied by any image deployed into it,
   * including one built from unreviewed code. Since the expectation is
   * mandatory to STATE, it is mandatory to SATISFY: this aborts.
   */
  it('ABORTS when the API publishes no release SHA — the build arg was never baked in', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ releaseSha: null }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-release-sha-absent',
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toThrow(
      /API_RELEASE_SHA build arg/,
    );
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS when the API names no deployment revision — it is not the reviewed Cloud Run deploy', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ revision: null }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-revision-absent',
    });
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS when the API can name NEITHER a revision nor a release SHA', async () => {
    const harness = makeHarness({
      deployment: deploymentBody({ revision: null, releaseSha: null }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-revision-absent',
    });
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES to run at all when --expected-api-release-sha is omitted', async () => {
    // Symmetric with the revision flag: an omitted expectation is a refusal,
    // never a silently skipped axis. Omitting THIS one is what made the
    // release SHA decorative in the first place.
    const harness = makeHarness();
    await expect(
      runGate6ProbeCapture(withoutFlag('--expected-api-release-sha'), harness.deps),
    ).rejects.toMatchObject({ code: 'expected-api-release-sha-missing' });
    expect(harness.requests).toHaveLength(0);
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES to run at all when --expected-api-revision is omitted', async () => {
    // An omitted expectation must be a refusal, never a silently skipped
    // check — the forgotten case is exactly the dangerous one.
    const harness = makeHarness();
    await expect(
      runGate6ProbeCapture(withoutFlag('--expected-api-revision'), harness.deps),
    ).rejects.toMatchObject({ code: 'expected-api-revision-missing' });
    expect(harness.requests).toHaveLength(0);
    expect(harness.files.size).toBe(0);
  });

  it('REFUSES to run at all when --expected-api-environment is omitted', async () => {
    const harness = makeHarness();
    await expect(
      runGate6ProbeCapture(withoutFlag('--expected-api-environment'), harness.deps),
    ).rejects.toMatchObject({ code: 'expected-api-environment-missing' });
    expect(harness.requests).toHaveLength(0);
  });

  it('REFUSES an --expected-api-environment that is not a real NODE_ENV', async () => {
    const harness = makeHarness();
    const args = baseArgs().map((value) => (value === API_ENVIRONMENT ? 'prod' : value));
    await expect(runGate6ProbeCapture(args, harness.deps)).rejects.toMatchObject({
      code: 'expected-api-environment-invalid',
    });
    expect(harness.requests).toHaveLength(0);
  });

  it('SEALS both sides of the binding and its verified result', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(sealedProbeFrom(harness).environment).toEqual({
      apiBaseUrl: API_BASE,
      apiEnvironment: API_ENVIRONMENT,
      apiService: 'smash-tracker-api',
      apiRevision: API_REVISION,
      apiReleaseSha: API_RELEASE_SHA,
      apiFirebaseProjectId: LOCAL_PROJECT_ID,
      apiDatabaseHost: HOST,
      apiDatabaseEmulatorHost: null,
      localDatabaseHost: HOST,
      localFirebaseProjectId: LOCAL_PROJECT_ID,
      localDatabaseEmulatorHost: null,
      expectedApiRevision: API_REVISION,
      expectedApiReleaseSha: API_RELEASE_SHA,
      expectedApiEnvironment: API_ENVIRONMENT,
      // What each of the three responses said about ITSELF, so the audit can
      // re-derive the mixed-revision check rather than trust that it ran.
      responseOrigins: [
        { label: 'deployment-identity', revision: API_REVISION, releaseSha: API_RELEASE_SHA },
        { label: 'users-me', revision: API_REVISION, releaseSha: API_RELEASE_SHA },
        { label: 'billing-checkout', revision: API_REVISION, releaseSha: API_RELEASE_SHA },
      ],
      projectIdChecked: true,
      bound: true,
    });
  });

  it('VALID PRODUCTION TUPLE: the whole bound capture round-trips through the real audit', async () => {
    const harness = makeHarness();
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    const { receipt, assertion } = await auditWith(harness, sealedProbeFrom(harness));
    expect(assertion.status).toBe('passed');
    expect(receipt.rejectedOperationProbes[0]).toMatchObject({
      valid: true,
      refusalCode: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
      apiEnvironment: API_ENVIRONMENT,
      apiRevision: API_REVISION,
      apiReleaseSha: API_RELEASE_SHA,
      environmentBound: true,
      originBoundResponses: 3,
      wroteNothing: true,
    });
  });
});

/**
 * DEPLOYMENT-BINDING HARDENING, ITEM 3 — one build must serve all three calls.
 *
 * The deployment identity, the identity pre-check, and the refused operation
 * are three separate HTTP requests, and only the first was ever revision-bound.
 * Under Cloud Run split traffic — or a deploy landing between two of the calls
 * — the operator would bind its evidence to revision A while the refusal it
 * seals came from revision B, with nothing in the artifact to show it.
 */
describe('no capture may straddle two revisions', () => {
  it('ABORTS when the REFUSAL came from a different revision than the identity — sealing nothing', async () => {
    // THE case. Identity and users/me are the reviewed build; the checkout
    // landed on the other half of a split-traffic rollout. Everything else
    // about this run is healthy: the refusal is a real, correctly-coded 403.
    const harness = makeHarness({
      operation: demoRefusal(
        {},
        { revision: 'smash-tracker-api-00099-old', releaseSha: 'facefeed00000000' },
      ),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-origin-mixed-revision',
    });
    // All three calls were made — the refusal is real — and NOTHING was sealed.
    expect(harness.requests).toHaveLength(3);
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS when the IDENTITY pre-check came from a different revision', async () => {
    const harness = makeHarness({
      identity: identityBody(UIDS.hbox, true, { revision: 'smash-tracker-api-00099-old' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-origin-mixed-revision',
    });
    // Aborted before the refused operation was ever issued.
    expect(harness.requests).toHaveLength(2);
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS on a same-revision response built from a DIFFERENT source', async () => {
    // A rebuild pushed to the same revision name is not a thing on Cloud Run,
    // but a proxy or a second service answering under one name is — and the
    // SHA is what distinguishes them.
    const harness = makeHarness({
      operation: demoRefusal({}, { releaseSha: 'facefeed00000000' }),
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-origin-mixed-revision',
    });
    expect(harness.files.size).toBe(0);
  });

  it.each([
    ['the deployment identity', 'deployment' as const],
    ['the identity pre-check', 'identity' as const],
    ['the refused operation', 'operation' as const],
  ])('ABORTS when %s carries no origin headers at all', async (_label, which) => {
    const stripped = { revision: null, releaseSha: null };
    const harness = makeHarness({
      deployment: which === 'deployment' ? deploymentBody({}, stripped) : undefined,
      identity: which === 'identity' ? identityBody(UIDS.hbox, true, stripped) : undefined,
      operation: which === 'operation' ? demoRefusal({}, stripped) : undefined,
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-origin-headers-missing',
    });
    expect(harness.files.size).toBe(0);
  });

  it('ABORTS when a response states its revision but not its source', async () => {
    const harness = makeHarness({ operation: demoRefusal({}, { releaseSha: null }) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'api-origin-headers-missing',
    });
    expect(harness.files.size).toBe(0);
  });

  it('the sealed origins cover EXACTLY the responses the audit requires', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(
      sealedProbeFrom(harness).environment.responseOrigins.map((origin) => origin.label),
    ).toEqual([...GATE6_ORIGIN_BOUND_RESPONSES]);
  });
});

describe('the identity pre-check', () => {
  it('ABORTS when the credential cannot be resolved, without attempting the operation', async () => {
    const harness = makeHarness({ identity: jsonResponse(401, {}) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-check-failed',
    });
    // Only the binding and identity calls were made — the refused operation
    // was never issued.
    expect(harness.requests).toHaveLength(2);
    expect(harness.files.size).toBe(0);
  });

  it('names token expiry, the overwhelmingly likely cause of a 401', async () => {
    const harness = makeHarness({ identity: jsonResponse(401, {}) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toThrow(
      /ID token has expired/,
    );
  });

  it('ABORTS when the credential authenticates as a DIFFERENT account', async () => {
    const harness = makeHarness({ identity: identityBody(UIDS.mkleo) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-uid-mismatch',
    });
    expect(harness.requests).toHaveLength(2);
  });

  it('ABORTS when the SERVER does not classify the account as a demo account', async () => {
    // Otherwise a 403 from some unrelated rule would be sealed as evidence
    // about the demo guard.
    const harness = makeHarness({ identity: identityBody(UIDS.hbox, false) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-not-demo',
    });
    expect(harness.requests).toHaveLength(2);
  });

  it('ABORTS on a non-JSON identity body rather than reading undefined members', async () => {
    const harness = makeHarness({
      identity: { status: 200, headers: {}, bodyText: '<html>nope</html>' },
    });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-check-failed',
    });
  });
});

describe('the sealed probe is tamper-evident end to end', () => {
  it('is REFUSED by the audit after a post-seal edit', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    const probe = sealedProbeFrom(harness);

    const { assertion } = await auditWith(harness, {
      ...probe,
      refusal: '403 from POST /something-else',
    });
    expect(assertion.status).toBe('failed');
    expect(assertion.findings.map((finding) => finding.code)).toContain(
      'rejected-operation-probe-invalid',
    );
  });

  it('is REFUSED by the audit when presented against a different database', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    const { assertion } = await auditWith(harness, sealedProbeFrom(harness), {
      expectedDatabaseHost: 'somewhere-else.firebaseio.com',
    });
    expect(assertion.findings.map((finding) => finding.code)).toContain(
      'rejected-operation-probe-host-mismatch',
    );
  });

  it('is REFUSED by the audit once it goes stale', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    const { assertion } = await auditWith(harness, sealedProbeFrom(harness), {
      nowMs: Date.now() + 3 * 24 * 60 * 60 * 1000,
    });
    expect(assertion.findings.map((finding) => finding.code)).toContain(
      'rejected-operation-probe-stale',
    );
  });
});

describe('the credential never escapes', () => {
  it('appears in no log line and in no written artifact', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(harness.logs.join('\n')).not.toContain(FAKE_ID_TOKEN);
    for (const content of harness.files.values()) {
      expect(content).not.toContain(FAKE_ID_TOKEN);
    }
    // It IS sent, of course — on both requests, as a bearer.
    for (const request of harness.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_ID_TOKEN}`);
    }
  });

  it('is stripped from anything routed through the redactor', () => {
    const line = `fetch failed {"authorization":"Bearer ${FAKE_ID_TOKEN}"}`;
    expect(redactAuthorization(line)).not.toContain(FAKE_ID_TOKEN);
    expect(redactAuthorization(line)).toContain('Bearer <redacted>');
  });

  it('refuses to run at all without a token', async () => {
    const harness = makeHarness({}, { idToken: '' });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toThrow(
      /GATE6_DEMO_ID_TOKEN/,
    );
    expect(harness.requests).toHaveLength(0);
  });
});

describe('argument surface and transport safety', () => {
  it('refuses a plaintext base URL for a non-local host — the operator carries a live credential', () => {
    expect(() => resolveApiBaseUrl('http://grandfinals.example/api')).toThrow(/must be https/);
    expect(() => resolveApiBaseUrl('not a url')).toThrow(/not a valid URL/);
    // Localhost is carved out so a local round-trip is still possible.
    expect(resolveApiBaseUrl('http://localhost:8080/api/')).toBe('http://localhost:8080/api');
    expect(resolveApiBaseUrl('https://grandfinals.example/api/')).toBe(
      'https://grandfinals.example/api',
    );
  });

  it('requires --account to name one of the four demo workspaces', async () => {
    const harness = makeHarness();
    await expect(
      runGate6ProbeCapture(
        baseArgs().map((value) => (value === 'hbox' ? 'supernova' : value)),
        harness.deps,
      ),
    ).rejects.toThrow(/--account must be one of/);
  });

  it('rejects an unsafe or duplicated uid map', async () => {
    const harness = makeHarness();
    const unsafe = baseArgs().map((value) => (value === UIDS.mkleo ? 'bad/uid' : value));
    await expect(runGate6ProbeCapture(unsafe, harness.deps)).rejects.toThrow(/unsafe uid/);
    const duplicated = baseArgs().map((value) => (value === UIDS.mkleo ? UIDS.hbox : value));
    await expect(runGate6ProbeCapture(duplicated, harness.deps)).rejects.toThrow(/must be unique/);
  });

  it('rejects a non-positive bound', async () => {
    const harness = makeHarness();
    await expect(
      runGate6ProbeCapture(baseArgs(['--request-timeout-ms', '0']), harness.deps),
    ).rejects.toThrow(/--request-timeout-ms must be a positive integer/);
  });

  it('bounds a hung HTTPS call at --request-timeout-ms instead of waiting forever', async () => {
    const harness = makeHarness({ hang: true });
    await expect(
      runGate6ProbeCapture(
        baseArgs(['--request-timeout-ms', '50', '--max-stall-ms', '60000']),
        harness.deps,
      ),
    ).rejects.toThrow(/exceeded its 50ms request timeout/);
    expect(harness.files.size).toBe(0);
  });

  it('aborts a hung run on the no-progress watchdog', async () => {
    const harness = makeHarness({ hang: true });
    await expect(
      runGate6ProbeCapture(
        baseArgs(['--request-timeout-ms', '60000', '--max-stall-ms', '60', '--heartbeat-ms', '20']),
        harness.deps,
      ),
    ).rejects.toThrow(/no progress for/);
    expect(harness.files.size).toBe(0);
  });

  it('stops before issuing any request once the lifecycle signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('terminated by SIGINT'));
    const harness = makeHarness({}, { signal: controller.signal });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toThrow(
      /terminated by SIGINT/,
    );
    expect(harness.requests).toHaveLength(0);
    expect(harness.files.size).toBe(0);
  });
});
