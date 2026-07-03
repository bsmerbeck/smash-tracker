import { describe, expect, it } from 'vitest';
import { buildTestApp } from './test-support/testApp.js';

describe('GET /healthz', () => {
  it('returns ok status without authentication', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  it('rejects requests with no Authorization header', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/matches' });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with a malformed Authorization header', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: 'Basic abc123' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with an invalid bearer token', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    expect(response.statusCode).toBe(401);
  });
});
