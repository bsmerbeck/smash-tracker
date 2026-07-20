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

  it('skips a corrupt record instead of failing the whole list (safeParse-and-skip)', async () => {
    const { app, database } = buildTestApp();

    database.seed(`matches/${TEST_UID}`, {
      goodKey: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
      },
      // Real prod corruption shape: `time` stored as a string 500'd the
      // entire GET /api/matches for the affected user (2026-07-06 onward).
      corruptKey: {
        fighter_id: 1,
        opponent_id: 8,
        time: '1700000000001',
        win: false,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: 'goodKey', fighter_id: 1, opponent_id: 8, time: 1700000000000, win: true },
    ]);
  });

  it('REGRESSION (CR-02): one corrupt vodTimestamps entry never 500s the list — the match survives with the bad entry dropped', async () => {
    const { app, database } = buildTestApp();

    database.seed(`matches/${TEST_UID}`, {
      // Corrupt entry in the legacy-array shape (string-typed seconds — the
      // same corruption class as the string-typed `time` prod incident).
      legacyShaped: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
        vodTimestamps: [
          { seconds: 'x', note: 'corrupt' },
          { seconds: 9, note: 'kept legacy' },
        ],
      },
      // Corrupt entry in the keyed shape.
      keyedShaped: {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000001,
        win: false,
        vodTimestamps: {
          bad: { seconds: 'x', note: 'corrupt' },
          good: { seconds: 4, note: 'kept keyed' },
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; vodTimestamps?: unknown[] }>;
    expect(body).toHaveLength(2);
    const byId = Object.fromEntries(body.map((match) => [match.id, match]));
    expect(byId.legacyShaped!.vodTimestamps).toMatchObject([{ seconds: 9, note: 'kept legacy' }]);
    expect(byId.keyedShaped!.vodTimestamps).toMatchObject([
      { id: 'good', seconds: 4, note: 'kept keyed' },
    ]);
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

  it('accepts and stores vodUrl but silently ignores a client-supplied vodTimestamps (Phase 8: notes are create-only via dedicated note endpoints)', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        // vodTimestamps is no longer part of createMatchInputSchema (08-01) —
        // an attempt to smuggle it through this path is stripped by Zod's
        // default strip-unknown-keys behavior, not rejected with a 400.
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ vodUrl: 'https://youtube.com/watch?v=abc123' });
    expect(body).not.toHaveProperty('vodTimestamps');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = Object.values(matches[TEST_UID]!)[0]!;
    expect(stored).toMatchObject({ vodUrl: 'https://youtube.com/watch?v=abc123' });
    expect(stored).not.toHaveProperty('vodTimestamps');
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

  it('sets vodUrl and silently ignores a client-supplied vodTimestamps on a match with no existing notes', async () => {
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
        // vodTimestamps is no longer part of updateMatchInputSchema (08-01)
        // — Zod strips it silently rather than rejecting the request.
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ vodUrl: 'https://youtube.com/watch?v=abc123' });
    expect(body).not.toHaveProperty('vodTimestamps');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!.existingKey).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=abc123',
    });
    expect(matches[TEST_UID]!.existingKey).not.toHaveProperty('vodTimestamps');
  });

  it('REGRESSION (RESEARCH Pitfall 1): note-survival-on-match-fact-edit — a PATCH updating vodUrl on a match with an existing legacy-array note preserves that note untouched, ignoring any client-supplied vodTimestamps attempt', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/existingKey`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: false,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      // Legacy dense-array shape — every pre-Phase-8 stored note.
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/existingKey',
      headers: authHeader(),
      payload: {
        ...validCreateInput,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
        // An attempt to smuggle a replacement note through the match-fact
        // PATCH — this MUST be ignored; the original note must survive
        // untouched, not be replaced or wiped.
        vodTimestamps: [{ seconds: 300, note: 'a stomped-in note' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=xyz789',
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!.existingKey).toMatchObject({
      vodUrl: 'https://youtube.com/watch?v=xyz789',
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });
  });

  it('clears vodUrl when omitted from the update payload, but PRESERVES existing vodTimestamps notes (omission no longer clears notes)', async () => {
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
    expect(body).toMatchObject({
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const stored = matches[TEST_UID]!.existingKey!;
    expect(stored).not.toHaveProperty('vodUrl');
    expect(stored).toMatchObject({
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });
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

/** Extracts every event row across `eventLedger`'s day shards — mirrors `coachingReviewDeliveries.test.ts`'s identically-named helper. */
function eventRows(dump: unknown): Array<{ eventName: string; actorId: string; payload: unknown }> {
  const typed = dump as { eventLedger?: Record<string, Record<string, unknown>> };
  return Object.values(typed.eventLedger ?? {}).flatMap((day) => Object.values(day)) as Array<{
    eventName: string;
    actorId: string;
    payload: unknown;
  }>;
}

/** Registers a managed client (coach = TEST_UID) and returns its tenantId, for `X-Active-Subject: client:{tenantId}` coaching-mode requests. */
async function createManagedClient(app: ReturnType<typeof buildTestApp>['app']): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/coaching/clients',
    headers: authHeader(),
    payload: { label: 'Alex' },
  });
  return response.json().clientId as string;
}

/**
 * Phase 11 carry-over (D-11, Plan 12-05): `client_vod_attached` — cataloged
 * in Phase 11 but never actually wired until now. Fires ONLY on the first
 * `vodUrl` write to a CLIENT-LIBRARY match (`subjectId !== uid`), on both
 * the create and update paths, and never for a personal match.
 */
describe('client_vod_attached carry-over (D-11)', () => {
  it('fires once when a coach CREATES a match directly into a client library with a vodUrl attached', async () => {
    const { app, database } = buildTestApp();
    const tenantId = await createManagedClient(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: { ...authHeader(), 'x-active-subject': `client:${tenantId}` },
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const fired = rows.filter((row) => row.eventName === 'client_vod_attached');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe(TEST_UID);
    expect(fired[0]?.payload).toEqual({});
  });

  it('does NOT fire when a coach creates a match into a client library with no vodUrl', async () => {
    const { app, database } = buildTestApp();
    const tenantId = await createManagedClient(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: { ...authHeader(), 'x-active-subject': `client:${tenantId}` },
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'client_vod_attached')).toHaveLength(0);
  });

  it('does NOT fire for a PERSONAL match creation with a vodUrl attached (subjectId === uid)', async () => {
    const { app, database } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'client_vod_attached')).toHaveLength(0);
  });

  it('fires once on the FIRST vodUrl PATCH to a client-library match that never had one', async () => {
    const { app, database } = buildTestApp();
    const tenantId = await createManagedClient(app);
    database.seed(`matches/${tenantId}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1',
      headers: { ...authHeader(), 'x-active-subject': `client:${tenantId}` },
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const fired = rows.filter((row) => row.eventName === 'client_vod_attached');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe(TEST_UID);
  });

  it('does NOT re-fire on a SECOND vodUrl PATCH that merely changes an already-attached URL', async () => {
    const { app, database } = buildTestApp();
    const tenantId = await createManagedClient(app);
    database.seed(`matches/${tenantId}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=already-attached',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1',
      headers: { ...authHeader(), 'x-active-subject': `client:${tenantId}` },
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'client_vod_attached')).toHaveLength(0);
  });

  it('does NOT fire on a PERSONAL match PATCH first-attaching a vodUrl (subjectId === uid)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1',
      headers: authHeader(),
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'client_vod_attached')).toHaveLength(0);
  });

  it('never leaks vodFirstAttached onto the wire response', async () => {
    const { app, database } = buildTestApp();
    const tenantId = await createManagedClient(app);
    database.seed(`matches/${tenantId}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1',
      headers: { ...authHeader(), 'x-active-subject': `client:${tenantId}` },
      payload: { ...validCreateInput, vodUrl: 'https://youtube.com/watch?v=abc123' },
    });

    expect(response.statusCode).toBe(200);
    expect('vodFirstAttached' in response.json()).toBe(false);
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

describe('POST /api/matches/:id/clear-vod', () => {
  it('drops vodUrl/vodStartSeconds/vodTimestamps together and returns the updated match', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      opponent: 'someplayer',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 30,
      vodTimestamps: [{ seconds: 42, note: 'missed a punish' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/clear-vod',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('vodUrl');
    expect(body).not.toHaveProperty('vodStartSeconds');
    expect(body).not.toHaveProperty('vodTimestamps');
    expect(body).toMatchObject({ opponent: 'someplayer' });

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!.m1).not.toHaveProperty('vodTimestamps');
  });

  it('returns 404 for a match that does not exist', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/missing/clear-vod',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/clear-vod',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('Owner note CRUD: POST/PATCH/DELETE /api/matches/:id/notes[/:noteId]', () => {
  function seedMatch(database: ReturnType<typeof buildTestApp>['database'], overrides = {}) {
    database.seed(`matches/${TEST_UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      ...overrides,
    });
  }

  it('creates a note and returns it with an id', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/notes',
      headers: authHeader(),
      payload: { seconds: 42, note: 'missed a punish', tags: ['punish'] },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ seconds: 42, note: 'missed a punish', tags: ['punish'] });
    expect(typeof body.id).toBe('string');

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (matches[TEST_UID]!.m1 as Record<string, unknown>)
      .vodTimestamps as Record<string, unknown>;
    expect(vodTimestamps[body.id]).toMatchObject({ seconds: 42, note: 'missed a punish' });
  });

  it('returns 404 when creating a note on a missing match', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/missing/notes',
      headers: authHeader(),
      payload: { seconds: 1, note: 'x' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('WR-07: a crafted :id with RTDB-illegal characters 404s on every note route + clear-vod — never a 500', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: { n1: { seconds: 1, note: 'x' } } });

    // `.` `#` `$` `[` `]` make firebase-admin's ref() throw synchronously
    // (500 without the guard); DEL (%7F) is path-illegal too (WR-08 class).
    const craftedIds = ['foo.bar', 'foo%23bar', 'foo$bar', 'foo%5Bbar%5D', 'foo%7Fbar'];

    for (const id of craftedIds) {
      const create = await app.inject({
        method: 'POST',
        url: `/api/matches/${id}/notes`,
        headers: authHeader(),
        payload: { seconds: 1, note: 'x' },
      });
      expect(create.statusCode).toBe(404);

      const update = await app.inject({
        method: 'PATCH',
        url: `/api/matches/${id}/notes/n1`,
        headers: authHeader(),
        payload: { seconds: 1, note: 'x' },
      });
      expect(update.statusCode).toBe(404);

      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/matches/${id}/notes/n1`,
        headers: authHeader(),
      });
      expect(remove.statusCode).toBe(404);

      const clearVod = await app.inject({
        method: 'POST',
        url: `/api/matches/${id}/clear-vod`,
        headers: authHeader(),
      });
      expect(clearVod.statusCode).toBe(404);
    }
  });

  it('WR-07: a crafted :id containing a slash (would address a NESTED child) 404s on the note create', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database);

    const response = await app.inject({
      method: 'POST',
      url: `/api/matches/m1%2Fnested/notes`,
      headers: authHeader(),
      payload: { seconds: 1, note: 'x' },
    });

    expect(response.statusCode).toBe(404);
    // Nothing was written under a nested child of the real match.
    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    expect(matches[TEST_UID]!.m1 as Record<string, unknown>).not.toHaveProperty('nested');
  });

  it('REGRESSION (CR-02): a corrupt sibling entry never breaks a note write — the new note lands, the corrupt entry is dropped', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, {
      vodTimestamps: {
        bad: { seconds: 'x', note: 'corrupt sibling' },
        good: { seconds: 9, note: 'healthy sibling' },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/notes',
      headers: authHeader(),
      payload: { seconds: 42, note: 'new note' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (matches[TEST_UID]!.m1 as Record<string, unknown>)
      .vodTimestamps as Record<string, unknown>;
    expect(vodTimestamps[body.id]).toMatchObject({ seconds: 42, note: 'new note' });
    expect(vodTimestamps.good).toMatchObject({ seconds: 9, note: 'healthy sibling' });
  });

  it('returns 401 for an unauthenticated create', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/notes',
      payload: { seconds: 1, note: 'x' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects the 21st note with a 403 and leaves the stored node at exactly 20 children', async () => {
    const { app, database } = buildTestApp();
    const twenty = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, { seconds: i, note: `note ${i}` }]),
    );
    seedMatch(database, { vodTimestamps: twenty });

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/notes',
      headers: authHeader(),
      payload: { seconds: 999, note: 'one too many' },
    });

    expect(response.statusCode).toBe(403);

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (matches[TEST_UID]!.m1 as Record<string, unknown>)
      .vodTimestamps as Record<string, unknown>;
    expect(Object.keys(vodTimestamps)).toHaveLength(20);
  });

  it('migrates a legacy-array match to keyed shape (push-style keys, not 0/1) on first note write', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: [{ seconds: 10, note: 'old note' }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/notes',
      headers: authHeader(),
      payload: { seconds: 20, note: 'new note' },
    });

    expect(response.statusCode).toBe(201);

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (matches[TEST_UID]!.m1 as Record<string, unknown>).vodTimestamps;
    expect(Array.isArray(vodTimestamps)).toBe(false);
    const keys = Object.keys(vodTimestamps as Record<string, unknown>);
    expect(keys).toHaveLength(2);
    expect(keys).not.toContain('0');
    expect(keys).not.toContain('1');
  });

  it('updates a note by id', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: { n1: { seconds: 10, note: 'original' } } });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1/notes/n1',
      headers: authHeader(),
      payload: { seconds: 15, note: 'edited' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'n1', seconds: 15, note: 'edited' });
  });

  it('returns 404 updating a missing noteId', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: { n1: { seconds: 10, note: 'original' } } });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1/notes/missing',
      headers: authHeader(),
      payload: { seconds: 15, note: 'edited' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 401 for an unauthenticated update', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: { n1: { seconds: 10, note: 'original' } } });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/matches/m1/notes/n1',
      payload: { seconds: 15, note: 'edited' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('deletes a note by id, including a coach-authored note (owner moderation)', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, {
      vodTimestamps: {
        n1: { seconds: 10, note: 'owner note' },
        n2: {
          seconds: 20,
          note: 'coach note',
          coach: { sessionId: '11111111-1111-4111-8111-111111111111', displayName: 'Coach' },
        },
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/m1/notes/n2',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(204);

    const dump = database.dump() as Record<string, unknown>;
    const matches = dump.matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (matches[TEST_UID]!.m1 as Record<string, unknown>)
      .vodTimestamps as Record<string, unknown>;
    expect(vodTimestamps).not.toHaveProperty('n2');
    expect(vodTimestamps).toHaveProperty('n1');
  });

  it('returns 404 deleting a missing noteId', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: { n1: { seconds: 10, note: 'original' } } });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/m1/notes/missing',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 401 for an unauthenticated delete', async () => {
    const { app, database } = buildTestApp();
    seedMatch(database, { vodTimestamps: { n1: { seconds: 10, note: 'original' } } });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/matches/m1/notes/n1',
    });

    expect(response.statusCode).toBe(401);
  });
});

/**
 * Phase 13 (ONBD-04): personal writes (never client-library writes) fire
 * `reconcilePlayerActivation`, which emits `analytics_activated` once the
 * personal library reaches `ANALYTICS_MIN_GAMES` (5) and `vod_activated`
 * once a personal match reaches vodUrl + 2 notes. Fire-and-forget, same
 * `await new Promise((resolve) => setTimeout(resolve, 0))` flush pattern as
 * the `client_vod_attached carry-over` describe above.
 */
describe('player activation reconciliation (ONBD-04)', () => {
  it('fires analytics_activated once a PERSONAL match creation crosses the 5-game threshold', async () => {
    const { app, database } = buildTestApp();
    for (let i = 0; i < 4; i += 1) {
      database.seed(`matches/${TEST_UID}/existing${i}`, {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const fired = rows.filter((row) => row.eventName === 'analytics_activated');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe(TEST_UID);
  });

  it('does not re-fire analytics_activated on a second personal creation past the threshold', async () => {
    const { app, database } = buildTestApp();
    for (let i = 0; i < 5; i += 1) {
      database.seed(`matches/${TEST_UID}/existing${i}`, {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: authHeader(),
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'analytics_activated')).toHaveLength(1);
  });

  it('does NOT reconcile activation for a client-library match creation (subjectId !== uid)', async () => {
    const { app, database } = buildTestApp();
    const tenantId = await createManagedClient(app);
    for (let i = 0; i < 4; i += 1) {
      database.seed(`matches/${tenantId}/existing${i}`, {
        fighter_id: 1,
        opponent_id: 8,
        time: 1700000000000,
        win: true,
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: { ...authHeader(), 'x-active-subject': `client:${tenantId}` },
      payload: validCreateInput,
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    expect(rows.filter((row) => row.eventName === 'analytics_activated')).toHaveLength(0);
  });

  it('fires vod_activated once a note POST brings a personal match to vodUrl + 2 notes', async () => {
    const { app, database } = buildTestApp();
    database.seed(`matches/${TEST_UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: { n1: { seconds: 5, note: 'first note' } },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/matches/m1/notes',
      headers: authHeader(),
      payload: { seconds: 30, note: 'second note' },
    });

    expect(response.statusCode).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = eventRows(database.dump());
    const fired = rows.filter((row) => row.eventName === 'vod_activated');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe(TEST_UID);
  });
});
