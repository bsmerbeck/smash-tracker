import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/playlists', () => {
  it('returns an empty list when the user has no playlists', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/playlists',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns stored playlists with their push keys', async () => {
    const { app, database } = buildTestApp();
    database.seed(`playlists/${TEST_UID}`, {
      p1: { name: 'Combo reel', createdAt: 100, matchIds: ['m1'] },
      p2: { name: 'Counterpicks', createdAt: 200, matchIds: [] },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/playlists',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        { id: 'p1', name: 'Combo reel', createdAt: 100, matchIds: ['m1'] },
        { id: 'p2', name: 'Counterpicks', createdAt: 200, matchIds: [] },
      ]),
    );
  });

  it('reads back a playlist with no matchIds key as matchIds: []', async () => {
    const { app, database } = buildTestApp();
    // RTDB drops empty arrays on write, so an emptied playlist leaves no
    // `matchIds` key at all (same lesson as stageFavorites).
    database.seed(`playlists/${TEST_UID}`, {
      p1: { name: 'Emptied', createdAt: 100 },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/playlists',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'p1', name: 'Emptied', createdAt: 100, matchIds: [] }]);
  });

  it('skips a corrupt record instead of failing the whole list', async () => {
    const { app, database } = buildTestApp();
    database.seed(`playlists/${TEST_UID}`, {
      good: { name: 'Good', createdAt: 100, matchIds: [] },
      corrupt: { createdAt: 'not-a-number' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/playlists',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'good', name: 'Good', createdAt: 100, matchIds: [] }]);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/playlists' });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/playlists', () => {
  it('creates a playlist with a server-stamped createdAt and empty matchIds', async () => {
    const { app, database } = buildTestApp();
    const before = Date.now();

    const response = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: authHeader(),
      payload: { name: 'Combo reel' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.name).toBe('Combo reel');
    expect(body.matchIds).toEqual([]);
    expect(body.createdAt).toBeGreaterThanOrEqual(before);
    expect(body.id).toEqual(expect.any(String));
    expect(database.dump()).toMatchObject({
      playlists: { [TEST_UID]: { [body.id]: { name: 'Combo reel' } } },
    });
  });

  it('rejects a blank name', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: authHeader(),
      payload: { name: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a name over 40 characters', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: authHeader(),
      payload: { name: 'a'.repeat(41) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects the 51st playlist with 403', async () => {
    const { app, database } = buildTestApp();
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) {
      seeded[`p${i}`] = { name: `Playlist ${i}`, createdAt: i, matchIds: [] };
    }
    database.seed(`playlists/${TEST_UID}`, seeded);

    const response = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: authHeader(),
      payload: { name: 'One too many' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      payload: { name: 'Combo reel' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('PATCH /api/playlists/:id', () => {
  it('reorders matchIds while preserving name', async () => {
    const { app, database } = buildTestApp();
    database.seed(`playlists/${TEST_UID}`, {
      p1: { name: 'Combo reel', createdAt: 100, matchIds: ['m1', 'm2'] },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/playlists/p1',
      headers: authHeader(),
      payload: { matchIds: ['m2', 'm1'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'p1',
      name: 'Combo reel',
      createdAt: 100,
      matchIds: ['m2', 'm1'],
    });
  });

  it('renames while preserving matchIds', async () => {
    const { app, database } = buildTestApp();
    database.seed(`playlists/${TEST_UID}`, {
      p1: { name: 'Combo reel', createdAt: 100, matchIds: ['m1', 'm2'] },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/playlists/p1',
      headers: authHeader(),
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'p1',
      name: 'Renamed',
      createdAt: 100,
      matchIds: ['m1', 'm2'],
    });
  });

  it('emptying matchIds reads back as []', async () => {
    const { app, database } = buildTestApp();
    database.seed(`playlists/${TEST_UID}`, {
      p1: { name: 'Combo reel', createdAt: 100, matchIds: ['m1'] },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/playlists/p1',
      headers: authHeader(),
      payload: { matchIds: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().matchIds).toEqual([]);
  });

  it('404s for an unknown playlist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/playlists/nope',
      headers: authHeader(),
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/playlists/p1',
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('DELETE /api/playlists/:id', () => {
  it('removes the playlist', async () => {
    const { app, database } = buildTestApp();
    database.seed(`playlists/${TEST_UID}`, {
      p1: { name: 'Combo reel', createdAt: 100, matchIds: [] },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/playlists/p1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    expect(database.dump()).not.toMatchObject({
      playlists: { [TEST_UID]: { p1: expect.anything() } },
    });
  });

  it('404s for an unknown playlist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/playlists/nope',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'DELETE', url: '/api/playlists/p1' });

    expect(response.statusCode).toBe(401);
  });
});
