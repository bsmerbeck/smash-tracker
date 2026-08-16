/**
 * Owner/Codex hard gate #4 follow-up: the CLI that PRODUCES the sealed
 * rejected-operation probes `gate6Audit.ts` consumes.
 *
 * Without this step the Gate-6 audit's `rejected-operation-no-trace`
 * assertion can only ever report `skipped`, and the runbook's
 * `skippedCount == 0` acceptance bar is unsatisfiable. Run it once per demo
 * account, then pass every probe it writes to the final audit.
 *
 *   GATE6_DEMO_ID_TOKEN='<id token for THIS demo account>' \
 *   pnpm --filter @smash-tracker/api exec tsx scripts/gate6CaptureProbe.ts \
 *     --account hbox \
 *     --hbox-uid <uid> --mkleo-uid <uid> --sparg0-uid <uid> --izaw-uid <uid> \
 *     --api-base-url https://grandfinals.gg/api \
 *     --expected-api-environment production \
 *     --expected-api-revision <the reviewed Cloud Run revision or release SHA> \
 *     --out ./gate6-probe-hbox.json
 *
 * THE TWO EXPECTATION FLAGS ARE MANDATORY. `--expected-api-revision` is the
 * immutable Cloud Run revision of the build the owner reviewed (off Cloud
 * Run, its release SHA); `--expected-api-environment` is the `NODE_ENV` that
 * build must report. Read the revision from the DEPLOYMENT record — asking
 * the API which build it is and then accepting whatever it answers proves
 * nothing. Omitting either is a hard refusal, never a skipped check: the
 * forgotten case is exactly the one that yields a probe captured against
 * something other than the reviewed deployment.
 *
 * THE CREDENTIAL. `GATE6_DEMO_ID_TOKEN` must hold a CURRENT Firebase ID token
 * for the demo account named by `--account` — the same bearer the browser
 * sends on every authed request. It is read from the environment and never
 * from a flag, because a flag lands in shell history and in every `ps`
 * listing on the machine; it is never logged, never written into the probe,
 * and stripped from any transport diagnostic by `redactAuthorization`. ID
 * tokens expire after one hour, so capture and audit in the same sitting —
 * an expired token surfaces as a clear `identity-check-failed`, never as a
 * silently vacuous probe.
 *
 * EXIT CODE IS THE VERDICT: `0` only when a probe was sealed and written.
 * Every refusal-proof failure — most importantly the operation SUCCEEDING —
 * exits `1` having written nothing.
 *
 * THE BINDING STEP RUNS FIRST. Before any snapshot, the operator asks the
 * deployed API — via `GET /api/deployment-identity` — which environment,
 * build, and RTDB it is actually using, and aborts unless all three match the
 * flags above and the database this process is configured to read. Without
 * that, an API backed by a DIFFERENT database (staging, say, with compatible
 * Firebase Auth and demo allowlists) would produce a probe in which the
 * refusal and the snapshots describe two unrelated systems.
 *
 * RTDB is READ ONLY here. The refused operation is an outbound HTTPS call to
 * the deployed API; this process's only write is the probe file.
 */
import { writeFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { getDeploymentConfig, loadEnv } from '../src/config/env.js';
import { initFirebase } from '../src/firebase/admin.js';
import { runWithLifecycle } from './enrichLifecycle.js';
import {
  redactAuthorization,
  runGate6ProbeCapture,
  type Gate6HttpRequest,
  type Gate6HttpResponse,
} from './gate6CaptureProbeCore.js';

/**
 * The real transport. `AbortSignal` is threaded straight through to `fetch`,
 * so the operator's per-request deadline and its SIGINT handling reach an
 * in-flight HTTPS call — a hung request to a deployed endpoint is the same
 * failure class as a hung RTDB read, and gets the same treatment.
 */
async function httpRequest(
  request: Gate6HttpRequest,
  options: { signal?: AbortSignal },
): Promise<Gate6HttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: options.signal,
  });
  // Headers are carried through because the refusal proof needs
  // `content-type` to tell the application's JSON refusal from a CDN/WAF HTML
  // error page. `Headers` lower-cases its keys, which is the casing the
  // operator reads by.
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, bodyText: await response.text() };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const env = loadEnv();
  const firebase = initFirebase(env);
  // The LOCAL database identity — what this process is about to snapshot.
  // Derived through the same `getDeploymentConfig` the API serves its own
  // identity from, so the two sides of the binding comparison are computed by
  // one function rather than by two descriptions of the same rule that can
  // drift apart.
  const local = getDeploymentConfig(env);

  await runWithLifecycle({
    // The wrapper logs whatever `run` throws, and a transport error can echo
    // the request headers — so its log goes through the redactor too, not just
    // the outer catch below.
    log: (line) => console.error(redactAuthorization(line)),
    run: (signal) =>
      runGate6ProbeCapture(process.argv.slice(2), {
        database: firebase.database,
        databaseHost: local.databaseHost,
        databaseProjectId: local.firebaseProjectId,
        databaseEmulatorHost: local.databaseEmulatorHost,
        now: () => Date.now(),
        log: (line) => console.log(line),
        writeFileText: (path, content) => writeFile(path, content, 'utf8'),
        idToken: process.env.GATE6_DEMO_ID_TOKEN ?? '',
        httpRequest,
        signal,
      }),
    cleanup: async () => {
      firebase.database.goOffline();
      await deleteApp(firebase.app);
    },
  });
}

void main().catch((error: unknown) => {
  // Redacted: a transport error can echo the request headers, and those carry
  // the bearer token.
  console.error(
    redactAuthorization(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
  process.exitCode = 1;
  setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
});
