import type { Database } from 'firebase-admin/database';
import type { Auth } from 'firebase-admin/auth';
import { buildApp } from '../app.js';
import { FakeDatabase } from './fakeDatabase.js';
import { FakeAuth, type FakeDecodedToken } from './fakeAuth.js';

export const TEST_UID = 'test-uid-123';
export const TEST_EMAIL = 'test@example.com';
export const TEST_TOKEN = 'valid-test-token';

export function buildTestApp(
  options: Pick<
    Parameters<typeof buildApp>[0],
    | 'startgg'
    | 'startggFetch'
    | 'gspLiveFetch'
    | 'parrygg'
    | 'parryggClients'
    | 'reports'
    | 'reportsClient'
    | 'stripe'
    | 'webBaseUrl'
    | 'stripeClient'
    | 'shareFetch'
    | 'ga4'
    | 'ga4Fetch'
    | 'internalJobs'
    | 'claimCode'
    // Phase 27 (RPT-04): the paid-prep activation gate config, threaded
    // through so gate-on/gate-off test cases can build an app with either
    // state without hand-rolling their own `buildApp(...)` call.
    | 'prepPaid'
    // Phase 29 (Research Tenancy, Isolation & Governance Gate, D-04): the
    // research-admin allowlist config, threaded through so tests can build
    // an app with a configured (or omitted/null) research allowlist.
    | 'research'
    // Phase 30.1 / 30.3: the demo-account allowlist, threaded through so
    // tests can build an app with a configured (or omitted/null) demo
    // allowlist — the money-safety and public-delivery guards are only
    // observable through a built app when this is set.
    | 'demo'
    // Phase 30.3 Gate 5 (30.3-integration follow-up): the YouTube Data API
    // config + overridable fetch for the bounded VOD-candidate discovery
    // route, threaded through so tests can build an app with either state.
    | 'youtube'
    | 'youtubeFetch'
    // Phase 30.3 (Gate 6 capture-evidence hardening, item 3): this API's own
    // deployment identity, threaded through so tests can build an app that
    // does — or pointedly does NOT — know who it is.
    | 'deployment'
    // Phase 23 Plan 05's raw-code isolation test installs a capturing
    // logger to assert the raw claim code is never emitted to logs.
    | 'logger'
  > = {},
) {
  const database = new FakeDatabase();
  const auth = new FakeAuth();
  auth.registerToken(TEST_TOKEN, { uid: TEST_UID, email: TEST_EMAIL });

  const app = buildApp({
    firebase: {
      // The fakes intentionally implement only the subset of the
      // firebase-admin surface RtdbService/auth plugin use.
      app: {} as never,
      auth: auth as unknown as Auth,
      database: database as unknown as Database,
    },
    logger: false,
    ...options,
  });

  return { app, database, auth };
}

export function authHeader(token: string = TEST_TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export function registerUser(auth: FakeAuth, token: string, decoded: FakeDecodedToken): void {
  auth.registerToken(token, decoded);
}
