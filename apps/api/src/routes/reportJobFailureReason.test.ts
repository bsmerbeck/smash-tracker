import { describe, expect, it } from 'vitest';
import {
  prepReportJobsResponseSchema,
  synthesisJobStatusResponseSchema,
} from '@smash-tracker/shared';
import type { PrepPaidConfig, ReportsConfig, StripeConfig } from '../config/env.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

/**
 * Phase 39 (plan 39-10, D-21): the two ungated job-status reads project the
 * stored job's `failureReason` so the paid cards can caption a validation
 * failure. Before this plan neither response carried the field, so a caption
 * keyed on it could never render in production. A NEW file — `reports.test.ts`
 * and `reportsSynthesis.test.ts` are not edited.
 *
 * The seeded job records are the exact terminal shapes `failJob` writes
 * (plans 39-07/39-08 prove those on the FINAL record): a spent prep job ends
 * `refunded` with `reason` + `failureReason`; a zero-spend free-access prep job
 * ends `failed` with `failureReason` and no `reason`-gated second write.
 */

const NON_ALLOWLIST_CONFIG: ReportsConfig = {
  anthropicApiKey: 'sk-test-key',
  allowedUids: new Set(['someone-else']),
};
const STRIPE_CONFIG: StripeConfig = { secretKey: 'sk-test-123', webhookSecret: 'whsec-test-456' };
const PREP_PAID_CONFIG: PrepPaidConfig = { enabled: true };
const ENTRY_KEY = 'evo-2026';

function app() {
  return buildTestApp({
    reports: NON_ALLOWLIST_CONFIG,
    stripe: STRIPE_CONFIG,
    prepPaid: PREP_PAID_CONFIG,
    parrygg: { apiKey: 'parry-key' },
  });
}

function seedPrepJob(
  database: FakeDatabase,
  opponentName: string,
  jobId: string,
  job: Record<string, unknown>,
): void {
  database.seed(`prepReportJobIndex/${TEST_UID}/${ENTRY_KEY}/${opponentName}`, {
    jobId,
    updatedAt: 5,
  });
  database.seed(`reportJobs/${TEST_UID}/${jobId}`, {
    createdAt: 1,
    updatedAt: 5,
    attempt: 0,
    creditRef: jobId,
    ...job,
  });
}

describe('GET /api/reports/jobs projects failureReason (plan 39-10, D-21)', () => {
  it('carries the cause on a refunded (spent) and a failed (zero-spend) validation job, and omits it on a job with none', async () => {
    const { app: server, database } = app();
    seedPrepJob(database, 'rival1', 'job-refunded', {
      status: 'refunded',
      reason: 'prep_report',
      failureReason: 'validation',
    });
    seedPrepJob(database, 'rival2', 'job-failed', {
      status: 'failed',
      failureReason: 'validation',
    });
    seedPrepJob(database, 'rival3', 'job-plain', { status: 'refunded', reason: 'prep_report' });

    const response = await server.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jobs: [
        {
          opponentName: 'rival1',
          jobId: 'job-refunded',
          status: 'refunded',
          updatedAt: 5,
          failureReason: 'validation',
        },
        {
          opponentName: 'rival2',
          jobId: 'job-failed',
          status: 'failed',
          updatedAt: 5,
          failureReason: 'validation',
        },
        { opponentName: 'rival3', jobId: 'job-plain', status: 'refunded', updatedAt: 5 },
      ],
    });
  });

  it('never exposes the job KIND (`reason`) — only the failure cause', async () => {
    const { app: server, database } = app();
    seedPrepJob(database, 'rival1', 'job-1', {
      status: 'refunded',
      reason: 'prep_bundle',
      failureReason: 'refusal',
    });
    const response = await server.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    const [entry] = (response.json() as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(entry).toMatchObject({ failureReason: 'refusal' });
    expect(entry).not.toHaveProperty('reason');
  });
});

describe('GET /api/reports/synthesis projects failureReason (plan 39-10, D-21)', () => {
  it('carries the cause on the refunded synthesis terminal, and omits it when absent', async () => {
    const { app: server, database } = app();
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'synth-1',
      updatedAt: 5,
    });
    database.seed(`reportJobs/${TEST_UID}/synth-1`, {
      status: 'refunded',
      createdAt: 1,
      updatedAt: 5,
      attempt: 0,
      creditRef: 'synth-1',
      reason: 'post_event_synthesis',
      failureReason: 'validation',
    });

    const withCause = await server.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(withCause.statusCode).toBe(200);
    expect(withCause.json()).toEqual({
      job: { jobId: 'synth-1', status: 'refunded', updatedAt: 5, failureReason: 'validation' },
    });

    database.seed(`reportJobs/${TEST_UID}/synth-1`, {
      status: 'refunded',
      createdAt: 1,
      updatedAt: 6,
      attempt: 0,
      creditRef: 'synth-1',
      reason: 'post_event_synthesis',
    });
    const withoutCause = await server.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(withoutCause.json()).toEqual({
      job: { jobId: 'synth-1', status: 'refunded', updatedAt: 6 },
    });
  });
});

