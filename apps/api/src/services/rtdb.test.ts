import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { RtdbService } from './rtdb.js';

const UID = 'test-uid-123';
const WEB_BASE_URL = 'https://grandfinals.gg';

const BASE_MATCH_INPUT = {
  fighter_id: 1,
  opponent_id: 8,
  map: { id: 1, name: 'Battlefield' },
  opponent: 'someplayer',
  notes: 'close game',
  matchType: 'online-friendly' as const,
  win: true,
};

/**
 * Phase 8 (Coaching Edit Sessions), Task 1 regression suite — the migration's
 * crux (RESEARCH Pitfall 1): `updateMatch` must carry `current.vodTimestamps`
 * through UNCONDITIONALLY on every full-overwrite PATCH, never read it from
 * `input` (which can no longer even supply it — 08-01 dropped the field from
 * `updateMatchInputSchema`).
 */
describe('RtdbService.updateMatch — vodTimestamps preserve-on-overwrite', () => {
  it('REGRESSION: PATCHing an unrelated match fact (opponent) preserves a pre-existing legacy-array note', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'oldopponent',
      notes: 'close game',
      matchType: 'online-friendly',
      win: true,
      // Legacy dense-array shape — every pre-Phase-8 stored note.
      vodTimestamps: [{ seconds: 42, note: 'missed a punish' }],
    });

    const updated = await rtdb.updateMatch(UID, 'm1', {
      ...BASE_MATCH_INPUT,
      opponent: 'newopponent',
    } as never);

    expect(updated.opponent).toBe('newopponent');
    expect(updated.vodTimestamps).toMatchObject([{ seconds: 42, note: 'missed a punish' }]);

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect(stored[UID]!.m1).toMatchObject({
      opponent: 'newopponent',
      vodTimestamps: [{ seconds: 42, note: 'missed a punish' }],
    });
  });

  it('preserves a keyed push-key-subtree note (post-migration shape) across a match-fact PATCH', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'oldopponent',
      notes: 'close game',
      matchType: 'online-friendly',
      win: true,
      vodTimestamps: { pushKey1: { seconds: 42, note: 'missed a punish' } },
    });

    const updated = await rtdb.updateMatch(UID, 'm1', {
      ...BASE_MATCH_INPUT,
      opponent: 'newopponent',
    } as never);

    expect(updated.opponent).toBe('newopponent');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect(stored[UID]!.m1).toMatchObject({
      opponent: 'newopponent',
      vodTimestamps: { pushKey1: { seconds: 42, note: 'missed a punish' } },
    });
  });

  it('does not fabricate a vodTimestamps node on a match that never had one', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'oldopponent',
      notes: 'close game',
      matchType: 'online-friendly',
      win: true,
    });

    const updated = await rtdb.updateMatch(UID, 'm1', {
      ...BASE_MATCH_INPUT,
      opponent: 'newopponent',
    } as never);

    expect(updated).not.toHaveProperty('vodTimestamps');
  });
});

describe('RtdbService.clearVodAndNotes', () => {
  it('drops vodUrl, vodStartSeconds, and vodTimestamps together, leaving every other field intact', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'someplayer',
      notes: 'close game',
      matchType: 'online-friendly',
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 30,
      vodTimestamps: [{ seconds: 42, note: 'missed a punish' }],
    });

    const result = await rtdb.clearVodAndNotes(UID, 'm1');

    expect(result).not.toHaveProperty('vodUrl');
    expect(result).not.toHaveProperty('vodStartSeconds');
    expect(result).not.toHaveProperty('vodTimestamps');
    expect(result).toMatchObject({ opponent: 'someplayer', notes: 'close game' });

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect(stored[UID]!.m1).not.toHaveProperty('vodUrl');
    expect(stored[UID]!.m1).not.toHaveProperty('vodStartSeconds');
    expect(stored[UID]!.m1).not.toHaveProperty('vodTimestamps');
    expect(stored[UID]!.m1).toMatchObject({ opponent: 'someplayer' });
  });

  it('throws NotFoundError for a missing match', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    await expect(rtdb.clearVodAndNotes(UID, 'missing')).rejects.toThrow('Match missing not found');
  });
});

describe('RtdbService.createShare — permission tiering + edit-tier expiry', () => {
  it("permissions: 'edit' stamps the token's permissions and a ~30-day expiresAt", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
    });

    const before = Date.now();
    const result = await rtdb.createShare(
      UID,
      {
        kind: 'review',
        matchId: 'm1',
        redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
        permissions: 'edit',
      } as never,
      WEB_BASE_URL,
    );
    const after = Date.now();

    const tokenRecord = database.dump().shareTokens as Record<string, Record<string, unknown>>;
    const stored = tokenRecord[result.token]!;
    expect(stored.permissions).toBe('edit');
    expect(typeof stored.expiresAt).toBe('number');
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(stored.expiresAt as number).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
    expect(stored.expiresAt as number).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
  });

  it("permissions: 'view' (or absent) stamps 'view' and writes NO expiresAt key", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
    });

    const result = await rtdb.createShare(
      UID,
      {
        kind: 'review',
        matchId: 'm1',
        redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
        permissions: 'view',
      } as never,
      WEB_BASE_URL,
    );

    const tokenRecord = database.dump().shareTokens as Record<string, Record<string, unknown>>;
    const stored = tokenRecord[result.token]!;
    expect(stored.permissions).toBe('view');
    expect(stored).not.toHaveProperty('expiresAt');
  });
});

