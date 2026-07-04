import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/opponent-notes', () => {
  it('returns an empty map when no notes exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponent-notes',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('returns the notes map keyed by canonical name', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponentNotes/${TEST_UID}`, {
      rival: { habits: 'Likes to roll away from pressure', updatedAt: 1000 },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponent-notes',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rival: { habits: 'Likes to roll away from pressure', updatedAt: 1000 },
    });
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/opponent-notes' });

    expect(response.statusCode).toBe(401);
  });
});

describe('PUT /api/opponent-notes/:name', () => {
  it('writes a new note and stamps updatedAt server-side', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: { habits: 'Rolls a lot', watchFor: 'Ledge mixups', banThese: [3, 31] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      habits: 'Rolls a lot',
      watchFor: 'Ledge mixups',
      banThese: [3, 31],
    });
    expect(body.updatedAt).toBeGreaterThanOrEqual(before);
    expect(database.dump()).toMatchObject({
      opponentNotes: {
        [TEST_UID]: {
          rival: { habits: 'Rolls a lot', watchFor: 'Ledge mixups', banThese: [3, 31] },
        },
      },
    });
  });

  it('overwrites an existing note (full replace, not merge)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponentNotes/${TEST_UID}`, {
      rival: { habits: 'old habit', watchFor: 'old watch', banThese: [1], updatedAt: 1 },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: { habits: 'new habit' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().habits).toBe('new habit');
    expect(response.json().watchFor).toBeUndefined();
    expect(response.json().banThese).toBeUndefined();
    expect(database.dump()).toMatchObject({
      opponentNotes: { [TEST_UID]: { rival: { habits: 'new habit' } } },
    });
  });

  it('allows an empty body (clearing all fields but keeping the row with a fresh updatedAt)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().habits).toBeUndefined();
    expect(typeof response.json().updatedAt).toBe('number');
  });

  it('normalizes the name param (trim + lowercase)', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/opponent-notes/${encodeURIComponent('  Rival  ')}`,
      headers: authHeader(),
      payload: { habits: 'test' },
    });

    expect(response.statusCode).toBe(200);
    expect(database.dump()).toMatchObject({
      opponentNotes: { [TEST_UID]: { rival: { habits: 'test' } } },
    });
  });

  it('rejects a name param containing RTDB-reserved characters', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/opponent-notes/${encodeURIComponent('a/b')}`,
      headers: authHeader(),
      payload: { habits: 'test' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects habits text over the max length', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: { habits: 'x'.repeat(2001) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects watchFor text over the max length', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: { watchFor: 'x'.repeat(2001) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects more than 5 banThese stage ids', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: { banThese: [1, 2, 3, 4, 5, 6] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects negative or non-integer stage ids', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
      payload: { banThese: [-1] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponent-notes/rival',
      payload: { habits: 'test' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('DELETE /api/opponent-notes/:name', () => {
  it('removes an existing note', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponentNotes/${TEST_UID}`, { rival: { habits: 'test', updatedAt: 1 } });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/opponent-notes/rival',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    expect(database.dump()).not.toMatchObject({
      opponentNotes: { [TEST_UID]: { rival: { habits: 'test' } } },
    });
  });

  it('returns 404 for a non-existent note', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/opponent-notes/nope',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/opponent-notes/rival',
    });

    expect(response.statusCode).toBe(401);
  });
});
