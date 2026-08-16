import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  DemoAccountConfig,
  PrepPaidConfig,
  ReportsConfig,
  StartggConfig,
  StripeConfig,
} from '../config/env.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import type { StripeLikeClient } from '../routes/billing.js';
import { authHeader, buildTestApp } from '../test-support/testApp.js';
import { readSubjectKind } from './subjectKind.js';

/**
 * Phase 30.3 Gate 6 (owner/Codex hard gate: "never charge / no public
 * delivery" must be SERVER enforcement, not hidden UI).
 *
 * The four demo accounts are ordinary, login-bearing personal accounts — NOT
 * managed clients and NOT research tenants — so neither the coaching-tenant
 * protections nor the RTEN-03 research refusals cover them. Phase 30.1
 * closed the seven bearer-token mint/resolution chokepoints
 * (`demoDeliveryInventory.test.ts`); this suite closes the MONEY surface and
 * the remaining ROUTE-level delivery surfaces, and locks the (currently
 * empty) server-side export/download surface so a future one cannot ship
 * ungated.
 *
 * Every refusal below is paired with a positive control on a FIFTH ordinary,
 * non-demo account proving the behavior is demo-scoped — and, for the
 * checkout refusal, with a null-config control proving the very same uid
 * transacts normally when the allowlist is not configured.
 */

const DEMO_UID = 'demo-hbox-uid-1';
const OTHER_DEMO_UID = 'demo-izaw-uid-1';
const DEMO_TOKEN = 'demo-hbox-token';
const OTHER_DEMO_TOKEN = 'demo-izaw-token';

/** The fifth ORDINARY account — never allowlisted anywhere, the positive control for every refusal. */
const ORDINARY_UID = 'ordinary-fifth-account-uid';
const ORDINARY_TOKEN = 'ordinary-fifth-account-token';

const DEMO_CONFIG: DemoAccountConfig = { demoUids: new Set([DEMO_UID, OTHER_DEMO_UID]) };

const STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk-test-123',
  webhookSecret: 'whsec-test-456',
};

const STARTGG_CONFIG: StartggConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'http://localhost:3001/api/integrations/startgg/callback',
  apiToken: 'server-data-token',
  stateSecret: 'state-secret',
  webBaseUrl: 'http://localhost:5173',
};

/**
 * Fixture precondition (mirrors `isolationEnumeration.test.ts`'s money
 * block): NEITHER the demo uid NOR the ordinary control uid is in
 * `REPORTS_ALLOWED_UIDS` — a uid in that allowlist already generates for
 * free, which would make the demo-entitlement proof vacuous.
 */
const REPORTS_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set(['some-unrelated-allowlisted-uid']),
};

const VALID_REPORT = {
  overview: 'A fast-falling Fox/Falco player.',
  gameplan: ['Punish landing lag.'],
  characterStrategy: { picks: ['Mario'], reasoning: 'Game 1: Mario.' },
  stageStrategy: { bans: ['Final Destination'], picks: ['Battlefield'], reasoning: 'Flat stages.' },
  headToHead: null,
  watchFor: ['Shine spikes off stage.'],
  confidenceNotes: 'No sampled sets — treat this as a cold read.',
};

function scoutFetchMock(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes('ResolveBySlug') || body.query.includes('ResolveById')) {
      return new Response(
        JSON.stringify({
          data: {
            user: { id: 1111624, slug: 'user/07dc2239', player: { id: 1802316, gamerTag: 'Test' } },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({ data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } } } }),
    );
  }) as typeof fetch;
}

function stubReportsClient(): AnthropicLikeClient {
  return {
    messages: {
      parse: (async () => ({ stop_reason: 'end_turn', parsed_output: VALID_REPORT })) as never,
    },
  };
}

/**
 * A Stripe seam whose `checkout.sessions.create` is a spy — the ordering
 * proof for requirement 1 is "this spy was never called", which no
 * tree-emptiness assertion alone can establish (a Stripe call leaves no
 * local trace).
 */
