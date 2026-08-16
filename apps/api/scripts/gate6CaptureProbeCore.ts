import type { Database } from 'firebase-admin/database';
import {
  API_RELEASE_SHA_HEADER,
  API_REVISION_HEADER,
  DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
  deploymentIdentitySchema,
  type DeploymentIdentity,
} from '@smash-tracker/shared';
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
  GATE6_ORIGIN_BOUND_RESPONSES,
  GATE6_REFUSED_OPERATION_EXPECTED_STATUS,
  GATE6_REJECTED_OPERATION_PROBE_FORMAT_VERSION,
  GATE6_WORKSPACE_KEYS,
  type Gate6OriginBoundResponse,
  type Gate6ProbeEnvironment,
  type Gate6RefusalEnvelope,
  type Gate6ResponseOrigin,
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
 *  1. BINDS the API to the database: asks the deployed API who it is, and
 *     refuses unless its environment, BOTH build coordinates (deployment
 *     revision AND release SHA), and RTDB match what this operator was told to
 *     require and what it is about to snapshot.
 *  2. Proves the supplied credential authenticates AS the demo account being
 *     probed, and that the SERVER agrees it is a demo account.
 *  3. Captures the pre-state trace snapshot.
 *  4. Performs ONE genuinely refused operation against the DEPLOYED API.
 *  5. PROVES the refusal — status, content type, AND the parsed application
 *     error code — before anything is sealed.
 *  6. Captures the post-state snapshot.
 *  7. Seals and writes the probe.
 *
 * Every one of the three HTTP responses above is additionally required to name
 * the ONE expected build in its own headers, so the capture cannot straddle
 * two revisions.
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
 * AND WHY STATUS ALONE WAS NOT ENOUGH (Phase 30.3 capture-evidence item 2).
 * The original proof stopped at the status code and ignored the body
 * entirely. Every 403 that never reaches the application — a CDN, a reverse
 * proxy, a WAF rule, an unrelated authorization failure — also leaves every
 * RTDB snapshot untouched, so it sealed a probe that was vacuously true. A
 * refusal now has to IDENTIFY itself: JSON content type, a parseable body,
 * and the demo checkout guard's own stable `code`. A human message would not
 * do, since it can be reworded in any release without ceremony.
 *
 * AND WHY THE BUILD BINDING NEEDED BOTH COORDINATES (deployment-binding
 * hardening, item 2). The binding compared ONE build coordinate,
 * `revision ?? releaseSha`. Cloud Run ALWAYS supplies `K_REVISION`, so the
 * release SHA was never consulted and the `API_RELEASE_SHA` build arg was
 * decorative. The revision names the deployment SLOT; the SHA names the SOURCE
 * that went into it — so an image built from the WRONG SOURCE, deployed as the
 * expected new revision, passed cleanly. `--expected-api-revision` and
 * `--expected-api-release-sha` are now two separate mandatory flags and BOTH
 * must match, with a null on either axis aborting rather than being waved
 * through as "this deployment does not publish that one".
 *
 * AND WHY EVERY RESPONSE MUST PROVE ITS OWN ORIGIN (item 3). The capture makes
 * THREE requests, and only the first was revision-bound. Under Cloud Run split
 * traffic — or a deploy landing between calls — the identity could come from
 * revision A while the refusal came from revision B, and the sealed artifact
 * would show nothing wrong. Every response now carries
 * `x-gf-api-revision`/`x-gf-api-release-sha`, every one is checked against the
 * expected pair, and all three are sealed so the audit re-derives the check
 * rather than trusting it happened.
 *
 * AND WHY THE API HAD TO BE BOUND TO THE DATABASE (capture-evidence item 3).
 * This operator drives a DEPLOYED API but snapshots the RTDB named by its OWN
 * local `.env`. Nothing connected the two: it sealed a `databaseHost` read from that same
 * local file, so the value agreed with itself by construction. Point it at an
 * API backed by a different database — one with compatible Firebase Auth and
 * a compatible demo allowlist, which is exactly what a staging deployment is
 * — and every check still passed while the refusal and the snapshots
 * described two different systems. Step 1 closes that: the API states its own
 * environment, build, and database host, and every disagreement aborts before
 * anything is sealed.
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
  /**
   * Exact match required. Anything else aborts before sealing. Imported from
   * the audit rather than restated, so the operator's pre-seal check and the
   * audit's own re-assertion against the literal can never drift.
   */
  expectedStatus: GATE6_REFUSED_OPERATION_EXPECTED_STATUS,
  /**
   * The stable application error code the refusal MUST carry, imported from
   * the shared module the handler itself sends. Not a copy: if the constant
   * ever changes, this operator and that handler change together, and a probe
   * sealed under the old value is refused by the audit's own re-check.
   */
  expectedCode: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
  description: 'POST /billing/checkout (credit purchase on a demo account)',
} as const;

