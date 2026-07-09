import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/gsp-readings', () => {
  it('returns an empty list when the user has no readings', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/gsp-readings',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns stored readings with their push keys', async () => {
    const { app, database } = buildTestApp();
    database.seed(`gspReadings/${TEST_UID}`, {
      r1: { fighter_id: 1, gsp: 9_000_000, time: 100 },
      r2: { fighter_id: 2, gsp: 12_000_000, time: 200 },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/gsp-readings',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        { id: 'r1', fighter_id: 1, gsp: 9_000_000, time: 100 },
        { id: 'r2', fighter_id: 2, gsp: 12_000_000, time: 200 },
      ]),
    );
  });

  it('skips a corrupt record instead of failing the whole list', async () => {
    const { app, database } = buildTestApp();
    database.seed(`gspReadings/${TEST_UID}`, {
      good: { fighter_id: 1, gsp: 9_000_000, time: 100 },
      corrupt: { gsp: 'not-a-number' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/gsp-readings',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'good', fighter_id: 1, gsp: 9_000_000, time: 100 }]);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/gsp-readings' });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/gsp-readings', () => {
  it('creates a reading with a server-stamped time', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const response = await app.inject({
      method: 'POST',
      url: '/api/gsp-readings',
      headers: authHeader(),
      payload: { fighter_id: 7, gsp: 10_500_000 },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.fighter_id).toBe(7);
    expect(body.gsp).toBe(10_500_000);
    expect(body.time).toBeGreaterThanOrEqual(before);
    expect(body.id).toEqual(expect.any(String));
    expect(database.dump()).toMatchObject({
      gspReadings: { [TEST_UID]: { [body.id]: { fighter_id: 7, gsp: 10_500_000 } } },
    });
  });

  it('rejects a negative GSP', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/gsp-readings',
      headers: authHeader(),
      payload: { fighter_id: 7, gsp: -1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a client-supplied time (server stamps it)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/gsp-readings',
      headers: authHeader(),
      payload: { fighter_id: 7, gsp: 1_000_000, time: 12345 },
    });

    // zod strips unknown keys by default; the record must still be
    // server-stamped rather than honoring the smuggled value.
    expect(response.statusCode).toBe(201);
    expect(response.json().time).toBeGreaterThan(12345);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/gsp-readings',
      payload: { fighter_id: 7, gsp: 1_000_000 },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('PATCH /api/gsp-readings/:id', () => {
  it('corrects the GSP value while preserving time and fighter', async () => {
    const { app, database } = buildTestApp();
    database.seed(`gspReadings/${TEST_UID}`, {
      r1: { fighter_id: 1, gsp: 9_000_000, time: 100 },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/gsp-readings/r1',
      headers: authHeader(),
      payload: { gsp: 9_100_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: 'r1', fighter_id: 1, gsp: 9_100_000, time: 100 });
  });

  it('404s for an unknown reading', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/gsp-readings/nope',
      headers: authHeader(),
      payload: { gsp: 9_100_000 },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/gsp-readings/:id', () => {
  it('removes the reading', async () => {
    const { app, database } = buildTestApp();
    database.seed(`gspReadings/${TEST_UID}`, {
      r1: { fighter_id: 1, gsp: 9_000_000, time: 100 },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/gsp-readings/r1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    expect(database.dump()).not.toMatchObject({
      gspReadings: { [TEST_UID]: { r1: expect.anything() } },
    });
  });

  it('404s for an unknown reading', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/gsp-readings/nope',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });
});
