import { describe, expect, it } from 'vitest';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import { authHeader, buildTestApp, TEST_EMAIL, TEST_UID } from '../test-support/testApp.js';

/**
 * Shared by every describe block below that asserts on `eventLedger` D-event
 * rows (`signup_completed`, `onboarding_intent_selected`,
 * `coaching_mode_enabled`) — module-scoped so it is not re-declared per
 * describe block.
 */
function allLedgerRows(database: ReturnType<typeof buildTestApp>['database']): unknown[] {
  const dump = database.dump() as { eventLedger?: Record<string, Record<string, unknown>> };
  const days = dump.eventLedger ?? {};
  return Object.values(days).flatMap((day) => Object.values(day));
}

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PUT /api/users/me', () => {
  it('upserts the user node from the verified token email', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ uid: TEST_UID, email: TEST_EMAIL });
    expect(database.dump()).toMatchObject({
      users: { [TEST_UID]: { email: TEST_EMAIL } },
    });
  });

  it('is idempotent when called twice', async () => {
    const { app } = buildTestApp();

    await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
    const second = await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ uid: TEST_UID, email: TEST_EMAIL });
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'PUT', url: '/api/users/me' });

    expect(response.statusCode).toBe(401);
  });

  // Phase 10 Plan 4 (Canonical Measurement, MEAS-02): `signup_completed` is
  // a server-only D event fired exactly once, on first-ever provisioning —
  // never on a returning user's re-provision. The handler's own `void
  // createEvent(...)` call is fire-and-forget, so tests flush a macrotask
  // tick after `inject()` before asserting on the ledger.
  describe('signup_completed (first-provision D event)', () => {
    it('emits exactly one signup_completed row for a uid whose email did not exist before the call', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
      });
      await flushMacrotask();

      expect(response.statusCode).toBe(200);
      const rows = allLedgerRows(database);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventName: 'signup_completed',
        actorId: TEST_UID,
        causationId: TEST_UID,
        source: 'api',
        actorKind: 'authenticated',
        consentState: 'unknown',
      });
    });

    it('emits no event for a returning user (email already present)', async () => {
      const { app, database } = buildTestApp();

      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
      await flushMacrotask();

      const second = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
      });
      await flushMacrotask();

      expect(second.statusCode).toBe(200);
      expect(allLedgerRows(database)).toHaveLength(1);
    });
  });

  // Phase 7 (Recap Cards & Share-Loop Analytics): referredByShareId is a
  // write-once, first-touch attribution field (FUNNEL-02). The incoming
  // value is the share-page bearer TOKEN (the public snapshot never exposes
  // a shareId), resolved server-side via shareTokens/{token} to the durable
  // shareId before storage (review CR-01).
  describe('referredByShareId (write-once attribution)', () => {
    // Real stamped values are 43-char base64url bearer tokens.
    const REFERRAL_TOKEN = 'a'.repeat(43);
    const OTHER_TOKEN = 'b'.repeat(43);

    function seedShareToken(
      database: ReturnType<typeof buildTestApp>['database'],
      token: string,
      shareId: string,
      extra: Record<string, unknown> = {},
    ) {
      database.seed(`shareTokens/${token}`, {
        shareId,
        ownerUid: 'owner-uid-1',
        permissions: 'view',
        createdAt: 1000,
        ...extra,
      });
    }

    it('resolves a valid token to its shareId and stores the shareId (never the token)', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-1');

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-1' } },
      });
    });

    it('never overwrites an existing attribution (write-once), even with a new valid token', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-old');
      seedShareToken(database, OTHER_TOKEN, 'share-new');

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: OTHER_TOKEN },
      });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-old' } },
      });
    });

    it('silently drops an unknown token (200, no field written) — provisioning never fails on a bad referral', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: OTHER_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect(dump.users[TEST_UID]!.email).toBe(TEST_EMAIL);
      expect('referredByShareId' in dump.users[TEST_UID]!).toBe(false);
    });

    it('silently drops a malformed token with RTDB-illegal path characters (200, never a 500)', async () => {
      const { app, database } = buildTestApp();

      // FakeDatabase throws on `.` in a ref path exactly like firebase-admin
      // does — this passing with 200 proves the SHARE_TOKEN_SHAPE guard runs
      // BEFORE any shareTokens/{token} read.
      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'crafted.path#token$probe' },
      });

      expect(response.statusCode).toBe(200);
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect('referredByShareId' in dump.users[TEST_UID]!).toBe(false);
    });

    it('rejects an oversized referredByShareId with 400 before any lookup (review WR-02)', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: 'x'.repeat(129) },
      });

      expect(response.statusCode).toBe(400);
      const dump = database.dump() as { users?: Record<string, unknown> };
      expect(dump.users?.[TEST_UID]).toBeUndefined();
    });

    it('still attributes through a REVOKED share token (revocation kills viewing, not attribution)', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-revoked', { revokedAt: 2000 });

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-revoked' } },
      });
    });

    // Review WR-05: provisioning must scope its writes to the fields it
    // owns — never full-overwrite the users/{uid} node — and a later
    // unstamped call must never erase an earlier call's attribution.
    it('does not erase an existing attribution on a later unstamped provisioning call', async () => {
      const { app, database } = buildTestApp();
      seedShareToken(database, REFERRAL_TOKEN, 'share-1');

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { referredByShareId: REFERRAL_TOKEN },
      });

      // Bodyless re-provision (token refresh, second tab) — with a full-node
      // set() this would wipe the field the first call just wrote.
      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, referredByShareId: 'share-1' } },
      });
    });

    it('preserves user-node fields it does not own across re-provisioning (scoped writes)', async () => {
      const { app, database } = buildTestApp();
      database.seed(`users/${TEST_UID}`, { email: 'stale@example.com', someFutureField: true });

      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, someFutureField: true } },
      });
    });

    it('still upserts the email with no body (backward compatible with the zero-arg call)', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ uid: TEST_UID, email: TEST_EMAIL });
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect(dump.users[TEST_UID]!.email).toBe(TEST_EMAIL);
      expect('referredByShareId' in dump.users[TEST_UID]!).toBe(false);
    });
  });

  // Phase 13 (ONBD-02/D-01/D-02): onboardingIntent persistence — the
  // conditional-spread `.nullish()` write discipline (production-gap item
  // 3), same as coachingModeEnabled/referredByShareId above.
  describe('onboardingIntent (conditional-spread persistence)', () => {
    it('persists a valid onboardingIntent on the user node', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'scout' },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, onboardingIntent: 'scout' } },
      });
    });

    it('rejects a body with an onboardingIntent outside the five-value enum (400, never written)', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'not_an_intent' },
      });

      expect(response.statusCode).toBe(400);
      const dump = database.dump() as { users?: Record<string, unknown> };
      expect(dump.users?.[TEST_UID]).toBeUndefined();
    });

    it('never writes onboardingIntent when the field is omitted (no null write — production-gap item 3)', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      const dump = database.dump() as { users: Record<string, Record<string, unknown>> };
      expect('onboardingIntent' in dump.users[TEST_UID]!).toBe(false);
    });

    it('a later omitted-field call leaves a previously-saved onboardingIntent untouched', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'prepare' },
      });
      // Bodyless re-provision (token refresh) — must not clear the saved intent.
      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, onboardingIntent: 'prepare' } },
      });
    });
  });

  // Phase 13 (ONBD-02/D-01/D-02): onboarding_intent_selected fires once per
  // GENUINE intent change (read-before-write guard, mirrors
  // signup_completed's isFirstProvision check), carrying the asked-vs-
  // skipped cohort split in payload.asked.
  describe('onboarding_intent_selected (change-guarded D event)', () => {
    it('emits with payload { intent, asked } when onboardingIntent is set with onboardingAsked true', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'scout', onboardingAsked: true },
      });
      await flushMacrotask();

      expect(response.statusCode).toBe(200);
      const rows = allLedgerRows(database);
      expect(rows).toHaveLength(2); // signup_completed (first provision) + this event
      expect(rows).toContainEqual(
        expect.objectContaining({
          eventName: 'onboarding_intent_selected',
          actorId: TEST_UID,
          causationId: TEST_UID,
          payload: { intent: 'scout', asked: true },
        }),
      );
    });

    it('marks payload.asked false for a context-skipped selection (onboardingAsked omitted)', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'review_vod' },
      });
      await flushMacrotask();

      const rows = allLedgerRows(database);
      expect(rows).toContainEqual(
        expect.objectContaining({
          eventName: 'onboarding_intent_selected',
          payload: { intent: 'review_vod', asked: false },
        }),
      );
    });

    it('does not re-emit on a second identical PUT with the same intent', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'scout', onboardingAsked: true },
      });
      await flushMacrotask();
      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'scout', onboardingAsked: true },
      });
      await flushMacrotask();

      const rows = allLedgerRows(database).filter(
        (row) => (row as { eventName?: string }).eventName === 'onboarding_intent_selected',
      );
      expect(rows).toHaveLength(1);
    });

    // The route-level change guard (previousIntent comparison) permits a
    // second createEvent() call on a genuine change — but `createEvent`'s
    // OWN ledger-level dedup (`eventDedup/{eventName}/{schemaVersion}/
    // {causationId}`, MEAS-05) is a permanent per-causationId flag, and
    // causationId is locked to `request.uid` (RESEARCH.md Pattern 3: the
    // mutated resource here is the user's own profile, not a per-selection
    // resource id) — mirroring `signup_completed`'s own exactly-once-ever
    // semantics. The net effect: onboarding_intent_selected fires on the
    // first genuine selection only, for the lifetime of the account.
    it('does not re-emit a second time even when the intent later genuinely changes (ledger-level causationId=uid dedup, mirrors signup_completed)', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'scout' },
      });
      await flushMacrotask();
      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { onboardingIntent: 'coach_clients' },
      });
      await flushMacrotask();

      const rows = allLedgerRows(database).filter(
        (row) => (row as { eventName?: string }).eventName === 'onboarding_intent_selected',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ payload: { intent: 'scout' } });
    });

    it('emits nothing when onboardingIntent is omitted entirely', async () => {
      const { app, database } = buildTestApp();

      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
      await flushMacrotask();

      const rows = allLedgerRows(database).filter(
        (row) => (row as { eventName?: string }).eventName === 'onboarding_intent_selected',
      );
      expect(rows).toHaveLength(0);
    });
  });

  // Phase 13 (ONBD-05/D-06, RESEARCH.md Pitfall 2): coaching_mode_enabled
  // was NEVER wired before this phase — this is the newly-added emission,
  // gated on a genuine false/absent -> true flip (never a repeat true, never
  // a false/no-op call).
  describe('coaching_mode_enabled (newly-wired D event)', () => {
    it('emits once on a genuine false/absent -> true flip', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      await flushMacrotask();

      expect(response.statusCode).toBe(200);
      const rows = allLedgerRows(database);
      expect(rows).toContainEqual(
        expect.objectContaining({
          eventName: 'coaching_mode_enabled',
          actorId: TEST_UID,
          causationId: TEST_UID,
        }),
      );
    });

    it('does not re-emit on a repeat PUT with coachingModeEnabled true', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      await flushMacrotask();
      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      await flushMacrotask();

      const rows = allLedgerRows(database).filter(
        (row) => (row as { eventName?: string }).eventName === 'coaching_mode_enabled',
      );
      expect(rows).toHaveLength(1);
    });

    it('does not emit for a false or absent coachingModeEnabled value', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: false },
      });
      await flushMacrotask();
      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
      await flushMacrotask();

      const rows = allLedgerRows(database).filter(
        (row) => (row as { eventName?: string }).eventName === 'coaching_mode_enabled',
      );
      expect(rows).toHaveLength(0);
    });

    // As with onboarding_intent_selected above: the route-level flip guard
    // would permit a second createEvent() call here, but createEvent's own
    // ledger-level dedup is a permanent per-(eventName, causationId) flag,
    // and causationId is locked to `request.uid` (the user's own profile
    // is the mutated resource) — so coaching_mode_enabled, like
    // signup_completed, fires at most once for the lifetime of the
    // account, even across a later disable/re-enable cycle.
    it('does not re-emit on a later false -> true flip after an explicit disable (ledger-level causationId=uid dedup)', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      await flushMacrotask();
      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: false },
      });
      await flushMacrotask();
      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      await flushMacrotask();

      const rows = allLedgerRows(database).filter(
        (row) => (row as { eventName?: string }).eventName === 'coaching_mode_enabled',
      );
      expect(rows).toHaveLength(1);
    });
  });
});