/** The identity pre-check endpoint. */
export const GATE6_IDENTITY_PATH = '/users/me';

/** The deployment-identity endpoint that binds this API to a database. */
export const GATE6_DEPLOYMENT_IDENTITY_PATH = '/deployment-identity';

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
  /**
   * Response headers, lower-cased. REQUIRED rather than optional: the refusal
   * proof needs `content-type` to tell an application refusal from an
   * HTML/CDN error page, and an optional field would let a transport that
   * forgot to supply them pass the check by omission.
   */
  headers: Record<string, string>;
  bodyText: string;
}

export interface Gate6CaptureDeps {
  database: Database;
  /**
   * The LOCALLY observed database identity — the host of this operator's own
   * `FIREBASE_DATABASE_URL`, i.e. the database it is about to snapshot. It is
   * compared against what the deployed API says IT uses; on its own it proves
   * nothing, which was the v1 defect.
   */
  databaseHost: string;
  /**
   * The locally observed Firebase project id, when the environment states
   * one. Best-effort and nullable: a developer machine often has none, so an
   * absent value marks the project axis UNCHECKED in the sealed artifact
   * rather than silently passing. The load-bearing binding is `databaseHost`,
   * which is always present on both sides.
   */
  databaseProjectId: string | null;
  /** The locally configured RTDB emulator host, when set. Part of the database identity. */
  databaseEmulatorHost: string | null;
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
 * The environment the operator was told to REQUIRE of the API.
 *
 * All three are mandatory flags with no default. Omitting any one is an
 * explicit refusal, never a silent skip: a "check the revision if you happened
 * to say which one" rule is not a check, it is an invitation to forget, and the
 * forgotten case is exactly the one that produces a probe captured against
 * something other than the reviewed build.
 *
 * WHY REVISION AND RELEASE SHA ARE TWO SEPARATE EXPECTATIONS. They answer
 * different questions and only the pair pins a build:
 *
 *  - `revision` is the DEPLOYMENT SLOT — Cloud Run's immutable `K_REVISION`.
 *    It proves WHICH DEPLOY answered the call.
 *  - `releaseSha` is the SOURCE — the git SHA the image was built from,
 *    injected at build time as `API_RELEASE_SHA`. It proves WHAT WAS IN that
 *    deploy.
 *
 * The previous rule collapsed them into `revision ?? releaseSha`. Cloud Run
 * ALWAYS supplies a revision, so the SHA was never consulted and the build arg
 * was decorative — an image built from the WRONG SOURCE, deployed as the
 * expected new revision, passed the binding cleanly. Requiring both closes it.
 */
interface Gate6ExpectedDeployment {
  revision: string;
  releaseSha: string;
  environment: string;
}

/** The environments an API may legitimately claim (`NODE_ENV`). */
const GATE6_ALLOWED_API_ENVIRONMENTS = ['production', 'development', 'test'] as const;

function readExpectedDeployment(flags: Map<string, string>): Gate6ExpectedDeployment {
  const revision = flags.get('--expected-api-revision');
  if (!revision) {
    throw new Gate6CaptureRefusal(
      'expected-api-revision-missing',
      '--expected-api-revision is REQUIRED. It is the immutable Cloud Run revision (K_REVISION) ' +
        'of the deployment the owner reviewed, and without it this capture cannot tell the ' +
        'reviewed deployment from any other deployment that happens to answer. Read it from the ' +
        'deployment record, not from the API — asking the API which build it is and then ' +
        'accepting whatever it says proves nothing. Nothing has been sealed.',
    );
  }
  const releaseSha = flags.get('--expected-api-release-sha');
  if (!releaseSha) {
    throw new Gate6CaptureRefusal(
      'expected-api-release-sha-missing',
      '--expected-api-release-sha is REQUIRED, SEPARATELY from --expected-api-revision. The ' +
        'revision names the deployment SLOT; this names the SOURCE — the reviewed git SHA the ' +
        'image was built from (API_RELEASE_SHA). Requiring only the revision lets an image built ' +
        'from unreviewed code, deployed as the expected new revision, pass the binding cleanly, ' +
        'which is the exact false green this flag closes. Read it from the deployment record — ' +
        'the SHA you built and pushed — not from the API. Nothing has been sealed.',
    );
  }
  const environment = flags.get('--expected-api-environment');
  if (!environment) {
    throw new Gate6CaptureRefusal(
      'expected-api-environment-missing',
      `--expected-api-environment is REQUIRED (one of ${GATE6_ALLOWED_API_ENVIRONMENTS.join(', ')}). ` +
        'Nothing has been sealed.',
    );
  }
  if (!GATE6_ALLOWED_API_ENVIRONMENTS.some((candidate) => candidate === environment)) {
    throw new Gate6CaptureRefusal(
      'expected-api-environment-invalid',
      `--expected-api-environment must be one of ${GATE6_ALLOWED_API_ENVIRONMENTS.join(', ')} ` +
        `(got ${environment})`,
    );
  }
  return { revision, releaseSha, environment };
}

/**
 * Every response's ORIGIN, checked — the mixed-revision guard.
 *
 * WHY THIS EXISTS. The capture makes THREE separate HTTP requests: the
 * deployment identity, the identity pre-check, and the refused operation. Only
 * the first was ever revision-bound. Under Cloud Run split traffic — or a
 * deploy that lands between two of the calls — they can be answered by
 * DIFFERENT revisions, so the operator would bind its evidence to revision A
 * while the refusal it seals actually came from revision B. Nothing in the
 * sealed artifact would show it, and nothing about the run would look wrong.
 *
 * WHY HEADERS RATHER THAN A REVISION-TAGGED URL. A revision-specific Cloud Run
 * URL would work only as well as the operator's discipline: the tag has to be
 * minted at deploy time and pasted correctly every run, and forgetting it
 * silently restores the hole this closes. It also bypasses the Firebase
 * Hosting rewrite that real traffic goes through, so the probe would become
 * evidence about a path no user takes. Headers are self-enforcing instead:
 * every response states its own origin, and a response that does not is
 * refused.
 *
 * ABSENCE IS A REFUSAL, not an exemption. A deployment that predates the
 * headers, an image built without `API_RELEASE_SHA`, or a response served
 * without them for any other reason cannot demonstrate which build produced
 * it — which is the whole question.
 */
function assertResponseOrigin(
  label: Gate6OriginBoundResponse,
  response: Gate6HttpResponse,
  expected: Gate6ExpectedDeployment,
): Gate6ResponseOrigin {
  const revision = response.headers[API_REVISION_HEADER]?.trim();
  const releaseSha = response.headers[API_RELEASE_SHA_HEADER]?.trim();
  if (!revision || !releaseSha) {
    throw new Gate6CaptureRefusal(
      'api-origin-headers-missing',
      `the "${label}" response carried no ${API_REVISION_HEADER}/${API_RELEASE_SHA_HEADER} ` +
        "headers, so it cannot state which build served it. Every one of this capture's three " +
        'requests must prove its own origin — binding only the identity call would leave the ' +
        'refusal free to come from a different revision under split traffic. Most likely the ' +
        'deployed API predates these headers, or the image was built without API_RELEASE_SHA. ' +
        'Nothing has been sealed.',
    );
  }
  if (revision !== expected.revision || releaseSha !== expected.releaseSha) {
    throw new Gate6CaptureRefusal(
      'api-origin-mixed-revision',
      `the "${label}" response was served by revision "${revision}" (source "${releaseSha}"), not ` +
        `the required "${expected.revision}" (source "${expected.releaseSha}"). This capture is ` +
        'spanning MORE THAN ONE BUILD — Cloud Run split traffic, or a deploy that landed ' +
        'mid-capture. Its identity and its refusal would not be evidence about the same code. ' +
        'Wait for the rollout to settle (or pin traffic to one revision) and re-run. Nothing has ' +
        'been sealed.',
    );
  }
  return { label, revision, releaseSha };
}

/**
 * Step 1 — BIND THE API TO THE DATABASE.
 *
 * This is the check the whole artifact's meaning rests on, and it was missing
 * entirely. The operator drives a DEPLOYED API and snapshots the RTDB from its
 * OWN environment; if those are not the same system, the refusal is real, the
 * snapshots are real, and the conclusion drawn from putting them side by side
 * is worthless. Because the pairing is invisible — both halves look healthy —
 * it can only be caught by making the API state its own identity and
 * comparing.
 *
 * Every disagreement aborts BEFORE the pre-state snapshot, so a mis-pointed
 * run costs one HTTP request and seals nothing.
 */
async function assertDeploymentBinding(
  deps: Gate6CaptureDeps,
  apiBaseUrl: string,
  expected: Gate6ExpectedDeployment,
  signal: AbortSignal,
): Promise<{
  /** Everything but `responseOrigins`, which is only complete once all three calls have been made. */
  environment: Omit<Gate6ProbeEnvironment, 'responseOrigins'>;
  origin: Gate6ResponseOrigin;
}> {
  const response = await deps.httpRequest(
    {
      method: 'GET',
      url: `${apiBaseUrl}${GATE6_DEPLOYMENT_IDENTITY_PATH}`,
      headers: { authorization: `Bearer ${deps.idToken}`, accept: 'application/json' },
    },
    { signal },
  );
  if (response.status !== 200) {
    throw new Gate6CaptureRefusal(
      'api-identity-unavailable',
      `GET ${GATE6_DEPLOYMENT_IDENTITY_PATH} returned ${response.status}, not 200, so the API ` +
        'cannot be tied to the database this operator is about to snapshot. A 503 means the ' +
        'server was deployed without a deployment identity; a 404 means it predates this ' +
        'endpoint and must be redeployed before a probe from it is worth anything. Nothing has ' +
        'been sealed.',
    );
  }
  let identity: DeploymentIdentity;
  try {
    identity = deploymentIdentitySchema.parse(JSON.parse(response.bodyText));
  } catch (error) {
    throw new Gate6CaptureRefusal(
      'api-identity-unavailable',
      `GET ${GATE6_DEPLOYMENT_IDENTITY_PATH} did not return a valid deployment identity ` +
        `(${error instanceof Error ? error.message : String(error)}). Nothing has been sealed.`,
    );
  }

  if (identity.environment !== expected.environment) {
    throw new Gate6CaptureRefusal(
      'api-environment-unexpected',
      `the API reports environment "${identity.environment}" but this capture requires ` +
        `"${expected.environment}". Nothing has been sealed.`,
    );
  }

  // BOTH build coordinates, independently. The revision names the deployment
  // SLOT; the release SHA names the SOURCE deployed into it. The old rule was
  // `revision ?? releaseSha`, and Cloud Run ALWAYS supplies a revision — so the
  // SHA was never consulted and a wrong-source image in the right slot passed.
  if (identity.revision === null) {
    throw new Gate6CaptureRefusal(
      'api-revision-absent',
      'the API named no deployment revision (K_REVISION), so it cannot confirm that it is the ' +
        `reviewed deployment "${expected.revision}". Cloud Run always injects one; an API that ` +
        'states none is not a Cloud Run deployment, and a Gate-6 probe must be captured against ' +
        'the reviewed production deployment. Nothing has been sealed.',
    );
  }
  if (identity.revision !== expected.revision) {
    throw new Gate6CaptureRefusal(
      'api-revision-unexpected',
      `the API is running deployment revision "${identity.revision}", not the reviewed ` +
        `"${expected.revision}". A probe captured against an unreviewed deployment is evidence ` +
        'about code nobody signed off on. Nothing has been sealed.',
    );
  }
  /**
   * A NULL RELEASE SHA ABORTS. Deliberately, and this is the decision the whole
   * item turns on: the image was built without the `API_RELEASE_SHA` build arg,
   * so it can name the slot it was deployed into but not the source it was
   * built from. Tolerating that would restore the exact hole — the revision
   * alone is satisfied by ANY image deployed into the expected slot, including
   * one built from unreviewed code. An expectation that is mandatory to state
   * cannot be optional to satisfy.
   */
  if (identity.releaseSha === null) {
    throw new Gate6CaptureRefusal(
      'api-release-sha-absent',
      'the API named no release SHA (API_RELEASE_SHA), so it can say which deployment slot it is ' +
        'running in but NOT which source it was built from. The revision alone is satisfied by ' +
        'any image deployed into that slot, including one built from unreviewed code — so this ' +
        `capture cannot show the deployment carries the reviewed "${expected.releaseSha}". ` +
        'Rebuild the image with the API_RELEASE_SHA build arg and redeploy that exact image. ' +
        'Nothing has been sealed.',
    );
  }
  if (identity.releaseSha !== expected.releaseSha) {
    throw new Gate6CaptureRefusal(
      'api-release-sha-unexpected',
      `the API is running an image built from "${identity.releaseSha}", not the reviewed ` +
        `"${expected.releaseSha}" — even though its deployment revision "${identity.revision}" ` +
        'is the expected one. That combination is precisely the failure this check exists for: ' +
        'an image built from the WRONG SOURCE, deployed into the RIGHT SLOT. Nothing has been ' +
        'sealed.',
    );
  }

  if (identity.databaseHost !== deps.databaseHost) {
    throw new Gate6CaptureRefusal(
      'api-database-mismatch',
      `the API says it uses ${identity.databaseHost} but this operator is snapshotting ` +
        `${deps.databaseHost}. The refusal and the snapshots would be about two different ` +
        'systems, so "the refused call wrote nothing" would be true and meaningless. This is ' +
        'the exact pairing the binding check exists to catch. Nothing has been sealed.',
    );
  }
  if (identity.databaseEmulatorHost !== deps.databaseEmulatorHost) {
    throw new Gate6CaptureRefusal(
      'api-database-mismatch',
      `emulator mismatch: the API reports ${identity.databaseEmulatorHost ?? 'no emulator'} and ` +
        `this operator ${deps.databaseEmulatorHost ?? 'no emulator'}. An API pointed at an ` +
        'emulator is a different database environment even when the host string matches. ' +
        'Nothing has been sealed.',
    );
  }

  // Project id is best-effort on BOTH sides — a runtime need not publish one.
  // When either side is silent the axis is recorded as UNCHECKED rather than
  // quietly counted as agreement; the host equality above is the binding that
  // carries the weight, and it is never skippable.
  const projectIdChecked = identity.firebaseProjectId !== null && deps.databaseProjectId !== null;
  if (projectIdChecked && identity.firebaseProjectId !== deps.databaseProjectId) {
    throw new Gate6CaptureRefusal(
      'api-database-mismatch',
      `Firebase project mismatch: the API reports ${identity.firebaseProjectId} and this ` +
        `operator ${deps.databaseProjectId}. Nothing has been sealed.`,
    );
  }

  return {
    environment: {
      apiBaseUrl,
      apiEnvironment: identity.environment,
      apiService: identity.service,
      apiRevision: identity.revision,
      apiReleaseSha: identity.releaseSha,
      apiFirebaseProjectId: identity.firebaseProjectId,
      apiDatabaseHost: identity.databaseHost,
      apiDatabaseEmulatorHost: identity.databaseEmulatorHost,
      localDatabaseHost: deps.databaseHost,
      localFirebaseProjectId: deps.databaseProjectId,
      localDatabaseEmulatorHost: deps.databaseEmulatorHost,
      expectedApiRevision: expected.revision,
      expectedApiReleaseSha: expected.releaseSha,
      expectedApiEnvironment: expected.environment,
      projectIdChecked,
      bound: true,
    },
    // Checked LAST for this response, so a body-level disagreement (wrong
    // database, wrong build) is reported in its own terms rather than as a
    // header mismatch.
    origin: assertResponseOrigin('deployment-identity', response, expected),
  };
}

/**
 * Step 2 — the IDENTITY PRE-CHECK.
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
  expected: Gate6ExpectedDeployment,
  signal: AbortSignal,
): Promise<Gate6ResponseOrigin> {
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
  return assertResponseOrigin('users-me', response, expected);
}

/**
 * Step 4+5 — perform the operation and PROVE it was refused BY THE
 * APPLICATION.
 *
 * The abort conditions are deliberately distinct findings, because they mean
 * different things and demand different responses.
 *
 * THE PROOF IS THE BODY, NOT THE STATUS. The original version stopped at
 * `status === 403` and never looked at `bodyText`. Everything on the path
 * between this process and the handler can produce a 403 — a CDN edge rule, a
 * reverse proxy, a WAF, an unrelated authorization failure — and every one of
 * them leaves the RTDB untouched, so the probe's central claim came out
 * vacuously true. Four things must now hold, in order:
 *
 *  1. status is exactly the expected one;
 *  2. the response is `application/json` — an HTML error page is an edge
 *     refusal, and no amount of body-sniffing makes it the application's;
 *  3. the body parses and carries the envelope's required members;
 *  4. `code` is the demo checkout guard's own stable identifier.
 *
 * A body that parses but carries a DIFFERENT code fails (4): it is some other
 * refusal, and evidence about the wrong guard is not evidence.
 */
async function performAndProveRefusal(
  deps: Gate6CaptureDeps,
  apiBaseUrl: string,
  expected: Gate6ExpectedDeployment,
  signal: AbortSignal,
): Promise<{ refusal: string; envelope: Gate6RefusalEnvelope; origin: Gate6ResponseOrigin }> {
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

  const contentType = response.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw new Gate6CaptureRefusal(
      'refused-operation-not-json',
      `${GATE6_REFUSED_OPERATION.description} returned ${response.status} with content type ` +
        `"${contentType || '(absent)'}", not application/json. This is an EDGE refusal — a CDN, ` +
        'reverse proxy, or WAF error page — not the application demo guard. It writes nothing to ' +
        'RTDB either, which is precisely why it would have sealed a vacuously-passing probe. ' +
        'Nothing has been sealed.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch {
    throw new Gate6CaptureRefusal(
      'refused-operation-body-unparseable',
      `${GATE6_REFUSED_OPERATION.description} returned ${response.status} with a body that is not ` +
        'parseable JSON, so the refusal cannot be attributed to the application. Nothing has ' +
        'been sealed.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Gate6CaptureRefusal(
      'refused-operation-body-unparseable',
      `${GATE6_REFUSED_OPERATION.description} returned ${response.status} with a JSON body that is ` +
        'not an error envelope object. Nothing has been sealed.',
    );
  }
  const body = parsed as Record<string, unknown>;

  if (body.code === undefined || body.code === null) {
    throw new Gate6CaptureRefusal(
      'refused-operation-code-missing',
      `${GATE6_REFUSED_OPERATION.description} returned a generic ${response.status} JSON envelope ` +
        `with no application error code. The demo checkout guard sends ` +
        `"${GATE6_REFUSED_OPERATION.expectedCode}"; a 403 without it may have come from anywhere ` +
        'on the path and proves nothing about the guard. Most likely the deployed API predates ' +
        'the code and must be redeployed. Nothing has been sealed.',
    );
  }
  if (body.code !== GATE6_REFUSED_OPERATION.expectedCode) {
    throw new Gate6CaptureRefusal(
      'refused-operation-code-unexpected',
      `${GATE6_REFUSED_OPERATION.description} was refused with application code ` +
        `"${String(body.code)}", not the demo checkout guard's ` +
        `"${GATE6_REFUSED_OPERATION.expectedCode}". Some OTHER rule refused this call, so a probe ` +
        'built on it would be evidence about the wrong guard. Nothing has been sealed.',
    );
  }
  if (typeof body.error !== 'string' || typeof body.message !== 'string') {
    throw new Gate6CaptureRefusal(
      'refused-operation-body-unparseable',
      `${GATE6_REFUSED_OPERATION.description} returned an envelope missing its error/message ` +
        'members. Nothing has been sealed.',
    );
  }
  if (body.statusCode !== response.status) {
    throw new Gate6CaptureRefusal(
      'refused-operation-body-unparseable',
      `${GATE6_REFUSED_OPERATION.description} returned HTTP ${response.status} but an envelope ` +
        `claiming statusCode ${String(body.statusCode)}; something between the guard and this ` +
        'operator re-wrapped the response. Nothing has been sealed.',
    );
  }

  return {
    refusal:
      `${response.status} ${GATE6_REFUSED_OPERATION.expectedCode} from ` +
      `${GATE6_REFUSED_OPERATION.method} ${GATE6_REFUSED_OPERATION.path}`,
    // THE load-bearing origin check. This is the response the whole probe is
    // built around; if it came from a different revision than the identity
    // call, everything else agreeing means nothing. The API emits these headers
    // on error responses too, precisely so a 403 can prove its own origin.
    origin: assertResponseOrigin('billing-checkout', response, expected),
    envelope: {
      status: response.status,
      contentType: contentType.trim(),
      code: GATE6_REFUSED_OPERATION.expectedCode,
      error: body.error,
      message: body.message,
      statusCode: response.status,
    },
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
  const expectedDeployment = readExpectedDeployment(flags);
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

  deps.log(`Database host (local): ${deps.databaseHost}`);
  deps.log(`API base URL: ${apiBaseUrl}`);
  deps.log(
    `Required API deployment: environment=${expectedDeployment.environment} ` +
      `revision=${expectedDeployment.revision} releaseSha=${expectedDeployment.releaseSha}`,
  );
  deps.log(`Account: ${workspace} (${uid})`);
  deps.log(
    `Refused operation: ${GATE6_REFUSED_OPERATION.description}, proven by application code ` +
      `"${GATE6_REFUSED_OPERATION.expectedCode}"`,
  );
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
    // 1 — BIND the API to the database, before anything else. A mis-pointed
    // run costs one request and seals nothing.
    const bound = await bounded('deployment-binding', () =>
      assertDeploymentBinding(deps, apiBaseUrl, expectedDeployment, monitor.signal),
    );
    const environment = bound.environment;
    deps.log(
      `API bound: ${environment.apiService ?? 'unnamed service'} @ revision ` +
        `${environment.apiRevision} built from ${environment.apiReleaseSha} ` +
        `(${environment.apiEnvironment}) uses ${environment.apiDatabaseHost}, which is the ` +
        'database being snapshotted' +
        (environment.projectIdChecked
          ? `; Firebase project ${environment.apiFirebaseProjectId} agrees`
          : '; Firebase project id UNCHECKED (one side did not state one)'),
    );

    // 2 — identity. Its response must also prove it came from the SAME build.
    const identityOrigin = await bounded('identity-check', () =>
      assertDemoIdentity(deps, apiBaseUrl, uid, expectedDeployment, monitor.signal),
    );
    deps.log(
      `Identity confirmed: the credential is ${uid} and the server calls it a demo account.`,
    );

    // 3 — pre-state. `startedAtMs` is taken FIRST and reused as the
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

    // 4 + 5 — the refused operation, proven refused BY THE APPLICATION
    // (status, content type, and the stable error code) before anything is
    // sealed.
    const outcome = await bounded('refused-operation', () =>
      performAndProveRefusal(deps, apiBaseUrl, expectedDeployment, monitor.signal),
    );
    const finishedAtMs = deps.now();
    deps.log(`Refusal PROVEN: ${outcome.refusal}`);

    // ONE BUILD SERVED ALL THREE. Each response was individually checked
    // against the expected revision+SHA as it arrived; this is the COVERAGE
    // half of the same rule — the sealed set must name every request the
    // contract requires, so a future fourth call added without an origin check
    // aborts here rather than quietly narrowing the guarantee.
    const responseOrigins: Gate6ResponseOrigin[] = [bound.origin, identityOrigin, outcome.origin];
    const originLabels = new Set(responseOrigins.map((origin) => origin.label));
    const missingOrigins = GATE6_ORIGIN_BOUND_RESPONSES.filter((label) => !originLabels.has(label));
    if (missingOrigins.length > 0 || originLabels.size !== responseOrigins.length) {
      throw new Gate6CaptureRefusal(
        'api-origin-coverage-incomplete',
        `the capture did not origin-check every required response (missing ` +
          `${missingOrigins.join(', ') || 'none'}; collected ` +
          `${responseOrigins.map((origin) => origin.label).join(', ')}). Nothing has been sealed.`,
      );
    }
    deps.log(
      `Origin PROVEN for all ${responseOrigins.length} responses: revision ` +
        `${expectedDeployment.revision}, source ${expectedDeployment.releaseSha}. No revision ` +
        'split.',
    );

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

    // 6 — post-state, over the SAME window, so the two snapshots are zippable.
    const after = await bounded('post-snapshot', () =>
      captureGate6TraceSnapshot(
        deps.database,
        uid,
        { startedAtMs, finishedAtMs, capturedAtMs: deps.now() },
        { requestTimeoutMs, signal: monitor.signal, onRead: monitor.onProgress },
      ),
    );
    deps.log(`Post-state captured: ${after.surfaces.length} surface(s).`);

    // 7 — seal. `refusalEnvelope` and `environment` are the two proofs a v1
    // probe lacked; the audit re-derives both rather than trusting them, but
    // they must be IN the artifact for that re-derivation to be possible at
    // all.
    const probe = createGate6RejectedOperationProbe({
      formatVersion: GATE6_REJECTED_OPERATION_PROBE_FORMAT_VERSION,
      workspace,
      uid,
      databaseHost: deps.databaseHost,
      operation: `${GATE6_REFUSED_OPERATION.description} [${GATE6_REFUSED_OPERATION.id}]`,
      refusal: outcome.refusal,
      refusalEnvelope: outcome.envelope,
      environment: { ...environment, responseOrigins },
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
