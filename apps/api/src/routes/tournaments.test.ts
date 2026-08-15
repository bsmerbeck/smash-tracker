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

  // Phase 30.3: admin-imported historical registry rows (written only by
  // the research-registry projector) are served through the SAME list,
  // discriminated by `origin` — legacy entries keep their exact shape.
  describe('admin-imported registry rows (Phase 30.3)', () => {
    const REGISTRY_ROW = {
      entryId: 'histimport:100001',
      origin: 'admin-imported',
      provider: 'startgg',
      startggEventId: '100001',
      tournamentName: 'The Big House 9',
      eventName: 'Ultimate Singles',
      tournamentSlug: 'tournament/the-big-house-9',
      eventSlug: 'tournament/the-big-house-9/event/ultimate-singles',
      startAtMs: 1_699_000_000_000,
      endAtMs: 1_699_000_500_000,
      numEntrants: 512,
      seed: 3,
      placement: 2,
      playedSetCount: 8,
      dqCount: 1,
      provenance: {
        source: 'research-import',
        importedAtMs: 1_755_000_000_000,
        asOfMs: 1_754_000_000_000,
      },
      registryWitness: 'research-import:v1:100001',
      firstSetAt: 1_699_000_000_000,
      lastSetAt: 1_699_000_500_000,
      setsPlayed: 8,
      slug: 'tournament/the-big-house-9',
    };

    it('serves a registry row with its origin/provenance members intact and entryKey stamped', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}`, {
        'histimport:100001': REGISTRY_ROW,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/tournaments',
        headers: authHeader(),
      });

      expect(response.statusCode).toBe(200);
      const [entry] = response.json() as Record<string, unknown>[];
      expect(entry).toMatchObject({
        ...REGISTRY_ROW,
        entryKey: 'histimport:100001',
      });
    });

    it('sorts registry rows into the mixed list by lastSetAt and leaves legacy shapes untouched', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}`, {
        'histimport:100001': REGISTRY_ROW, // lastSetAt 1_699_000_500_000
        '987': {
          eventId: 987,
          eventName: 'Ultimate Singles',
          firstSetAt: 1_700_000_000_000,
          lastSetAt: 1_700_000_500_000,
          setsPlayed: 5,
        },
        'manual-locals-42-abc': {
          eventName: 'Locals #42',
          firstSetAt: 1_690_000_000_000,
          lastSetAt: 1_690_000_000_000,
          setsPlayed: 0,
          source: 'manual',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/tournaments',
        headers: authHeader(),
      });

      const entries = response.json() as Record<string, unknown>[];
      expect(entries.map((entry) => entry.entryKey)).toEqual([
        '987',
        'histimport:100001',
        'manual-locals-42-abc',
      ]);
      // Legacy rows never grow an origin member — the discriminator is
      // exclusive to admin-imported rows.
      expect('origin' in entries[0]!).toBe(false);
      expect('origin' in entries[2]!).toBe(false);
      expect(entries[1]).toMatchObject({ origin: 'admin-imported', provider: 'startgg' });
    });

    it('registry rows are past events: firstSetAt is historical, so the prep upcoming-gate can never fire', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}`, {
        'histimport:100001': REGISTRY_ROW,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/tournaments',
        headers: authHeader(),
      });

      const [entry] = response.json() as { firstSetAt: number }[];
      expect(entry!.firstSetAt).toBeLessThan(Date.now());
    });

    it('skips a corrupt registry row (never a 500, never a fallback to the legacy shape)', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}`, {
        // origin present but the required registryWitness is missing — the
        // registry parser must reject it, and the legacy parser must NOT
        // be consulted as a fallback (that would serve a half-shaped row).
        'histimport:9': {
          entryId: 'histimport:9',
          origin: 'admin-imported',
          provider: 'startgg',
          startggEventId: '9',
          eventName: 'Broken Import',
          playedSetCount: 1,
          firstSetAt: 1_699_000_000_000,
          lastSetAt: 1_699_000_000_000,
          setsPlayed: 1,
        },
        '987': {
          eventId: 987,
          eventName: 'Ultimate Singles',
          firstSetAt: 1_700_000_000_000,
          lastSetAt: 1_700_000_500_000,
          setsPlayed: 5,
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
  });
});