describe('GET /api/users/me', () => {
  it('returns 404 when the user has not been upserted yet', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns the profile with fighter selections after upsert', async () => {
    const { app, database } = buildTestApp();

    await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });
    database.seed(`primaryFighters/${TEST_UID}`, [1, 2]);
    database.seed(`secondaryFighters/${TEST_UID}`, [3]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      uid: TEST_UID,
      email: TEST_EMAIL,
      fighters: { primary: [1, 2], secondary: [3] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
  });

  // Phase 11 walkthrough fix round 1 (FB-3): coaching mode is an explicit
  // opt-in — defaults false, settable/clearable via PUT, never overwritten
  // by an unrelated provisioning call.
  describe('coachingModeEnabled', () => {
    it('defaults to false when never set', async () => {
      const { app } = buildTestApp();
      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: authHeader(),
      });

      expect(response.json()).toMatchObject({ coachingModeEnabled: false });
    });

    it('PUT /api/users/me sets coachingModeEnabled to true', async () => {
      const { app, database } = buildTestApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });

      expect(response.statusCode).toBe(200);
      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, coachingModeEnabled: true } },
      });

      const getResponse = await app.inject({
        method: 'GET',
        url: '/api/users/me',
        headers: authHeader(),
      });
      expect(getResponse.json()).toMatchObject({ coachingModeEnabled: true });
    });

    it('PUT /api/users/me can turn coachingModeEnabled back off', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: false },
      });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, coachingModeEnabled: false } },
      });
    });

    it('a provisioning call that omits coachingModeEnabled leaves a previously-set value untouched', async () => {
      const { app, database } = buildTestApp();

      await app.inject({
        method: 'PUT',
        url: '/api/users/me',
        headers: authHeader(),
        payload: { coachingModeEnabled: true },
      });
      // Bodyless re-provision (token refresh) — must not reset the toggle.
      await app.inject({ method: 'PUT', url: '/api/users/me', headers: authHeader() });

      expect(database.dump()).toMatchObject({
        users: { [TEST_UID]: { email: TEST_EMAIL, coachingModeEnabled: true } },
      });
    });
  });
});

