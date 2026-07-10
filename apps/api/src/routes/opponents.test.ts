import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/opponents', () => {
  it('returns an empty array when no opponents exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponents',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns opponent names as a flat list', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponents/${TEST_UID}`, { someplayer: true, other: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponents',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sort()).toEqual(['other', 'someplayer']);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/opponents' });

    expect(response.statusCode).toBe(401);
  });

  it('skips corrupt entry values instead of failing the whole list (safeParse-and-skip)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponents/${TEST_UID}`, {
      someplayer: true,
      corruptvalue: 'not-a-boolean',
      other: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponents',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sort()).toEqual(['other', 'someplayer']);
  });

  it('returns an empty list when the whole node is a corrupt scalar (real prod shape)', async () => {
    const { app, database } = buildTestApp();
    // Cloud Run logs showed one user's opponents node stored as a bare
    // boolean ("expected record, received boolean") — 500'd since 2026-07-09.
    database.seed(`opponents/${TEST_UID}`, true);

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponents',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
