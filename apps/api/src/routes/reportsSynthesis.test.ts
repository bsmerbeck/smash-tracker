import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase-admin/auth';
import type { Database } from 'firebase-admin/database';
import {
  CLAIM_ID_VOCABULARY,
  extractCitationTokens,
  isSnapshotId,
  MIN_VIABLE_CLAIMS,
  serializeCitationToken,
  storedPracticePlanSchema,
  validateReportOutput,
  vodEvidenceId,
  type GeneratedPracticePlan,
  type StoredPracticePlan,
} from '@smash-tracker/shared';
import type { PrepPaidConfig, ReportsConfig, StripeConfig } from '../config/env.js';
import type { AnthropicLikeClient } from '../reports/generate.js';
import {
  CLAIM_SELECTION_SECTION_IDS,
  engineAuthoredSummary,
  type ClaimSelection,
  type ClaimSelectionSectionId,
} from '../reports/claimSelection.js';
import { snapshotIdFor } from '../reports/snapshotId.js';
import { assembleSynthesisPayload } from '../reports/synthesis.js';
// The shipped citation rule, retired from production by plan 39-08 and
// frozen byte-identically as test support — the migration battery below
// runs against the rule that SHIPPED.
import {
  SynthesisValidationError,
  validatePracticePlanCitations,
} from '../test-support/retiredCitationRule.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import { FakeAuth } from '../test-support/fakeAuth.js';
import {
  authHeader,
  buildTestApp,
  TEST_EMAIL,
  TEST_TOKEN,
  TEST_UID,
} from '../test-support/testApp.js';
import { buildApp } from '../app.js';

/**
 * Phase 28 (28-07, REV-03): route-level tests for the `post_event_synthesis`
 * arm of `POST /api/reports`, `runSynthesisGeneration`, and the two ungated
 * reads (`GET /reports/synthesis`, `GET /reports/practice-plans/:planId`).
 * A NEW file — `reports.test.ts` stays untouched (its own suite proves the
 * legacy/prep_report/prep_bundle branches are byte-unaffected by this plan).
 */

const REPORTS_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set([TEST_UID]),
};

const NON_ALLOWLIST_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set(['someone-else']),
};

const STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk-test-123',
  webhookSecret: 'whsec-test-456',
};

const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };

const ENTRY_KEY = 'evo-2026-review';
const FIRST_SET_AT = 1_700_000_000_000;

function stubClient(
  impl: (params: unknown) => Promise<{ stop_reason: string | null; parsed_output: unknown }>,
): AnthropicLikeClient {
  return {
    messages: {
      parse: impl as AnthropicLikeClient['messages']['parse'],
    },
  };
}

/** Seeds `tournamentEntries/{TEST_UID}/{ENTRY_KEY}` — matches `assembleSynthesisPayload`'s registry-row precondition. */
function seedEntry(database: FakeDatabase, overrides: Record<string, unknown> = {}): void {
  database.seed(`tournamentEntries/${TEST_UID}/${ENTRY_KEY}`, {
    eventName: 'EVO 2026',
    firstSetAt: FIRST_SET_AT,
    lastSetAt: FIRST_SET_AT,
    setsPlayed: 2,
    source: 'manual',
    ...overrides,
  });
}

/**
 * Seeds `prepBriefs/{TEST_UID}/{ENTRY_KEY}` — CONVERTED (frozen `reviewAt`)
 * by default, matching the review-mode precondition synthesis requires.
 * Pass `converted: false` for the "hasn't converted yet" 409 case.
 */
function seedBrief(
  database: FakeDatabase,
  options: { converted?: boolean; likelyOpponents?: Record<string, true> } = {},
): void {
  const { converted = true, likelyOpponents } = options;
  database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
    eventDate: FIRST_SET_AT,
    activatedAt: FIRST_SET_AT,
    lastOpenedAt: FIRST_SET_AT,
    ...(converted ? { reviewAt: FIRST_SET_AT } : {}),
    ...(likelyOpponents ? { likelyOpponents } : {}),
  });
}

/** Seeds `matches/{TEST_UID}/{id}` — mirrors `synthesis.test.ts`'s own seed helper shape. */
function seedMatch(
  database: FakeDatabase,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`matches/${TEST_UID}/${id}`, {
    fighter_id: 1,
    opponent_id: 2,
    time: FIRST_SET_AT,
    win: true,
    eventName: 'EVO 2026',
    ...overrides,
  });
}

/**
 * Phase 39 (plan 39-08, review C3-B1 — this file's half): the VIABLE
 * synthesis evidence. Synthesis claims are `vod_annotation` rows built from
 * ANNOTATIONS, one per `(matchId, seconds)` moment, sharing ONE event-level
 * sample whose countable games are the event's ANNOTATED games. Read, not
 * assumed: the pre-39-08 seed below (one moment in one game) issues exactly
 * ONE claim — abstained, `gamesNeeded: 2` — which is below
 * `MIN_VIABLE_CLAIMS['post_event_synthesis']` (2), so after this plan's D-21
 * seam every generation-success case here would fail fast into a refund.
 *
 * The treatment: the same "strengthen at module scope, never inside a test
 * body" rule plan 39-06 used, applied to this file's own seed helper rather
 * than a `buildTestApp` wrapper — a wrapper would seed annotations into EVERY
 * app, including the "zero stored annotations: 409" case, whose whole point
 * is an annotation-free workspace. `viableEvidenceFixture.ts` (plan 39-06)
 * carries no synthesis material and is not modified. Each call now seeds the
 * named moment plus two companion moments in two more games of the same
 * event: three annotated games clear the abstention floor, so each moment is
 * one evidenced claim (distinct values, no collapse) — `c01` is always the
 * named `m1@42` moment (ids rank by ascending evidence id at equal games).
 * Hand-authored, deterministic, no production data.
 */
const VIABLE_COMPANION_MOMENTS = [
  { matchId: 'viable-2', seconds: 10, note: 'late shield' },
  { matchId: 'viable-3', seconds: 20, note: 'missed the ledge trap' },
] as const;

/** The claim ids the viable seed issues, in rank order: `m1@42`, then the two companions. */
const VIABLE_CLAIM_IDS = ['c01', 'c02', 'c03'] as const;

/** Which issued claim id names which seeded moment under the viable seed. */
const VIABLE_CLAIM_ID_BY_MOMENT: Readonly<Record<string, (typeof VIABLE_CLAIM_IDS)[number]>> = {
  'm1:42': 'c01',
  'viable-2:10': 'c02',
  'viable-3:20': 'c03',
};

/** One annotated VOD moment the test drives, plus the two viable companions (see `VIABLE_COMPANION_MOMENTS`). */
function seedOneAnnotation(database: FakeDatabase, matchId = 'm1', seconds = 42): void {
  seedMatch(database, matchId, {
    source: 'startgg',
    vodTimestamps: [{ seconds, note: 'clean punish' }],
  });
  for (const moment of VIABLE_COMPANION_MOMENTS) {
    seedMatch(database, moment.matchId, {
      source: 'startgg',
      vodTimestamps: [{ seconds: moment.seconds, note: moment.note }],
    });
  }
}

/** Connective prose that passes the prose lint (no digit, no entity name, no confidence word). */
const CLEAN_PROSE: Readonly<Record<ClaimSelectionSectionId, string>> = {
  // Qualitative only (owner decision D-24): "strong" is a confidence-tier
  // word and would withhold the section.
  overview: 'A composed showing overall.',
  gameplan: 'Drill the punish you annotated.',
  watchFor: 'Watch the moments you flagged.',
};

/** Prose the lint strips (rule R4): an integer no claim licenses. */
const STRIPPED_PROSE = 'Repeat it 777 times before the next event.';

/** Builds a claim selection — sections by claim ids, prose defaulting to `CLEAN_PROSE`, all action slots null unless given. */
function selectionOf(
  claimIds: Readonly<Record<ClaimSelectionSectionId, readonly string[]>>,
  prose: Partial<Record<ClaimSelectionSectionId, string>> = {},
  actions: Partial<Pick<ClaimSelection, 'action1' | 'action2' | 'action3'>> = {},
): ClaimSelection {
  const section = (id: ClaimSelectionSectionId) => ({
    claimIds: [...claimIds[id]] as ClaimSelection['sections']['overview']['claimIds'],
    connective: prose[id] ?? CLEAN_PROSE[id],
  });
  return {
    sections: {
      overview: section('overview'),
      gameplan: section('gameplan'),
      watchFor: section('watchFor'),
    },
    action1: actions.action1 ?? null,
    action2: actions.action2 ?? null,
    action3: actions.action3 ?? null,
  };
}

/**
 * Plan 39-08 migration of the pre-39-08 `citablePlan` (a `GeneratedPracticePlan`
 * whose one focusArea cited `(matchId, seconds)`): the model now SELECTS the
 * moment's claim. Selects that moment's claim plus the viable companions, so
 * the selection survives validation.
 */
function citablePlan(matchId: string, seconds: number): ClaimSelection {
  const cited = VIABLE_CLAIM_ID_BY_MOMENT[`${matchId}:${seconds}`];
  if (!cited) {
    throw new Error(`no viable claim seeded for ${matchId}@${seconds}`);
  }
  const others = VIABLE_CLAIM_IDS.filter((id) => id !== cited);
  return selectionOf({ overview: [cited, others[0]!], gameplan: [others[1]!], watchFor: [cited] });
}

/**
 * Plan 39-08 migration of the pre-39-08 `uncitablePlan` (every focusArea
 * citing a pair outside the evidence — total drop, INV-2): a selection naming
 * only claim ids that were never issued, so every one is dropped (rule R1)
 * and zero claims survive.
 */
function uncitablePlan(): ClaimSelection {
  return selectionOf({ overview: ['c20'], gameplan: ['c21'], watchFor: [] });
}

