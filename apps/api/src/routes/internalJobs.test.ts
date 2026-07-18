import { describe, expect, it } from 'vitest';
import type { InternalJobsConfig } from '../config/env.js';
import { buildTestApp } from '../test-support/testApp.js';

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
