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
  /** Response to `GET /users/me`. */
  identity?: Gate6HttpResponse;
  /** Response to the refused operation. */
  operation?: Gate6HttpResponse;
  /** Runs when the refused operation is issued — stands in for a server that WROTE something. */
  onOperation?: (fake: FakeDatabase) => void;
  /** Makes every request hang forever. */
  hang?: boolean;
}

function identityBody(uid: string, isDemoAccount = true): Gate6HttpResponse {
  return {
    status: 200,
    bodyText: JSON.stringify({ uid, email: 'demo@example.test', fighters: [], isDemoAccount }),
  };
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
      if (request.url.endsWith(GATE6_IDENTITY_PATH)) {
        return script.identity ?? identityBody(UIDS.hbox);
      }
      script.onOperation?.(fake);
      return script.operation ?? { status: 403, bodyText: '{"error":"Forbidden"}' };
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
    '--out',
    OUT_PATH,
    ...extra,
  ];
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
      refusal: '403 from POST /billing/checkout',
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

  it('checks identity BEFORE the refused operation, and issues exactly two requests', async () => {
    const harness = makeHarness();
    await runGate6ProbeCapture(baseArgs(), harness.deps);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]!.url).toBe(`${API_BASE}${GATE6_IDENTITY_PATH}`);
    expect(harness.requests[1]!.url).toBe(`${API_BASE}${GATE6_REFUSED_OPERATION.path}`);
    expect(harness.requests[1]!.method).toBe('POST');
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
    const harness = makeHarness({ operation: { status: 200, bodyText: '{"url":"https://pay"}' } });
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
    const harness = makeHarness({ operation: { status: 401, bodyText: '{}' } });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'refused-operation-unexpected-status',
    });
    expect(harness.files.size).toBe(0);
  });

  it.each([[400], [404], [500]])('ABORTS on an unexpected %i without sealing', async (status) => {
    const harness = makeHarness({ operation: { status, bodyText: '{}' } });
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

describe('RED EVIDENCE — the generic-403 hole exists in the CURRENT code', () => {
  it('seals a probe from a generic JSON 403 carrying NO application code', async () => {
    const harness = makeHarness({
      operation: {
        status: 403,
        bodyText: JSON.stringify({ error: 'Forbidden', message: 'nope', statusCode: 403 }),
      },
    });
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    expect(harness.files.size).toBe(1);
  });

  it('seals a probe from an HTML/CDN 403 that never reached the application at all', async () => {
    const harness = makeHarness({
      operation: {
        status: 403,
        bodyText: '<html><head><title>403 Forbidden</title></head><body>cloudfront</body></html>',
      },
    });
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    expect(harness.files.size).toBe(1);
  });

  it('seals a probe from a 403 with an empty body', async () => {
    const harness = makeHarness({ operation: { status: 403, bodyText: '' } });
    expect(await runGate6ProbeCapture(baseArgs(), harness.deps)).toBe(0);
    expect(harness.files.size).toBe(1);
  });
});

describe('the identity pre-check', () => {
  it('ABORTS when the credential cannot be resolved, without attempting the operation', async () => {
    const harness = makeHarness({ identity: { status: 401, bodyText: '{}' } });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-check-failed',
    });
    // Only the identity call was made — the refused operation was never issued.
    expect(harness.requests).toHaveLength(1);
    expect(harness.files.size).toBe(0);
  });

  it('names token expiry, the overwhelmingly likely cause of a 401', async () => {
    const harness = makeHarness({ identity: { status: 401, bodyText: '{}' } });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toThrow(
      /ID token has expired/,
    );
  });

  it('ABORTS when the credential authenticates as a DIFFERENT account', async () => {
    const harness = makeHarness({ identity: identityBody(UIDS.mkleo) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-uid-mismatch',
    });
    expect(harness.requests).toHaveLength(1);
  });

  it('ABORTS when the SERVER does not classify the account as a demo account', async () => {
    // Otherwise a 403 from some unrelated rule would be sealed as evidence
    // about the demo guard.
    const harness = makeHarness({ identity: identityBody(UIDS.hbox, false) });
    await expect(runGate6ProbeCapture(baseArgs(), harness.deps)).rejects.toMatchObject({
      code: 'identity-not-demo',
    });
    expect(harness.requests).toHaveLength(1);
  });

  it('ABORTS on a non-JSON identity body rather than reading undefined members', async () => {
    const harness = makeHarness({ identity: { status: 200, bodyText: '<html>nope</html>' } });
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