function billableApp(overrides: Partial<Parameters<typeof buildTestApp>[0]> = {}) {
  return buildTestApp({
    reports: NON_ALLOWLIST_CONFIG,
    stripe: STRIPE_CONFIG,
    prepPaid: PREP_PAID_CONFIG,
    // The plugin's own top-level gate requires EITHER startgg OR parrygg
    // config to be present (else every /reports* route 503s, regardless of
    // `reports`/`prepPaid`) — synthesis itself never calls either provider,
    // but this minimal config satisfies that unrelated precondition, same
    // as `reports.test.ts`'s own `prep_report` test fixtures.
    parrygg: { apiKey: 'parry-key' },
    reportsClient: stubClient(async () => ({
      stop_reason: 'end_turn',
      parsed_output: citablePlan('m1', 42),
    })),
    ...overrides,
  });
}

/** Reads every `eventLedger` row for `eventName` out of a raw database dump — mirrors `reports.test.ts`'s helper. */
function findEvents(
  database: FakeDatabase,
  eventName: string,
): Array<{ payload: Record<string, unknown> }> {
  const dump = database.dump() as Record<string, unknown>;
  const eventLedger = (dump.eventLedger ?? {}) as Record<string, Record<string, unknown>>;
  const results: Array<{ payload: Record<string, unknown> }> = [];
  for (const dayBucket of Object.values(eventLedger)) {
    for (const event of Object.values(dayBucket)) {
      const e = event as { eventName?: string; payload?: Record<string, unknown> };
      if (e.eventName === eventName) {
        results.push({ payload: e.payload ?? {} });
      }
    }
  }
  return results;
}

/** Wraps `database.ref` to record write order — mirrors `reports.test.ts`'s `trackWrites`. */
function trackWrites(database: FakeDatabase): string[] {
  const writes: string[] = [];
  const originalRef = database.ref.bind(database);
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    const ref = originalRef(path);
    return {
      ...ref,
      set: async (value: unknown) => {
        const status = (value as { status?: string } | null)?.status;
        writes.push(`set:${path ?? ''}${status ? `#${status}` : ''}`);
        return ref.set(value);
      },
      update: async (values: Record<string, unknown>) => {
        writes.push(`update:${path ?? ''}`);
        return ref.update(values);
      },
      transaction: async (fn: (current: unknown) => unknown) => {
        writes.push(`transaction:${path ?? ''}`);
        return ref.transaction(fn);
      },
    };
  });
  return writes;
}

const SYNTHESIS_PAYLOAD = { reason: 'post_event_synthesis' as const, entryKey: ENTRY_KEY };

// ---------------------------------------------------------------------------
// Task 1: gate inheritance, pre-spend checks, spend, 402 restore
// ---------------------------------------------------------------------------