function eventRows(dump: unknown): Array<{ eventName: string; actorId: string; payload: unknown }> {
  const typed = dump as { eventLedger?: Record<string, Record<string, unknown>> };
  return Object.values(typed.eventLedger ?? {}).flatMap((day) => Object.values(day)) as Array<{
    eventName: string;
    actorId: string;
    payload: unknown;
  }>;
}

describe('POST /api/tournaments/manual-entry', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      payload: { eventName: 'Locals #42' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('writes a manual entry that GET /tournaments returns without a safeParse skip', async () => {
    const { app } = buildTestApp();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Locals #42' },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as Record<string, unknown>;
    expect(created).toMatchObject({
      eventName: 'Locals #42',
      source: 'manual',
      setsPlayed: 0,
    });
    expect(typeof created.entryKey).toBe('string');
    expect((created.entryKey as string).startsWith('manual-')).toBe(true);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    expect(listResponse.statusCode).toBe(200);
    const entries = listResponse.json() as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventName: 'Locals #42',
      source: 'manual',
      entryKey: created.entryKey,
    });
  });

  it('honors an explicit eventDate for firstSetAt/lastSetAt, else defaults to now', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Regional', eventDate: 1_700_000_000_000 },
    });

    const entry = response.json() as { firstSetAt: number; lastSetAt: number };
    expect(entry.firstSetAt).toBe(1_700_000_000_000);
    expect(entry.lastSetAt).toBe(1_700_000_000_000);
  });

  it('stores lastSetAt = eventEndDate and firstSetAt = eventDate when eventEndDate is provided', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: {
        eventName: 'Multi-Day Major',
        eventDate: 1_700_000_000_000,
        eventEndDate: 1_700_200_000_000,
      },
    });

    expect(response.statusCode).toBe(201);
    const entry = response.json() as { firstSetAt: number; lastSetAt: number };
    expect(entry.firstSetAt).toBe(1_700_000_000_000);
    expect(entry.lastSetAt).toBe(1_700_200_000_000);
  });

  it('is byte-identical to the no-eventEndDate path when eventEndDate is omitted', async () => {
    const { app } = buildTestApp();

    const withDate = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Regional', eventDate: 1_700_000_000_000 },
    });
    const withDateEntry = withDate.json() as { firstSetAt: number; lastSetAt: number };
    expect(withDateEntry.firstSetAt).toBe(1_700_000_000_000);
    expect(withDateEntry.lastSetAt).toBe(1_700_000_000_000);

    const withoutAnyDate = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'No Date Event' },
    });
    const noDateEntry = withoutAnyDate.json() as { firstSetAt: number; lastSetAt: number };
    expect(noDateEntry.firstSetAt).toBe(noDateEntry.lastSetAt);
    expect(typeof noDateEntry.firstSetAt).toBe('number');
  });

  it('rejects end before start with a 400 (route-level proof the shared refine gates the handler)', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: {
        eventName: 'Backwards Dates',
        eventDate: 1_700_000_000_000,
        eventEndDate: 1_699_000_000_000,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('sorts a multi-day manual entry into the registry by its end date (lastSetAt desc)', async () => {
    const { app } = buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Single Day Weekly', eventDate: 1_700_050_000_000 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: {
        eventName: 'Multi-Day Major',
        eventDate: 1_700_000_000_000,
        eventEndDate: 1_700_300_000_000,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });

    const entries = response.json() as { eventName: string }[];
    expect(entries.map((e) => e.eventName)).toEqual(['Multi-Day Major', 'Single Day Weekly']);
  });

  it('rejects an empty label', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('derives unique entryKeys for two entries sharing the same label', async () => {
    const { app } = buildTestApp();

    const first = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Locals #42' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Locals #42' },
    });

    const firstEntry = first.json() as { entryKey: string };
    const secondEntry = second.json() as { entryKey: string };
    expect(firstEntry.entryKey).not.toBe(secondEntry.entryKey);
  });

  it('fires tournament_prep_activated once on the first manual entry (dedup marker set)', async () => {
    const { app, database } = buildTestApp();

    await app.inject({
      method: 'POST',
      url: '/api/tournaments/manual-entry',
      headers: authHeader(),
      payload: { eventName: 'Locals #42' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = eventRows(database.dump());
    const fired = rows.filter((row) => row.eventName === 'tournament_prep_activated');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.actorId).toBe(TEST_UID);
  });
});
