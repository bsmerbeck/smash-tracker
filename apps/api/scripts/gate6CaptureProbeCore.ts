import type { Database } from 'firebase-admin/database';
import {
  DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
  withRegistryDeadline,
} from '../src/research/registry/deadline.js';
import { isPathSafeTenantId } from '../src/research/subjectKind.js';
import {
  captureGate6TraceSnapshot,
  createGate6Monitor,
  createGate6RejectedOperationProbe,
  gate6WindowDayShards,
  GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
  GATE6_DEFAULT_MAX_STALL_MS,
  GATE6_WORKSPACE_KEYS,
  type Gate6UidMap,
  type Gate6WorkspaceKey,
} from './gate6AuditCore.js';

/**
 * Owner/Codex hard gate #4 follow-up: THE PROBE-CAPTURE OPERATOR.
 *
 * WHY THIS EXISTS. B5 replaced the Gate-6 audit's false-RED "zero trace"
 * assertion with an operation-scoped one: a REFUSED call must leave every
 * trace surface byte-identical. The verifier then found the gap that made the
 * whole assertion inert in practice — `captureGate6TraceSnapshot` and
 * `createGate6RejectedOperationProbe` were exported but called only from the
 * unit suite. `gate6Audit.ts` CONSUMES probe files; nothing PRODUCED one. So
 * in production `rejected-operation-no-trace` could only ever be SKIPPED, and
 * the runbook's `skippedCount == 0` bar was unsatisfiable. Excellent code with
 * no production execution path. This module is that path.
 *
 * WHAT IT DOES, in order:
 *  1. Proves the supplied credential authenticates AS the demo account being
 *     probed, and that the SERVER agrees it is a demo account.
 *  2. Captures the pre-state trace snapshot.
 *  3. Performs ONE genuinely refused operation against the DEPLOYED API.
 *  4. PROVES the refusal — exact status match — before anything is sealed.
 *  5. Captures the post-state snapshot.
 *  6. Seals and writes the probe.
 *
 * WHY THE REFUSAL PROOF IS THE WHOLE DESIGN. A probe built around an operation
 * that silently SUCCEEDED is the worst possible artifact this system could
 * produce: it would seal a success as a refusal, and the audit would then
 * happily attest "the refused call wrote nothing" about a call that was never
 * refused. Almost as bad is an operation that never REACHED the guard — a 401
 * from a stale token also leaves every surface untouched, so it would pass
 * vacuously while proving nothing about the demo refusal. Both are refused
 * here, loudly, before sealing:
 *  - any 2xx  -> `refused-operation-succeeded`, the loudest failure in the file;
 *  - any status other than the expected one -> `refused-operation-unexpected-status`.
 *
 * READ-ONLY WITH RESPECT TO RTDB. The only database access is
 * `captureGate6TraceSnapshot`, which reads. The refused operation is an
 * outbound HTTPS call to the deployed API — the server decides to write
 * nothing, which is precisely the property being witnessed. The operator's
 * only write of any kind is its own probe file.
 *
 * PURE OF I/O SHELLS. Database, clock, log, filesystem and HTTP are all
 * injected, so the whole operator runs against `FakeDatabase` and a fake
 * transport with zero network — the same shape `deriveTournamentRegistryCore`
 * uses. `gate6CaptureProbe.ts` is the thin CLI that wires the real world in.
 */

// ---------------------------------------------------------------------------
// The refused operation
// ---------------------------------------------------------------------------

