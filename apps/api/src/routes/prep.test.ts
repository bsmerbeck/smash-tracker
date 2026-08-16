import { describe, expect, it } from 'vitest';
import { PREP_LIKELY_OPPONENTS_MAX, REVIEW_CHECKLIST_ITEM_IDS } from '@smash-tracker/shared';
import type { PrepPaidConfig, ReportsConfig, StripeConfig } from '../config/env.js';
import { authHeader, buildTestApp, registerUser, TEST_UID } from '../test-support/testApp.js';

const ENTRY_KEY = 'manual-locals-42-abc123';
const FIRST_SET_AT = 1_700_000_000_000;

/** Walks every `eventLedger/{day}/{pushKey}` envelope currently in the fake tree — mirrors `prep.test.ts`'s helper. */
function allLedgerEnvelopes(
  database: ReturnType<typeof buildTestApp>['database'],
): Array<{ eventName?: string }> {
  const tree = database.dump() as Record<string, unknown>;
  const ledgerByDay = (tree.eventLedger ?? {}) as Record<
    string,
    Record<string, { eventName?: string }>
  >;
  return Object.values(ledgerByDay).flatMap((day) => Object.values(day));
}

function countEnvelopesByName(
  database: ReturnType<typeof buildTestApp>['database'],
  eventName: string,
): number {
  return allLedgerEnvelopes(database).filter((envelope) => envelope.eventName === eventName).length;
}

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

  it('returns 409 and creates no prepBriefs node for an admin-imported historical registry row (Phase 30.3), even with future timestamps', async () => {
    const { app, database } = buildTestApp();
    const entryKey = 'histimport:987654';
    // Deliberately future first/lastSetAt: the server refusal must hold on
    // the origin discriminator alone, not on the timestamps the web gate
    // happens to use (a mis-recorded future date must not resurrect prep).
    const futureMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    // Seeded directly (not via seedEntry): registry rows carry no legacy
    // `source` member, and FakeDatabase rejects undefined own-properties
    // exactly like the real SDK, so the override-spread path can't drop it.
    database.seed(`tournamentEntries/${TEST_UID}/${entryKey}`, {
      entryId: entryKey,
      origin: 'admin-imported',
      provider: 'startgg',
      startggEventId: '987654',
      eventName: 'Imported Historical Open',
      registryWitness: 'research-import:v1:987654',
      provenance: { source: 'research-import', importedAtMs: FIRST_SET_AT },
      playedSetCount: 0,
      firstSetAt: futureMs,
      lastSetAt: futureMs,
      setsPlayed: 0,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${encodeURIComponent(entryKey)}/activate`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(409);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.prepBriefs).toBeUndefined();
  });

  it('Phase 30.3 Gate 6: the imported-entry 409 is ZERO-TRACE — no brief, job, event, ledger entry, or credit mutation', async () => {
    const { app, database } = buildTestApp();
    const entryKey = 'histimport:112233';
    // Deliberately FUTURE-dated again (the protection must not pass by
    // accident because real imported events happen to be historical) AND
    // with pre-existing money state, so a debit or a refund would be
    // visible as a CHANGE rather than merely as an absent tree.
    const futureMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    database.seed(`tournamentEntries/${TEST_UID}/${entryKey}`, {
      entryId: entryKey,
      origin: 'admin-imported',
      provider: 'startgg',
      startggEventId: '112233',
      eventName: 'Imported Historical Major',
      registryWitness: 'research-import:v1:112233',
      provenance: { source: 'research-import', importedAtMs: FIRST_SET_AT },
      playedSetCount: 0,
      firstSetAt: futureMs,
      lastSetAt: futureMs,
      setsPlayed: 0,
    });
    database.seed(`credits/${TEST_UID}/balance`, 7);

    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${encodeURIComponent(entryKey)}/activate`,
      headers: authHeader(),
    });
    // Drain the fire-and-forget `void createEvent(...)` queue so a
    // zero-envelope assertion is meaningful rather than a race.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(response.statusCode).toBe(409);

    const dump = database.dump() as Record<string, unknown>;
    // Per-tree assertions (named, so a failure says WHICH surface leaked)…
    for (const tree of [
      'prepBriefs',
      'prepReportJobIndex',
      'prepSynthesisJobIndex',
      'reportJobs',
      'reportJobsByStatus',
      'reportJobsByDay',
      'eventLedger',
      'eventDedup',
      'outboxPending',
      'creditLedger',
      'creditLedgerByDay',
      'creditBundleOps',
    ]) {
      expect(dump[tree]).toBeUndefined();
    }
    // …plus the credit BALANCE specifically, which pre-existed and so
    // cannot be proven untouched by an absence check.
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(7);
    expect(countEnvelopesByName(database, 'prep_brief_activated')).toBe(0);
    // Whole-tree byte equality: the 409 changed literally nothing.
    expect(JSON.stringify(database.dump())).toBe(before);
  });

  it('POSITIVE CONTROL: an ordinary (non-imported) entry on a different account activates normally and DOES write a brief + event', async () => {
    const { app, database, auth } = buildTestApp();
    registerUser(auth, 'ordinary-fifth-token', {
      uid: 'ordinary-fifth-uid',
      email: 'ordinary-fifth@test.com',
    });
    seedEntry(database, 'ordinary-fifth-uid', ENTRY_KEY);

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader('ordinary-fifth-token'),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(response.statusCode).toBe(200);
    const dump = database.dump() as Record<string, unknown>;
    const briefs = dump.prepBriefs as Record<string, Record<string, unknown>>;
    expect(briefs['ordinary-fifth-uid']![ENTRY_KEY]).toBeDefined();
    expect(countEnvelopesByName(database, 'prep_brief_activated')).toBe(1);
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

describe('PUT /api/prep/:entryKey/review-checklist/:itemId', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/review-checklist/attachVods`,
      payload: { checked: true },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 400 and writes no reviewChecklist node for an unknown item id', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/review-checklist/notARealItem`,
      headers: authHeader(),
      payload: { checked: true },
    });

    expect(response.statusCode).toBe(400);
    const briefNode = database.dump() as {
      prepBriefs?: Record<string, Record<string, { reviewChecklist?: unknown }>>;
    };
    expect(briefNode.prepBriefs?.[TEST_UID]?.[ENTRY_KEY]?.reviewChecklist).toBeUndefined();
  });

  it('toggles and returns the brief', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    const checkedOn = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/review-checklist/attachVods`,
      headers: authHeader(),
      payload: { checked: true },
    });

    expect(checkedOn.statusCode).toBe(200);
    const onBody = checkedOn.json() as { brief: { reviewChecklist: Record<string, boolean> } };
    expect(onBody.brief.reviewChecklist).toEqual({ attachVods: true });

    const checkedOff = await app.inject({
      method: 'PUT',
      url: `/api/prep/${ENTRY_KEY}/review-checklist/attachVods`,
      headers: authHeader(),
      payload: { checked: false },
    });

    expect(checkedOff.statusCode).toBe(200);
    const offBody = checkedOff.json() as { brief: { reviewChecklist: Record<string, boolean> } };
    expect(offBody.brief.reviewChecklist).toEqual({});
  });

  it('WR-03: rejects the toggle with 409 on an unconverted brief — no write, no completed event, and the write-once marker stays uncommitted', async () => {
    const { app, database } = buildTestApp();
    // A genuinely FUTURE event: activation does not freeze reviewAt, so the
    // brief is still in prep mode when the review-checklist PUT arrives.
    const futureAt = Date.now() + 1_000_000_000;
    seedEntry(database, TEST_UID, ENTRY_KEY, {
      source: 'startgg',
      firstSetAt: futureAt,
      lastSetAt: futureAt,
    });
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    for (const itemId of REVIEW_CHECKLIST_ITEM_IDS) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/prep/${ENTRY_KEY}/review-checklist/${itemId}`,
        headers: authHeader(),
        payload: { checked: true },
      });
      expect(response.statusCode).toBe(409);
    }

    const tree = database.dump() as {
      prepBriefs?: Record<
        string,
        Record<string, { reviewChecklist?: unknown; reviewCompletedAt?: unknown }>
      >;
    };
    expect(tree.prepBriefs?.[TEST_UID]?.[ENTRY_KEY]?.reviewChecklist).toBeUndefined();
    expect(tree.prepBriefs?.[TEST_UID]?.[ENTRY_KEY]?.reviewCompletedAt).toBeUndefined();
    expect(countEnvelopesByName(database, 'post_event_review_completed')).toBe(0);
    // The funnel invariant WR-03 protects: `completed` can never precede
    // `started` (which only fires from freezeReviewAtIfDue on conversion).
    expect(countEnvelopesByName(database, 'post_event_review_started')).toBe(0);
  });

  it('completing every review checklist item emits post_event_review_completed exactly once', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);
    await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    for (const itemId of REVIEW_CHECKLIST_ITEM_IDS) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/prep/${ENTRY_KEY}/review-checklist/${itemId}`,
        headers: authHeader(),
        payload: { checked: true },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(countEnvelopesByName(database, 'post_event_review_completed')).toBe(1);
  });
});

/**
 * Phase 28 (28-04, Task 3): the write-once `reviewAt` freeze rides the
 * activate/open mutations — never GET (owner invariants 3 and 5).
 */
describe('reviewAt freeze wiring on activate/open (28-04)', () => {
  it('activate handler freezes when the event already passed (archival/backfill converts on first visit)', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY, { source: 'startgg', lastSetAt: FIRST_SET_AT });

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { brief: { reviewAt?: number } };
    expect(body.brief.reviewAt).toBe(FIRST_SET_AT);
    expect(countEnvelopesByName(database, 'post_event_review_started')).toBe(1);
  });

  it('activate handler leaves reviewAt unset for a genuinely future event', async () => {
    const { app, database } = buildTestApp();
    const futureLastSetAt = Date.now() + 1_000_000_000;
    seedEntry(database, TEST_UID, ENTRY_KEY, {
      source: 'startgg',
      firstSetAt: futureLastSetAt,
      lastSetAt: futureLastSetAt,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/activate`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { brief: { reviewAt?: number } };
    expect(body.brief.reviewAt).toBeUndefined();
    expect(countEnvelopesByName(database, 'post_event_review_started')).toBe(0);
  });

  it('open handler freezes existing pre-Phase-28 briefs whose entry has already passed', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY, { source: 'startgg', lastSetAt: FIRST_SET_AT });
    // A brief created without any Phase 28 review fields at all — simulates
    // a brief activated before this phase shipped.
    database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
      eventDate: FIRST_SET_AT,
      activatedAt: FIRST_SET_AT,
      lastOpenedAt: FIRST_SET_AT,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/open`,
      headers: authHeader(),
      payload: { openId: 'open-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { brief: { reviewAt?: number } };
    expect(body.brief.reviewAt).toBe(FIRST_SET_AT);
    expect(countEnvelopesByName(database, 'post_event_review_started')).toBe(1);
  });

  it('open handler tolerates a missing registry row (no candidate, no throw)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
      eventDate: FIRST_SET_AT,
      activatedAt: FIRST_SET_AT,
      lastOpenedAt: FIRST_SET_AT,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/prep/${ENTRY_KEY}/open`,
      headers: authHeader(),
      payload: { openId: 'open-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { brief: { reviewAt?: number } };
    expect(body.brief.reviewAt).toBeUndefined();
  });
});

