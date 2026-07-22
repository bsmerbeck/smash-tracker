import { describe, expect, it } from 'vitest';
import type { InternalJobsConfig } from '../config/env.js';
import { buildTestApp } from '../test-support/testApp.js';
import { dayShardKey } from '../events/ledger.js';

const INTERNAL_JOBS_CONFIG: InternalJobsConfig = { secret: 'test-scheduler-secret' };
const SECRET_HEADER = 'x-internal-jobs-secret';

describe('/internal/jobs (unconfigured)', () => {
  it('answers 503 on GET /internal/jobs/project-ga4 when internalJobs config is missing', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/project-ga4',
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 on an arbitrary /internal/jobs/* path when unconfigured', async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/anything-else',
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('GET /internal/jobs/project-ga4 (configured)', () => {
  it('answers 401 when the secret header is missing', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/project-ga4',
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 401 when the secret header is wrong', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/project-ga4',
      headers: { [SECRET_HEADER]: 'wrong-secret' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('runs the handler and returns 200 when the secret header matches exactly', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/project-ga4',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projected: 0, skipped: 0, failed: 0 });
  });
});

describe('GET /internal/jobs/reconcile', () => {
  it('answers 401 when the secret header is missing', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({ method: 'GET', url: '/internal/jobs/reconcile' });
    expect(response.statusCode).toBe(401);
  });

  it('runs the handler and returns 200 with a reconcile summary when authorized', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/reconcile',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ checked: 0, missing: 0, phantom: 0, duplicate: 0 });
  });
});

describe('GET /internal/jobs/sweep-stuck-jobs', () => {
  it('answers 401 when the secret header is missing', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({ method: 'GET', url: '/internal/jobs/sweep-stuck-jobs' });
    expect(response.statusCode).toBe(401);
  });

  it('runs the handler and returns 200 with a sweep summary when authorized', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/sweep-stuck-jobs',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ swept: 0, refunded: 0 });
  });
});

describe('GET /internal/jobs/funnel-readout', () => {
  it('answers 401 when the secret header is missing', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({ method: 'GET', url: '/internal/jobs/funnel-readout' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 401 when the secret header is wrong', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/funnel-readout',
      headers: { [SECRET_HEADER]: 'wrong-secret' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 400 when days is out of range or non-numeric', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });

    const tooHigh = await app.inject({
      method: 'GET',
      url: '/internal/jobs/funnel-readout?days=15',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(tooHigh.statusCode).toBe(400);

    const tooLow = await app.inject({
      method: 'GET',
      url: '/internal/jobs/funnel-readout?days=0',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(tooLow.statusCode).toBe(400);

    const nonNumeric = await app.inject({
      method: 'GET',
      url: '/internal/jobs/funnel-readout?days=abc',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(nonNumeric.statusCode).toBe(400);
  });

  it('runs the handler and returns 200 with aggregate-only funnel data when authorized', async () => {
    const { app, database } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const today = dayShardKey(Date.now());

    database.seed(`eventLedger/${today}/key1`, { eventName: 'signup_completed' });
    database.seed(`eventLedger/${today}/key2`, { eventName: 'signup_completed' });
    database.seed(`reconciliationExceptions/${today}/exc1`, {
      kind: 'missing_event',
      subjectRef: 'some-uid',
      expected: { eventName: 'checkout_completed' },
      actual: 'absent',
      detectedAt: Date.now(),
    });
    database.seed(`outboxPending/${today}/key1`, { attempt: 0, nextRetryAt: null });

    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/funnel-readout?days=1',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      generatedAt: number;
      days: Array<{
        day: string;
        eventCounts: Record<string, number>;
        exceptionCounts: Record<string, number>;
        pendingProjection: number;
      }>;
      totals: {
        eventCounts: Record<string, number>;
        exceptionCounts: Record<string, number>;
        pendingProjection: number;
      };
    };

    expect(typeof body.generatedAt).toBe('number');
    expect(body.days).toHaveLength(1);
    expect(body.days[0]?.day).toBe(today);
    expect(body.totals.eventCounts).toEqual({ signup_completed: 2 });
    expect(body.totals.exceptionCounts).toEqual({ missing_event: 1 });
    expect(body.totals.pendingProjection).toBe(1);

    const serialized = response.body;
    expect(serialized).not.toContain('subjectRef');
    expect(serialized).not.toContain('actorId');
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('detectedAt');
  });
});

describe('GET /internal/jobs/prune', () => {
  it('answers 401 when the secret header is missing', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({ method: 'GET', url: '/internal/jobs/prune' });
    expect(response.statusCode).toBe(401);
  });

  it('runs the handler and returns 200 with a prune summary when authorized', async () => {
    const { app } = buildTestApp({ internalJobs: INTERNAL_JOBS_CONFIG });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/jobs/prune',
      headers: { [SECRET_HEADER]: INTERNAL_JOBS_CONFIG.secret },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { prunedLedgerDays: string[]; prunedExceptionDays: string[] };
    expect(Array.isArray(body.prunedLedgerDays)).toBe(true);
    expect(Array.isArray(body.prunedExceptionDays)).toBe(true);
  });
});
