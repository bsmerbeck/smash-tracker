import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/stage-favorites', () => {
  it('returns an empty default when the user has never saved favorites', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/stage-favorites',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stageIds: [], updatedAt: 0 });
  });

  it('returns the saved favorites when present', async () => {
    const { app, database } = buildTestApp();
    database.seed(`stageFavorites/${TEST_UID}`, { stageIds: [113, 1, 1000, 1001], updatedAt: 555 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stage-favorites',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stageIds: [113, 1, 1000, 1001], updatedAt: 555 });
  });

  it('tolerates a record whose stageIds key was dropped by RTDB (empty array write)', async () => {
    const { app, database } = buildTestApp();
    // RTDB silently drops empty arrays on write, so a user who removed their
    // last favorite reads back as { updatedAt } only.
    database.seed(`stageFavorites/${TEST_UID}`, { updatedAt: 777 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stage-favorites',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stageIds: [], updatedAt: 777 });
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/stage-favorites' });

    expect(response.statusCode).toBe(401);
  });
});

describe('PUT /api/stage-favorites', () => {
  it('saves favorites in the given order and stamps updatedAt server-side', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: { stageIds: [113, 1, 1000, 1001] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stageIds).toEqual([113, 1, 1000, 1001]);
    expect(body.updatedAt).toBeGreaterThanOrEqual(before);
    expect(database.dump()).toMatchObject({
      stageFavorites: { [TEST_UID]: { stageIds: [113, 1, 1000, 1001] } },
    });
  });

  it('overwrites previously-saved favorites', async () => {
    const { app, database } = buildTestApp();
    database.seed(`stageFavorites/${TEST_UID}`, { stageIds: [3], updatedAt: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: { stageIds: [1, 113] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().stageIds).toEqual([1, 113]);
  });

  it('dedupes repeated ids, keeping the first occurrence', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: { stageIds: [113, 1, 113, 3, 1] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().stageIds).toEqual([113, 1, 3]);
  });

  it('accepts an empty list (removing the last favorite)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: { stageIds: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().stageIds).toEqual([]);
  });

  it('rejects unknown stage ids', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: { stageIds: [1, 99999] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects the id-0 no-selection sentinel', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: { stageIds: [0] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a missing body', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      headers: authHeader(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/stage-favorites',
      payload: { stageIds: [1] },
    });

    expect(response.statusCode).toBe(401);
  });
});
