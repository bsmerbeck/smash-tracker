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

/** A stored start.gg-synced match (id `sgg-123-g1` in the tests). */
const syncedRecord = {
  fighter_id: 1,
  opponent_id: 8,
  time: 1700000000000,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'someplayer',
  notes: '',
  matchType: 'online-tourney',
  win: true,
  source: 'startgg',
  externalId: 'sgg:123:g1',
} as const;

/**
 * The PATCH payload a well-behaved annotation editor (VodNotesDialog) sends
 * for `syncedRecord`: every sync-owned game fact carried through unchanged.
 */
const syncedCarryThroughPayload = {
  fighter_id: syncedRecord.fighter_id,
  opponent_id: syncedRecord.opponent_id,
  map: syncedRecord.map,
  opponent: syncedRecord.opponent,
  notes: syncedRecord.notes,
  matchType: syncedRecord.matchType,
  win: syncedRecord.win,
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

  it('accepts and stores stocksLeft, eventName, and tournamentName', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        stocksLeft: 2,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      stocksLeft: 2,
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
    });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({
      stocksLeft: 2,
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
    });
  });

  it('omits stocksLeft/eventName/tournamentName from the stored record when not provided', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).not.toHaveProperty('stocksLeft');
    expect(body).not.toHaveProperty('eventName');
    expect(body).not.toHaveProperty('tournamentName');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).not.toHaveProperty('stocksLeft');
    expect(stored).not.toHaveProperty('eventName');
    expect(stored).not.toHaveProperty('tournamentName');
  });

  it('omits stocksLeft/eventName/tournamentName when submitted as empty/whitespace strings', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, eventName: '', tournamentName: '   ' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).not.toHaveProperty('eventName');
    expect(body).not.toHaveProperty('tournamentName');
  });

  it('returns 400 when stocksLeft is out of range', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, stocksLeft: 4 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when stocksLeft is negative', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, stocksLeft: -1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when eventName exceeds 80 characters', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, eventName: 'a'.repeat(81) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('accepts and stores vodUrl and vodTimestamps', async () => {
    const { app, database } = buildTestApp();

    const vodTimestamps = [{ seconds: 161, note: 'missed punish on shield' }];

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps,
    });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps,
    });
  });

  it('accepts and stores vodStartSeconds', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodStartSeconds: 5025,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ vodStartSeconds: 5025 });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({ vodStartSeconds: 5025 });
  });

  it('omits vodStartSeconds from the stored record when not provided', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty('vodStartSeconds');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).not.toHaveProperty('vodStartSeconds');
  });

  it('accepts and stores match-level tags', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, tags: ['practice-friendlies', 'my custom tag'] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ tags: ['practice-friendlies', 'my custom tag'] });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({ tags: ['practice-friendlies', 'my custom tag'] });
  });

  it('accepts and stores note-level tags inside vodTimestamps entries', async () => {
    const { app, database } = buildTestApp();

    const vodTimestamps = [
      { seconds: 161, note: 'missed punish on shield', tags: ['punish', 'my custom tag'] },
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ vodTimestamps });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({ vodTimestamps });
  });

  it('accepts and stores a tag-only vodTimestamp entry with an empty note', async () => {
    const { app, database } = buildTestApp();

    const vodTimestamps = [{ seconds: 42, note: '', tags: ['punish'] }];

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ vodTimestamps });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({ vodTimestamps });
  });

  it('omits tags from the stored record when not provided', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty('tags');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).not.toHaveProperty('tags');
  });

  it('rejects source/externalId from client input (server-only fields)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, source: 'startgg', externalId: 'sgg:123:g1' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('externalId');
  });

  it('accepts and stores a gsp reading', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, matchType: 'quickplay', gsp: 9_420_000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ gsp: 9_420_000 });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({ gsp: 9_420_000 });
  });

  it('accepts an anonymous (blank) opponent for online/GSP matches and omits it + the registry entry', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        opponent: '',
        matchType: 'quickplay',
        gsp: 12_345_678,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty('opponent');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).not.toHaveProperty('opponent');
    expect(stored).toMatchObject({ gsp: 12_345_678 });
    // No blank key written into the opponents registry.
    const opponents = (dump.opponents ?? {}) as Record<string, unknown>;
    expect(opponents[TEST_UID] ?? {}).toEqual({});
  });

  it('omits gsp from the stored record when not provided', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty('gsp');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).not.toHaveProperty('gsp');
  });

  it('returns 400 when gsp is negative', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, gsp: -1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when gsp is not an integer', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, gsp: 123.45 },
    });

    expect(response.statusCode).toBe(400);
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

  it('accepts and stores stocksLeft, eventName, and tournamentName', async () => {
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
      payload: {
        ...validCreateInput,
        stocksLeft: 3,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stocksLeft: 3,
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
    });
  });

  it('omits stocksLeft/eventName/tournamentName from the stored record when not provided', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      stocksLeft: 2,
      eventName: 'Stale Event',
      tournamentName: 'Stale Tournament',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('stocksLeft');
    expect(body).not.toHaveProperty('eventName');
    expect(body).not.toHaveProperty('tournamentName');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = matches[TEST_UID]!.existingKey!;
    expect(stored).not.toHaveProperty('stocksLeft');
    expect(stored).not.toHaveProperty('eventName');
    expect(stored).not.toHaveProperty('tournamentName');
  });

  it('returns 400 when stocksLeft is out of range', async () => {
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
      payload: { ...validCreateInput, stocksLeft: 4 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('sets vodUrl and vodTimestamps', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
    });

    const vodTimestamps = [
      { seconds: 161, note: 'missed punish on shield' },
      { seconds: 490, note: 'lost ledge trump war' },
    ];

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps,
    });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!.existingKey).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps,
    });
  });

  it('updates existing vodUrl and vodTimestamps', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
        vodTimestamps: [{ seconds: 300, note: 'updated note' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=xyz789',
      vodTimestamps: [{ seconds: 300, note: 'updated note' }],
    });
  });

  it('clears vodUrl and vodTimestamps when omitted from the update payload', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('vodUrl');
    expect(body).not.toHaveProperty('vodTimestamps');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = matches[TEST_UID]!.existingKey!;
    expect(stored).not.toHaveProperty('vodUrl');
    expect(stored).not.toHaveProperty('vodTimestamps');
  });

  it('sets vodStartSeconds', async () => {
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
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodStartSeconds: 5025,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ vodStartSeconds: 5025 });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!.existingKey).toMatchObject({ vodStartSeconds: 5025 });
  });

  it('updates existing vodStartSeconds', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 5025,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodStartSeconds: 90,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ vodStartSeconds: 90 });
  });

  it('clears vodStartSeconds when omitted from the update payload', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 5025,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('vodStartSeconds');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = matches[TEST_UID]!.existingKey!;
    expect(stored).not.toHaveProperty('vodStartSeconds');
  });

  it('drops tags from the stored record when the update payload sends an explicit empty array', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      tags: ['practice-friendlies'],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: { ...validCreateInput, tags: [] },
    });

    // The PATCH response echoes the in-memory record built from the
    // request (no RTDB round-trip before responding), so it still reflects
    // the `tags: []` the caller sent.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tags: [] });

    // But RTDB silently drops keys holding an empty array on write, so the
    // persisted record — and any subsequent read — genuinely lacks the
    // `tags` key. This confirms that behavior rather than relying on
    // `.optional()` semantics alone.
    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = matches[TEST_UID]!.existingKey!;
    expect(stored).not.toHaveProperty('tags');

    const list = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });
    const [readBack] = list.json() as Array<Record<string, unknown>>;
    expect(readBack).not.toHaveProperty('tags');
  });

  it('returns 400 when vodTimestamps exceeds 20 entries', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
    });

    const vodTimestamps = Array.from({ length: 21 }, (_, i) => ({
      seconds: i,
      note: `note ${i}`,
    }));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123', vodTimestamps },
    });

    expect(response.statusCode).toBe(400);
  });

  it('accepts a vodTimestamps entry with a blank note (tag-only quick capture)', async () => {
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
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 10, note: '   ' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vodTimestamps: [{ seconds: 10, note: '' }],
    });
  });

  it('returns 400 when a vodTimestamps seconds value is negative', async () => {
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
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: -5, note: 'negative seconds' }],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('sets a gsp reading', async () => {
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
      payload: { ...validCreateInput, matchType: 'quickplay', gsp: 8_500_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ gsp: 8_500_000 });
  });

  it('updates an existing gsp reading', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      gsp: 8_000_000,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: { ...validCreateInput, matchType: 'quickplay', gsp: 8_100_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ gsp: 8_100_000 });
  });

  it('clears gsp when omitted from the update payload', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      gsp: 8_000_000,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('gsp');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = matches[TEST_UID]!.existingKey!;
    expect(stored).not.toHaveProperty('gsp');
  });

  it('returns 400 when gsp is negative', async () => {
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
      payload: { ...validCreateInput, gsp: -1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('preserves the original time — editing corrects a match, it does not re-date it', async () => {
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
      payload: { ...validCreateInput, win: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ time: 1700000000000, win: true });
  });

  it('returns 409 when changing game data on a synced match', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/sgg-123-g1`, {
      ...syncedRecord,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/sgg-123-g1',
      headers: authHeader(),
      // Flipping the result is exactly the edit sync would undo.
      payload: { ...syncedCarryThroughPayload, win: !syncedRecord.win },
    });

    expect(response.statusCode).toBe(409);
    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!['sgg-123-g1']).toMatchObject({ win: syncedRecord.win });
  });

  it('allows annotation-only updates (notes/vod/gsp) on a synced match, preserving provenance', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/sgg-123-g1`, {
      ...syncedRecord,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/sgg-123-g1',
      headers: authHeader(),
      payload: {
        ...syncedCarryThroughPayload,
        notes: 'their ledge habits are exploitable',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      },
    });

    expect(response.statusCode).toBe(200);
    // source/externalId/time survive the full-overwrite rebuild.
    expect(response.json()).toMatchObject({
      notes: 'their ledge habits are exploitable',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      source: 'startgg',
      externalId: 'sgg:123:g1',
      time: syncedRecord.time,
    });
  });

  it('allows a tags-only update on a synced match (tags are not sync-owned)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/sgg-123-g1`, {
      ...syncedRecord,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/sgg-123-g1',
      headers: authHeader(),
      payload: {
        ...syncedCarryThroughPayload,
        tags: ['practice-friendlies'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tags: ['practice-friendlies'],
      source: 'startgg',
      externalId: 'sgg:123:g1',
    });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!['sgg-123-g1']).toMatchObject({ tags: ['practice-friendlies'] });
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

  it('returns 409 for a synced match and leaves it in place', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/sgg-123-g1`, { ...syncedRecord });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/sgg-123-g1',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(409);
    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!['sgg-123-g1']).toMatchObject({ source: 'startgg' });
  });
});