/**
 * THE OPERATION THIS OPERATOR DRIVES, and why it is this one.
 *
 * `POST /billing/checkout` was chosen over the other three server-side demo
 * refusals (review delivery, session delivery, workspace export) on three
 * counts:
 *
 *  - ZERO PRECONDITIONS. The coaching refusals all address a `:clientId`, so
 *    driving one means either inventing an id — which makes the resulting 403
 *    less certainly the DEMO guard rather than an ordinary
 *    not-found/not-yours — or creating a real client first, which would be a
 *    WRITE, and this operator must not write to RTDB at all. Checkout needs
 *    nothing but a valid pack id.
 *
 *  - THE GUARD IS THE FIRST STATEMENT IN THE HANDLER. `routes/billing.ts`
 *    documents the ordering as load-bearing: the demo refusal precedes the
 *    pack lookup, the idempotency-key mint, the Stripe Checkout Session
 *    create, and the `checkout_started` emission. So "this refused call wrote
 *    nothing" is exactly the claim the guard makes, and the surfaces the probe
 *    compares — `creditLedger/{uid}`, `credits/{uid}`, and the
 *    ledger/outbox/dedup triple the `checkout_started` event would have
 *    landed in — are exactly the ones it prevents writes to. The pairing is
 *    meaningful rather than incidental.
 *
 *  - IT IS THE MONEY PATH. Of the four refusals, this is the one whose failure
 *    costs real money, so it is the one most worth holding durable evidence
 *    for.
 *
 * `pack5` is a real pack id from the shared `CREDIT_PACKS`, so the body passes
 * `checkoutRequestSchema`. That matters: a body that failed schema validation
 * would 400 at the Fastify boundary and never reach the demo guard, making the
 * probe evidence about the validator instead of the refusal.
 */
export const GATE6_REFUSED_OPERATION = {
  /** Stable id, echoed into the probe's `operation` text. */
  id: 'billing-checkout',
  method: 'POST',
  path: '/billing/checkout',
  /** A REAL pack id — see above. */
  body: { packId: 'pack5' } as const,
  /** Exact match required. Anything else aborts before sealing. */
  expectedStatus: 403,
  description: 'POST /billing/checkout (credit purchase on a demo account)',
} as const;

/** The identity pre-check endpoint. */
export const GATE6_IDENTITY_PATH = '/users/me';

// ---------------------------------------------------------------------------
// Injected transport
// ---------------------------------------------------------------------------

export interface Gate6HttpRequest {
  method: string;
  url: string;
  /** Includes `Authorization`. NEVER logged — see `Gate6CaptureDeps.idToken`. */
  headers: Record<string, string>;
  body?: string;
}

export interface Gate6HttpResponse {
  status: number;
  bodyText: string;
}

export interface Gate6CaptureDeps {
  database: Database;
  /** Database IDENTITY, sealed into the probe. */
  databaseHost: string;
  now: () => number;
  log: (line: string) => void;
  writeFileText: (path: string, content: string) => Promise<void>;
  /**
   * The demo account's Firebase ID token.
   *
   * Supplied by the CLI from an ENVIRONMENT VARIABLE, never a flag (a flag
   * lands in shell history and in every `ps` listing on the box). It is passed
   * to `httpRequest` in the `Authorization` header and is never logged, never
   * written to the probe, and never included in an error message — see
   * `redactAuthorization`.
   */
  idToken: string;
  httpRequest: (
    request: Gate6HttpRequest,
    options: { signal?: AbortSignal },
  ) => Promise<Gate6HttpResponse>;
  /** The lifecycle's shutdown signal. */
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
}

/**
 * Strips the bearer credential from anything about to be logged. Applied to
 * every diagnostic that could conceivably carry a header dump — a transport
 * error from `fetch` most obviously.
 */
export function redactAuthorization(text: string): string {
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}`);
  }
  return value;
}

function positiveInteger(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function parseGate6CaptureArgs(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === undefined || !name.startsWith('--')) {
      throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Flag ${name} expects a value`);
    }
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

/**
 * The API origin+prefix the refused call is issued against.
 *
 * HTTPS is REQUIRED, with an explicit localhost carve-out for a local
 * round-trip. The operator is carrying a live bearer credential for a real
 * account; sending it over plaintext to a non-local host would leak it to
 * anything on the path, and "the runbook says use https" is not an
 * enforcement mechanism.
 */
export function resolveApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--api-base-url is not a valid URL: ${raw}`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `--api-base-url must be https for a non-local host (got ${url.protocol}//${url.hostname}); ` +
        'this operator carries a live bearer credential',
    );
  }
  return raw.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

