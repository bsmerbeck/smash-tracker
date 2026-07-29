import { describe, expect, it } from 'vitest';
import { PREP_LIKELY_OPPONENTS_MAX } from '@smash-tracker/shared';
import type { PrepPaidConfig, ReportsConfig, StripeConfig } from '../config/env.js';
import { authHeader, buildTestApp, registerUser, TEST_UID } from '../test-support/testApp.js';

const ENTRY_KEY = 'manual-locals-42-abc123';
const FIRST_SET_AT = 1_700_000_000_000;

/** Phase 27 (RPT-04): the three configs `paidReportsAvailable` requires, all present, for gate-on test cases. */
const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
const REPORTS_CONFIG: ReportsConfig = { anthropicApiKey: 'sk-test-key', allowedUids: new Set() };
const STRIPE_CONFIG: StripeConfig = { secretKey: 'sk_test', webhookSecret: 'whsec_test' };

function seedEntry(
  database: ReturnType<typeof buildTestApp>['database'],
  uid: string,
  entryKey: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`tournamentEntries/${uid}/${entryKey}`, {
    eventName: 'Locals #42',
    firstSetAt: FIRST_SET_AT,
    lastSetAt: FIRST_SET_AT,
    setsPlayed: 0,
    source: 'manual',
    ...overrides,
  });
}

describe('entryKey validation', () => {
  it('returns 400 for an entryKey containing an RTDB-illegal character (WR-01)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${encodeURIComponent('a.b')}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 (not 500) for an entryKey containing an ASCII control character (WR-01 residual)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${encodeURIComponent('a\x01b')}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/prep/:entryKey', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: `/api/prep/${ENTRY_KEY}` });

    expect(response.statusCode).toBe(401);
  });

  it('returns 200 { activated: false } with no brief and writes nothing to the database (D-12)', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);

    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });

    const after = JSON.stringify(database.dump());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ activated: false, paidReportsAvailable: false });
    expect(after).toEqual(before);
  });

  it('still returns activated: true for a brief whose eventDate is in the past (D-03)', async () => {
    const { app, database } = buildTestApp();
    const pastDate = FIRST_SET_AT - 1_000_000_000;
    database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
      eventDate: pastDate,
      activatedAt: pastDate,
      lastOpenedAt: pastDate,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { activated: boolean; brief?: { eventDate: number } };
    expect(body.activated).toBe(true);
    expect(body.brief?.eventDate).toBe(pastDate);
  });

  // Phase 27 (RPT-04): `paidReportsAvailable` is returned unconditionally in
  // BOTH response shapes (not-activated and activated), reflecting whether
  // the app was built with the prep-paid config AND the reports config AND
  // the stripe config all present.
  describe('paidReportsAvailable (RPT-04)', () => {
    it('is false in the not-activated shape when the app was built without the prep-paid config', async () => {
      const { app, database } = buildTestApp();
      seedEntry(database, TEST_UID, ENTRY_KEY);

      const response = await app.inject({
        method: 'GET',
        url: `/api/prep/${ENTRY_KEY}`,
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ paidReportsAvailable: false });
    });

    it('is false in the activated shape when the app was built without the prep-paid config', async () => {
      const { app, database } = buildTestApp();
      database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
        eventDate: FIRST_SET_AT,
        activatedAt: FIRST_SET_AT,
        lastOpenedAt: FIRST_SET_AT,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/prep/${ENTRY_KEY}`,
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { activated: boolean; paidReportsAvailable: boolean };
      expect(body.activated).toBe(true);
      expect(body.paidReportsAvailable).toBe(false);
    });

    it('is true in the not-activated shape when the app was built with prepPaid + reports + stripe all present', async () => {
      const { app, database } = buildTestApp({
        prepPaid: PREP_PAID_CONFIG,
        reports: REPORTS_CONFIG,
        stripe: STRIPE_CONFIG,
      });
      seedEntry(database, TEST_UID, ENTRY_KEY);

      const response = await app.inject({
        method: 'GET',
        url: `/api/prep/${ENTRY_KEY}`,
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ paidReportsAvailable: true });
    });

    it('is true in the activated shape when the app was built with prepPaid + reports + stripe all present', async () => {
      const { app, database } = buildTestApp({
        prepPaid: PREP_PAID_CONFIG,
        reports: REPORTS_CONFIG,
        stripe: STRIPE_CONFIG,
      });
      database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
        eventDate: FIRST_SET_AT,
        activatedAt: FIRST_SET_AT,
        lastOpenedAt: FIRST_SET_AT,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/prep/${ENTRY_KEY}`,
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { activated: boolean; paidReportsAvailable: boolean };
      expect(body.activated).toBe(true);
      expect(body.paidReportsAvailable).toBe(true);
    });

    it('is false when prepPaid is present but reports/stripe are not (partial config never enables it)', async () => {
      const { app, database } = buildTestApp({ prepPaid: PREP_PAID_CONFIG });
      seedEntry(database, TEST_UID, ENTRY_KEY);

      const response = await app.inject({
        method: 'GET',
        url: `/api/prep/${ENTRY_KEY}`,
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ paidReportsAvailable: false });
    });
  });
});

