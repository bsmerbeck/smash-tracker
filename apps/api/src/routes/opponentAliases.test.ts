import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/opponents/aliases', () => {
  it('returns an empty map when no aliases exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponents/aliases',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('returns the flat alias map', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponentAliases/${TEST_UID}`, { rivl: 'rival', riv: 'rival' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/opponents/aliases',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rivl: 'rival', riv: 'rival' });
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/opponents/aliases' });

    expect(response.statusCode).toBe(401);
  });
});

describe('PUT /api/opponents/aliases/:alias', () => {
  it('writes a new alias -> canonical mapping and returns the updated map', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponents/aliases/rivl',
      headers: authHeader(),
      payload: { canonical: 'rival' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rivl: 'rival' });
    expect(database.dump()).toMatchObject({
      opponentAliases: { [TEST_UID]: { rivl: 'rival' } },
    });
  });

  it('normalizes both the alias (params) and canonical (body) name', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/opponents/aliases/${encodeURIComponent('  Rivl  ')}`,
      headers: authHeader(),
      payload: { canonical: '  Rival  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rivl: 'rival' });
  });

  it('rejects a direct self-merge (alias === canonical)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponents/aliases/rival',
      headers: authHeader(),
      payload: { canonical: 'rival' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/cannot be merged into itself/i);
  });

  it('rejects a self-merge that only becomes apparent after transitive resolution', async () => {
    const { app, database } = buildTestApp();
    // "rivl" already resolves to "rival". Writing rival -> rivl should
    // resolve rivl -> rival first, discover the target IS rival, and reject.
    database.seed(`opponentAliases/${TEST_UID}`, { rivl: 'rival' });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponents/aliases/rival',
      headers: authHeader(),
      payload: { canonical: 'rivl' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('resolves the canonical transitively when the target is itself an alias, keeping the map flat', async () => {
    const { app, database } = buildTestApp();
    // "riv" -> "rivl" already exists. Merging "rivl" -> "rival" should NOT
    // create a chain; instead "riv" continues to resolve correctly because
    // "rivl" becomes a terminal alias pointing at "rival", and a fresh write
    // of another alias into "rivl" resolves through it.
    database.seed(`opponentAliases/${TEST_UID}`, { riv: 'rivl' });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponents/aliases/newalias',
      headers: authHeader(),
      payload: { canonical: 'riv' },
    });

    expect(response.statusCode).toBe(200);
    // "riv" resolves (through the existing map) to "rivl" — the final
    // non-aliased name — so "newalias" is written pointing at "rivl", not "riv".
    expect(response.json()).toEqual({ riv: 'rivl', newalias: 'rivl' });
  });

  it('rejects an invalid canonical name (blank)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponents/aliases/rivl',
      headers: authHeader(),
      payload: { canonical: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an alias param containing RTDB-reserved characters', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/opponents/aliases/${encodeURIComponent('a/b')}`,
      headers: authHeader(),
      payload: { canonical: 'rival' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/opponents/aliases/rivl',
      payload: { canonical: 'rival' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('DELETE /api/opponents/aliases/:alias', () => {
  it('removes an existing alias', async () => {
    const { app, database } = buildTestApp();
    database.seed(`opponentAliases/${TEST_UID}`, { rivl: 'rival' });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/opponents/aliases/rivl',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);
    expect(database.dump()).not.toMatchObject({
      opponentAliases: { [TEST_UID]: { rivl: 'rival' } },
    });
  });

  it('returns 404 for a non-existent alias', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/opponents/aliases/nope',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/opponents/aliases/rivl',
    });

    expect(response.statusCode).toBe(401);
  });
});
