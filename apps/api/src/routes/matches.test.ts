import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const validCreateInput = {
  fighter_id: 1,
  opponent_id: 8,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'someplayer',
  notes: 'close game',
  matchType: 'online-friendly',
  win: true,
};

describe('GET /api/matches', () => {
  it('returns an empty array when the user has no matches', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('lists matches with their push key as id', async () => {
    const { app, database } = buildTestApp();

    database.seed(`matches/${TEST_UID}`, {
      pushKey1: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: 'pushKey1', fighter_id: 1, opponent_id: 8, time: 1700000000000, win: true },
    ]);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/matches' });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/matches', () => {
  it('creates a match and maintains the opponents map', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'someplayer',
      notes: 'close game',
      matchType: 'online-friendly',
      win: true,
    });
    expect(typeof body.id).toBe('string');
    expect(typeof body.time).toBe('number');

    expect(database.dump()).toMatchObject({
      opponents: { [TEST_UID]: { someplayer: true } },
    });
  });

  it('returns 400 for an invalid body', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { fighter_id: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400 });
  });
});

describe('PATCH /api/matches/:id', () => {
  it('updates an existing match', async () => {
    const { app, database } = buildTestApp();

    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: { ...validCreateInput, win: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'existingKey', win: false });
  });

  it('returns 404 for a match that does not exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/does-not-exist',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for an invalid body', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: { ...validCreateInput, win: 'not-a-boolean' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('DELETE /api/matches/:id', () => {
  it('removes an existing match', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/existingKey',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });
    expect(list.json()).toEqual([]);
  });

  it('returns 404 for a match that does not exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/does-not-exist',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });
});