describe('the wire field is an OPEN string (tolerant client read)', () => {
  it('a cause the client does not know yet still parses — it never fails the whole status list', () => {
    const parsedJobs = prepReportJobsResponseSchema.safeParse({
      jobs: [
        {
          opponentName: 'rival1',
          jobId: 'job-1',
          status: 'refunded',
          updatedAt: 1,
          failureReason: 'some_future_cause',
        },
      ],
    });
    expect(parsedJobs.success).toBe(true);

    const parsedSynthesis = synthesisJobStatusResponseSchema.safeParse({
      job: { jobId: 'j', status: 'failed', updatedAt: 1, failureReason: 'some_future_cause' },
    });
    expect(parsedSynthesis.success).toBe(true);
  });
});

/**
 * Post-plan fix (39-10, owner decision [HUMAN] 2026-09-25): the two job-status
 * reads also project `wasCharged` — the spend fact persisted on the job — so
 * the paid cards' refund wording reads the record, not the viewer's CURRENT
 * free-access status. Present only when the stored job carries a boolean;
 * absent on older records (the web then falls back to the credits read).
 */
describe('GET /api/reports/jobs and /api/reports/synthesis project wasCharged (post-plan fix 39-10)', () => {
  it('jobs: true and false are both carried (false is a value, not an absence); a record without it omits the key', async () => {
    const { app: server, database } = app();
    seedPrepJob(database, 'rival1', 'job-charged', {
      status: 'refunded',
      reason: 'prep_report',
      wasCharged: true,
    });
    seedPrepJob(database, 'rival2', 'job-free', { status: 'failed', wasCharged: false });
    seedPrepJob(database, 'rival3', 'job-old', { status: 'failed' });

    const response = await server.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jobs: [
        {
          opponentName: 'rival1',
          jobId: 'job-charged',
          status: 'refunded',
          updatedAt: 5,
          wasCharged: true,
        },
        {
          opponentName: 'rival2',
          jobId: 'job-free',
          status: 'failed',
          updatedAt: 5,
          wasCharged: false,
        },
        { opponentName: 'rival3', jobId: 'job-old', status: 'failed', updatedAt: 5 },
      ],
    });
  });

  it('synthesis: the zero-spend refunded terminal reads wasCharged false; an older record omits it', async () => {
    const { app: server, database } = app();
    database.seed(`prepSynthesisJobIndex/${TEST_UID}/${ENTRY_KEY}`, {
      jobId: 'synth-free',
      updatedAt: 5,
    });
    database.seed(`reportJobs/${TEST_UID}/synth-free`, {
      status: 'refunded',
      createdAt: 1,
      updatedAt: 5,
      attempt: 0,
      creditRef: 'synth-free',
      reason: 'post_event_synthesis',
      wasCharged: false,
    });
    const free = await server.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(free.json()).toEqual({
      job: { jobId: 'synth-free', status: 'refunded', updatedAt: 5, wasCharged: false },
    });

    database.seed(`reportJobs/${TEST_UID}/synth-free`, {
      status: 'refunded',
      createdAt: 1,
      updatedAt: 6,
      attempt: 0,
      creditRef: 'synth-free',
      reason: 'post_event_synthesis',
    });
    const old = await server.inject({
      method: 'GET',
      url: `/api/reports/synthesis?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    expect(old.json()).toEqual({ job: { jobId: 'synth-free', status: 'refunded', updatedAt: 6 } });
  });

  it('a stored null (RTDB-stripped / legacy writer) reads as absent, never as false', async () => {
    const { app: server, database } = app();
    seedPrepJob(database, 'rival1', 'job-null', { status: 'failed', wasCharged: null });
    const response = await server.inject({
      method: 'GET',
      url: `/api/reports/jobs?entryKey=${encodeURIComponent(ENTRY_KEY)}`,
      headers: authHeader(),
    });
    const [entry] = (response.json() as { jobs: Array<Record<string, unknown>> }).jobs;
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('wasCharged');
  });
});