describe('RtdbService.createNote / updateNote / deleteNote — owner note CRUD (capped transaction)', () => {
  function seedMatch(database: FakeDatabase, overrides: Record<string, unknown> = {}) {
    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      ...overrides,
    });
  }

  it('createNote returns an id-bearing note and persists it under a real RTDB push key', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database);

    const note = await rtdb.createNote(UID, 'm1', { seconds: 42, note: 'missed a punish' });

    expect(note.seconds).toBe(42);
    expect(note.note).toBe('missed a punish');
    expect(typeof note.id).toBe('string');
    expect(note.id).not.toBe('0');
    expect(note.id).not.toBe('legacy-0');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps[note.id]).toMatchObject({ seconds: 42, note: 'missed a punish' });
  });

  it('createNote throws NotFoundError for a missing match', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    await expect(rtdb.createNote(UID, 'missing', { seconds: 1, note: 'x' })).rejects.toThrow(
      'Match missing not found',
    );
  });

  it('migrates a legacy dense-array node to a keyed object (push-style keys, not 0/1) on first write, preserving the pre-existing note', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: [{ seconds: 10, note: 'old legacy note' }] });

    await rtdb.createNote(UID, 'm1', { seconds: 20, note: 'new note' });

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps;
    expect(Array.isArray(vodTimestamps)).toBe(false);
    const keys = Object.keys(vodTimestamps as Record<string, unknown>);
    expect(keys).toHaveLength(2);
    expect(keys).not.toContain('0');
    expect(keys).not.toContain('1');
    const values = Object.values(vodTimestamps as Record<string, unknown>);
    expect(values).toContainEqual({ seconds: 10, note: 'old legacy note' });
    expect(values).toContainEqual({ seconds: 20, note: 'new note' });
  });

  it('rejects the 21st note (shared cap) and leaves the stored node at exactly 20 children', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    const twenty = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, { seconds: i, note: `note ${i}` }]),
    );
    seedMatch(database, { vodTimestamps: twenty });

    await expect(
      rtdb.createNote(UID, 'm1', { seconds: 999, note: 'one too many' }),
    ).rejects.toThrow(/already has 20 notes/);

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(Object.keys(vodTimestamps)).toHaveLength(20);
  });

  it('stamps coach attribution on the new note when a coach param is supplied (the 08-03 seam)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database);

    const coach = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Coach Person',
    };
    const note = await rtdb.createNote(UID, 'm1', { seconds: 5, note: 'coach note' }, coach);

    expect(note.coach).toEqual(coach);
  });

  it('updateNote edits an existing note by id', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: { existingNote: { seconds: 10, note: 'original' } } });

    const updated = await rtdb.updateNote(UID, 'm1', 'existingNote', {
      seconds: 15,
      note: 'edited',
    });

    expect(updated).toMatchObject({ id: 'existingNote', seconds: 15, note: 'edited' });

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps.existingNote).toMatchObject({ seconds: 15, note: 'edited' });
  });

  it('updateNote on a missing noteId throws NotFoundError', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: { existingNote: { seconds: 10, note: 'original' } } });

    await expect(
      rtdb.updateNote(UID, 'm1', 'missingNote', { seconds: 1, note: 'x' }),
    ).rejects.toThrow('Note missingNote not found');
  });

  it('deleteNote removes a note by id (owner can delete a coach-authored note too)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
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

    await rtdb.deleteNote(UID, 'm1', 'n2');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps).not.toHaveProperty('n2');
    expect(vodTimestamps).toHaveProperty('n1');
  });

  it('deleteNote removes the entire vodTimestamps node when deleting the last remaining note', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: { onlyNote: { seconds: 10, note: 'only' } } });

    await rtdb.deleteNote(UID, 'm1', 'onlyNote');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect(stored[UID]!.m1).not.toHaveProperty('vodTimestamps');
  });

  it('deleteNote on a missing noteId throws NotFoundError', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: { existingNote: { seconds: 10, note: 'original' } } });

    await expect(rtdb.deleteNote(UID, 'm1', 'missingNote')).rejects.toThrow(
      'Note missingNote not found',
    );
  });

  it('deleteNote on a missing match throws NotFoundError', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);

    await expect(rtdb.deleteNote(UID, 'missing', 'noteId')).rejects.toThrow(
      'Note noteId not found on match missing',
    );
  });
});
