import { describe, expect, it, vi } from 'vitest';
import {
  resolveTournamentTier,
  RULESET_CONTRACT_VERSION,
  stageIdKey,
  TIER_OVERRIDE_CONTRACT_VERSION,
  tournamentEntrySchema,
  type TierEntryFields,
} from '@smash-tracker/shared';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import type { FakeDatabase } from '../test-support/fakeDatabase.js';
import { importPlayerMatches } from '../startgg/sync.js';
import type { StartggSet } from '../startgg/client.js';

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

  // 39.2 code review API-WR-02: an override that fails its stored schema (a
  // newer release's tier word, a hand edit) must not hide the whole event —
  // the event stays listed with that override treated as absent, so the user
  // can still reach the control that replaces or clears it.
  describe('an unreadable stored override (API-WR-02)', () => {
    const ENTRY = {
      eventId: 987,
      eventName: 'Ultimate Singles',
      numEntrants: 512,
      isOnline: false,
      firstSetAt: 1_700_000_000_000,
      lastSetAt: 1_700_000_500_000,
      setsPlayed: 5,
    };

    async function listed(app: ReturnType<typeof buildTestApp>['app']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/tournaments',
        headers: authHeader(),
      });
      expect(response.statusCode).toBe(200);
      return response.json() as Record<string, unknown>[];
    }

    it('keeps the event listed with an invalid tierOverride treated as absent', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}/987`, {
        ...ENTRY,
        tierOverride: { contractVersion: 2, tier: 'premier', setAtMs: 1, reason: 'x' },
        rulesetOverride: { contractVersion: 1, dsr: 'none' },
      });

      const entries = await listed(app);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ eventId: 987, entryKey: '987', numEntrants: 512 });
      expect(entries[0]).not.toHaveProperty('tierOverride');
      // The sibling override that IS readable is still served.
      expect(entries[0]!.rulesetOverride).toEqual({ contractVersion: 1, dsr: 'none' });
    });

    it('keeps the event listed with an invalid rulesetOverride treated as absent', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}/987`, {
        ...ENTRY,
        rulesetOverride: { contractVersion: 1, dsr: 'not-a-variant' },
      });

      const entries = await listed(app);

      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toHaveProperty('rulesetOverride');
    });

    it('keeps an admin-imported registry row listed with an invalid tierOverride treated as absent', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}/histimport:100001`, {
        entryId: 'histimport:100001',
        origin: 'admin-imported',
        provider: 'startgg',
        startggEventId: '100001',
        eventName: 'Ultimate Singles',
        playedSetCount: 8,
        provenance: {
          source: 'research-import',
          importedAtMs: 1_755_000_000_000,
          asOfMs: 1_754_000_000_000,
        },
        registryWitness: 'research-import:v1:100001',
        firstSetAt: 1_699_000_000_000,
        lastSetAt: 1_699_000_500_000,
        setsPlayed: 8,
        tierOverride: { contractVersion: 1, tier: 'major' },
      });

      const entries = await listed(app);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ entryKey: 'histimport:100001', origin: 'admin-imported' });
      expect(entries[0]).not.toHaveProperty('tierOverride');
    });

    it('the user can replace, then clear, an invalid override through the tier PATCH', async () => {
      const { app, database } = buildTestApp();
      database.seed(`tournamentEntries/${TEST_UID}/987`, {
        ...ENTRY,
        tierOverride: { contractVersion: 1, tier: 'premier', setAtMs: 1 },
      });

      const replace = await app.inject({
        method: 'PATCH',
        url: '/api/tournaments/987/tier',
        headers: authHeader(),
        payload: { tierOverride: { tier: 'major' } },
      });
      expect(replace.statusCode).toBe(200);
      expect((await listed(app))[0]!.tierOverride).toMatchObject({ tier: 'major' });

      const clear = await app.inject({
        method: 'PATCH',
        url: '/api/tournaments/987/tier',
        headers: authHeader(),
        payload: { tierOverride: null },
      });
      expect(clear.statusCode).toBe(200);
      expect((await listed(app))[0]).not.toHaveProperty('tierOverride');
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

// EVID-04 (37-CONTEXT.md D-10, D-18): the route's hard edges — ownership,
// validation, and the two-row-shape serialization round trip.
describe('PATCH /api/tournaments/:entryKey/ruleset', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      payload: { rulesetOverride: null },
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for an entry key with no stored entry', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/missing-entry/ruleset',
      headers: authHeader(),
      payload: { rulesetOverride: null },
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an entry owned by a different uid and performs no write on it', async () => {
    const { app, database, auth } = buildTestApp();
    auth.registerToken('other-uid-token', { uid: 'other-uid', email: 'other@example.com' });
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
    });
    const before = structuredClone(database.dump());

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader('other-uid-token'),
      payload: { rulesetOverride: null },
    });

    expect(response.statusCode).toBe(404);
    // The uid-scoped path is the enforcement, not merely the convention: the
    // OTHER uid's entry (this test's caller isn't TEST_UID) must be
    // byte-unchanged after the request.
    expect(database.dump()).toEqual(before);
  });

  it('stores exactly one rulesetOverride child carrying the running contract version', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader(),
      payload: { rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION, dsr: 'none' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { entryKey: string; rulesetOverride: { dsr: string } };
    expect(body).toMatchObject({ entryKey: '987', rulesetOverride: { dsr: 'none' } });
    const stored = (database.dump().tournamentEntries as Record<string, Record<string, unknown>>)[
      TEST_UID
    ]?.['987'] as Record<string, unknown>;
    expect(stored.rulesetOverride).toEqual({
      contractVersion: RULESET_CONTRACT_VERSION,
      dsr: 'none',
    });
  });

  it('a clearing PATCH removes the rulesetOverride child entirely', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
        rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION, dsr: 'none' },
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader(),
      payload: { rulesetOverride: null },
    });

    expect(response.statusCode).toBe(200);
    const stored = (database.dump().tournamentEntries as Record<string, Record<string, unknown>>)[
      TEST_UID
    ]?.['987'] as Record<string, unknown>;
    expect('rulesetOverride' in stored).toBe(false);
  });

  it('rejects a stage presence map with an unprefixed or non-numeric key with a 400', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader(),
      payload: {
        rulesetOverride: {
          contractVersion: RULESET_CONTRACT_VERSION,
          starterStageIds: { '113': true },
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a ban count outside its bound with a 400', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader(),
      payload: {
        rulesetOverride: {
          contractVersion: RULESET_CONTRACT_VERSION,
          banCounts: { bo3: 99, bo5: 2 },
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a DSR value outside the enum with a 400', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader(),
      payload: {
        rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION, dsr: 'illegal-value' },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('a GET after a successful PATCH returns the entry with its override intact for an ordinary entry', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_700_000_000_000,
        lastSetAt: 1_700_000_500_000,
        setsPlayed: 5,
      },
    });

    await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/ruleset',
      headers: authHeader(),
      payload: {
        rulesetOverride: {
          contractVersion: RULESET_CONTRACT_VERSION,
          starterStageIds: { [stageIdKey(113)]: true },
        },
      },
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });
    const [entry] = getResponse.json() as Array<{ rulesetOverride?: unknown }>;
    expect(entry?.rulesetOverride).toEqual({
      contractVersion: RULESET_CONTRACT_VERSION,
      starterStageIds: { [stageIdKey(113)]: true },
    });
  });

  // The registry-first union order is load-bearing: an admin-imported row
  // also satisfies the legacy schema, which would strip its new members if
  // only the legacy schema declared `rulesetOverride`.
  it('a GET after a successful PATCH returns an admin-imported registry row with its override intact', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      'histimport:100001': {
        entryId: 'histimport:100001',
        origin: 'admin-imported',
        provider: 'startgg',
        startggEventId: '100001',
        eventName: 'Ultimate Singles',
        playedSetCount: 8,
        provenance: {
          source: 'research-import',
          importedAtMs: 1_755_000_000_000,
        },
        registryWitness: 'research-import:v1:100001',
        firstSetAt: 1_699_000_000_000,
        lastSetAt: 1_699_000_500_000,
        setsPlayed: 8,
      },
    });

    await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/histimport:100001/ruleset',
      headers: authHeader(),
      payload: { rulesetOverride: { contractVersion: RULESET_CONTRACT_VERSION, dsr: 'none' } },
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });
    const [entry] = getResponse.json() as Array<{ rulesetOverride?: unknown }>;
    expect(entry?.rulesetOverride).toEqual({
      contractVersion: RULESET_CONTRACT_VERSION,
      dsr: 'none',
    });
  });
});

// Phase 39.2 (TIER-04, D-15, D-17): the tier override route's hard edges —
// ownership, server-stamped members, null-as-clear, both row shapes, and the
// never-persisted-resolution property.
describe('PATCH /api/tournaments/:entryKey/tier', () => {
  const LEGACY_ENTRY = {
    eventId: 987,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_700_000_000_000,
    lastSetAt: 1_700_000_500_000,
    setsPlayed: 5,
  };

  function storedFor(
    database: ReturnType<typeof buildTestApp>['database'],
    uid: string,
    key: string,
  ): Record<string, unknown> | undefined {
    return (database.dump().tournamentEntries as Record<string, Record<string, unknown>>)?.[uid]?.[
      key
    ] as Record<string, unknown> | undefined;
  }

  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      payload: { tierOverride: null },
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for an entry key with no stored entry', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/missing-entry/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'major' } },
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an entry owned by a different uid and leaves the database byte-identical', async () => {
    const { app, database, auth } = buildTestApp();
    auth.registerToken('other-uid-token', { uid: 'other-uid', email: 'other@example.com' });
    database.seed(`tournamentEntries/${TEST_UID}`, { '987': LEGACY_ENTRY });
    // dump() returns the LIVE tree, so snapshot by value or the comparison is vacuous.
    const before = structuredClone(database.dump());

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      headers: authHeader('other-uid-token'),
      payload: { tierOverride: { tier: 'major' } },
    });

    expect(response.statusCode).toBe(404);
    expect(database.dump()).toEqual(before);
  });

  it('stores exactly one tierOverride child with the running contract version and a numeric setAtMs, ignoring smuggled members', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, { '987': LEGACY_ENTRY });
    const before = structuredClone(storedFor(database, TEST_UID, '987'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'major', contractVersion: 99, setAtMs: 5 } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { entryKey: string; tierOverride: Record<string, unknown> };
    expect(body.entryKey).toBe('987');
    const stored = storedFor(database, TEST_UID, '987') as Record<string, unknown>;
    const override = stored.tierOverride as Record<string, unknown>;
    expect(Object.keys(override).sort()).toEqual(['contractVersion', 'setAtMs', 'tier']);
    expect(override.contractVersion).toBe(TIER_OVERRIDE_CONTRACT_VERSION);
    expect(override.tier).toBe('major');
    expect(typeof override.setAtMs).toBe('number');
    expect(override.setAtMs).not.toBe(5);
    expect(body.tierOverride).toEqual(override);
    // No sibling member of the entry was rewritten (WR-02).
    const { tierOverride: _added, ...rest } = stored;
    void _added;
    expect(rest).toEqual(before);
  });

  it('rejects an unknown tier word with 400 and writes nothing', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, { '987': LEGACY_ENTRY });
    // dump() returns the LIVE tree, so snapshot by value or the comparison is vacuous.
    const before = structuredClone(database.dump());

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'legendary' } },
    });

    expect(response.statusCode).toBe(400);
    expect(database.dump()).toEqual(before);
  });

  it('a clearing PATCH removes the tierOverride child entirely and writes no null', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': {
        ...LEGACY_ENTRY,
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'minor',
          setAtMs: 1_700_000_000_000,
        },
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      headers: authHeader(),
      payload: { tierOverride: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ entryKey: '987' });
    const stored = storedFor(database, TEST_UID, '987') as Record<string, unknown>;
    expect('tierOverride' in stored).toBe(false);
    expect(stored).toEqual(LEGACY_ENTRY);
  });

  // D-17: the coach clause is vacuous at the data layer — client tenants have
  // no tournament registry and this route is own-uid. The committed proof is
  // that a client-subject header can never redirect the write.
  it('D-17: an X-Active-Subject client header cannot write another subject entry and never redirects the caller write', async () => {
    const { app, database } = buildTestApp();
    const tenantId = 'tenant-abc';
    database.seed(`tournamentEntries/${TEST_UID}`, { a: { ...LEGACY_ENTRY, eventId: 1 } });
    database.seed(`tournamentEntries/${tenantId}`, { b: { ...LEGACY_ENTRY, eventId: 2 } });
    const headers = { ...authHeader(), 'x-active-subject': `client:${tenantId}` };

    // dump() returns the LIVE tree, so snapshot by value or the comparison is vacuous.
    const before = structuredClone(database.dump());
    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/b/tier',
      headers,
      payload: { tierOverride: { tier: 'major' } },
    });
    expect(foreign.statusCode).toBe(404);
    expect(database.dump()).toEqual(before);

    const own = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/a/tier',
      headers,
      payload: { tierOverride: { tier: 'major' } },
    });
    expect(own.statusCode).toBe(200);
    expect(storedFor(database, TEST_UID, 'a')?.tierOverride).toMatchObject({ tier: 'major' });
    // The client tenant's subtree is byte-identical to before.
    expect(storedFor(database, tenantId, 'b')).toEqual({ ...LEGACY_ENTRY, eventId: 2 });
    expect(
      Object.keys(
        (database.dump().tournamentEntries as Record<string, unknown>)[tenantId] as object,
      ),
    ).toEqual(['b']);
  });

  it('a GET after a successful PATCH returns tierOverride for an ordinary (legacy-shaped) entry', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, { '987': LEGACY_ENTRY });

    await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'regional' } },
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });
    const [entry] = getResponse.json() as Array<{ tierOverride?: { tier: string } }>;
    expect(entry?.tierOverride).toMatchObject({ tier: 'regional' });
  });

  it('a GET after a successful PATCH returns tierOverride for an admin-imported registry row', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      'histimport:100001': {
        entryId: 'histimport:100001',
        origin: 'admin-imported',
        provider: 'startgg',
        startggEventId: '100001',
        eventName: 'Ultimate Singles',
        playedSetCount: 8,
        provenance: { source: 'research-import', importedAtMs: 1_755_000_000_000 },
        registryWitness: 'research-import:v1:100001',
        firstSetAt: 1_699_000_000_000,
        lastSetAt: 1_699_000_500_000,
        setsPlayed: 8,
      },
    });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/histimport:100001/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'local' } },
    });
    expect(patch.statusCode).toBe(200);

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });
    const [entry] = getResponse.json() as Array<{
      tierOverride?: { tier: string };
      origin?: string;
    }>;
    expect(entry?.origin).toBe('admin-imported');
    expect(entry?.tierOverride).toMatchObject({ tier: 'local' });
  });

  it('never persists a resolved tier: the stored entry parses under the STRICT row schema after a PATCH', async () => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}`, {
      '987': { ...LEGACY_ENTRY, numEntrants: 1581, isOnline: false },
    });

    await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/987/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'major' } },
    });

    const stored = storedFor(database, TEST_UID, '987') as Record<string, unknown>;
    const parsed = tournamentEntrySchema.strict().safeParse(stored);
    expect(parsed.success).toBe(true);
    for (const forbidden of ['tier', 'basis', 'source', 'estimate']) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });
});