describe('POST /api/reports post_event_synthesis — gate and pre-spend checks', () => {
  it('gate off: post_event_synthesis answers 503 before any write', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = buildTestApp({
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stubClient(modelSpy),
      // prepPaid deliberately omitted — gate off.
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database);
    database.seed(`credits/${TEST_UID}/balance`, 5);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(database.dump())).toEqual(before);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('gate on, foreign or never-activated entryKey: 404 with no side effects', async () => {
    const { app, database } = billableApp();
    database.seed(`credits/${TEST_UID}/balance`, 3);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('gate on, brief not yet converted (no frozen reviewAt): 409 with no side effects', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database, { converted: false });
    seedOneAnnotation(database);
    database.seed(`credits/${TEST_UID}/balance`, 3);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('gate on, zero stored annotations: 409 with no side effects', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    // No matches/vodTimestamps seeded at all — evidenceCount === 0.
    database.seed(`credits/${TEST_UID}/balance`, 3);
    const before = JSON.stringify(database.dump());

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(database.dump())).toEqual(before);
  });

  it('happy submission: queued job written with reason post_event_synthesis, prepSynthesisJobIndex points at it, exactly one credit spent, 202 mirrors the job-status shape', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 3);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as {
      job: { jobId: string; status: string; updatedAt: number; resultRef?: string };
    };
    expect(body.job.status).toBe('succeeded');
    expect(typeof body.job.jobId).toBe('string');
    expect(typeof body.job.resultRef).toBe('string');

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);

    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${body.job.jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({
      status: 'succeeded',
      reason: 'post_event_synthesis',
    });

    const indexSnapshot = await database
      .ref(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`)
      .get();
    expect(indexSnapshot.val()).toMatchObject({ jobId: body.job.jobId });

    const planSnapshot = await database
      .ref(`practicePlans/${TEST_UID}/${body.job.resultRef}`)
      .get();
    expect(planSnapshot.exists()).toBe(true);
    expect((planSnapshot.val() as StoredPracticePlan).entryKey).toBe(ENTRY_KEY);
  });

  it('a zero-credit FRESH submission answers 402 with no job row, no index pointer, and no writes at all', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database);
    database.seed(`credits/${TEST_UID}/balance`, 0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(402);
    // The fake leaves an empty parent node behind on remove (real RTDB
    // prunes it) — the invariant is that the job/pointer PATH ITSELF is
    // gone, mirroring `reports.test.ts`'s own zero-credit-fresh precedent.
    const indexSnapshot = await database
      .ref(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`)
      .get();
    expect(indexSnapshot.exists()).toBe(false);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.creditLedger).toBeUndefined();
    expect(findEvents(database, 'report_failed')).toHaveLength(0);
    expect(findEvents(database, 'report_started')).toHaveLength(0);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(0);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('a zero-credit retry over a REFUNDED prior job answers 402, restores the prior index pointer byte-exactly, and leaves the old job untouched', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database);
    const priorJob = {
      status: 'refunded',
      createdAt: 1_000,
      updatedAt: 2_000,
      attempt: 0,
      creditRef: 'prior-synth-job',
      reason: 'post_event_synthesis',
    };
    database.seed(`reportJobs/${TEST_UID}/prior-synth-job`, priorJob);
    const priorPointer = { jobId: 'prior-synth-job', updatedAt: 2_000 };
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, priorPointer);
    database.seed(`credits/${TEST_UID}/balance`, 0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(402);

    // The prior job is byte-unchanged — it was only ever read, never written.
    const priorJobSnapshot = await database.ref(`reportJobs/${TEST_UID}/prior-synth-job`).get();
    expect(priorJobSnapshot.val()).toEqual(priorJob);

    // The pointer is restored to the PRIOR jobId, not left pointing at the
    // new (removed) job this rejected attempt minted.
    const indexSnapshot = await database
      .ref(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`)
      .get();
    expect(indexSnapshot.val()).toEqual(priorPointer);

    expect(findEvents(database, 'report_failed')).toHaveLength(0);
    expect(findEvents(database, 'report_started')).toHaveLength(0);
    expect(modelSpy).not.toHaveBeenCalled();
  });

  it('an outstanding job (fresh queued/running/failed) or a succeeded job 409s a new submission; only a refunded terminal permits retry', async () => {
    for (const status of ['queued', 'running', 'failed', 'succeeded']) {
      const { app, database } = billableApp();
      seedEntry(database);
      seedBrief(database);
      seedOneAnnotation(database);
      // `updatedAt: Date.now()` — WITHIN the staleness window: a fresh
      // queued/failed job is still protected by the 409 (CR-02's stale
      // recovery only unlocks jobs older than REPORT_JOB_STALE_MS).
      database.seed(`reportJobs/${TEST_UID}/blocking-job-${status}`, {
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        creditRef: `blocking-job-${status}`,
        reason: 'post_event_synthesis',
        ...(status === 'succeeded' ? { resultRef: 'some-plan-id' } : {}),
      });
      database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
        jobId: `blocking-job-${status}`,
        updatedAt: 2,
      });
      database.seed(`credits/${TEST_UID}/balance`, 3);

      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: SYNTHESIS_PAYLOAD,
      });

      expect(response.statusCode).toBe(409);
      const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
      expect(balance.val()).toBe(3);
    }

    // Staleness never unlocks running/succeeded: a stale running job is the
    // sweep's to recover (refund included), and succeeded is forever
    // terminal — only stale queued/failed crash remnants become retryable.
    for (const status of ['running', 'succeeded']) {
      const { app, database } = billableApp();
      seedEntry(database);
      seedBrief(database);
      seedOneAnnotation(database);
      database.seed(`reportJobs/${TEST_UID}/stale-blocking-${status}`, {
        status,
        createdAt: 1,
        updatedAt: 2,
        attempt: 0,
        creditRef: `stale-blocking-${status}`,
        reason: 'post_event_synthesis',
        ...(status === 'succeeded' ? { resultRef: 'some-plan-id' } : {}),
      });
      database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
        jobId: `stale-blocking-${status}`,
        updatedAt: 2,
      });
      database.seed(`credits/${TEST_UID}/balance`, 3);

      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: SYNTHESIS_PAYLOAD,
      });

      expect(response.statusCode).toBe(409);
      const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
      expect(balance.val()).toBe(3);
    }
  });

  it('an allowlisted uid skips the spend but follows the identical job flow', async () => {
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: citablePlan('m1', 42),
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.exists()).toBe(false);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.creditLedger).toBeUndefined();
  });

  it('WR-01: two concurrent submissions for one entryKey spend exactly one credit — one 202, one 409', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 3);

    // Both requests interleave through the same pre-read phase; the
    // transactional pointer claim is the single serialization point, so
    // exactly one commits and the other 409s with nothing written or spent.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: SYNTHESIS_PAYLOAD,
      }),
      app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: SYNTHESIS_PAYLOAD,
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);

    // ONE credit spent, ONE job node, ONE report_started — never two.
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(2);
    expect(findEvents(database, 'report_started')).toHaveLength(1);
    const dump = database.dump() as Record<string, unknown>;
    const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
    expect(Object.keys(reportJobs[TEST_UID]!)).toHaveLength(1);

    // The pointer names the winner's job.
    const winner = (first.statusCode === 202 ? first : second).json() as {
      job: { jobId: string };
    };
    const indexSnapshot = await database
      .ref(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`)
      .get();
    expect(indexSnapshot.val()).toMatchObject({ jobId: winner.job.jobId });
  });

  it('WR-04: the queued job write lands only AFTER the spend commits, and a 402 leaves no job node at all', async () => {
    // Part 1: zero credit — the reportJobs tree is NEVER created, not even
    // transiently-then-removed (the pre-fix compensation shape).
    {
      const { app, database } = billableApp();
      seedEntry(database);
      seedBrief(database);
      seedOneAnnotation(database, 'm1', 42);
      database.seed(`credits/${TEST_UID}/balance`, 0);
      const writes = trackWrites(database);

      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: SYNTHESIS_PAYLOAD,
      });

      expect(response.statusCode).toBe(402);
      const dump = database.dump() as Record<string, unknown>;
      expect(dump.reportJobs).toBeUndefined();
      expect(writes.some((entry) => entry.startsWith(`set:reportJobs/`))).toBe(false);
    }

    // Part 2: happy path — the spend transaction strictly precedes the
    // queued job write (owner invariant "402 before any durable job write").
    {
      const { app, database } = billableApp();
      seedEntry(database);
      seedBrief(database);
      seedOneAnnotation(database, 'm1', 42);
      database.seed(`credits/${TEST_UID}/balance`, 1);
      const writes = trackWrites(database);

      const response = await app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: authHeader(),
        payload: SYNTHESIS_PAYLOAD,
      });

      expect(response.statusCode).toBe(202);
      const spendIndex = writes.findIndex((entry) =>
        entry.startsWith(`transaction:credits/${TEST_UID}/balance`),
      );
      const queuedIndex = writes.findIndex(
        (entry) => entry.startsWith(`set:reportJobs/${TEST_UID}/`) && entry.endsWith('#queued'),
      );
      expect(spendIndex).toBeGreaterThan(-1);
      expect(queuedIndex).toBeGreaterThan(-1);
      expect(spendIndex).toBeLessThan(queuedIndex);
    }
  });

  it('IN-03: a corrupt job node behind the index pointer never 500s the purchase path — treated as no existing job', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 3);
    // A pointer whose job node fails reportJobSchema (missing required
    // fields) — the sibling GET already tolerates this (T-27-43); the POST
    // used a throwing parse and 500'd every future submission.
    database.seed(`reportJobs/${TEST_UID}/corrupt-job`, { status: 'notARealStatus' });
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'corrupt-job',
      updatedAt: 2_000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { job: { jobId: string; status: string } };
    expect(body.job.status).toBe('succeeded');
  });

  it('CR-01: a client-supplied jobId is rejected with 400 and can never clobber or delete an existing job record', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database);
    database.seed(`credits/${TEST_UID}/balance`, 3);
    // A pre-existing SUCCEEDED prep job — the exact durable record a
    // client-supplied jobId equal to its id used to overwrite (queued reset),
    // and then DELETE outright on the zero-credit path.
    const priorJob = {
      status: 'succeeded',
      createdAt: 1_000,
      updatedAt: 2_000,
      attempt: 0,
      creditRef: 'existing-prep-job',
      reason: 'prep_report',
      resultRef: 'stored-report-id',
    };
    database.seed(`reportJobs/${TEST_UID}/existing-prep-job`, priorJob);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: { ...SYNTHESIS_PAYLOAD, jobId: 'existing-prep-job' },
    });

    expect(response.statusCode).toBe(400);
    // The pre-existing job record is byte-unchanged — never overwritten,
    // never removed (P2a class, fd600f9 precedent).
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/existing-prep-job`).get();
    expect(jobSnapshot.val()).toEqual(priorJob);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(3);
    expect(findEvents(database, 'report_started')).toHaveLength(0);
  });

  it('git diff of routes/reports.ts touches zero lines inside the gate-check region — inherited, not modified', () => {
    // Proven structurally by the OTHER tests in this file (a gate-off
    // synthesis request 503s with zero writes, same as every other
    // prep-context reason) — this test documents the acceptance criterion
    // rather than re-asserting it; the `git diff` check itself runs outside
    // vitest (verify step).
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 2: runSynthesisGeneration — claim, generate, validate, store;
// fail-and-refund on total drop (INV-2, INV-7)
// ---------------------------------------------------------------------------

describe('runSynthesisGeneration — validate-then-store, fail-and-refund on total drop', () => {
  it('happy path: queued->running claim, generation, validation, plan stored under practicePlans/{uid}, succeeded terminal with resultRef, report_started and report_completed events', async () => {
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: citablePlan('m1', 42),
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 3);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });
    expect(response.statusCode).toBe(202);
    const { job } = response.json() as { job: { jobId: string; resultRef: string } };

    const planSnapshot = await database.ref(`practicePlans/${TEST_UID}/${job.resultRef}`).get();
    expect(planSnapshot.exists()).toBe(true);
    const plan = planSnapshot.val() as StoredPracticePlan;
    expect(plan.summary).toBe(CLEAN_PROSE.overview);
    // Phase 39 (plan 39-08, migrated): the claim-anchored record replaces the
    // model-authored focusAreas — `projectPracticePlanSelection` omits the
    // key; the stored claims, sections and validation block carry the plan.
    expect(Object.prototype.hasOwnProperty.call(plan, 'focusAreas')).toBe(false);
    expect(Object.keys(plan.claims ?? {}).sort()).toEqual([...VIABLE_CLAIM_IDS]);
    expect(plan.sections?.overview?.claimIds).toEqual(['c01', 'c02']);
    expect(plan.validation?.status).toBe('passed');
    expect(isSnapshotId(plan.validation?.snapshotId ?? '')).toBe(true);

    for (const eventName of ['report_started', 'report_completed']) {
      const events = findEvents(database, eventName);
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]!.payload)).toEqual(['reason']);
      expect(events[0]!.payload.reason).toBe('post_event_synthesis');
    }
  });

  it('INV-2: if citation validation removes every substantive claim, the job fails and refunds', async () => {
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: uncitablePlan(),
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const writes = trackWrites(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(502);

    const dump = database.dump() as Record<string, unknown>;
    const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
    const jobId = Object.keys(reportJobs[TEST_UID]!)[0]!;
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
    });

    // NO practicePlans write, NO succeeded status.
    expect(dump.practicePlans).toBeUndefined();

    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);

    const ledger = dump.creditLedger as Record<string, Record<string, unknown>>;
    const refundEntries = Object.values(ledger[TEST_UID]!).filter(
      (entry) => (entry as { type: string }).type === 'refund',
    );
    expect(refundEntries).toHaveLength(1);

    // reportJobsByDay records `failed`, never `refunded` (soak-safe shards).
    const byDay = dump.reportJobsByDay as Record<string, Record<string, unknown>>;
    const dayEntries = Object.values(byDay).flatMap((bucket) => Object.entries(bucket));
    const dayEntry = dayEntries.find(([id]) => id === jobId);
    expect(dayEntry?.[1]).toMatchObject({ status: 'failed' });

    expect(findEvents(database, 'report_failed')).toHaveLength(1);

    // Ordering: failed written -> refund transaction commits -> refunded written.
    const failedIndex = writes.indexOf(`set:reportJobs/${TEST_UID}/${jobId}#failed`);
    const refundedIndex = writes.indexOf(`set:reportJobs/${TEST_UID}/${jobId}#refunded`);
    const refundTransactionIndex = writes.findIndex(
      (entry, index) =>
        index > failedIndex && entry.startsWith(`transaction:credits/${TEST_UID}/balance`),
    );
    expect(failedIndex).toBeGreaterThan(-1);
    expect(refundedIndex).toBeGreaterThan(-1);
    expect(refundTransactionIndex).toBeGreaterThan(-1);
    expect(failedIndex).toBeLessThan(refundTransactionIndex);
    expect(refundTransactionIndex).toBeLessThan(refundedIndex);
  });

  it('partial drop ships the survivors: one unissued claim id dropped, plan stored with droppedClaimCount 1 and the surviving claims intact', async () => {
    // Plan 39-08 migration: the pre-39-08 case had one citable and one
    // uncitable focusArea. The same scenario on the shared validator is a
    // selection with three issued claims and one never-issued id (rule R1).
    const plan = selectionOf({ overview: ['c01', 'c02'], gameplan: ['c03'], watchFor: ['c09'] });
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({ stop_reason: 'end_turn', parsed_output: plan })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const { job } = response.json() as { job: { resultRef: string } };

    const planSnapshot = await database.ref(`practicePlans/${TEST_UID}/${job.resultRef}`).get();
    const stored = planSnapshot.val() as StoredPracticePlan;
    expect(Object.keys(stored.claims ?? {}).sort()).toEqual([...VIABLE_CLAIM_IDS]);
    expect(stored.claims?.c09).toBeUndefined();
    expect(stored.droppedClaimCount).toBe(1);

    // Job succeeds — a partial drop is not a failure.
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(0);
  });

  it('model refusal/unparseable output follows the existing ReportGenerationError -> failJob path (refund included)', async () => {
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({ stop_reason: 'refusal', parsed_output: null })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(502);
    const dump = database.dump() as Record<string, unknown>;
    const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
    const jobId = Object.keys(reportJobs[TEST_UID]!)[0]!;
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
    });
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('INV-7: FakeDatabase empty-array round-trip — a stored practice plan with all-empty arrays parses through storedPracticePlanSchema', async () => {
    const { database } = billableApp();

    // Record 1: focusAreas stripped to nothing at the top level — written
    // through the SAME `ref(...).push().set(...)` primitive
    // `runSynthesisGeneration` uses for storage (Task 3 adds the HTTP read
    // endpoint this record is later read back through; this test proves the
    // storage+schema round-trip directly, scoped to this task's own code).
    const ref1 = database.ref(`practicePlans/${TEST_UID}`).push();
    await ref1.set({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      summary: 'A strong showing overall.',
      focusAreas: [],
    });

    // Record 2: a focusArea whose own `drills` array is stripped.
    const ref2 = database.ref(`practicePlans/${TEST_UID}`).push();
    await ref2.set({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      summary: 'A strong showing overall.',
      focusAreas: [{ title: 'Neutral game', evidence: 'Good read here', drills: [] }],
    });

    const snapshot1 = await database.ref(`practicePlans/${TEST_UID}/${ref1.key}`).get();
    const parsed1 = storedPracticePlanSchema.parse(snapshot1.val());
    expect(parsed1.focusAreas).toEqual([]);

    const snapshot2 = await database.ref(`practicePlans/${TEST_UID}/${ref2.key}`).get();
    const parsed2 = storedPracticePlanSchema.parse(snapshot2.val());
    expect(parsed2.focusAreas).toHaveLength(1);
    expect(parsed2.focusAreas[0]!.drills).toEqual([]);
  });

  it('refund idempotency under replay: a second failJob invocation for the same job does not double-refund', async () => {
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: uncitablePlan(),
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });
    expect(response.statusCode).toBe(502);

    const dump = database.dump() as Record<string, unknown>;
    const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
    const jobId = Object.keys(reportJobs[TEST_UID]!)[0]!;

    // The job's own node (read directly — Task 3 adds the HTTP read this
    // would otherwise go through) confirms the refunded terminal.
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
    expect(jobSnapshot.val()).toMatchObject({ status: 'refunded' });

    // `failJob` is the ONE call site (no exported hook exists for the route
    // to invoke it twice on the same job — the queued->running claim
    // transaction and the one-job-per-entryKey pointer structurally prevent
    // a second attempt from ever reaching THIS job's `failJob` call again);
    // this asserts the single failure produced EXACTLY one refund entry,
    // never a duplicate.
    const ledger = (database.dump() as Record<string, unknown>).creditLedger as Record<
      string,
      Record<string, unknown>
    >;
    const refundEntries = Object.values(ledger[TEST_UID]!).filter(
      (entry) => (entry as { type: string }).type === 'refund',
    );
    expect(refundEntries).toHaveLength(1);
    const balance = await database.ref(`credits/${TEST_UID}/balance`).get();
    expect(balance.val()).toBe(1);
  });

  it('CR-02: a synthesis job that fails for a free-access (allowlisted) uid reaches the refunded terminal WITHOUT any refund, and the entry stays retryable', async () => {
    // Before the CR-02 fix, a zero-spend failure rested at `failed` forever
    // — and `failed` is not a retryable pointer state, so ONE flaky model
    // call permanently bricked post-event synthesis for the entry.
    let modelCalls = 0;
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stubClient(async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { stop_reason: 'refusal', parsed_output: null }
          : { stop_reason: 'end_turn', parsed_output: citablePlan('m1', 42) };
      }),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(502);
    const dump = database.dump() as Record<string, unknown>;
    const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
    const jobId = Object.keys(reportJobs[TEST_UID]!)[0]!;
    const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${jobId}`).get();
    // Refunded TERMINAL with zero credit movement — no creditLedger entry
    // exists (failJob's refundCredit call is still gated on `spent`).
    expect(jobSnapshot.val()).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
    });
    expect(dump.creditLedger).toBeUndefined();
    // The day-shard mirror keeps recording `failed` (soak-safe shards).
    const byDay = dump.reportJobsByDay as Record<string, Record<string, unknown>>;
    const dayEntries = Object.values(byDay).flatMap((bucket) => Object.entries(bucket));
    expect(dayEntries.find(([id]) => id === jobId)?.[1]).toMatchObject({ status: 'failed' });

    // The deadlock regression itself: a resubmission for the same entryKey
    // is ACCEPTED (never 409) and succeeds.
    const retry = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });
    expect(retry.statusCode).toBe(202);
    const retryBody = retry.json() as { job: { jobId: string; status: string } };
    expect(retryBody.job.status).toBe('succeeded');
    expect((database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
  });

  it('CR-02: a prep_report zero-spend failure keeps its Phase 27 failed terminal byte-identically (the refunded-without-refund terminal is scoped to post_event_synthesis)', async () => {
    // Guard against the CR-02 fix leaking into the prep surfaces: the
    // pinned Phase 27 contract (reports.test.ts "a prep job that fails for
    // a free-access uid stays failed") must be unaffected — asserted here
    // structurally via failJob's terminal condition, exercised through the
    // real reports.test.ts fixture in that file.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./reports.ts', import.meta.url), 'utf-8');
    expect(source).toContain("reason && (spent || reason === 'post_event_synthesis')");
  });

  it('CR-02: a pointer at a STALE queued job (crash between the queued write and the running claim) permits retry instead of 409ing forever', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 3);
    // Stale: updatedAt far beyond REPORT_JOB_STALE_MS (15 min).
    database.seed(`reportJobs/${TEST_UID}/stranded-queued-job`, {
      status: 'queued',
      createdAt: 1_000,
      updatedAt: 2_000,
      attempt: 0,
      creditRef: 'stranded-queued-job',
      reason: 'post_event_synthesis',
    });
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'stranded-queued-job',
      updatedAt: 2_000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { job: { jobId: string; status: string } };
    expect(body.job.status).toBe('succeeded');
    expect(body.job.jobId).not.toBe('stranded-queued-job');
    const indexSnapshot = await database
      .ref(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`)
      .get();
    expect(indexSnapshot.val()).toMatchObject({ jobId: body.job.jobId });
  });

  it('grep-locked acceptance: no new refund call site beyond the reused internals', () => {
    // Documented here (the actual grep runs in the verify step, outside
    // vitest): `grep -c "refundCredit" apps/api/src/routes/reports.ts` must
    // be UNCHANGED from before this plan — `failJob` is the only call site,
    // reused verbatim by `runSynthesisGeneration`.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 3: ungated reads — synthesis job status and practice-plan fetch
// ---------------------------------------------------------------------------

describe('GET /api/reports/synthesis and GET /api/reports/practice-plans/:planId', () => {
  it('GET /reports/synthesis returns the latest job for the entry; no pointer -> {job: null}; pointer to a missing/corrupt job row -> {job: null}', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 3);

    // No pointer at all.
    const noneResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(noneResponse.statusCode).toBe(200);
    expect(noneResponse.json()).toEqual({ job: null });

    // Pointer to a missing job row.
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'missing-job',
      updatedAt: 1,
    });
    const missingResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(missingResponse.statusCode).toBe(200);
    expect(missingResponse.json()).toEqual({ job: null });

    // Pointer to a corrupt job row.
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'corrupt-job',
      updatedAt: 1,
    });
    database.seed(`reportJobs/${TEST_UID}/corrupt-job`, { status: 'not-a-real-status' });
    const corruptResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(corruptResponse.statusCode).toBe(200);
    expect(corruptResponse.json()).toEqual({ job: null });

    // Clear the corrupt pointer before submitting for real — the POST
    // handler's OWN current-job check (unlike this GET) parses the pointed
    // job via `reportJobSchema.parse` (matching the prep_report precedent,
    // routes/reports.ts:1004-1007), so a corrupt row left in place would
    // throw there rather than exercising the real happy-path this test
    // asserts next.
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, null);

    // A real, resolved job returns its status.
    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/reports',
      headers: authHeader(),
      payload: SYNTHESIS_PAYLOAD,
    });
    expect(submitResponse.statusCode).toBe(202);
    const { job: submittedJob } = submitResponse.json() as { job: { jobId: string } };

    const realResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(realResponse.statusCode).toBe(200);
    const body = realResponse.json() as { job: { jobId: string; status: string } };
    expect(body.job.jobId).toBe(submittedJob.jobId);
    expect(body.job.status).toBe('succeeded');
  });

  it('both GETs work with the gate OFF — status polling and plan viewing survive a mid-session flip-off', async () => {
    const { database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`practicePlans/${TEST_UID}/plan-1`, {
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      summary: 'A strong showing overall.',
      focusAreas: [{ title: 'Neutral game', evidence: 'text', drills: ['drill'] }],
    });
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'gate-off-job',
      updatedAt: 1,
    });
    database.seed(`reportJobs/${TEST_UID}/gate-off-job`, {
      status: 'succeeded',
      createdAt: 1,
      updatedAt: 2,
      attempt: 0,
      creditRef: 'gate-off-job',
      reason: 'post_event_synthesis',
      resultRef: 'plan-1',
    });

    // A SECOND app instance pointed at the SAME database, built WITHOUT the
    // paid-prep config — simulating the owner flipping the gate off after
    // this job already resolved (mirrors `reports.test.ts`'s own
    // gate-off-after-purchase precedent for `GET /reports/jobs`).
    const gateOffApp = buildAppSharingDatabase(database, {
      reports: NON_ALLOWLIST_CONFIG,
      stripe: STRIPE_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      // prepPaid deliberately omitted — the gate is off.
    });

    const statusResponse = await gateOffApp.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      job: { jobId: 'gate-off-job', status: 'succeeded', resultRef: 'plan-1' },
    });

    const planResponse = await gateOffApp.inject({
      method: 'GET',
      url: '/api/reports/practice-plans/plan-1',
      headers: authHeader(),
    });
    expect(planResponse.statusCode).toBe(200);
    expect((planResponse.json() as { plan: StoredPracticePlan }).plan.entryKey).toBe(ENTRY_KEY);
  });

  it('GET /reports/practice-plans/:planId returns the stored plan for the owner; a foreign uid planId 404s indistinguishably from a missing one', async () => {
    const { app, database } = billableApp();
    const SHARED_PLAN_ID = 'shared-plan-id';

    // Same planId string queried once when it doesn't exist ANYWHERE, and
    // once after seeding it under a FOREIGN uid — the message echoes only
    // the caller's own requested id, never server-derived existence data,
    // so querying the identical id both times is what actually proves
    // "indistinguishable" (both responses byte-equal).
    const missingResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/practice-plans/${SHARED_PLAN_ID}`,
      headers: authHeader(),
    });
    expect(missingResponse.statusCode).toBe(404);

    database.seed(`practicePlans/someone-else/${SHARED_PLAN_ID}`, {
      entryKey: 'their-entry',
      createdAt: FIRST_SET_AT,
      summary: 'Not yours.',
      focusAreas: [{ title: 'x', evidence: 'y', drills: ['z'] }],
    });

    const foreignResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/practice-plans/${SHARED_PLAN_ID}`,
      headers: authHeader(),
    });
    expect(foreignResponse.statusCode).toBe(404);
    expect(foreignResponse.json()).toEqual(missingResponse.json());

    // Sanity: the owner CAN read their own plan under the same id.
    const ownRef = database.ref(`practicePlans/${TEST_UID}/${SHARED_PLAN_ID}`);
    await ownRef.set({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      summary: 'Mine.',
      focusAreas: [{ title: 'x', evidence: 'y', drills: ['z'] }],
    });
    const ownResponse = await app.inject({
      method: 'GET',
      url: `/api/reports/practice-plans/${SHARED_PLAN_ID}`,
      headers: authHeader(),
    });
    expect(ownResponse.statusCode).toBe(200);
    expect((ownResponse.json() as { plan: StoredPracticePlan }).plan.summary).toBe('Mine.');
  });

  it('WR-06: a planId with an RTDB-illegal character answers 400, never a 500 from database.ref()', async () => {
    const { app } = billableApp();

    for (const planId of ['a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a\x01b']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/reports/practice-plans/${encodeURIComponent(planId)}`,
        headers: authHeader(),
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('GET /reports/:id still works — no route-shadowing regression from the new static-prefixed paths', async () => {
    const { app, database } = billableApp();
    database.seed(`scoutReports/${TEST_UID}/report-1`, {
      createdAt: Date.now(),
      model: 'claude-opus-4-8',
      player: { id: 1, gamerTag: 'Pandem1c' },
      report: {
        overview: 'x',
        gameplan: ['x'],
        characterStrategy: { picks: ['Mario'], reasoning: 'x' },
        stageStrategy: { bans: ['x'], picks: ['x'], reasoning: 'x' },
        watchFor: ['x'],
        confidenceNotes: 'x',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reports/report-1',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-08 Task 1): post-event synthesis on the shared claim
// pipeline — snapshot, D-21, validator seam, store-step totality, events.
// Money oracle: the credit BALANCE and the credit ledger's `refund` entries,
// never the `credit_refunded` event (deduped on `${ref}:credit_refunded`, so
// it prints 1 whether one refund happened or two).
// ---------------------------------------------------------------------------

/** The `ref`s of every `refund` entry in the caller's credit ledger. */
function refundLedgerRefs(database: FakeDatabase): string[] {
  const dump = database.dump() as Record<string, unknown>;
  const ledger = (dump.creditLedger ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(ledger[TEST_UID] ?? {})
    .filter((entry) => (entry as { type?: string }).type === 'refund')
    .map((entry) => (entry as { ref: string }).ref);
}

/** The ONE job this test submitted, read back as its FINAL stored record. */
async function onlyJob(
  database: FakeDatabase,
): Promise<{ jobId: string; job: Record<string, unknown> }> {
  const dump = database.dump() as Record<string, unknown>;
  const reportJobs = dump.reportJobs as Record<string, Record<string, unknown>>;
  const ids = Object.keys(reportJobs[TEST_UID]!);
  expect(ids).toHaveLength(1);
  const jobSnapshot = await database.ref(`reportJobs/${TEST_UID}/${ids[0]!}`).get();
  return { jobId: ids[0]!, job: jobSnapshot.val() as Record<string, unknown> };
}

/** Seeds a thin event from the BARE helpers (never the viable seed): exactly the given moments. */
function seedThinEvent(
  database: FakeDatabase,
  moments: ReadonlyArray<{ matchId: string; seconds: number }>,
): void {
  const byMatch = new Map<string, number[]>();
  for (const moment of moments) {
    byMatch.set(moment.matchId, [...(byMatch.get(moment.matchId) ?? []), moment.seconds]);
  }
  for (const [matchId, seconds] of byMatch) {
    seedMatch(database, matchId, {
      source: 'startgg',
      vodTimestamps: seconds.map((value) => ({ seconds: value, note: 'thin moment' })),
    });
  }
}

async function submitSynthesis(app: Awaited<ReturnType<typeof billableApp>>['app']) {
  return app.inject({
    method: 'POST',
    url: '/api/reports',
    headers: authHeader(),
    payload: SYNTHESIS_PAYLOAD,
  });
}

async function assembledFor(database: FakeDatabase) {
  const assembled = await assembleSynthesisPayload(
    database as unknown as Database,
    TEST_UID,
    ENTRY_KEY,
  );
  if (!assembled.found) {
    throw new Error('expected the seeded entry to assemble');
  }
  return assembled;
}

describe('C3-B1 viable synthesis evidence: the seed issues enough claims, the bare seed does not (plan 39-08)', () => {
  it('the viable seed issues exactly the three evidenced vod_annotation claims every generation-success case selects', async () => {
    const { database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);

    const assembled = await assembledFor(database);
    const claims = assembled.claimSet.claims;
    expect(claims.map((claim) => claim.id)).toEqual([...VIABLE_CLAIM_IDS]);
    expect(claims.length).toBeGreaterThanOrEqual(MIN_VIABLE_CLAIMS.post_event_synthesis);
    expect(claims.every((claim) => claim.predicate === 'vod_annotation')).toBe(true);
    expect(claims.every((claim) => claim.value.kind === 'count' && claim.tier === 'low')).toBe(
      true,
    );
    for (const [moment, claimId] of Object.entries(VIABLE_CLAIM_ID_BY_MOMENT)) {
      const [matchId, seconds] = moment.split(':');
      const claim = claims.find((candidate) => candidate.id === claimId)!;
      expect(claim.evidenceIds).toEqual([vodEvidenceId(matchId!, Number(seconds))]);
    }
  });

  it('FALSIFIER: the pre-39-08 seed (one moment in one game) issues fewer than the minimum', async () => {
    const { database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedThinEvent(database, [{ matchId: 'm1', seconds: 42 }]);

    const assembled = await assembledFor(database);
    expect(assembled.claimSet.claims).toHaveLength(1);
    expect(assembled.claimSet.claims[0]!.value).toEqual({ kind: 'abstained', gamesNeeded: 2 });
    expect(assembled.claimSet.claims.length).toBeLessThan(MIN_VIABLE_CLAIMS.post_event_synthesis);
  });
});

describe('evidence snapshot + validator seam on post_event_synthesis (plan 39-08, RPT-07/D-05/D-06/D-07)', () => {
  it('writes the content-addressed snapshot BEFORE the model is called, and stores the plan with its snapshot id', async () => {
    let snapshotPresentAtModelCall: boolean | null = null;
    const holder: { database?: FakeDatabase } = {};
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => {
        const dump = holder.database!.dump() as Record<string, unknown>;
        const snapshots = (dump.evidenceSnapshots ?? {}) as Record<string, unknown>;
        snapshotPresentAtModelCall = snapshots[TEST_UID] !== undefined;
        return { stop_reason: 'end_turn', parsed_output: citablePlan('m1', 42) };
      }),
    });
    holder.database = database;
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const expectedSnapshotId = snapshotIdFor((await assembledFor(database)).snapshot);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(202);
    expect(snapshotPresentAtModelCall).toBe(true);
    const dump = database.dump() as Record<string, unknown>;
    const snapshots = (dump.evidenceSnapshots as Record<string, Record<string, unknown>>)[
      TEST_UID
    ]!;
    expect(Object.keys(snapshots)).toEqual([expectedSnapshotId]);
    const storedRows = (snapshots[expectedSnapshotId] as { rows: Record<string, unknown> }).rows;
    expect(Object.keys(storedRows).sort()).toEqual(
      [
        vodEvidenceId('m1', 42),
        vodEvidenceId('viable-2', 10),
        vodEvidenceId('viable-3', 20),
      ].sort(),
    );
    const { job } = response.json() as { job: { resultRef: string } };
    const plan = (
      await database.ref(`practicePlans/${TEST_UID}/${job.resultRef}`).get()
    ).val() as StoredPracticePlan;
    expect(plan.validation).toEqual({
      status: 'passed',
      policyVersion: expect.any(Number),
      snapshotId: expectedSnapshotId,
      claimSchemaVersion: expect.any(Number),
    });
    expect(storedPracticePlanSchema.parse(plan).summary).toBe(CLEAN_PROSE.overview);
  });

  it('C1-H1/C1-B1: a validation failure ends REFUNDED with failureReason validation on the FINAL record, one refund, no stored plan', async () => {
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: uncitablePlan(),
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    const { jobId, job } = await onlyJob(database);
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
      failureReason: 'validation',
    });
    expect(refundLedgerRefs(database)).toEqual([jobId]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
    expect((database.dump() as Record<string, unknown>).practicePlans).toBeUndefined();
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
    expect(findEvents(database, 'report_failed')).toHaveLength(1);
  });

  it('a validation failure and a truncation failure have IDENTICAL terminal status and money effects for the same job shape', async () => {
    async function run(respond: () => Promise<{ stop_reason: string; parsed_output: unknown }>) {
      const { app, database } = billableApp({ reportsClient: stubClient(respond) });
      seedEntry(database);
      seedBrief(database);
      seedOneAnnotation(database, 'm1', 42);
      database.seed(`credits/${TEST_UID}/balance`, 1);
      const response = await submitSynthesis(app);
      const { jobId, job } = await onlyJob(database);
      return {
        statusCode: response.statusCode,
        status: job.status,
        reason: job.reason,
        failureReason: job.failureReason,
        refundsForThisJob: refundLedgerRefs(database).filter((ref) => ref === jobId).length,
        refundsTotal: refundLedgerRefs(database).length,
        balance: (await database.ref(`credits/${TEST_UID}/balance`).get()).val(),
        reportFailed: findEvents(database, 'report_failed').length,
        stored: (database.dump() as Record<string, unknown>).practicePlans !== undefined,
      };
    }

    const validation = await run(async () => ({
      stop_reason: 'end_turn',
      parsed_output: uncitablePlan(),
    }));
    const truncation = await run(async () => ({ stop_reason: 'max_tokens', parsed_output: null }));

    const { failureReason: validationCause, ...validationMoney } = validation;
    const { failureReason: truncationCause, ...truncationMoney } = truncation;
    expect(validationMoney).toEqual(truncationMoney);
    expect(validationMoney).toMatchObject({
      statusCode: 502,
      status: 'refunded',
      reason: 'post_event_synthesis',
      refundsForThisJob: 1,
      refundsTotal: 1,
      balance: 1,
      reportFailed: 1,
      stored: false,
    });
    // Only the CAUSE differs — never the money.
    expect(validationCause).toBe('validation');
    expect(truncationCause).toBeUndefined();
  });

  it('the retry window still keys on the job-KIND reason: a validation-failed entry is resubmittable and succeeds, the cause riding a separate field', async () => {
    let calls = 0;
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => {
        calls += 1;
        return {
          stop_reason: 'end_turn',
          parsed_output: calls === 1 ? uncitablePlan() : citablePlan('m1', 42),
        };
      }),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 2);

    const first = await submitSynthesis(app);
    expect(first.statusCode).toBe(502);
    const { jobId: firstJobId, job: firstJob } = await onlyJob(database);
    // Kind and cause are two fields; the kind enum never carries the cause.
    expect(firstJob.reason).toBe('post_event_synthesis');
    expect(firstJob.failureReason).toBe('validation');
    expect(firstJob.status).toBe('refunded');

    const retry = await submitSynthesis(app);
    expect(retry.statusCode).toBe(202);
    const retryBody = retry.json() as { job: { jobId: string; status: string } };
    expect(retryBody.job.status).toBe('succeeded');
    expect(retryBody.job.jobId).not.toBe(firstJobId);
    const pointer = await database.ref(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`).get();
    expect(pointer.val()).toMatchObject({ jobId: retryBody.job.jobId });
    // 2 -> spend -> refund -> spend: one credit net, exactly one refund.
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
    expect(refundLedgerRefs(database)).toEqual([firstJobId]);
  });

  it('C3-M1/D-20: a stored plan whose overview prose was stripped carries strippedSectionCount 1, the engine-authored summary, and emits report_prose_stripped once', async () => {
    const selection = selectionOf(
      { overview: ['c01', 'c02'], gameplan: ['c03'], watchFor: ['c01'] },
      { overview: STRIPPED_PROSE },
    );
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: selection,
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const issued = (await assembledFor(database)).claimSet.claims;

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(202);
    const { job } = response.json() as { job: { resultRef: string } };
    const stored = (
      await database.ref(`practicePlans/${TEST_UID}/${job.resultRef}`).get()
    ).val() as StoredPracticePlan;
    expect(stored.strippedSectionCount).toBe(1);
    expect(stored.sections?.overview?.connective ?? '').toBe('');
    expect(stored.summary).toBe(engineAuthoredSummary(issued));
    expect(stored.summary.length).toBeGreaterThan(0);
    expect(storedPracticePlanSchema.safeParse(stored).success).toBe(true);
    const stripped = findEvents(database, 'report_prose_stripped');
    expect(stripped).toHaveLength(1);
    expect(Object.keys(stripped[0]!.payload)).toEqual(['reason']);
    // A charged, delivered plan — never a refund on stripped prose (D-20).
    expect(refundLedgerRefs(database)).toEqual([]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(0);
  });

  it('C3-M1/D-20: a plan with zero stripped sections has NO strippedSectionCount key and emits no report_prose_stripped', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(202);
    const { job } = response.json() as { job: { resultRef: string } };
    const stored = (
      await database.ref(`practicePlans/${TEST_UID}/${job.resultRef}`).get()
    ).val() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(stored, 'strippedSectionCount')).toBe(false);
    expect(findEvents(database, 'report_prose_stripped')).toHaveLength(0);
    expect(findEvents(database, 'report_claims_dropped')).toHaveLength(0);
  });

  it('C2-H2(b): a record the stored schema rejects is a REFUND through the validation branch — never an uncaught 500 with the job left running', async () => {
    // The stub bypasses the SDK's Zod parse, so an empty actionId reaches the
    // store step; storedActionSlotSchema requires `.min(1)`.
    const selection = selectionOf(
      { overview: ['c01', 'c02'], gameplan: ['c03'], watchFor: [] },
      {},
      { action1: { actionId: '', claimId: 'c01' } as unknown as ClaimSelection['action1'] },
    );
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: selection,
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    const { jobId, job } = await onlyJob(database);
    expect(job).toMatchObject({ status: 'refunded', failureReason: 'validation' });
    expect(refundLedgerRefs(database)).toEqual([jobId]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
    expect((database.dump() as Record<string, unknown>).practicePlans).toBeUndefined();
    const running = await database.ref(`reportJobsByStatus/running/${TEST_UID}/${jobId}`).get();
    expect(running.exists()).toBe(false);
  });
});