/** Thrown for every condition that must prevent a probe from being sealed. */
export class Gate6CaptureRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Gate6CaptureRefusal';
  }
}

function readUids(flags: Map<string, string>): Gate6UidMap {
  const uids: Gate6UidMap = {
    hbox: required(flags, '--hbox-uid'),
    mkleo: required(flags, '--mkleo-uid'),
    sparg0: required(flags, '--sparg0-uid'),
    izaw: required(flags, '--izaw-uid'),
  };
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    if (!isPathSafeTenantId(uids[workspace])) {
      throw new Error(`unsafe uid for ${workspace}`);
    }
  }
  if (new Set(Object.values(uids)).size !== GATE6_WORKSPACE_KEYS.length) {
    throw new Error('Every demo account UID must be unique');
  }
  return uids;
}

function requestedWorkspace(flags: Map<string, string>): Gate6WorkspaceKey {
  const account = required(flags, '--account');
  const key = GATE6_WORKSPACE_KEYS.find((candidate) => candidate === account);
  if (!key) {
    throw new Error(`--account must be one of ${GATE6_WORKSPACE_KEYS.join(', ')}`);
  }
  return key;
}

/**
 * Step 1 — the IDENTITY PRE-CHECK.
 *
 * Without it, a 403 proves far less than it appears to. The token might belong
 * to a different account entirely (so the refusal is about someone else), or
 * the server might not classify this uid as a demo account at all (so the 403
 * came from some other rule and the probe would be evidence about the wrong
 * guard). `GET /users/me` answers both in one read: it echoes the
 * authenticated `uid`, and `isDemoAccount` is DERIVED from the very allowlist
 * that drives the refusal, so agreement here means the 403 that follows is the
 * demo guard firing on the intended account.
 */
async function assertDemoIdentity(
  deps: Gate6CaptureDeps,
  apiBaseUrl: string,
  uid: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await deps.httpRequest(
    {
      method: 'GET',
      url: `${apiBaseUrl}${GATE6_IDENTITY_PATH}`,
      headers: { authorization: `Bearer ${deps.idToken}`, accept: 'application/json' },
    },
    { signal },
  );
  if (response.status !== 200) {
    throw new Gate6CaptureRefusal(
      'identity-check-failed',
      `GET ${GATE6_IDENTITY_PATH} returned ${response.status}, not 200. The supplied credential could ` +
        'not be resolved to an account, so no refusal it produces would be attributable. ' +
        '(401 almost always means the ID token has expired — they last one hour.)',
    );
  }
  let identity: { uid?: unknown; isDemoAccount?: unknown };
  try {
    identity = JSON.parse(response.bodyText) as typeof identity;
  } catch {
    throw new Gate6CaptureRefusal(
      'identity-check-failed',
      `GET ${GATE6_IDENTITY_PATH} did not return JSON`,
    );
  }
  if (identity.uid !== uid) {
    throw new Gate6CaptureRefusal(
      'identity-uid-mismatch',
      `the supplied credential authenticates as a different account than the one being probed ` +
        `(expected ${uid}, got ${String(identity.uid)})`,
    );
  }
  if (identity.isDemoAccount !== true) {
    throw new Gate6CaptureRefusal(
      'identity-not-demo',
      `the server does not classify ${uid} as a demo account (isDemoAccount=${String(
        identity.isDemoAccount,
      )}), so a refusal from it would not be the demo guard. Check the deployed ` +
        'demo-account allowlist before capturing.',
    );
  }
}

/**
 * Step 3+4 — perform the operation and PROVE it was refused.
 *
 * The two abort conditions are deliberately distinct findings, because they
 * mean opposite things and demand opposite responses.
 */