// Phase 39.2 tracer (TIER-04 + F1): an owner sets Major on a synced event, the
// routine start.gg re-sync runs, and the real GET route still resolves Major
// (Set manually) — on one database, through the real writer, RTDB and route.
// 39.2 code review API-IN-05: the override PATCH routes checked existence,
// then wrote with a plain update(). An entry removed in between (a reconcile
// orphan removal, for one) came back as an override-only stub that GET skips
// as corrupt and reconcile reports as a foreign collision forever.
describe('override PATCH when the entry vanishes between the existence check and the write (API-IN-05)', () => {
  const ENTRY = {
    eventId: 987,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_700_000_000_000,
    lastSetAt: 1_700_000_500_000,
    setsPlayed: 5,
  };

  /**
   * One-shot: the entry is removed right after the route's first read of it
   * resolves (the read it holds says "exists"), or right before its first
   * transaction on it runs.
   */
  function removeEntryMidRequest(database: FakeDatabase, entryPath: string): void {
    let fired = false;
    const originalRef = database.ref.bind(database);
    vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
      const ref = originalRef(path);
      if (fired || path !== entryPath) {
        return ref;
      }
      const { get, transaction } = ref;
      ref.get = async () => {
        const value = structuredClone((await get()).val());
        fired = true;
        await originalRef(entryPath).remove();
        return { exists: () => value !== null, val: () => value };
      };
      ref.transaction = async (updateFn) => {
        fired = true;
        await originalRef(entryPath).remove();
        return transaction(updateFn);
      };
      return ref;
    });
  }

  it.each([
    ['tier', { tierOverride: { tier: 'major' } }],
    ['ruleset', { rulesetOverride: { contractVersion: 1, dsr: 'none' } }],
  ])('a %s PATCH answers 404 and leaves no override-only stub', async (member, payload) => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}/987`, ENTRY);
    removeEntryMidRequest(database, `tournamentEntries/${TEST_UID}/987`);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tournaments/987/${member}`,
      headers: authHeader(),
      payload,
    });

    expect(response.statusCode).toBe(404);
    const tree = database.dump() as { tournamentEntries?: Record<string, Record<string, unknown>> };
    expect(tree.tournamentEntries?.[TEST_UID]?.['987']).toBeUndefined();
  });

  it.each([
    ['tier', { tierOverride: { tier: 'major' } }, 'tierOverride'],
    ['ruleset', { rulesetOverride: { contractVersion: 1, dsr: 'none' } }, 'rulesetOverride'],
  ])('a %s PATCH on a present entry still writes only its member', async (member, payload, key) => {
    const { app, database } = buildTestApp();
    database.seed(`tournamentEntries/${TEST_UID}/987`, ENTRY);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tournaments/987/${member}`,
      headers: authHeader(),
      payload,
    });

    expect(response.statusCode).toBe(200);
    const tree = structuredClone(database.dump()) as {
      tournamentEntries: Record<string, Record<string, Record<string, unknown>>>;
    };
    const stored = tree.tournamentEntries[TEST_UID]!['987']!;
    expect(stored).toMatchObject(ENTRY);
    expect(Object.keys(stored).sort()).toEqual([...Object.keys(ENTRY), key].sort());
  });
});

describe('tier override tracer: sync -> PATCH -> re-sync -> GET -> resolveTournamentTier', () => {
  const PLAYER_ID = 1802316;

  function offlineEventSet(): StartggSet {
    return {
      id: 1,
      completedAt: 1_700_000_000,
      fullRoundText: 'Winners Round 1',
      round: 1,
      displayScore: '2-0',
      totalGames: 2,
      event: {
        id: 4001,
        name: 'Ultimate Singles',
        isOnline: false,
        numEntrants: 1581,
        videogame: { id: 1386 },
        tournament: { name: 'Supernova Fixture' },
      },
      slots: [
        {
          entrant: {
            id: 1,
            name: 'Team | Me',
            participants: [{ player: { id: PLAYER_ID } }],
            seeds: [{ seedNum: 4 }],
            standing: { placement: 9 },
          },
        },
        {
          entrant: {
            id: 2,
            name: 'PowPow',
            participants: [{ player: { id: 999, gamerTag: 'PowPow' } }],
            seeds: [{ seedNum: 12 }],
            standing: { placement: 33 },
          },
        },
      ],
      games: [
        {
          winnerId: 1,
          stage: { id: 311, name: 'Battlefield' },
          selections: [
            { character: { id: 1271 }, entrant: { id: 1 } },
            { character: { id: 1332 }, entrant: { id: 2 } },
          ],
          entrant1Score: 3,
          entrant2Score: 0,
        },
      ],
    };
  }

  function fetchFor(sets: StartggSet[]): typeof fetch {
    return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('PlayerSets')) {
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
          }),
        );
      }
      return new Response('no details', { status: 500 });
    }) as typeof fetch;
  }

  it('an override set through the route survives the next sync and resolves as manual with the estimate still visible', async () => {
    const { app, database } = buildTestApp();
    const sync = () =>
      importPlayerMatches(
        database as never,
        TEST_UID,
        PLAYER_ID,
        'server-token',
        fetchFor([offlineEventSet()]),
        { warn: () => undefined },
      );

    await sync();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/tournaments/4001/tier',
      headers: authHeader(),
      payload: { tierOverride: { tier: 'major' } },
    });
    expect(patch.statusCode).toBe(200);

    await sync();

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/tournaments',
      headers: authHeader(),
    });
    expect(getResponse.statusCode).toBe(200);
    const entries = getResponse.json() as Array<TierEntryFields & { eventId?: number }>;
    const entry = entries.find((e) => e.eventId === 4001);
    expect(entry).toBeDefined();
    expect(resolveTournamentTier({ entry: entry as TierEntryFields })).toMatchObject({
      tier: 'major',
      basis: 'manual',
      source: 'manual',
      estimate: { tier: 'supermajor', entrants: 1581 },
    });
  });
});