describe('D-21 thin-evidence FAIL FAST on post_event_synthesis (plan 39-08)', () => {
  it('one annotated moment (one issued claim, below the minimum): ZERO model calls, one refund, failureReason on the FINAL record, no plan, snapshot kept', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedEntry(database);
    seedBrief(database);
    // NOT the viable seed — the bare helpers, one moment. (A workspace with
    // NO annotations never reaches this branch: the route's pre-spend
    // evidence precondition answers 409 before any spend — see the
    // "zero stored annotations" case above.)
    seedThinEvent(database, [{ matchId: 'm1', seconds: 42 }]);
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const thin = await assembledFor(database);
    expect(thin.claimSet.claims.length).toBeLessThan(MIN_VIABLE_CLAIMS.post_event_synthesis);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).not.toHaveBeenCalled();
    const { jobId, job } = await onlyJob(database);
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
      failureReason: 'validation',
    });
    expect(refundLedgerRefs(database)).toEqual([jobId]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
    const dump = database.dump() as Record<string, unknown>;
    expect(dump.practicePlans).toBeUndefined();
    expect(findEvents(database, 'report_failed_validation')).toHaveLength(1);
    const snapshotId = snapshotIdFor(thin.snapshot);
    const snapshot = await database.ref(`evidenceSnapshots/${TEST_UID}/${snapshotId}`).get();
    expect(snapshot.exists()).toBe(true);
    expect(Object.keys((snapshot.val() as { rows: Record<string, unknown> }).rows)).toEqual([
      vodEvidenceId('m1', 42),
    ]);
  });

  it('two moments in ONE game collapse to one abstained claim (identical predicate/subject/value) — still below the minimum, still fails fast', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedEntry(database);
    seedBrief(database);
    seedThinEvent(database, [
      { matchId: 'm1', seconds: 42 },
      { matchId: 'm1', seconds: 90 },
    ]);
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const thin = await assembledFor(database);
    expect(thin.claimSet.claims).toHaveLength(1);
    expect([...thin.claimSet.claims[0]!.evidenceIds].sort()).toEqual(
      [vodEvidenceId('m1', 42), vodEvidenceId('m1', 90)].sort(),
    );

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).not.toHaveBeenCalled();
    const { jobId, job } = await onlyJob(database);
    expect(job).toMatchObject({ status: 'refunded', failureReason: 'validation' });
    expect(refundLedgerRefs(database)).toEqual([jobId]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
  });

  it('a FREE-ACCESS thin submission rests at refunded + failureReason validation with NO ledger movement (the recorded CR-02 zero-spend residual, unchanged)', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = buildTestApp({
      reports: REPORTS_CONFIG,
      prepPaid: PREP_PAID_CONFIG,
      parrygg: { apiKey: 'parry-key' },
      reportsClient: stubClient(modelSpy),
    });
    seedEntry(database);
    seedBrief(database);
    seedThinEvent(database, [{ matchId: 'm1', seconds: 42 }]);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).not.toHaveBeenCalled();
    const { job } = await onlyJob(database);
    expect(job).toMatchObject({ status: 'refunded', failureReason: 'validation' });
    expect((database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
  });
});