async function performAndProveRefusal(
  deps: Gate6CaptureDeps,
  apiBaseUrl: string,
  signal: AbortSignal,
): Promise<{ status: number; refusal: string }> {
  const response = await deps.httpRequest(
    {
      method: GATE6_REFUSED_OPERATION.method,
      url: `${apiBaseUrl}${GATE6_REFUSED_OPERATION.path}`,
      headers: {
        authorization: `Bearer ${deps.idToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(GATE6_REFUSED_OPERATION.body),
    },
    { signal },
  );

  if (response.status >= 200 && response.status < 300) {
    throw new Gate6CaptureRefusal(
      'refused-operation-succeeded',
      `${GATE6_REFUSED_OPERATION.description} SUCCEEDED (${response.status}). The demo guard did NOT ` +
        'fire. NOTHING has been sealed — a probe built around this call would assert "the refused ' +
        'operation wrote nothing" about an operation that was never refused, which is the exact ' +
        'false green this whole assertion exists to prevent. Treat this as a production defect in ' +
        'the demo guard, not as a capture failure.',
    );
  }
  if (response.status !== GATE6_REFUSED_OPERATION.expectedStatus) {
    throw new Gate6CaptureRefusal(
      'refused-operation-unexpected-status',
      `${GATE6_REFUSED_OPERATION.description} returned ${response.status}, not the expected ` +
        `${GATE6_REFUSED_OPERATION.expectedStatus}. The call did not reach the demo guard, so ` +
        '"nothing was written" would be true but vacuous. Nothing has been sealed.',
    );
  }
  return {
    status: response.status,
    refusal: `${response.status} from ${GATE6_REFUSED_OPERATION.method} ${GATE6_REFUSED_OPERATION.path}`,
  };
}

/**
 * Captures ONE sealed rejected-operation probe. Returns the process exit code:
 * `0` only when a probe was sealed and written.
 */
export async function runGate6ProbeCapture(
  argv: string[],
  deps: Gate6CaptureDeps,
): Promise<number> {
  const flags = parseGate6CaptureArgs(argv);
  const uids = readUids(flags);
  const workspace = requestedWorkspace(flags);
  const uid = uids[workspace];
  const apiBaseUrl = resolveApiBaseUrl(required(flags, '--api-base-url'));
  const outPath = required(flags, '--out');
  const requestTimeoutMs = positiveInteger(
    flags,
    '--request-timeout-ms',
    DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
  );
  const maxStallMs = positiveInteger(flags, '--max-stall-ms', GATE6_DEFAULT_MAX_STALL_MS);
  const heartbeatIntervalMs = positiveInteger(
    flags,
    '--heartbeat-ms',
    deps.heartbeatIntervalMs ?? GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS,
  );

  if (!deps.idToken) {
    throw new Error(
      'No demo ID token was supplied. Set the GATE6_DEMO_ID_TOKEN environment variable to a ' +
        'current Firebase ID token for the demo account being probed.',
    );
  }

  deps.log(`Database host: ${deps.databaseHost}`);
  deps.log(`API base URL: ${apiBaseUrl}`);
  deps.log(`Account: ${workspace} (${uid})`);
  deps.log(`Refused operation: ${GATE6_REFUSED_OPERATION.description}`);
  deps.log(
    `Bounds: requestTimeoutMs=${requestTimeoutMs} maxStallMs=${maxStallMs} heartbeatMs=${heartbeatIntervalMs}`,
  );

  const monitor = createGate6Monitor(
    {
      signal: deps.signal,
      maxStallMs,
      heartbeatIntervalMs,
      log: deps.log,
      clock: deps.now,
    },
    'gate6-capture',
  );

  /** Every awaited call is bounded and raced against the stall watchdog. */
  const bounded = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    monitor.onProgress(label);
    return Promise.race([
      withRegistryDeadline(label, operation, {
        requestTimeoutMs,
        signal: monitor.signal,
      }),
      monitor.stallPromise,
    ]);
  };

  try {
    // 1 — identity.
    await bounded('identity-check', () =>
      assertDemoIdentity(deps, apiBaseUrl, uid, monitor.signal),
    );
    deps.log(
      `Identity confirmed: the credential is ${uid} and the server calls it a demo account.`,
    );

    // 2 — pre-state. `startedAtMs` is taken FIRST and reused as the
    // pre-snapshot's `capturedAtMs`, so the audit's bracket invariant
    // (`before.capturedAtMs <= startedAtMs`) holds by construction rather than
    // by luck.
    const startedAtMs = deps.now();
    const before = await bounded('pre-snapshot', () =>
      captureGate6TraceSnapshot(
        deps.database,
        uid,
        { startedAtMs, finishedAtMs: startedAtMs, capturedAtMs: startedAtMs },
        { requestTimeoutMs, signal: monitor.signal, onRead: monitor.onProgress },
      ),
    );
    deps.log(`Pre-state captured: ${before.surfaces.length} surface(s).`);

    // 3 + 4 — the refused operation, proven refused before anything is sealed.
    const outcome = await bounded('refused-operation', () =>
      performAndProveRefusal(deps, apiBaseUrl, monitor.signal),
    );
    const finishedAtMs = deps.now();
    deps.log(`Refusal PROVEN: ${outcome.refusal}`);

    // The audit requires both snapshots to name the shard set their own window
    // implies. A call that straddles UTC midnight would give the pre-snapshot
    // (taken inside one day) a different set from the window
    // (`startedAtMs..finishedAtMs`, spanning two) — so rather than sealing a
    // probe the audit would then reject as window-invalid, refuse here with an
    // instruction a human can act on. A refused HTTP call takes milliseconds;
    // re-running is free.
    const windowShards = gate6WindowDayShards(startedAtMs, finishedAtMs);
    if (windowShards.length !== before.dayShards.length) {
      throw new Gate6CaptureRefusal(
        'window-straddles-utc-midnight',
        `the operation window crossed a UTC day boundary (${before.dayShards.join(',')} -> ` +
          `${windowShards.join(',')}), so the pre-snapshot does not cover every shard the window ` +
          'implies. Nothing has been sealed. Simply re-run the capture.',
      );
    }

    // 5 — post-state, over the SAME window, so the two snapshots are zippable.
    const after = await bounded('post-snapshot', () =>
      captureGate6TraceSnapshot(
        deps.database,
        uid,
        { startedAtMs, finishedAtMs, capturedAtMs: deps.now() },
        { requestTimeoutMs, signal: monitor.signal, onRead: monitor.onProgress },
      ),
    );
    deps.log(`Post-state captured: ${after.surfaces.length} surface(s).`);

    // 6 — seal.
    const probe = createGate6RejectedOperationProbe({
      formatVersion: 1,
      workspace,
      uid,
      databaseHost: deps.databaseHost,
      operation: `${GATE6_REFUSED_OPERATION.description} [${GATE6_REFUSED_OPERATION.id}]`,
      refusal: outcome.refusal,
      startedAtMs,
      finishedAtMs,
      before,
      after,
    });
    await deps.writeFileText(outPath, `${JSON.stringify(probe, null, 2)}\n`);
    deps.log(`[probe] ${workspace}: sealed -> ${outPath}`);

    // A capture that observed a write is still SEALED and still written — the
    // audit is the thing that renders the verdict, and suppressing the artifact
    // would hide the very evidence the gate needs. It is announced here so the
    // operator is not surprised by the audit going red later.
    const changed = before.surfaces.filter((surface) => {
      const match = after.surfaces.find((candidate) => candidate.path === surface.path);
      return match === undefined || match.digest !== surface.digest;
    });
    if (changed.length > 0 || before.surfaces.length !== after.surfaces.length) {
      deps.log(
        `WARNING: the refused operation appears to have CHANGED ${changed.length} surface(s) ` +
          `(${changed.map((surface) => surface.path).join(', ')}). The probe is sealed and written ` +
          'anyway — the audit will fail on it, which is the correct outcome and the reason this ' +
          'evidence must not be suppressed.',
      );
    }
    return 0;
  } finally {
    monitor.dispose();
  }
}