function spyStripeClient(): { client: StripeLikeClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => ({
    id: 'cs_test_demo_guard',
    url: 'https://checkout.stripe.com/session/test',
  }));
  return {
    create,
    client: {
      checkout: { sessions: { create } },
      webhooks: {
        constructEvent: vi.fn(() => {
          throw new Error('constructEvent stub not configured for this test');
        }),
      },
    },
  };
}

/**
 * Fire-and-forget `void createEvent(...)` needs a macrotask tick before a
 * zero-row assertion is meaningful — the per-file drain helper convention
 * (`billing/credits.test.ts`, `isolationEnumeration.test.ts`).
 */
function flush(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

/**
 * Every tree a checkout attempt could touch — Stripe bookkeeping, the
 * canonical event ledger and its dedup/outbox siblings, and the whole credit
 * subsystem. Asserted ABSENT after a refused demo checkout.
 */
const MONEY_TREES = [
  'credits',
  'creditLedger',
  'creditLedgerByDay',
  'creditBundleOps',
  'processedStripeEvents',
  'processedStripeEventsByDay',
  'eventLedger',
  'eventDedup',
  'outboxPending',
  'reportJobs',
  'reportJobsByStatus',
  'reportJobsByDay',
] as const;

function buildMoneyApp(overrides: { demo?: DemoAccountConfig | null } = {}) {
  const { client, create } = spyStripeClient();
  const built = buildTestApp({
    startgg: STARTGG_CONFIG,
    startggFetch: scoutFetchMock(),
    reports: REPORTS_CONFIG,
    reportsClient: stubReportsClient(),
    stripe: STRIPE_CONFIG,
    stripeClient: client,
    webBaseUrl: 'https://grandfinals.gg',
    demo: 'demo' in overrides ? overrides.demo : DEMO_CONFIG,
  });
  built.auth.registerToken(DEMO_TOKEN, { uid: DEMO_UID, email: 'demo-hbox@test.com' });
  built.auth.registerToken(OTHER_DEMO_TOKEN, { uid: OTHER_DEMO_UID, email: 'demo-izaw@test.com' });
  built.auth.registerToken(ORDINARY_TOKEN, { uid: ORDINARY_UID, email: 'ordinary@test.com' });
  return { ...built, stripeCreate: create };
}

// ---------------------------------------------------------------------------
// Block 0: anti-vacuous fixture preconditions.
// ---------------------------------------------------------------------------

describe('demoMoneyGuards: fixture preconditions (anti-vacuous guards)', () => {
  it('neither the demo uid nor the ordinary control uid is in REPORTS_ALLOWED_UIDS', () => {
    expect(REPORTS_CONFIG.allowedUids.has(DEMO_UID)).toBe(false);
    expect(REPORTS_CONFIG.allowedUids.has(OTHER_DEMO_UID)).toBe(false);
    expect(REPORTS_CONFIG.allowedUids.has(ORDINARY_UID)).toBe(false);
  });

  it("the demo uid resolves 'ordinary' — every refusal below comes from the demo allowlist, not the research-kind gate", async () => {
    const { database } = buildMoneyApp();
    expect(await readSubjectKind(database as never, DEMO_UID)).toBe('ordinary');
    expect(await readSubjectKind(database as never, ORDINARY_UID)).toBe('ordinary');
  });
});

// ---------------------------------------------------------------------------
// Block 1 (requirement 1): checkout refusal, BEFORE any Stripe/event/ledger/
// credit operation.
// ---------------------------------------------------------------------------

describe('demoMoneyGuards: POST /api/billing/checkout refuses a demo account before any side effect', () => {
  it('answers 403, NEVER calls Stripe, and leaves every money/event tree untouched', async () => {
    const { app, database, stripeCreate } = buildMoneyApp();

    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(DEMO_TOKEN),
      payload: { packId: 'pack5', attemptId: 'demo-attempt-1' },
    });
    await flush();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'Forbidden', statusCode: 403 });

    // ORDERING PROOF: no Stripe Checkout Session was ever requested. A
    // tree-emptiness assertion alone cannot show this — a Stripe call
    // leaves no local trace.
    expect(stripeCreate).not.toHaveBeenCalled();

    const dump = database.dump() as Record<string, unknown>;
    for (const tree of MONEY_TREES) {
      expect(dump[tree]).toBeUndefined();
    }
    // Whole-tree byte equality: nothing at all was written, not merely
    // nothing in the enumerated trees.
    expect(JSON.stringify(database.dump())).toBe(before);
  });

  it('refuses the SECOND allowlisted demo uid too (not a one-uid fixture artifact)', async () => {
    const { app, database, stripeCreate } = buildMoneyApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(OTHER_DEMO_TOKEN),
      payload: { packId: 'pack15' },
    });
    await flush();

    expect(response.statusCode).toBe(403);
    expect(stripeCreate).not.toHaveBeenCalled();
    expect((database.dump() as Record<string, unknown>).eventLedger).toBeUndefined();
  });

  it('POSITIVE CONTROL: the fifth ORDINARY account checks out normally — Stripe is called once and checkout_started is emitted', async () => {
    const { app, database, stripeCreate } = buildMoneyApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(ORDINARY_TOKEN),
      payload: { packId: 'pack5', attemptId: 'ordinary-attempt-1' },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toBe('https://checkout.stripe.com/session/test');
    expect(stripeCreate).toHaveBeenCalledTimes(1);

    const dump = database.dump() as Record<string, unknown>;
    const ledgerByDay = (dump.eventLedger ?? {}) as Record<
      string,
      Record<string, { eventName?: string; actorId?: string }>
    >;
    const started = Object.values(ledgerByDay)
      .flatMap((day) => Object.values(day))
      .filter((envelope) => envelope.eventName === 'checkout_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.actorId).toBe(ORDINARY_UID);
  });

  it('NULL-CONFIG CONTROL: with the demo allowlist unconfigured, the very same uid checks out normally', async () => {
    const { app, stripeCreate } = buildMoneyApp({ demo: null });

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: authHeader(DEMO_TOKEN),
      payload: { packId: 'pack5' },
    });

    expect(response.statusCode).toBe(200);
    expect(stripeCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Block 2 (requirement 2): free report access as an ENTITLEMENT — the credit
// path is bypassed, never debited.
// ---------------------------------------------------------------------------

describe('demoMoneyGuards: a demo account generates reports free, bypassing (never debiting) the credit path', () => {
  it('generates with a ZERO balance and writes no creditLedger row and no credits node', async () => {
    const { app, database } = buildMoneyApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(DEMO_TOKEN),
      payload: { query: 'user/07dc2239', jobId: 'demo-free-job-1' },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    expect(response.json().report.overview).toBe(VALID_REPORT.overview);

    const dump = database.dump() as Record<string, unknown>;
    // BYPASS, not a grant: no balance node was ever created for this uid,
    // and no credit ledger row exists to reconcile.
    expect(dump.credits).toBeUndefined();
    expect(dump.creditLedger).toBeUndefined();
    expect(dump.creditLedgerByDay).toBeUndefined();
    // The job machine still ran (this is a real generation, not a stub) —
    // proving the 200 above is not a vacuous early return.
    const reportJobs = dump.reportJobs as Record<string, Record<string, { status?: string }>>;
    expect(reportJobs[DEMO_UID]!['demo-free-job-1']!.status).toBe('succeeded');
  });

  it('an EXISTING demo balance is left untouched by a generation (no silent debit)', async () => {
    const { app, database } = buildMoneyApp();
    database.seed(`credits/${DEMO_UID}/balance`, 4);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(DEMO_TOKEN),
      payload: { query: 'user/07dc2239', jobId: 'demo-free-job-2' },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${DEMO_UID}/balance`).get();
    expect(balance.val()).toBe(4);
    expect((database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
  });

  it('POSITIVE CONTROL: the fifth ORDINARY account is still charged exactly one credit per generation', async () => {
    const { app, database } = buildMoneyApp();
    database.seed(`credits/${ORDINARY_UID}/balance`, 3);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(ORDINARY_TOKEN),
      payload: { query: 'user/07dc2239', jobId: 'ordinary-paid-job-1' },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    const balance = await database.ref(`credits/${ORDINARY_UID}/balance`).get();
    expect(balance.val()).toBe(2);
    const ledger = (database.dump() as Record<string, unknown>).creditLedger as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(ledger[ORDINARY_UID]!)).toHaveLength(1);
  });

  it('POSITIVE CONTROL: the fifth ORDINARY account with a zero balance still gets the 402 paywall', async () => {
    const { app } = buildMoneyApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(ORDINARY_TOKEN),
      payload: { query: 'user/07dc2239', jobId: 'ordinary-broke-job-1' },
    });

    expect(response.statusCode).toBe(402);
  });

  it('GET /api/reports/config reports freeAccess for the demo account and NOT for the ordinary one', async () => {
    const { app } = buildMoneyApp();

    const demoConfig = await app.inject({
      method: 'GET',
      url: '/api/reports/config',
      headers: authHeader(DEMO_TOKEN),
    });
    const ordinaryConfig = await app.inject({
      method: 'GET',
      url: '/api/reports/config',
      headers: authHeader(ORDINARY_TOKEN),
    });

    expect(demoConfig.json()).toMatchObject({ enabled: true, freeAccess: true });
    expect(ordinaryConfig.json()).toMatchObject({ enabled: true, freeAccess: false });
  });

  it('GET /api/billing/credits reports freeAccess for the demo account and NOT for the ordinary one', async () => {
    const { app } = buildMoneyApp();

    const demoCredits = await app.inject({
      method: 'GET',
      url: '/api/billing/credits',
      headers: authHeader(DEMO_TOKEN),
    });
    const ordinaryCredits = await app.inject({
      method: 'GET',
      url: '/api/billing/credits',
      headers: authHeader(ORDINARY_TOKEN),
    });

    expect(demoCredits.json()).toMatchObject({ freeAccess: true });
    expect(ordinaryCredits.json()).toMatchObject({ freeAccess: false });
  });

  it('the v2.5 paid-prep activation gate still WINS over the demo entitlement (gate order preserved, not reordered)', async () => {
    // The gate is the FIRST statement in `POST /api/reports` and is
    // deliberately left above the demo entitlement: a prep-context request
    // 503s for a demo account exactly as it does for an allowlisted uid
    // while `PREP_PAID_REPORTS_ENABLED` is unset. Recorded as a test so a
    // future "make demo prep work" change has to confront the locked
    // ordering contract rather than silently invert it.
    const { app, database } = buildMoneyApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(DEMO_TOKEN),
      payload: { reason: 'prep_report', entryKey: 'evo-2026-ult', opponentName: 'rival' },
    });
    await flush();

    expect(response.statusCode).toBe(503);
    expect((database.dump() as Record<string, unknown>).reportJobs).toBeUndefined();
  });

  it('with the gate ON, a demo prep-context request generates without a debit (entitlement reaches the prep arm too)', async () => {
    const prepPaid: PrepPaidConfig = { enabled: true };
    const { client } = spyStripeClient();
    const built = buildTestApp({
      startgg: STARTGG_CONFIG,
      startggFetch: scoutFetchMock(),
      reports: REPORTS_CONFIG,
      reportsClient: stubReportsClient(),
      stripe: STRIPE_CONFIG,
      stripeClient: client,
      prepPaid,
      demo: DEMO_CONFIG,
    });
    built.auth.registerToken(DEMO_TOKEN, { uid: DEMO_UID, email: 'demo-hbox@test.com' });
    built.database.seed(`prepBriefs/${DEMO_UID}/evo-2026-ult`, {
      eventDate: 1_700_000_000_000,
      activatedAt: 1_700_000_000_000,
      lastOpenedAt: 1_700_000_000_000,
      likelyOpponents: { rival: true },
      scoutBindings: {
        rival: {
          provider: 'startgg',
          startggUserSlug: 'user/07dc2239',
          displayTag: 'Test',
          method: 'matchHistory',
          confirmedAt: 1,
        },
      },
    });

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(DEMO_TOKEN),
      payload: {
        reason: 'prep_report',
        entryKey: 'evo-2026-ult',
        opponentName: 'rival',
        jobId: 'demo-prep-job-1',
      },
    });
    await flush();

    expect(response.statusCode).toBe(200);
    const dump = built.database.dump() as Record<string, unknown>;
    expect(dump.credits).toBeUndefined();
    expect(dump.creditLedger).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Block 3 (requirement 3, ROUTE level): the anonymous public-delivery
// surfaces answer a demo-owned token identically to an unknown token.
//
// `demoDeliveryInventory.test.ts` proves the SERVICE-level mint/resolution
// refusals. This block proves the two root-scoped crawler surfaces — the
// recap/share HTML and the generated OG card — inherit them, since both are
// thin callers of the gated `RtdbService.getShareByToken`.
// ---------------------------------------------------------------------------

const OG_TOKEN = 'demoOgToken_-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OG_UNKNOWN_TOKEN = 'noSuchOgTok_-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OG_CONTROL_TOKEN = 'ordinaryOgTk_-aaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A minimal, valid 1x1 PNG — fine as a fake sprite/static-fallback fetch response. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function ogFetchRouter() {
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<html><head></head><body></body></html>'),
      arrayBuffer: () =>
        Promise.resolve(
          TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
        ),
    } as unknown as Response),
  );
}

function seedActiveShare(
  database: ReturnType<typeof buildTestApp>['database'],
  token: string,
  shareId: string,
  ownerUid: string,
): void {
  database.seed(`shareTokens/${token}`, {
    shareId,
    ownerUid,
    permissions: 'view',
    createdAt: 1000,
  });
  database.seed(`shareSnapshots/${shareId}`, {
    uid: ownerUid,
    matchId: 'match-1',
    createdAt: 1000,
    result: 'win',
    fighterId: 1,
    opponentFighterId: 3,
    stage: { id: 1, name: 'Battlefield' },
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    reviewedMomentsCount: 2,
    redaction: { includedNotes: false, includedTags: false, showDisplayName: false },
  });
}

describe('demoMoneyGuards: the anonymous crawler surfaces refuse a demo-owned token', () => {
  it('GET /s/:token/og.png returns the IDENTICAL static fallback for a demo-owned token as for an unknown token (no oracle)', async () => {
    const fetchImpl = ogFetchRouter();
    const { app, database } = buildTestApp({
      demo: DEMO_CONFIG,
      shareFetch: fetchImpl as unknown as typeof fetch,
    });
    seedActiveShare(database, OG_TOKEN, 'share-demo-1', DEMO_UID);

    const demoResponse = await app.inject({ method: 'GET', url: `/s/${OG_TOKEN}/og.png` });
    const unknownResponse = await app.inject({
      method: 'GET',
      url: `/s/${OG_UNKNOWN_TOKEN}/og.png`,
    });

    expect(demoResponse.statusCode).toBe(200);
    expect(demoResponse.rawPayload.equals(unknownResponse.rawPayload)).toBe(true);
  });

  it('POSITIVE CONTROL: an ordinary account’s token renders a card that DIFFERS from the unknown-token fallback', async () => {
    const fetchImpl = ogFetchRouter();
    const { app, database } = buildTestApp({
      demo: DEMO_CONFIG,
      shareFetch: fetchImpl as unknown as typeof fetch,
    });
    seedActiveShare(database, OG_CONTROL_TOKEN, 'share-ordinary-1', ORDINARY_UID);

    const controlResponse = await app.inject({
      method: 'GET',
      url: `/s/${OG_CONTROL_TOKEN}/og.png`,
    });
    const unknownResponse = await app.inject({
      method: 'GET',
      url: `/s/${OG_UNKNOWN_TOKEN}/og.png`,
    });

    expect(controlResponse.statusCode).toBe(200);
    expect(controlResponse.rawPayload.equals(unknownResponse.rawPayload)).toBe(false);
  });

  it('GET /api/vod-shares/:token 404s a demo-owned token but resolves an ordinary one', async () => {
    const { app, database } = buildTestApp({ demo: DEMO_CONFIG });
    seedActiveShare(database, OG_TOKEN, 'share-demo-2', DEMO_UID);
    seedActiveShare(database, OG_CONTROL_TOKEN, 'share-ordinary-2', ORDINARY_UID);

    const demoResponse = await app.inject({ method: 'GET', url: `/api/vod-shares/${OG_TOKEN}` });
    const controlResponse = await app.inject({
      method: 'GET',
      url: `/api/vod-shares/${OG_CONTROL_TOKEN}`,
    });

    expect(demoResponse.statusCode).toBe(404);
    expect(controlResponse.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Block 4 (requirement 4): the server-side export/download surface is EMPTY,
// locked.
//
// CSV export is entirely client-side today (`apps/web/src/pages/MatchData/
// lib/matchCsv.ts` builds a Blob from already-fetched matches) — there is no
// server endpoint that serves an export/download/print payload, so there is
// nothing to refuse. That is a fact about the current tree, not a permanent
// guarantee, so it is machine-checked here: the day someone adds a
// `text/csv` or `Content-Disposition: attachment` responder to the API, this
// lock fails and forces them to demo-gate it.
//
// The ONE binary payload the API does serve — `GET /s/:token/og.png` — is
// already demo-gated at its single resolution chokepoint (Block 3).
// ---------------------------------------------------------------------------

const API_SRC = resolve('src');

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Strips `//` and `/* *\/` comments so a comment-only mention never trips the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const DOWNLOAD_PAYLOAD_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'text/csv content type', pattern: /text\/csv/i },
  { name: 'Content-Disposition header', pattern: /content-disposition/i },
  { name: 'spreadsheet content type', pattern: /application\/vnd\.(ms-excel|openxmlformats)/i },
  // Deliberately the FULL download-forcing form (`attachment; filename=`)
  // rather than a bare `filename =`, which would false-positive on any
  // ordinary local variable of that name.
  { name: 'attachment filename', pattern: /attachment\s*;\s*filename/i },
];

const ALL_API_SOURCE_FILES = collectSourceFiles(API_SRC);

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

function discoverDownloadResponders(): { file: string; matched: string }[] {
  const hits: { file: string; matched: string }[] = [];
  for (const file of ALL_API_SOURCE_FILES) {
    const source = stripComments(readFileSync(file, 'utf-8'));
    for (const { name, pattern } of DOWNLOAD_PAYLOAD_PATTERNS) {
      if (pattern.test(source)) {
        hits.push({ file: relPath(file), matched: name });
      }
    }
  }
  return hits;
}

describe('demoMoneyGuards: the API serves no export/download/print payload (locked, requirement 4)', () => {
  it('discovers a non-trivial number of API source files (anti-vacuous-pass guard)', () => {
    expect(ALL_API_SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('no API source file emits a CSV/attachment/spreadsheet download payload', () => {
    // A new hit here is NOT a licence to extend this list — it means a
    // server-side export surface now exists and must be demo-gated the same
    // way `getShareByToken` is, with its own paired refusal + positive
    // control, BEFORE it is allowlisted here.
    expect(discoverDownloadResponders()).toEqual([]);
  });

  it.each([
    `reply.header('Content-Type', 'text/csv; charset=utf-8');`,
    `reply.header('Content-Disposition', 'attachment; filename="matches.csv"');`,
    `reply.type('application/vnd.ms-excel');`,
  ])('FIXTURE: a download responder IS detected by the scan — %s', (fixture) => {
    const matched = DOWNLOAD_PAYLOAD_PATTERNS.filter(({ pattern }) =>
      pattern.test(stripComments(fixture)),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it('FIXTURE: an ordinary local variable named `filename` does NOT trip the scan (no false positives)', () => {
    const fixture = `const filename = buildOgCardName(token);`;
    const matched = DOWNLOAD_PAYLOAD_PATTERNS.filter(({ pattern }) =>
      pattern.test(stripComments(fixture)),
    );
    expect(matched).toEqual([]);
  });
});