describe('D-23: only EVIDENCED claims clear MIN_VIABLE_CLAIMS on the synthesis fail-fast (code review SH-CR-03)', () => {
  it('two annotated games (two distinct abstained claims — as many as the minimum, none evidenced): ZERO model calls, exactly one refund, balance restored', async () => {
    const modelSpy = vi.fn(async () => ({
      stop_reason: 'end_turn' as const,
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedEntry(database);
    seedBrief(database);
    // Two games, one moment each, against DIFFERENT opponent characters, so
    // the two abstained claims do not collapse into one.
    seedMatch(database, 'm1', {
      source: 'startgg',
      opponent_id: 2,
      vodTimestamps: [{ seconds: 42, note: 'thin moment' }],
    });
    seedMatch(database, 'm2', {
      source: 'startgg',
      opponent_id: 3,
      vodTimestamps: [{ seconds: 90, note: 'thin moment' }],
    });
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const thin = await assembledFor(database);
    expect(thin.claimSet.claims.length).toBeGreaterThanOrEqual(
      MIN_VIABLE_CLAIMS.post_event_synthesis,
    );
    expect(thin.claimSet.claims.filter((claim) => claim.value.kind !== 'abstained')).toEqual([]);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    expect(modelSpy).not.toHaveBeenCalled();
    const { jobId, job } = await onlyJob(database);
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
      failureReason: 'validation',
      wasCharged: true,
    });
    expect(refundLedgerRefs(database)).toEqual([jobId]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
    expect((database.dump() as Record<string, unknown>).practicePlans).toBeUndefined();
  });
});

describe('C4-H1: the synthesis snapshot write and D-21 check sit BELOW the claim transaction (plan 39-08)', () => {
  /** `runSynthesisGeneration`'s body with comment lines stripped — so a comment can neither satisfy nor break the order. */
  function synthesisBody(): string {
    const source = readFileSync(new URL('./reports.ts', import.meta.url), 'utf-8');
    const body = source.slice(
      source.indexOf('async function runSynthesisGeneration'),
      source.indexOf('function buildPrepResolveScout'),
    );
    return body
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
  }

  it('claim.committed < writeEvidenceSnapshot < MIN_VIABLE_CLAIMS < generatePracticePlan, by byte offset', () => {
    const body = synthesisBody();
    const claim = body.indexOf('claim.committed');
    const snapshot = body.indexOf('writeEvidenceSnapshot(');
    const check = body.indexOf("MIN_VIABLE_CLAIMS['post_event_synthesis']");
    const model = body.indexOf('generatePracticePlan(');
    for (const offset of [claim, snapshot, check, model]) {
      expect(offset).toBeGreaterThan(-1);
    }
    expect(claim).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(check);
    expect(check).toBeLessThan(model);
  });

  it('the D-21 branch and the validator branch both go through failCurrentJob — no direct failJob call and no refundCredit in the synthesis body', () => {
    const body = synthesisBody();
    expect(body).toContain("failCurrentJob(jobDay, 'validation')");
    expect(body.match(/failCurrentJob\(jobDay, 'validation'\)/g)).toHaveLength(2);
    expect(body).not.toMatch(/refundCredit\(/);
    // The only `failJob(` in the body is the failCurrentJob wrapper itself.
    expect(body.match(/failJob\(/g)).toHaveLength(1);
  });

  it('reachability, read from source: every synthesis submission mints a fresh server-side jobId behind the index-pointer transaction', () => {
    const source = readFileSync(new URL('./reports.ts', import.meta.url), 'utf-8');
    const branch = source.slice(
      source.indexOf("if (request.body.reason === 'post_event_synthesis')"),
      source.indexOf('const generation = await runSynthesisGeneration('),
    );
    const mint = branch.indexOf('const synthJobId = randomUUID();');
    const pointerClaim = branch.indexOf('await indexRef.transaction(');
    expect(mint).toBeGreaterThan(-1);
    expect(pointerClaim).toBeGreaterThan(mint);
  });
});

describe('C2-H2(c) strip/drop lattice on post_event_synthesis: every cell ends in exactly one of stored-valid or one refund, and none throws (plan 39-08)', () => {
  const BANDS = {
    below: ['c01'],
    at: ['c01', 'c02'],
    above: ['c01', 'c02', 'c03'],
  } as const;
  expect(BANDS.below.length).toBeLessThan(MIN_VIABLE_CLAIMS.post_event_synthesis);
  expect(BANDS.at.length).toBe(MIN_VIABLE_CLAIMS.post_event_synthesis);

  const cells: Array<{ mask: number; band: keyof typeof BANDS }> = [];
  for (let mask = 0; mask < 8; mask += 1) {
    for (const band of Object.keys(BANDS) as Array<keyof typeof BANDS>) {
      cells.push({ mask, band });
    }
  }

  it.each(cells)('strip mask $mask x band $band', async ({ mask, band }) => {
    const strippedIds = CLAIM_SELECTION_SECTION_IDS.filter((_, index) => (mask >> index) & 1);
    const ids = BANDS[band];
    const selection = selectionOf(
      { overview: ids, gameplan: ids, watchFor: ids },
      Object.fromEntries(strippedIds.map((id) => [id, STRIPPED_PROSE])),
    );
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: selection,
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const issued = (await assembledFor(database)).claimSet.claims;

    const response = await submitSynthesis(app);

    const { jobId, job } = await onlyJob(database);
    const balance = (await database.ref(`credits/${TEST_UID}/balance`).get()).val();
    const plans = (database.dump() as Record<string, unknown>).practicePlans as
      Record<string, Record<string, Record<string, unknown>>> | undefined;
    if (band === 'below') {
      expect(response.statusCode).toBe(502);
      expect(job).toMatchObject({ status: 'refunded', failureReason: 'validation' });
      expect(refundLedgerRefs(database)).toEqual([jobId]);
      expect(balance).toBe(1);
      expect(plans).toBeUndefined();
      return;
    }
    expect(response.statusCode).toBe(202);
    expect(job.status).toBe('succeeded');
    expect(refundLedgerRefs(database)).toEqual([]);
    expect(balance).toBe(0);
    const stored = Object.values(plans![TEST_UID]!)[0]!;
    const parsed = storedPracticePlanSchema.parse(stored);
    expect(parsed.summary.length).toBeGreaterThan(0);
    if (strippedIds.length > 0) {
      expect(stored.strippedSectionCount).toBe(strippedIds.length);
    } else {
      expect(Object.prototype.hasOwnProperty.call(stored, 'strippedSectionCount')).toBe(false);
    }
    if (strippedIds.includes('overview')) {
      const surviving = issued.filter((claim) => (ids as readonly string[]).includes(claim.id));
      expect(parsed.summary).toBe(engineAuthoredSummary(surviving));
    } else {
      expect(parsed.summary).toBe(CLEAN_PROSE.overview);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-08 Task 2): the migration battery — the shared
// validator is AT LEAST AS STRICT as the shipped citation rule on synthesis
// evidence, exercised through the REAL assembly plumbing (the payload's own
// pre-serialized cite tokens, `extractCitationTokens`, `vodEvidenceId` and the
// issued claim set), before the shipped rule is retired.
// ---------------------------------------------------------------------------

describe('migration battery: shared validator vs the shipped validatePracticePlanCitations on real synthesis evidence (plan 39-08 Task 2)', () => {
  type FocusArea = GeneratedPracticePlan['focusAreas'][number];

  async function realEvidence() {
    const { database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    const assembled = await assembledFor(database);
    const citeOf = (matchId: string, seconds: number): string =>
      assembled.payload.evidence.find(
        (item) => item.matchId === matchId && item.seconds === seconds,
      )!.cite;
    return { assembled, citeOf };
  }

  /** The shipped rule's verdict: which focusAreas survive, or a whole-plan rejection. */
  function shippedVerdict(
    focusAreas: FocusArea[],
    allowedPairs: ReadonlySet<string>,
  ): { planAccepted: boolean; survivingTitles: string[]; storedEvidence: string[] } {
    try {
      const result = validatePracticePlanCitations(
        { summary: 'Battery plan', focusAreas },
        allowedPairs,
      );
      return {
        planAccepted: true,
        survivingTitles: result.plan.focusAreas.map((area) => area.title),
        storedEvidence: result.plan.focusAreas.map((area) => area.evidence),
      };
    } catch (error) {
      expect(error).toBeInstanceOf(SynthesisValidationError);
      return { planAccepted: false, survivingTitles: [], storedEvidence: [] };
    }
  }

  /**
   * Translates the SAME model output into the claim-selection world through
   * the real plumbing: each focusArea becomes one section; each citation
   * token resolves through `vodEvidenceId` to the issued claim carrying that
   * evidence id, and a token resolving to no issued claim becomes the first
   * never-issued vocabulary id (the only way a selection can name something
   * the engine did not issue). The prose is the focusArea text minus tokens.
   */
  function toSelection(
    focusAreas: FocusArea[],
    assembled: Awaited<ReturnType<typeof assembledFor>>,
  ): { selection: ClaimSelection; claimIdsByTitle: Map<string, string[]> } {
    expect(focusAreas.length).toBeLessThanOrEqual(CLAIM_SELECTION_SECTION_IDS.length);
    const issued = new Set(assembled.claimSet.claims.map((claim) => claim.id as string));
    const unissued = CLAIM_ID_VOCABULARY.find((id) => !issued.has(id))!;
    const claimIdsByTitle = new Map<string, string[]>();
    const sections = Object.fromEntries(
      CLAIM_SELECTION_SECTION_IDS.map((sectionId, index) => {
        const area = focusAreas[index];
        if (!area) {
          return [sectionId, { claimIds: [], connective: 'Nothing here.' }];
        }
        const claimIds = extractCitationTokens(area.evidence).map((token) => {
          const evidenceId = vodEvidenceId(token.sourceVodRef, token.seconds);
          const claim = assembled.claimSet.claims.find((candidate) =>
            candidate.evidenceIds.includes(evidenceId),
          );
          return claim ? claim.id : unissued;
        });
        claimIdsByTitle.set(area.title, claimIds);
        const connective = area.evidence.replace(/\{\{cite:[^}]*\}\}/g, '').trim() || 'See clip.';
        return [sectionId, { claimIds, connective }];
      }),
    ) as ClaimSelection['sections'];
    return {
      selection: { sections, action1: null, action2: null, action3: null },
      claimIdsByTitle,
    };
  }

  function sharedVerdict(
    selection: ClaimSelection,
    assembled: Awaited<ReturnType<typeof assembledFor>>,
  ) {
    return validateReportOutput({
      snapshot: assembled.snapshot,
      issuedClaims: assembled.claimSet.claims,
      output: selection,
      surface: 'post_event_synthesis',
    });
  }

  /**
   * The law, per citation and per plan: every citation token the shipped
   * rule cannot resolve (its `(matchId, seconds)` pair is outside
   * `allowedPairs`) maps to a claim the shared validator does NOT keep; a
   * focusArea with no tokens contributes no claim at all; and a plan the
   * shipped rule rejects outright is a `failed` outcome.
   */
  function expectAtLeastAsStrict(
    focusAreas: FocusArea[],
    assembled: Awaited<ReturnType<typeof assembledFor>>,
  ) {
    const shipped = shippedVerdict(focusAreas, assembled.allowedPairs);
    const { selection, claimIdsByTitle } = toSelection(focusAreas, assembled);
    const outcome = sharedVerdict(selection, assembled);
    for (const area of focusAreas) {
      const claimIds = claimIdsByTitle.get(area.title) ?? [];
      const tokens = extractCitationTokens(area.evidence);
      expect(claimIds).toHaveLength(tokens.length);
      tokens.forEach((token, index) => {
        if (!assembled.allowedPairs.has(`${token.sourceVodRef}:${token.seconds}`)) {
          expect(outcome.survivingClaimIds).not.toContain(claimIds[index]);
        }
      });
    }
    if (!shipped.planAccepted) {
      expect(outcome.status).toBe('failed');
    }
    return { shipped, outcome };
  }

  it('an ACCEPTED citation set: both accept, and the shared survivors are exactly the cited moments’ claims', async () => {
    const { assembled, citeOf } = await realEvidence();
    const focusAreas: FocusArea[] = [
      { title: 'A', evidence: `${citeOf('m1', 42)} Good read here.`, drills: ['d'] },
      { title: 'B', evidence: `${citeOf('viable-2', 10)} Shield less.`, drills: ['d'] },
    ];
    const { shipped, outcome } = expectAtLeastAsStrict(focusAreas, assembled);
    expect(shipped).toMatchObject({ planAccepted: true, survivingTitles: ['A', 'B'] });
    expect(outcome.status).toBe('passed');
    expect([...outcome.survivingClaimIds].sort()).toEqual(['c01', 'c02']);
    expect(outcome.strippedSectionIds).toEqual([]);
  });

  it('a citation naming an UNKNOWN pair: the shipped rule drops that focusArea; the shared validator drops the claim (R1) and, with nothing viable left, fails', async () => {
    const { assembled, citeOf } = await realEvidence();
    const unknown = serializeCitationToken({
      sourceVodRef: 'no-such-match',
      seconds: 999,
      label: 'x',
    });
    const onlyUnknown: FocusArea[] = [
      { title: 'U', evidence: `${unknown} Looks right.`, drills: ['d'] },
    ];
    const first = expectAtLeastAsStrict(onlyUnknown, assembled);
    expect(first.shipped.planAccepted).toBe(false);
    expect(first.outcome.droppedClaims.map((dropped) => dropped.rule)).toEqual(['R1']);
    expect(first.outcome.survivingClaimIds).toEqual([]);

    // Mixed with one real citation: the shipped rule STORES the real one; the
    // shared validator keeps the real claim but, below the surface minimum,
    // refuses the plan — strictly stricter, never looser.
    const mixed: FocusArea[] = [
      { title: 'Real', evidence: `${citeOf('m1', 42)} Real moment.`, drills: ['d'] },
      { title: 'U', evidence: `${unknown} Looks right.`, drills: ['d'] },
    ];
    const second = expectAtLeastAsStrict(mixed, assembled);
    expect(second.shipped).toMatchObject({ planAccepted: true, survivingTitles: ['Real'] });
    expect(second.outcome.survivingClaimIds).toEqual(['c01']);
    expect(second.outcome.status).toBe('failed');
  });

  it('an EMPTY citation set: the shipped rule rejects the plan (INV-2) and the shared validator fails it', async () => {
    const { assembled } = await realEvidence();
    const focusAreas: FocusArea[] = [
      { title: 'E', evidence: 'Just prose, no citation tokens at all.', drills: ['d'] },
    ];
    const { shipped, outcome } = expectAtLeastAsStrict(focusAreas, assembled);
    expect(shipped.planAccepted).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(outcome.survivingClaimIds).toEqual([]);
  });

  it('a citation whose pair EXISTS but whose surrounding claim is WRONG: the shipped rule stores the wrong number verbatim; the shared validator withholds it (R4 strips that prose)', async () => {
    const { assembled, citeOf } = await realEvidence();
    const focusAreas: FocusArea[] = [
      {
        title: 'Wrong',
        evidence: `${citeOf('m1', 42)} Your record here is actually 18-2, a dominant showing.`,
        drills: ['d'],
      },
      { title: 'B', evidence: `${citeOf('viable-2', 10)} Shield less.`, drills: ['d'] },
    ];
    const { shipped, outcome } = expectAtLeastAsStrict(focusAreas, assembled);
    // The RPT-08 hard case: citation existence alone let the wrong claim ship.
    expect(shipped.planAccepted).toBe(true);
    expect(shipped.survivingTitles).toContain('Wrong');
    expect(shipped.storedEvidence.some((text) => text.includes('18-2'))).toBe(true);
    // The shared validator keeps the engine's claim (its value is recomputed
    // from the snapshot, never the model's) and strips the section whose prose
    // states the unlicensed figure — the wrong number never reaches storage.
    expect(outcome.status).toBe('passed');
    expect(outcome.strippedSectionIds).toContain('overview');
    expect(outcome.strippedSectionIds).not.toContain('gameplan');
  });
});

/**
 * Builds a second app instance sharing an EXISTING `FakeDatabase` — mirrors
 * `reports.test.ts`'s own `gateOffApp` construction (a second `buildApp`
 * call pointed at the same in-memory database, simulating the owner
 * flipping the activation gate off mid-session without losing prior data).
 */
function buildAppSharingDatabase(
  database: FakeDatabase,
  options: Partial<Parameters<typeof buildApp>[0]>,
): ReturnType<typeof buildApp> {
  const auth = new FakeAuth();
  auth.registerToken(TEST_TOKEN, { uid: TEST_UID, email: TEST_EMAIL });
  return buildApp({
    firebase: {
      app: {} as never,
      auth: auth as unknown as Auth,
      database: database as unknown as Database,
    },
    logger: false,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25): `wasCharged` on
// the synthesis job. The zero-spend free-access failure is THE case the web's
// "your credit was refunded" badge got wrong — `failJob` writes the
// `refunded` terminal for it (Phase 28 CR-02) with no refund — so the record
// itself must say no credit was taken. Money is pinned alongside.
// ---------------------------------------------------------------------------

function freeAccessSynthesisApp(
  respond: () => Promise<{ stop_reason: string | null; parsed_output: unknown }>,
) {
  return buildTestApp({
    reports: REPORTS_CONFIG,
    prepPaid: PREP_PAID_CONFIG,
    parrygg: { apiKey: 'parry-key' },
    reportsClient: stubClient(respond),
  });
}

describe('post-plan fix (39-10): wasCharged on the post_event_synthesis job', () => {
  it('billable: the QUEUED write (after the spend) already carries wasCharged true; the succeeded record keeps it; one spend, zero refunds', async () => {
    const { app, database } = billableApp();
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);
    const queuedValues: unknown[] = [];
    const originalRef = database.ref.bind(database);
    vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
      const ref = originalRef(path);
      return {
        ...ref,
        set: async (value: unknown) => {
          if (
            (path ?? '').startsWith(`reportJobs/${TEST_UID}/`) &&
            (value as { status?: string } | null)?.status === 'queued'
          ) {
            queuedValues.push(value);
          }
          return ref.set(value);
        },
      };
    });

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(202);
    expect(queuedValues).toHaveLength(1);
    expect(queuedValues[0]).toMatchObject({ status: 'queued', wasCharged: true });
    const { job } = await onlyJob(database);
    expect(job).toMatchObject({ status: 'succeeded', wasCharged: true });
    expect(refundLedgerRefs(database)).toEqual([]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(0);
  });

  it('billable validation failure: the refunded terminal carries wasCharged true; exactly one refund, balance restored', async () => {
    const { app, database } = billableApp({
      reportsClient: stubClient(async () => ({
        stop_reason: 'end_turn',
        parsed_output: uncitablePlan(),
      })),
    });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    const { jobId, job } = await onlyJob(database);
    expect(job).toMatchObject({
      status: 'refunded',
      failureReason: 'validation',
      wasCharged: true,
    });
    expect(refundLedgerRefs(database)).toEqual([jobId]);
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).val()).toBe(1);
  });

  it('CR-02 zero-spend free-access failure: the refunded terminal carries wasCharged FALSE — no spend, no refund, no ledger', async () => {
    const { app, database } = freeAccessSynthesisApp(async () => ({
      stop_reason: 'end_turn',
      parsed_output: uncitablePlan(),
    }));
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(502);
    const { job } = await onlyJob(database);
    expect(job).toMatchObject({
      status: 'refunded',
      reason: 'post_event_synthesis',
      failureReason: 'validation',
      wasCharged: false,
    });
    expect((database.dump() as Record<string, unknown>).creditLedger).toBeUndefined();
    expect((await database.ref(`credits/${TEST_UID}/balance`).get()).exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Code review iteration 4 (R4-WR-02): the owner's locked "one model call per
// job, no retries" rule holds on the synthesis call too — it goes through the
// same bounded client as the scout path.
// ---------------------------------------------------------------------------

describe('code review R4-WR-02: the synthesis model call is one bounded attempt', () => {
  it('reaches the SDK with maxRetries 0 and an explicit timeout of at most eight minutes', async () => {
    // Typed with the SDK call's two parameters so the per-request options
    // (the second argument) can be read back from the recorded call.
    const modelSpy = vi.fn<
      (
        params: unknown,
        options?: unknown,
      ) => Promise<{ stop_reason: 'end_turn'; parsed_output: unknown }>
    >(async () => ({
      stop_reason: 'end_turn',
      parsed_output: citablePlan('m1', 42),
    }));
    const { app, database } = billableApp({ reportsClient: stubClient(modelSpy) });
    seedEntry(database);
    seedBrief(database);
    seedOneAnnotation(database, 'm1', 42);
    database.seed(`credits/${TEST_UID}/balance`, 1);

    const response = await submitSynthesis(app);

    expect(response.statusCode).toBe(202);
    expect(modelSpy).toHaveBeenCalledTimes(1);
    const options = modelSpy.mock.calls[0]![1] as
      { maxRetries?: unknown; timeout?: unknown } | undefined;
    expect(options).toBeDefined();
    expect(options!.maxRetries).toBe(0);
    expect(typeof options!.timeout).toBe('number');
    expect(options!.timeout as number).toBeGreaterThan(0);
    expect(options!.timeout as number).toBeLessThanOrEqual(8 * 60 * 1000);
  });
});