describe('POST /api/prep/:entryKey/activate', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 and creates no prepBriefs node for an entryKey absent from the caller registry', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.prepBriefs).toBeUndefined();
  });

  it('returns 404 for an entryKey belonging to a different uid (cross-user probe)', async () => {
    const { app, database, auth } = buildTestApp();
    registerUser(auth, 'foreign-token', { uid: 'foreign-uid', email: 'foreign@test.com' });
    seedEntry(database, 'foreign-uid', ENTRY_KEY);

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('first activate returns justActivated: true with eventDate from the registry firstSetAt; second returns false with the same eventDate', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);

    const first = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { justActivated: boolean; brief: { eventDate: number } };
    expect(firstBody.justActivated).toBe(true);
    expect(firstBody.brief.eventDate).toBe(FIRST_SET_AT);

    const second = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { justActivated: boolean; brief: { eventDate: number } };
    expect(secondBody.justActivated).toBe(false);
    expect(secondBody.brief.eventDate).toBe(FIRST_SET_AT);
  });
});

describe('POST /api/prep/:entryKey/open', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/open`,
      payload: { openId: 'open-1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('stamps lastOpenedAt on an existing brief', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/open`,
      headers: authHeader(),
      payload: { openId: 'open-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { brief: { lastOpenedAt: number } };
    expect(typeof body.brief.lastOpenedAt).toBe('number');
  });
});

describe('PUT /api/prep/:entryKey/checklist/:itemId', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/checklist/confirmRegistration`,
      payload: { checked: true },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 400 and writes no checklist node for an unknown item id', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/checklist/notARealItem`,
      headers: authHeader(),
      payload: { checked: true },
    });

    expect(response.statusCode).toBe(400);
    const briefNode = database.dump() as {
      prepBriefs?: Record<string, Record<string, { checklist?: unknown }>>;
    };
    expect(briefNode.prepBriefs?.[TEST_UID]?.[ENTRY_KEY]?.checklist).toBeUndefined();
  });

  it('checked: true adds the item, checked: false clears it back to an empty checklist', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    const checkedOn = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/checklist/confirmRegistration`,
      headers: authHeader(),
      payload: { checked: true },
    });

    expect(checkedOn.statusCode).toBe(200);
    const onBody = checkedOn.json() as { brief: { checklist: Record<string, boolean> } };
    expect(onBody.brief.checklist).toEqual({ confirmRegistration: true });

    const checkedOff = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/checklist/confirmRegistration`,
      headers: authHeader(),
      payload: { checked: false },
    });

    expect(checkedOff.statusCode).toBe(200);
    const offBody = checkedOff.json() as { brief: { checklist: Record<string, boolean> } };
    expect(offBody.brief.checklist).toEqual({});
  });
});

describe('PUT/DELETE /api/prep/:entryKey/opponents/:name', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/somebody`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 409 once PREP_LIKELY_OPPONENTS_MAX is exceeded by a genuinely new name', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    for (let i = 0; i < PREP_LIKELY_OPPONENTS_MAX; i += 1) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/prep/${ENTRY_KEY}/opponents/opponent-${i}`,
        headers: authHeader(),
      });
      expect(response.statusCode).toBe(200);
    }

    const overCap = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/one-too-many`,
      headers: authHeader(),
    });

    expect(overCap.statusCode).toBe(409);
  });

  it('adds and then removes a likely opponent', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    const added = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival`,
      headers: authHeader(),
    });
    expect(added.statusCode).toBe(200);
    const addedBody = added.json() as { brief: { likelyOpponents: Record<string, boolean> } };
    expect(addedBody.brief.likelyOpponents).toEqual({ rival: true });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival`,
      headers: authHeader(),
    });
    expect(removed.statusCode).toBe(200);
    const removedBody = removed.json() as { brief: { likelyOpponents: Record<string, boolean> } };
    expect(removedBody.brief.likelyOpponents).toEqual({});
  });
});
