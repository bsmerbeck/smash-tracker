import { describe, expect, it } from 'vitest';
import { DEFAULT_ELITE_THRESHOLD } from '@smash-tracker/shared';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/gsp-settings', () => {
  it('returns the placeholder default when the user has never saved settings', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/gsp-settings',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ eliteThreshold: DEFAULT_ELITE_THRESHOLD, updatedAt: 0 });
  });

  it('returns the saved settings when present', async () => {
    const { app, database } = buildTestApp();
    database.seed(`gspSettings/${TEST_UID}`, { eliteThreshold: 12_000_000, updatedAt: 555 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/gsp-settings',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ eliteThreshold: 12_000_000, updatedAt: 555 });
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/gsp-settings' });

    expect(response.statusCode).toBe(401);
  });
});

describe('PUT /api/gsp-settings', () => {
  it('saves a new threshold and stamps updatedAt server-side', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/gsp-settings',
      headers: authHeader(),
      payload: { eliteThreshold: 11_500_000 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.eliteThreshold).toBe(11_500_000);
    expect(body.updatedAt).toBeGreaterThanOrEqual(before);
    expect(database.dump()).toMatchObject({
      gspSettings: { [TEST_UID]: { eliteThreshold: 11_500_000 } },
    });
  });

  it('overwrites a previously-saved threshold', async () => {
    const { app, database } = buildTestApp();
    database.seed(`gspSettings/${TEST_UID}`, { eliteThreshold: 9_000_000, updatedAt: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/gsp-settings',
      headers: authHeader(),
      payload: { eliteThreshold: 13_000_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().eliteThreshold).toBe(13_000_000);
  });

  it('rejects a non-positive threshold', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/gsp-settings',
      headers: authHeader(),
      payload: { eliteThreshold: 0 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a missing body', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/gsp-settings',
      headers: authHeader(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/gsp-settings',
      payload: { eliteThreshold: 10_000_000 },
    });

    expect(response.statusCode).toBe(401);
  });
});
