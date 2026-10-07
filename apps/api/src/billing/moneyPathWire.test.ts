import { afterEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import { startFakeRtdbServer, type FakeRtdbServer } from '../test-support/fakeRtdbServer.js';
import { FakeAuth } from '../test-support/fakeAuth.js';
import { buildApp } from '../app.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import { fulfillCheckoutSession, refundCreditOnce } from './credits.js';
import { withSettleRetries } from '../routes/reports.js';
import { runSweepStuckReportJobs } from '../jobs/sweepStuckReportJobs.js';

// ---------------------------------------------------------------------------
// Code review R7-IN-06 (iteration 7): the money path against the REAL
// `firebase-admin` SDK, over a fake of the RTDB wire protocol
// (`test-support/fakeRtdbServer.ts`). The in-memory fakes cannot model the
// two client behaviours these scenarios turn on: a transaction's first run
// sees earlier OPTIMISTIC local writes, and a SENT transaction is aborted with
// `disconnect` when the socket drops while a plain set or update is re-sent.
// Every verdict is read from the SERVER's state — the balance, the ledger, the
// day mirrors and the events — never from what a function returned.
//
// - R7-CR-01: a settle-write retry must never start while the previous
//   attempt may still be pending, and a refund is never "already done" on the
//   strength of an unconfirmed local marker.
// - R7-CR-02: a terminal `set(failed)` that stalls must be awaited, not
//   abandoned — an abandoned write lands later as `failed`, which the
//   stuck-job sweep skips, and the spent credit is never refunded.
// - R7-CR-03: the Stripe grant is create-once and retry-safe — a socket drop
//   or a crash mid-grant must end, after Stripe's retries, with the pack
//   granted exactly once and its whole trail written.
// - R6-WR-06 (kept): a refund or a spend from another process that lands
//   mid-grant survives, and duplicate delivery grants once.
// ---------------------------------------------------------------------------

const UID = 'u1';
const SESSION = { id: 'cs_wire', metadata: { uid: UID, packId: 'pack5' } };
const PACK_CREDITS = 5;
const EMULATOR_HOST_VAR = 'FIREBASE_DATABASE_EMULATOR_HOST';

let appCounter = 0;
const openApps: App[] = [];
let server: FakeRtdbServer | null = null;
const previousEmulatorHost = process.env[EMULATOR_HOST_VAR];

/** Starts the wire server with `seed` and points the SDK at it. */
async function startServer(seed: Record<string, unknown>): Promise<FakeRtdbServer> {
  server = await startFakeRtdbServer(seed);
  process.env[EMULATOR_HOST_VAR] = `127.0.0.1:${server.port}`;
  return server;
}

/** A fresh SDK client (one process) connected to the wire server. */
async function connectClient(): Promise<{ app: App; database: Database }> {
  appCounter += 1;
  const app = initializeApp(
    { projectId: 'wire-test', databaseURL: 'https://wire-test-default-rtdb.firebaseio.com' },
    `wire-${appCounter}`,
  );
  openApps.push(app);
  const database = getDatabase(app);
  await database.ref('warm').get();
  return { app, database };
}

async function closeClient(app: App): Promise<void> {
  const index = openApps.indexOf(app);
  if (index >= 0) {
    openApps.splice(index, 1);
    await deleteApp(app);
  }
}

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await deleteApp(app);
  }
  await server?.close();
  server = null;
  if (previousEmulatorHost === undefined) {
    delete process.env[EMULATOR_HOST_VAR];
  } else {
    process.env[EMULATOR_HOST_VAR] = previousEmulatorHost;
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` until it holds or `timeoutMs` passes; returns whether it held. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(50);
  }
  return predicate();
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  );
}

interface LedgerRow {
  type: string;
  amount: number;
  ref: string;
  createdAt: number;
}

function ledgerOf(fake: FakeRtdbServer): Record<string, LedgerRow> {
  return (fake.get(`creditLedger/${UID}`) ?? {}) as Record<string, LedgerRow>;
}

function ledgerSum(fake: FakeRtdbServer): number {
  return Object.values(ledgerOf(fake)).reduce((sum, row) => sum + row.amount, 0);
}

function balanceOf(fake: FakeRtdbServer): number {
  const balance = fake.get(`credits/${UID}/balance`);
  return typeof balance === 'number' ? balance : 0;
}

function eventCount(fake: FakeRtdbServer, eventName: string): number {
  const ledger = (fake.get('eventLedger') ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(ledger)
    .flatMap((day) => Object.values(day ?? {}))
    .filter((entry) => (entry as { eventName?: string }).eventName === eventName).length;
}

/** Every day-mirror row for `id` under `root/{day}/…`. */
function mirrorCount(fake: FakeRtdbServer, root: string, pick: (day: unknown) => number): number {
  const days = (fake.get(root) ?? {}) as Record<string, unknown>;
  return Object.values(days).reduce((sum: number, day) => sum + pick(day), 0);
}

function processedByDay(fake: FakeRtdbServer, eventId: string): number {
  return mirrorCount(fake, 'processedStripeEventsByDay', (day) =>
    (day as Record<string, unknown> | null)?.[eventId] ? 1 : 0,
  );
}

/** The purchase rows in the ledger's day mirror (refunds and spends write no mirror). */
function purchaseMirrorCount(fake: FakeRtdbServer): number {
  return mirrorCount(
    fake,
    'creditLedgerByDay',
    (day) =>
      Object.values((day as Record<string, Record<string, LedgerRow>> | null)?.[UID] ?? {}).filter(
        (row) => row.type === 'purchase',
      ).length,
  );
}

/** Stripe's delivery loop: a throw is a 5xx and Stripe delivers the same event again, until a 2xx. */
async function deliverUntilAcknowledged(
  deliver: () => Promise<{ granted: boolean }>,
  maxDeliveries = 4,
): Promise<{ deliveries: number; errors: string[] }> {
  const errors: string[] = [];
  for (let delivery = 1; delivery <= maxDeliveries; delivery += 1) {
    const outcome = await settle(deliver());
    if (outcome.ok) {
      return { deliveries: delivery, errors };
    }
    errors.push(outcome.error.message);
    await sleep(500);
  }
  return { deliveries: maxDeliveries, errors };
}

/** The purchase trail every completed grant leaves, read from the server. */
async function expectOneCompletedGrant(fake: FakeRtdbServer, opening: number, eventId: string) {
  expect(await waitFor(() => eventCount(fake, 'credits_granted') >= 1)).toBe(true);
  await sleep(300);
  const purchases = Object.entries(ledgerOf(fake)).filter(([, row]) => row.type === 'purchase');
  expect(purchases, fake.log.join('\n')).toHaveLength(1);
  expect(purchases[0]![1]).toMatchObject({ amount: PACK_CREDITS, ref: eventId });
  expect(opening + ledgerSum(fake)).toBe(balanceOf(fake));
  expect(fake.get(`processedStripeEvents/${eventId}`)).not.toBeNull();
  expect(processedByDay(fake, eventId)).toBe(1);
  expect(purchaseMirrorCount(fake)).toBe(1);
  expect(eventCount(fake, 'credits_granted')).toBe(1);
}

describe('R7-CR-01 (wire): a settle-write retry never starts while the previous attempt may still be pending', () => {
  it('a refund whose first transaction is unacknowledged and then dropped is refunded exactly once, and the job only says refunded when the balance moved', async () => {
    const fake = await startServer({ credits: { [UID]: { balance: 0 } } });
    const { database } = await connectClient();
    fake.hold = (kind) => kind === 'tx';
    setTimeout(() => {
      fake.hold = null;
      fake.dropAll();
    }, 2_400);

    // failJob's refund and the terminal write that follows it, in order.
    const refund = await settle(
      withSettleRetries(() => refundCreditOnce(database, UID, 'job1', 'job1:exec1')),
    );
    await database
      .ref(`reportJobs/${UID}/job1`)
      .set({ status: refund.ok ? 'refunded' : 'failed', creditRef: 'job1' });

    expect(refund.ok, fake.log.join('\n')).toBe(true);
    expect(await waitFor(() => balanceOf(fake) === 1, 8_000)).toBe(true);
    await sleep(300);
    expect(balanceOf(fake), fake.log.join('\n')).toBe(1);
    const marker = fake.get(`credits/${UID}/refundMarkers/job1:exec1`) as { ledgerKey: string };
    expect(marker).not.toBeNull();
    const ledger = ledgerOf(fake);
    expect(Object.keys(ledger)).toEqual([marker.ledgerKey]);
    expect(ledger[marker.ledgerKey]).toMatchObject({ type: 'refund', amount: 1, ref: 'job1' });
    expect(0 + ledgerSum(fake)).toBe(balanceOf(fake));
    expect(fake.get(`reportJobs/${UID}/job1/status`)).toBe('refunded');
  }, 30_000);

  it('a second refund attempt that starts while the first is still pending never reports done from the pending local marker', async () => {
    const fake = await startServer({ credits: { [UID]: { balance: 0 } } });
    const { database } = await connectClient();
    fake.hold = (kind) => kind === 'tx';

    const first = settle(refundCreditOnce(database, UID, 'job1', 'job1:exec1'));
    await sleep(300);
    const second = settle(refundCreditOnce(database, UID, 'job1', 'job1:exec1'));
    await sleep(300);
    fake.hold = null;
    fake.dropAll();
    const outcomes = await Promise.all([first, second]);
    await sleep(1_500);

    // Code review R8-IN-05: asserted whichever way the attempts ended. An
    // attempt that reported the refund done must be backed by the server (the
    // balance moved), and when both rejected nothing may have moved it either
    // — the ledger agrees in both cases.
    const reportedDone = outcomes.some((outcome) => outcome.ok);
    expect(balanceOf(fake), fake.log.join('\n')).toBe(reportedDone ? 1 : 0);
    expect(0 + ledgerSum(fake), fake.log.join('\n')).toBe(balanceOf(fake));

    // The route's retry then completes the refund exactly once.
    await withSettleRetries(() => refundCreditOnce(database, UID, 'job1', 'job1:exec1'));
    await sleep(500);
    expect(balanceOf(fake), fake.log.join('\n')).toBe(1);
    expect(Object.values(ledgerOf(fake)).filter((row) => row.type === 'refund')).toHaveLength(1);
    expect(0 + ledgerSum(fake)).toBe(balanceOf(fake));
  }, 30_000);
});

describe('R7-CR-02 (wire): an unsettled row whose terminal write stalls is still refunded exactly once', () => {
  // Code review R8-IN-05: driven through the route's REAL `failJob`, not a
  // copy of its body, so a bound or throw re-added inside `failJob` itself is
  // caught too. The synthesis arm's `failJob` runs with `rowSettled=false`:
  // its row is still `running` until the terminal `set` lands. The stubbed
  // model stalls every write, schedules the drop, and refuses — which takes
  // the `ReportGenerationError` branch into `failJob`.
  it("the synthesis arm's failJob under a 9.5 s stall: the write is awaited, the index cleared, the credit refunded, and the sweep refunds nothing more", async () => {
    const entryKey = 'wire-event';
    const firstSetAt = 1_700_000_000_000;
    const annotated = (seconds: number, note: string) => ({
      fighter_id: 1,
      opponent_id: 2,
      time: firstSetAt,
      win: true,
      eventName: 'Wire Open',
      source: 'startgg',
      vodTimestamps: [{ seconds, note }],
    });
    const fake = await startServer({
      credits: { [UID]: { balance: 1 } },
      tournamentEntries: {
        [UID]: {
          [entryKey]: {
            eventName: 'Wire Open',
            firstSetAt,
            lastSetAt: firstSetAt,
            setsPlayed: 2,
            source: 'manual',
          },
        },
      },
      prepBriefs: {
        [UID]: {
          [entryKey]: {
            eventDate: firstSetAt,
            activatedAt: firstSetAt,
            lastOpenedAt: firstSetAt,
            reviewAt: firstSetAt,
          },
        },
      },
      // Three annotated games clear the abstention floor, so the evidence is
      // viable and the job reaches the model call.
      matches: {
        [UID]: {
          m1: annotated(42, 'clean punish'),
          m2: annotated(10, 'late shield'),
          m3: annotated(20, 'missed the ledge trap'),
        },
      },
    });
    const { app: sdkApp, database } = await connectClient();
    const auth = new FakeAuth();
    auth.registerToken('wire-token', { uid: UID, email: 'wire@example.test' });
    let modelCalls = 0;
    const stallingRefusal: AnthropicLikeClient = {
      messages: {
        parse: (async () => {
          modelCalls += 1;
          fake.hold = () => true;
          setTimeout(() => {
            fake.hold = null;
            fake.dropAll();
          }, 9_500);
          return { stop_reason: 'refusal', parsed_output: null };
        }) as AnthropicLikeClient['messages']['parse'],
      },
    };
    const api = buildApp({
      firebase: { app: sdkApp, auth: auth as unknown as Auth, database },
      logger: false,
      reports: { anthropicApiKey: 'sk-test-key', allowedUids: new Set(['someone-else']) },
      stripe: { secretKey: 'sk-test-123', webhookSecret: 'whsec-test-456' },
      prepPaid: { enabled: true },
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stallingRefusal,
    });

    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/reports',
        headers: { authorization: 'Bearer wire-token' },
        payload: { reason: 'post_event_synthesis', entryKey },
      });
      await sleep(1_500);

      expect(modelCalls).toBe(1);
      expect(response.statusCode, response.body).toBe(502);
      const jobs = (fake.get(`reportJobs/${UID}`) ?? {}) as Record<string, { status?: string }>;
      const jobIds = Object.keys(jobs);
      expect(jobIds, fake.log.join('\n')).toHaveLength(1);
      const jobId = jobIds[0]!;
      // failJob's refunded terminal is written only after its refund resolved.
      expect(fake.get(`reportJobs/${UID}/${jobId}/status`), fake.log.join('\n')).toBe('refunded');
      expect(fake.get(`reportJobsByStatus/running/${UID}/${jobId}`)).toBeNull();
      expect(balanceOf(fake), fake.log.join('\n')).toBe(1);
      expect(Object.values(ledgerOf(fake)).filter((row) => row.type === 'refund')).toHaveLength(1);
      expect(1 + ledgerSum(fake)).toBe(balanceOf(fake));

      const sweep = await runSweepStuckReportJobs(database, { now: Date.now() + 60 * 60 * 1000 });
      await sleep(500);
      expect(sweep.refunded).toBe(0);
      expect(balanceOf(fake), fake.log.join('\n')).toBe(1);
      expect(1 + ledgerSum(fake)).toBe(balanceOf(fake));
    } finally {
      await api.close();
    }
  }, 40_000);
});

describe('R7-CR-03 (wire): the Stripe grant is create-once and retry-safe', () => {
  it('a socket drop while the grant is in flight: after Stripe retries, the pack is granted exactly once with its whole trail', async () => {
    const opening = 3;
    const fake = await startServer({ credits: { [UID]: { balance: opening } } });
    const { database } = await connectClient();
    fake.hold = (kind, path, data) =>
      path.startsWith('/credits') ||
      (kind === 'merge' &&
        Object.keys((data ?? {}) as Record<string, unknown>).some((key) =>
          key.startsWith('credits/'),
        ));
    setTimeout(() => {
      fake.hold = null;
      fake.dropAll();
    }, 1_500);

    const stripe = await deliverUntilAcknowledged(() =>
      fulfillCheckoutSession(database, SESSION, 'evt_drop'),
    );

    expect(stripe.deliveries).toBeLessThanOrEqual(3);
    expect(await waitFor(() => balanceOf(fake) === opening + PACK_CREDITS)).toBe(true);
    await expectOneCompletedGrant(fake, opening, 'evt_drop');
    expect(balanceOf(fake)).toBe(opening + PACK_CREDITS);
  }, 30_000);

  it('a crash after the grant committed and before its trail: the retry on another instance writes the trail at the marker ledger key and grants nothing twice', async () => {
    const opening = 3;
    const fake = await startServer({ credits: { [UID]: { balance: opening } } });
    const first = await connectClient();
    fake.hold = (kind, _path, data) =>
      kind === 'merge' &&
      Object.keys((data ?? {}) as Record<string, unknown>).some((key) =>
        key.startsWith('processedStripeEvents/'),
      );

    void settle(fulfillCheckoutSession(first.database, SESSION, 'evt_crash'));
    const trailHeld = await waitFor(() => fake.log.some((line) => line.startsWith('HELD merge')));
    // The first instance dies with its trail unsent; Stripe never got a 2xx.
    await closeClient(first.app);
    fake.hold = null;
    const committedBalance = balanceOf(fake);

    const second = await connectClient();
    const stripe = await deliverUntilAcknowledged(() =>
      fulfillCheckoutSession(second.database, SESSION, 'evt_crash'),
    );

    expect(trailHeld).toBe(true);
    expect(committedBalance).toBe(opening + PACK_CREDITS);
    expect(stripe.errors).toEqual([]);
    await expectOneCompletedGrant(fake, opening, 'evt_crash');
    expect(balanceOf(fake), fake.log.join('\n')).toBe(opening + PACK_CREDITS);
    // The grant had committed before the crash: the retry reused its marker's ledger key.
    const marker = fake.get(`credits/${UID}/grantMarkers/evt_crash`) as {
      ledgerKey: string;
    } | null;
    expect(marker).not.toBeNull();
    expect(Object.keys(ledgerOf(fake))).toEqual([marker!.ledgerKey]);
  }, 30_000);

  it('a second delivery in the same process while the first grant is still pending never completes the trail from the pending local marker', async () => {
    const opening = 3;
    const fake = await startServer({ credits: { [UID]: { balance: opening } } });
    const { database } = await connectClient();
    fake.hold = (kind, path) => kind === 'tx' && path.startsWith('/credits');

    const firstDelivery = settle(fulfillCheckoutSession(database, SESSION, 'evt_dup'));
    await sleep(300);
    const secondDelivery = settle(fulfillCheckoutSession(database, SESSION, 'evt_dup'));
    await sleep(300);
    fake.hold = null;
    fake.dropAll();
    const outcomes = await Promise.all([firstDelivery, secondDelivery]);
    await sleep(1_500);

    // Stripe re-delivers every delivery that did not get a 2xx.
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        await deliverUntilAcknowledged(() => fulfillCheckoutSession(database, SESSION, 'evt_dup'));
      }
    }

    expect(await waitFor(() => balanceOf(fake) === opening + PACK_CREDITS)).toBe(true);
    await expectOneCompletedGrant(fake, opening, 'evt_dup');
    expect(balanceOf(fake)).toBe(opening + PACK_CREDITS);
  }, 30_000);
});

describe('R6-WR-06 (wire, kept): a write from another process that lands mid-grant survives, and duplicate delivery grants once', () => {
  /** Lets `competing` commit on the server the moment the grant's first write touching credits/ arrives. */
  function landBeforeFirstCreditsWrite(fake: FakeRtdbServer, competing: () => void): void {
    let fired = false;
    fake.beforeWrite = (kind, path, data) => {
      const touchesCredits =
        path.startsWith('/credits') ||
        (kind === 'merge' &&
          Object.keys((data ?? {}) as Record<string, unknown>).some((key) =>
            key.startsWith('credits/'),
          ));
      if (!fired && touchesCredits) {
        fired = true;
        competing();
      }
    };
  }

  it('a refund from another process: 3 + 1 + 5 = 9, and the ledger reconciles', async () => {
    const opening = 3;
    const fake = await startServer({ credits: { [UID]: { balance: opening } } });
    const { database } = await connectClient();
    landBeforeFirstCreditsWrite(fake, () => {
      fake.serverSet(`credits/${UID}/balance`, balanceOf(fake) + 1);
      fake.serverSet(`credits/${UID}/refundMarkers/jobX:e1`, {
        ledgerKey: 'Lrefund',
        createdAt: Date.now(),
      });
      fake.serverSet(`creditLedger/${UID}/Lrefund`, {
        type: 'refund',
        amount: 1,
        createdAt: Date.now(),
        ref: 'jobX',
      });
    });

    await fulfillCheckoutSession(database, SESSION, 'evt_refund_between');

    await expectOneCompletedGrant(fake, opening, 'evt_refund_between');
    expect(balanceOf(fake)).toBe(opening + 1 + PACK_CREDITS);
    expect(fake.get(`credits/${UID}/refundMarkers/jobX:e1`)).not.toBeNull();
  }, 30_000);

  it('a spend from another process: 3 - 1 + 5 = 7, no free credit', async () => {
    const opening = 3;
    const fake = await startServer({ credits: { [UID]: { balance: opening } } });
    const { database } = await connectClient();
    landBeforeFirstCreditsWrite(fake, () => {
      fake.serverSet(`credits/${UID}/balance`, balanceOf(fake) - 1);
      fake.serverSet(`creditLedger/${UID}/Lspend`, {
        type: 'spend',
        amount: -1,
        createdAt: Date.now(),
        ref: 'jobY',
      });
    });

    await fulfillCheckoutSession(database, SESSION, 'evt_spend_between');

    await expectOneCompletedGrant(fake, opening, 'evt_spend_between');
    expect(balanceOf(fake)).toBe(opening - 1 + PACK_CREDITS);
  }, 30_000);

  it('two instances fulfil the same Stripe event at once: granted once', async () => {
    const opening = 3;
    const fake = await startServer({ credits: { [UID]: { balance: opening } } });
    const a = await connectClient();
    const b = await connectClient();

    const outcomes = await Promise.all([
      settle(fulfillCheckoutSession(a.database, SESSION, 'evt_same')),
      settle(fulfillCheckoutSession(b.database, SESSION, 'evt_same')),
    ]);
    // Stripe re-delivers a delivery that did not get a 2xx.
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        await deliverUntilAcknowledged(() =>
          fulfillCheckoutSession(a.database, SESSION, 'evt_same'),
        );
      }
    }

    await expectOneCompletedGrant(fake, opening, 'evt_same');
    expect(balanceOf(fake)).toBe(opening + PACK_CREDITS);
  }, 30_000);
});