// Phase 30.1 Plan 05 (WKSP-01A, review C3-L1, T-30.1-12): the self-only
// coverage read — REQUIRED HTTP-layer proof that the route accepts no
// subject parameter of any kind and resolves ONLY `request.uid`. A
// composer-only test (see `research/selfCoverage.test.ts`) cannot prove
// this route-layer boundary.
describe('GET /api/users/me/coverage', () => {
  const OTHER_UID = 'other-uid-999';

  function seedSnapshot(
    database: ReturnType<typeof buildTestApp>['database'],
    uid: string,
    playerId: string,
  ) {
    database.seed(`researchCoverage/${uid}`, {
      asOfMs: 1_000,
      players: {
        [playerId]: {
          playerId,
          runId: 'run-1',
          runCompletedAtMs: 1_000,
          asOfMs: 1_000,
          counters: {},
          namedGaps: {},
          dateCoverage: {},
          classificationCounts: {},
          uniqueCounters: {},
          uniqueNamedGaps: {},
          uniqueClassificationCounts: {},
        },
      },
      totals: { counters: {}, namedGaps: {}, dateCoverage: {}, classificationCounts: {} },
    });
    database.seed(`researchIdentity/${uid}`, {
      confirmedPlayerIds: {
        [playerId]: {
          playerId,
          primary: true,
          confirmedByUid: uid,
          confirmedAtMs: 1_000,
        },
      },
    });
  }

  it('rejects unauthenticated requests (401)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/users/me/coverage' });

    expect(response.statusCode).toBe(401);
  });

  it('returns the benign empty shape when the caller has no migrated research data', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/coverage',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      coverage: null,
      confirmedPlayerIds: [],
      confirmedPlayerIdCount: 0,
      unresolvedCandidateCount: 0,
    });
  });

  it('resolves request.uid — an authenticated caller with migrated data gets its OWN coverage', async () => {
    const { app, database } = buildTestApp();
    seedSnapshot(database, TEST_UID, 'player-self');

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/coverage',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.confirmedPlayerIds).toEqual(['player-self']);
    expect(body.coverage.players).toHaveProperty('player-self');
  });

  it('NEVER returns a second uid seeded coverage for the TEST_UID caller (cross-uid isolation)', async () => {
    const { app, database } = buildTestApp();
    seedSnapshot(database, OTHER_UID, 'player-other');

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/coverage',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    // TEST_UID has no coverage of its own — the other uid's is never leaked.
    expect(response.json()).toEqual({
      coverage: null,
      confirmedPlayerIds: [],
      confirmedPlayerIdCount: 0,
      unresolvedCandidateCount: 0,
    });
  });

  it('NEVER returns another uid coverage even when the caller also has its own (cross-uid isolation with data on both sides)', async () => {
    const { app, database } = buildTestApp();
    seedSnapshot(database, TEST_UID, 'player-self');
    seedSnapshot(database, OTHER_UID, 'player-other');

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/coverage',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.confirmedPlayerIds).toEqual(['player-self']);
    expect(JSON.stringify(body)).not.toContain('player-other');
    expect(JSON.stringify(body)).not.toContain(OTHER_UID);
  });

  // Phase 30.2 Plan 10 (ENR-06/ENR-09): the additive `enrichment` member —
  // present when `researchEnrichmentCoverage/{uid}` exists, ABSENT (never
  // `null`) when it does not. Neither case touches any assertion above.
  it('omits the enrichment member when no researchEnrichmentCoverage node exists', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/coverage',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect('enrichment' in response.json()).toBe(false);
  });

  it('returns the enrichment member when researchEnrichmentCoverage/{uid} exists', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentCoverage/${TEST_UID}`, {
      asOfMs: 1_000,
      runId: 'run-1',
      counts: { matched: 2 },
      cohortCounts: { startggOnly: 1, liquipediaSupplemented: 1 },
      perSourcePage: {
        'Supernova/2026': {
          sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026',
          revisionId: 1,
          contentHash: 'a'.repeat(64),
          fetchedAtMs: 1_000,
          observationCount: 5,
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/coverage',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enrichment.counts.matched).toBe(2);
    expect(body.enrichment.perSourcePage['Supernova/2026'].sourcePageUrl).toBe(
      'https://liquipedia.net/smash/Supernova/2026',
    );
  });
});

// Phase 30.2 Plan 10 (ENR-09): the self-scoped attribution lookup — a
// bounded, caller-supplied match-key list resolved ONLY against the
// caller's own uid, exactly like the coverage route above.
describe('GET /api/users/me/enrichment/attribution', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
    });

    expect(response.statusCode).toBe(401);
  });

  function seedObservation(
    database: FakeDatabase,
    observationId: string,
    sourcePageTitle: string,
    sourcePageUrl: string,
    sourceRevisionId: number,
  ): void {
    database.seed(`researchEnrichmentObservations/${TEST_UID}/${observationId}`, {
      observationId,
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle,
      sourcePageUrl,
      sourceRevisionId,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-match2@1',
      templateFamily: 'match2',
      fetchedAtMs: 1_000,
      observedAtMs: 1_000,
      matchingStatus: 'matched',
    });
  }

  it('returns the STAGE half for a stage witness, including source page identity, revision id, raw stage text and stage form — and NO vod half', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      projectedStageId: 3,
      projectedStageName: 'Battlefield',
      projectedStageRaw: 'BF',
      projectedStageForm: 'normal',
      stageObservationId: 'obs-1',
      stageSourceRevisionId: 42,
      stageParserVersion: 'liquipedia-bracket-match2@1',
      stageProjectedAtMs: 1_000,
    });
    seedObservation(
      database,
      'obs-1',
      'Supernova/2026',
      'https://liquipedia.net/smash/Supernova/2026',
      42,
    );

    const response = await app.inject({
      method: 'GET',
      // A second, never-witnessed key stays silently absent from the
      // response — not an error, per the plan's stated behavior.
      url: '/api/users/me/enrichment/attribution?keys=match-1,match-2',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.attributions).toEqual([
      {
        matchKey: 'match-1',
        stage: {
          sourcePageTitle: 'Supernova/2026',
          sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026',
          sourceRevisionId: 42,
          rawStage: 'BF',
          stageForm: 'normal',
        },
      },
    ]);
    // 30.2 gap-closure BLOCKER 2: a stage-only witness must NOT produce a
    // VOD half — that is what made every VOD surface mislabel a
    // user-entered VOD as Liquipedia-derived.
    expect(body.attributions[0].vod).toBeUndefined();
  });

  it('builds each half from its OWN observation when the two fields were enriched from different source pages', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      projectedStageId: 3,
      projectedStageName: 'Battlefield',
      projectedStageRaw: 'BF',
      projectedStageForm: 'normal',
      stageObservationId: 'obs-stage',
      stageSourceRevisionId: 42,
      projectedVodUrl: 'https://youtube.example/set',
      vodObservationId: 'obs-vod',
      vodSourceRevisionId: 99,
    });
    seedObservation(
      database,
      'obs-stage',
      'Supernova/2026 Bracket',
      'https://liquipedia.net/smash/Supernova/2026_Bracket',
      42,
    );
    seedObservation(
      database,
      'obs-vod',
      'Supernova/2026 VODs',
      'https://liquipedia.net/smash/Supernova/2026_VODs',
      99,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().attributions[0];
    // The VOD half links to the VOD observation's page — NOT the stage
    // observation's, which is what the single-slot shape reported.
    expect(entry.vod).toEqual({
      sourcePageTitle: 'Supernova/2026 VODs',
      sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026_VODs',
      sourceRevisionId: 99,
    });
    expect(entry.stage.sourcePageUrl).toBe('https://liquipedia.net/smash/Supernova/2026_Bracket');
    expect(entry.stage.sourceRevisionId).toBe(42);
  });

  it('returns only the VOD half for a vod-only witness, with no stage-only members anywhere', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      projectedVodUrl: 'https://youtube.example/set',
      vodObservationId: 'obs-vod',
      vodSourceRevisionId: 99,
    });
    seedObservation(
      database,
      'obs-vod',
      'Supernova/2026 VODs',
      'https://liquipedia.net/smash/Supernova/2026_VODs',
      99,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().attributions[0];
    expect(entry.stage).toBeUndefined();
    expect(entry.vod.sourcePageUrl).toBe('https://liquipedia.net/smash/Supernova/2026_VODs');
  });

  it('30.3 integration follow-up: returns the CHARACTERS and STOCKS halves for a seat-proven witness', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      projectedSubjectSeat: 1,
      projectedSubjectCharRaw: 'Fox',
      projectedSubjectFighterId: 8,
      projectedOpponentCharRaw: 'Falco',
      projectedOpponentFighterId: 22,
      charsObservationId: 'obs-chars',
      charsSourceRevisionId: 20,
      projectedStocksLeft: 2,
      stocksObservationId: 'obs-chars',
      stocksSourceRevisionId: 20,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().attributions[0];
    expect(entry.characters).toEqual({
      subjectRaw: 'Fox',
      opponentRaw: 'Falco',
      subjectFighterId: 8,
      opponentFighterId: 22,
    });
    expect(entry.stocks).toEqual({ stocksLeft: 2 });
    // No stage/VOD claim was made — those halves stay absent.
    expect(entry.stage).toBeUndefined();
    expect(entry.vod).toBeUndefined();
  });

  it('30.3 integration follow-up: the CHARACTERS half is present with a flagged-unmapped fighter id omitted when orientation is proven but one side is unmapped, and STOCKS stays absent with no committed value', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      projectedSubjectSeat: 1,
      projectedSubjectCharRaw: 'SomeUnreviewedCode',
      // No `projectedSubjectFighterId` — flagged unmapped, never guessed.
      projectedOpponentCharRaw: 'Falco',
      projectedOpponentFighterId: 22,
      charsObservationId: 'obs-chars',
      charsSourceRevisionId: 20,
      // No `projectedStocksLeft` — the stocks half never committed.
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().attributions[0];
    expect(entry.characters).toEqual({
      subjectRaw: 'SomeUnreviewedCode',
      opponentRaw: 'Falco',
      opponentFighterId: 22,
    });
    expect(entry.characters.subjectFighterId).toBeUndefined();
    expect(entry.stocks).toBeUndefined();
  });

  it('30.3 integration follow-up: omits BOTH the CHARACTERS and STOCKS halves for an orientation-abstained witness, even when stage/VOD are present', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      // No `projectedSubjectSeat` — orientation never proven (abstention),
      // even though a stage claim exists alongside it.
      projectedStageId: 3,
      projectedStageName: 'Battlefield',
      stageObservationId: 'obs-stage',
      stageSourceRevisionId: 42,
    });
    seedObservation(
      database,
      'obs-stage',
      'Supernova/2026',
      'https://liquipedia.net/smash/Supernova/2026',
      42,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().attributions[0];
    expect(entry.characters).toBeUndefined();
    expect(entry.stocks).toBeUndefined();
    expect(entry.stage).toBeDefined();
  });

  it('omits a witness that claims NEITHER field (every pending member cleared without a commit)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`researchEnrichmentProjection/${TEST_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ attributions: [] });
  });

  it('returns an empty result for a match key whose witness belongs to another subject (cross-uid isolation)', async () => {
    const { app, database } = buildTestApp();
    const OTHER_UID = 'other-uid-attribution';
    database.seed(`researchEnrichmentProjection/${OTHER_UID}/match-1`, {
      matchKey: 'match-1',
      targetSetId: 'set-1',
      projectedStageRaw: 'BF',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/enrichment/attribution?keys=match-1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ attributions: [] });
  });

  it('rejects a key list longer than USERS_ENRICHMENT_ATTRIBUTION_MAX_KEYS with a client error', async () => {
    const { app } = buildTestApp();
    const tooMany = Array.from({ length: 201 }, (_, i) => `match-${i}`).join(',');

    const response = await app.inject({
      method: 'GET',
      url: `/api/users/me/enrichment/attribution?keys=${tooMany}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET/PUT /api/users/me/fighters', () => {
  it('returns empty arrays when nothing has been set', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me/fighters',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ primary: [], secondary: [] });
  });

  it('sets and reads back primary/secondary fighter ids', async () => {
    const { app } = buildTestApp();

    const putResponse = await app.inject({
      method: 'PUT',
      url: '/api/users/me/fighters',
      headers: authHeader(),
      payload: { primary: [1, 8, 41], secondary: [12] },
    });

    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({ primary: [1, 8, 41], secondary: [12] });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/users/me/fighters',
      headers: authHeader(),
    });

    expect(getResponse.json()).toEqual({ primary: [1, 8, 41], secondary: [12] });
  });

  it('rejects a body with non-numeric fighter ids', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/me/fighters',
      headers: authHeader(),
      payload: { primary: ['mario'], secondary: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400 });
  });
});
