import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

describe('GET /api/tournaments', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/tournaments' });

    expect(response.statusCode).toBe(401);
  });

  it('returns an empty array when the user has no tournament entries', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns seeded entries sorted by lastSetAt descending', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        tournamentName: 'Test Weekly 42',
        numEntrants: 512,
        seed: 408,
        placement: 257,
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
      '555': {
        eventId: 555,
        eventName: 'Ultimate Doubles',
        firstSetAt: 1_701_000_000_000,
        lastSetAt: 1_701_000_900_000,
        setsPlayed: 2,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entries = response.json() as { eventId: number }[];
    expect(entries.map((e) => e.eventId)).toEqual([555, 987]);
    expect(entries[1]).toMatchObject({
      eventId: 987,
      eventName: 'Ultimate Singles',
      tournamentName: 'Test Weekly 42',
      numEntrants: 512,
      seed: 408,
      placement: 257,
      setsPlayed: 5,
    });
  });

  it('passes through slug, eventSlug, and topStandings when present', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
        slug: 'tournament/the-box-juice-box-26',
        eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
        topStandings: [
          { placement: 1, name: 'Champ', gamerTag: 'Champ', userSlug: 'user/abc123' },
          { placement: 2, name: 'RunnerUp' },
        ],
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const [entry] = response.json() as Record<string, unknown>[];
    expect(entry).toMatchObject({
      slug: 'tournament/the-box-juice-box-26',
      eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
      topStandings: [
        { placement: 1, name: 'Champ', gamerTag: 'Champ', userSlug: 'user/abc123' },
        { placement: 2, name: 'RunnerUp' },
      ],
    });
  });

  it('injects entryKey from the RTDB child key on both start.gg and parry.gg entries', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '99': {
        eventId: 99,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 3,
      },
      'pgg-foo': {
        eventName: 'Ultimate Singles',
        firstSetAt: 1_701_000_000_000,
        lastSetAt: 1_701_000_900_000,
        setsPlayed: 2,
        source: 'parrygg',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entries = response.json() as Record<string, unknown>[];
    const startggEntry = entries.find((e) => e.eventId === 99);
    const parryggEntry = entries.find((e) => e.entryKey === 'pgg-foo');
    expect(startggEntry?.entryKey).toBe('99');
    expect(parryggEntry).toMatchObject({ entryKey: 'pgg-foo', source: 'parrygg' });
  });

  // Review WR-03: safeParse-and-skip (production-gap rule) — one corrupt
  // record must never 500 the whole registry list.
  it('skips a corrupt entry and still returns the healthy ones (never a 500)', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
      corrupt: {
        eventName: 'Broken Entry',
        // string-typed time — the exact corruption class that once took
        // down GET /api/matches for days (see rtdb.ts's listMatches).
        firstSetAt: 'not-a-number',
        lastSetAt: 1_700_000_400_000,
        setsPlayed: 1,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const entries = response.json() as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ eventId: 987, entryKey: '987' });
  });

  it('omits slug/eventSlug/topStandings when absent from the stored entry', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '555': {
        eventId: 555,
        eventName: 'Ultimate Doubles',
        firstSetAt: 1_701_000_000_000,
        lastSetAt: 1_701_000_900_000,
        setsPlayed: 2,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    const [entry] = response.json() as Record<string, unknown>[];
    expect('slug' in entry!).toBe(false);
    expect('eventSlug' in entry!).toBe(false);
    expect('topStandings' in entry!).toBe(false);
  });
});
