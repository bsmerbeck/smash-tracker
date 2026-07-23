import { describe, expect, it } from 'vitest';
import { matchRecordSchema } from '@smash-tracker/shared';
import { FakeDatabase } from '../../src/test-support/fakeDatabase.js';
import { runSeedDemo } from './personalDataset.js';
import { wipeDemo } from './manifest.js';

const UID = 'test-uid';
const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

interface Dump {
  matches?: Record<string, Record<string, Record<string, unknown>>>;
  opponents?: Record<string, Record<string, unknown>>;
  opponentNotes?: Record<string, Record<string, unknown>>;
  gspSettings?: Record<string, unknown>;
  gspReadings?: Record<string, Record<string, Record<string, unknown>>>;
  playlists?: Record<string, Record<string, { name: string; matchIds?: string[] }>>;
  demoSeed?: Record<string, { seededAt: number; paths: string[] }>;
  eventLedger?: unknown;
  outboxPending?: unknown;
  eventDedup?: unknown;
}

describe('runSeedDemo', () => {
  it('writes zero canonical event-ledger entries (SEED-06)', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });

    const dump = database.dump() as Dump;
    expect(dump.eventLedger).toBeUndefined();
    expect(dump.outboxPending).toBeUndefined();
    expect(dump.eventDedup).toBeUndefined();
  });

  it('seeds the full personal dataset with the expected counts and shapes', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });

    const dump = database.dump() as Dump;

    const matches = dump.matches?.[UID] ?? {};
    expect(Object.keys(matches).length).toBeGreaterThanOrEqual(60);

    const opponents = dump.opponents?.[UID] ?? {};
    expect(Object.keys(opponents).length).toBe(12);

    const opponentNotes = dump.opponentNotes?.[UID] ?? {};
    expect(Object.keys(opponentNotes).length).toBe(8);

    expect(dump.gspSettings?.[UID]).toBeDefined();

    const gspReadings = Object.values(dump.gspReadings?.[UID] ?? {});
    const byFighter = new Map<number, number>();
    for (const reading of gspReadings) {
      const fighterId = reading.fighter_id as number;
      byFighter.set(fighterId, (byFighter.get(fighterId) ?? 0) + 1);
    }
    expect(byFighter.size).toBe(3);
    for (const count of byFighter.values()) {
      expect(count).toBeGreaterThanOrEqual(12);
      expect(count).toBeLessThanOrEqual(16);
    }

    const playlists = Object.values(dump.playlists?.[UID] ?? {});
    expect(playlists.length).toBeGreaterThanOrEqual(2);
    for (const playlist of playlists) {
      expect(playlist.matchIds?.length ?? 0).toBeGreaterThanOrEqual(3);
    }
  });

  it('back-dates matches and GSP readings so their `time` values span >= 80 days', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });

    const dump = database.dump() as Dump;

    const matchTimes = Object.values(dump.matches?.[UID] ?? {}).map((m) => m.time as number);
    const matchSpan = Math.max(...matchTimes) - Math.min(...matchTimes);
    expect(matchSpan).toBeGreaterThanOrEqual(80 * DAY_MS);
    expect(new Set(matchTimes).size).toBeGreaterThan(1);

    const gspTimes = Object.values(dump.gspReadings?.[UID] ?? {}).map((r) => r.time as number);
    const gspSpan = Math.max(...gspTimes) - Math.min(...gspTimes);
    expect(gspSpan).toBeGreaterThan(0);
  });

  it('attaches vodUrl + vodTimestamps to exactly the VOD-coherent matches', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });

    const dump = database.dump() as Dump;
    const matches = Object.values(dump.matches?.[UID] ?? {});
    const vodMatches = matches.filter((m) => m.vodUrl !== undefined);

    expect(vodMatches.length).toBeGreaterThanOrEqual(8);
    expect(vodMatches.length).toBe(10);
    for (const match of vodMatches) {
      const timestamps = match.vodTimestamps as Record<string, unknown> | undefined;
      expect(timestamps).toBeDefined();
      const count = Object.keys(timestamps ?? {}).length;
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThanOrEqual(6);
    }
  });

  it('produces schema-valid match records and playlists referencing real match ids (SEED-05)', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });

    const dump = database.dump() as Dump;
    const matches = dump.matches?.[UID] ?? {};

    for (const record of Object.values(matches)) {
      expect(() => matchRecordSchema.parse(record)).not.toThrow();
    }

    const playlists = Object.values(dump.playlists?.[UID] ?? {});
    for (const playlist of playlists) {
      for (const matchId of playlist.matchIds ?? []) {
        expect(matches[matchId]).toBeDefined();
      }
    }
  });

  it('flushes a non-empty demoSeed/{uid} manifest', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });

    const dump = database.dump() as Dump;
    const manifest = dump.demoSeed?.[UID];
    expect(manifest).toBeDefined();
    expect(manifest?.paths.length ?? 0).toBeGreaterThan(0);
  });

  it('wipe removes exactly the seeded records and leaves a non-seeded survivor untouched (SEED-03)', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}/REAL-KEEP`, {
      fighter_id: 28,
      opponent_id: 85,
      time: 1,
      map: { id: 1, name: 'Battlefield' },
      matchType: 'quickplay',
      win: true,
    });

    await runSeedDemo(database as never, { uid: UID, now: NOW });
    await wipeDemo(database as never, UID);

    const dump = database.dump() as Dump;
    const matches = dump.matches?.[UID] ?? {};
    expect(Object.keys(matches)).toEqual(['REAL-KEEP']);
    // opponents/opponentNotes/gspReadings/playlists are wiped one manifested
    // leaf key at a time (each opponent name / reading id / playlist id is
    // its own recorded path); FakeDatabase, unlike real RTDB, does not prune
    // a parent node back to `undefined` once its last child key is deleted —
    // so the correct post-wipe assertion is "no keys remain", not "the node
    // itself is undefined".
    expect(Object.keys(dump.opponents?.[UID] ?? {})).toEqual([]);
    expect(Object.keys(dump.opponentNotes?.[UID] ?? {})).toEqual([]);
    expect(Object.keys(dump.gspReadings?.[UID] ?? {})).toEqual([]);
    expect(Object.keys(dump.playlists?.[UID] ?? {})).toEqual([]);
    // gspSettings/{uid} and demoSeed/{uid} are each recorded/removed as a
    // SINGLE manifested path (one key under their respective root nodes), so
    // deleting that one key does leave the parent's `[UID]` entry undefined.
    expect(dump.gspSettings?.[UID]).toBeUndefined();
    expect(dump.demoSeed?.[UID]).toBeUndefined();
  });

  it('is idempotent: a second run against the same uid does not duplicate matches (SEED-04)', async () => {
    const database = new FakeDatabase();
    await runSeedDemo(database as never, { uid: UID, now: NOW });
    const dumpAfterFirst = database.dump() as Dump;
    const countAfterFirst = Object.keys(dumpAfterFirst.matches?.[UID] ?? {}).length;

    await runSeedDemo(database as never, { uid: UID, now: NOW });
    const dumpAfterSecond = database.dump() as Dump;
    const countAfterSecond = Object.keys(dumpAfterSecond.matches?.[UID] ?? {}).length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