/**
 * Phase 28 (28-04, Task 3): GET's effective `reviewAt` and the GET-never-
 * writes proof.
 */
describe('GET /api/prep/:entryKey — effective reviewAt (28-04)', () => {
  it('returns the frozen reviewAt when present', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY, { source: 'startgg', lastSetAt: FIRST_SET_AT });
    database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
      eventDate: FIRST_SET_AT,
      activatedAt: FIRST_SET_AT,
      lastOpenedAt: FIRST_SET_AT,
      reviewAt: FIRST_SET_AT,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { reviewAt?: number };
    expect(body.reviewAt).toBe(FIRST_SET_AT);
  });

  it('returns a server-derived candidate when no frozen reviewAt exists yet', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY, { source: 'startgg', lastSetAt: FIRST_SET_AT });
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
    const body = response.json() as { reviewAt?: number };
    expect(body.reviewAt).toBe(FIRST_SET_AT);
  });

  it('returns nothing extra when the brief is not activated', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { activated: boolean; reviewAt?: number };
    expect(body.activated).toBe(false);
    expect(body.reviewAt).toBeUndefined();
  });

  it('performs no writes even when the candidate is already past (the freeze waits for a mutation)', async () => {
    const { app, database } = buildTestApp();
    seedEntry(database, TEST_UID, ENTRY_KEY, { source: 'startgg', lastSetAt: FIRST_SET_AT });
    database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
      eventDate: FIRST_SET_AT,
      activatedAt: FIRST_SET_AT,
      lastOpenedAt: FIRST_SET_AT,
    });

    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}`,
      headers: authHeader(),
    });

    const after = JSON.stringify(database.dump());

    expect(response.statusCode).toBe(200);
    const body = response.json() as { reviewAt?: number };
    expect(body.reviewAt).toBe(FIRST_SET_AT);
    expect(after).toEqual(before);
    expect(countEnvelopesByName(database, 'post_event_review_started')).toBe(0);
  });
});
