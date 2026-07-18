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

describe('WR-05: expired edit shares — manage-list status + active-cap exclusion', () => {
  /** Seeds a review share (snapshot + token + owner index) directly. */
  function seedShare(
    database: FakeDatabase,
    shareId: string,
    token: string,
    tokenOverrides: Record<string, unknown> = {},
  ) {
    database.seed(`shareSnapshots/${shareId}`, {
      uid: UID,
      matchId: 'm1',
      createdAt: 1700000100000,
      result: 'win',
      fighterId: 1,
      opponentFighterId: 8,
      matchDate: 1700000000000,
      vodUrl: 'https://youtube.com/watch?v=abc123',
      reviewedMomentsCount: 0,
      redaction: { includedNotes: true, includedTags: true, showDisplayName: false },
    });
    database.seed(`shareTokens/${token}`, {
      shareId,
      ownerUid: UID,
      permissions: 'edit',
      createdAt: 1700000100000,
      ...tokenOverrides,
    });
    database.seed(`sharesByUser/${UID}/${shareId}`, token);
  }

  it("listSharesForUser marks an edit share past expiresAt as 'expired' (not 'active')", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedShare(database, 'expiredShare', 'expiredTokenAAAAABBBBB', {
      expiresAt: Date.now() - 1000,
    });
    seedShare(database, 'liveShare', 'liveTokenAAAAABBBBBCCC', {
      expiresAt: Date.now() + 1000000,
    });
    seedShare(database, 'revokedShare', 'revokedTokenAAAAABBBBB', {
      expiresAt: Date.now() - 1000,
      revokedAt: 1700000200000,
    });

    const rows = await rtdb.listSharesForUser(UID, WEB_BASE_URL);

    const byId = Object.fromEntries(rows.map((row) => [row.shareId, row]));
    expect(byId.expiredShare!.status).toBe('expired');
    expect(byId.liveShare!.status).toBe('active');
    // Revocation (an explicit owner action) wins over expiry when both apply.
    expect(byId.revokedShare!.status).toBe('revoked');
  });

  it('expired shares do NOT count toward the 100-active cap — createShare succeeds when 100 shares exist but some are expired', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      vodUrl: 'https://youtube.com/watch?v=abc123',
    });
    // 99 live shares + 1 expired = 99 ACTIVE, so one slot remains.
    for (let i = 0; i < 99; i += 1) {
      seedShare(database, `share${i}`, `liveToken${String(i).padStart(12, '0')}`, {
        expiresAt: Date.now() + 1000000,
      });
    }
    seedShare(database, 'expiredShare', 'expiredTokenAAAAABBBBB', {
      expiresAt: Date.now() - 1000,
    });

    const created = await rtdb.createShare(
      UID,
      {
        kind: 'review',
        matchId: 'm1',
        redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
        permissions: 'view',
      } as never,
      WEB_BASE_URL,
    );
    expect(created.shareId).toBeTruthy();

    // With 100 genuinely ACTIVE shares the cap still bites.
    seedShare(database, 'share99', 'liveToken999999999999', {
      expiresAt: Date.now() + 1000000,
    });
    await expect(
      rtdb.createShare(
        UID,
        {
          kind: 'review',
          matchId: 'm1',
          redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
          permissions: 'view',
        } as never,
        WEB_BASE_URL,
      ),
    ).rejects.toThrow(/at most 100 shares/);
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

// ---------------------------------------------------------------------------
// Review CR-01 regression: FakeDatabase.transaction now emulates real RTDB's
// null-local-cache FIRST run (see fakeDatabase.test.ts). These tests pin the
// note transactions' survival of that first run: the pre-fix code returned
// `undefined` when the (null) first run found no matching note, aborting
// permanently — 404ing EVERY owner/coach note edit and delete in production
// while the old always-real-data fake kept the whole suite green.
// ---------------------------------------------------------------------------
describe('CR-01 regression: note edit/delete vs real-RTDB null-first-run transaction semantics', () => {
  function seedMatch(database: FakeDatabase, overrides: Record<string, unknown> = {}) {
    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      ...overrides,
    });
  }

  it('updateNote commits through the null-first-run + server-verified retry path', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: { realNote: { seconds: 10, note: 'original' } } });

    const updated = await rtdb.updateNote(UID, 'm1', 'realNote', { seconds: 12, note: 'edited' });

    expect(updated).toMatchObject({ id: 'realNote', seconds: 12, note: 'edited' });
    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect((stored[UID]!.m1 as Record<string, unknown>).vodTimestamps).toMatchObject({
      realNote: { seconds: 12, note: 'edited' },
    });
  });

  it('deleteNote commits through the null-first-run + server-verified retry path', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, {
      vodTimestamps: {
        realNote: { seconds: 10, note: 'to delete' },
        keptNote: { seconds: 20, note: 'kept' },
      },
    });

    await rtdb.deleteNote(UID, 'm1', 'realNote');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps).not.toHaveProperty('realNote');
    expect(vodTimestamps).toHaveProperty('keptNote');
  });

  it('updateNote on a match with NO vodTimestamps node 404s without fabricating a node (no-op commit)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database);

    await expect(rtdb.updateNote(UID, 'm1', 'anyNote', { seconds: 1, note: 'x' })).rejects.toThrow(
      'Note anyNote not found',
    );
    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect(stored[UID]!.m1).not.toHaveProperty('vodTimestamps');
  });

  it('deleteNote on a match with NO vodTimestamps node 404s without fabricating a node', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database);

    await expect(rtdb.deleteNote(UID, 'm1', 'anyNote')).rejects.toThrow('Note anyNote not found');
    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    expect(stored[UID]!.m1).not.toHaveProperty('vodTimestamps');
  });
});

// ---------------------------------------------------------------------------
// Review WR-06: edit/delete on a legacy dense-array node must apply the SAME
// re-keying migration createNote does — never persist a synthesized
// `legacy-<index>` id as a real RTDB key (which a later createNote would
// silently re-key wholesale, 404ing every concurrently-held note id).
// ---------------------------------------------------------------------------
describe('WR-06 regression: edit/delete migrate legacy-array nodes instead of persisting legacy-N keys', () => {
  function seedMatch(database: FakeDatabase, overrides: Record<string, unknown> = {}) {
    database.seed(`matches/${UID}/m1`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1700000000000,
      win: true,
      ...overrides,
    });
  }

  it('updateNote on a legacy-array match re-keys EVERY entry with real push keys and returns the post-migration id', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, {
      vodTimestamps: [
        { seconds: 10, note: 'first legacy' },
        { seconds: 20, note: 'second legacy' },
      ],
    });

    const updated = await rtdb.updateNote(UID, 'm1', 'legacy-0', {
      seconds: 11,
      note: 'edited legacy',
    });

    // The returned id is the note's NEW real push key, never legacy-0.
    expect(updated.id).not.toMatch(/^legacy-/);
    expect(updated).toMatchObject({ seconds: 11, note: 'edited legacy' });

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    const keys = Object.keys(vodTimestamps);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toMatch(/^legacy-/);
      expect(key).not.toMatch(/^\d+$/);
    }
    expect(vodTimestamps[updated.id]).toMatchObject({ seconds: 11, note: 'edited legacy' });
    expect(Object.values(vodTimestamps)).toContainEqual({
      seconds: 20,
      note: 'second legacy',
    });
  });

  it('deleteNote on a legacy-array match removes the target and re-keys the survivors with real push keys', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, {
      vodTimestamps: [
        { seconds: 10, note: 'doomed legacy' },
        { seconds: 20, note: 'surviving legacy' },
      ],
    });

    await rtdb.deleteNote(UID, 'm1', 'legacy-0');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    const keys = Object.keys(vodTimestamps);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toMatch(/^legacy-/);
    expect(keys[0]).not.toMatch(/^\d+$/);
    expect(vodTimestamps[keys[0]!]).toEqual({ seconds: 20, note: 'surviving legacy' });
  });

  it('a subsequent createNote after a migrating edit does NOT re-key the already-migrated notes (ids are stable)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedMatch(database, { vodTimestamps: [{ seconds: 10, note: 'legacy note' }] });

    const migrated = await rtdb.updateNote(UID, 'm1', 'legacy-0', {
      seconds: 10,
      note: 'migrated note',
    });
    await rtdb.createNote(UID, 'm1', { seconds: 50, note: 'brand new' });

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    // The migrated note keeps the exact key the edit assigned it.
    expect(vodTimestamps[migrated.id]).toMatchObject({ seconds: 10, note: 'migrated note' });
    expect(Object.keys(vodTimestamps)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 Plan 3 (Coaching Edit Sessions): the coach backend — an edit-tier
// token resolves to a LIVE redacted recompute (never the frozen snapshot),
// and three anonymous session-scoped write helpers guard ownership +
// re-check revocation/expiry on every single call (T-08-09/T-08-12).
// ---------------------------------------------------------------------------

const EDIT_TOKEN = 'editTokenAAAAABBBBBCCCCC';
const COACH_SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const COACH = { sessionId: COACH_SESSION, displayName: 'Coach Person' };

interface SeedEditShareOptions {
  redaction?: { includedNotes: boolean; includedTags: boolean; showDisplayName: boolean };
  tokenOverrides?: Record<string, unknown>;
  matchOverrides?: Record<string, unknown>;
}

function seedEditShare(database: FakeDatabase, options: SeedEditShareOptions = {}): void {
  const redaction = options.redaction ?? {
    includedNotes: true,
    includedTags: true,
    showDisplayName: false,
  };
  database.seed(`matches/${UID}/m1`, {
    fighter_id: 1,
    opponent_id: 8,
    time: 1700000000000,
    win: true,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    ...options.matchOverrides,
  });
  database.seed('shareSnapshots/share1', {
    uid: UID,
    matchId: 'm1',
    createdAt: 1700000100000,
    result: 'win',
    fighterId: 1,
    opponentFighterId: 8,
    matchDate: 1700000000000,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    reviewedMomentsCount: 0,
    redaction,
  });
  database.seed(`shareTokens/${EDIT_TOKEN}`, {
    shareId: 'share1',
    ownerUid: UID,
    permissions: 'edit',
    createdAt: 1700000100000,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    ...options.tokenOverrides,
  });
}

describe('RtdbService.getEditSessionByToken — live-redacted edit-session read', () => {
  it("resolves an edit token to a live view carrying permissions: 'edit', per-note ids, and coach attribution", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          ownerNote: { seconds: 10, note: 'owner note' },
          coachNote: { seconds: 20, note: 'coach note', coach: COACH },
        },
      },
    });

    const session = await rtdb.getEditSessionByToken(EDIT_TOKEN);

    expect(session).not.toBeNull();
    expect(session!.permissions).toBe('edit');
    expect(session!.timestamps).toHaveLength(2);
    const byId = Object.fromEntries(session!.timestamps!.map((stamp) => [stamp.id, stamp]));
    expect(byId.ownerNote).toMatchObject({ seconds: 10, note: 'owner note' });
    expect(byId.ownerNote!.coach ?? undefined).toBeUndefined();
    // Review WR-02: attribution is display-name ONLY — the stored sessionId
    // (the write-ownership secret) must never be serialized.
    expect(byId.coachNote).toMatchObject({
      seconds: 20,
      note: 'coach note',
      coach: { displayName: 'Coach Person' },
    });
    expect(byId.coachNote!.coach).not.toHaveProperty('sessionId');
  });

  it("WR-02: computes each note's `own` flag from the caller's sessionId — and never serves any sessionId back", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          mine: { seconds: 10, note: 'my note', coach: COACH },
          theirs: {
            seconds: 20,
            note: 'their note',
            coach: { sessionId: OTHER_SESSION, displayName: 'Other Coach' },
          },
          ownerNote: { seconds: 30, note: 'owner note' },
        },
      },
    });

    const session = await rtdb.getEditSessionByToken(EDIT_TOKEN, COACH_SESSION);

    const byId = Object.fromEntries(session!.timestamps!.map((stamp) => [stamp.id, stamp]));
    expect(byId.mine!.own).toBe(true);
    expect(byId.theirs!.own ?? undefined).toBeUndefined();
    expect(byId.ownerNote!.own ?? undefined).toBeUndefined();
    // No sessionId anywhere in the serialized session — not even the caller's own.
    expect(JSON.stringify(session)).not.toContain(COACH_SESSION);
    expect(JSON.stringify(session)).not.toContain(OTHER_SESSION);
  });

  it('WR-02: without a caller sessionId, no note is marked own (and still no sessionId is served)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: { mine: { seconds: 10, note: 'my note', coach: COACH } },
      },
    });

    const session = await rtdb.getEditSessionByToken(EDIT_TOKEN);

    expect(session!.timestamps![0]!.own ?? undefined).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(COACH_SESSION);
  });

  it('reflects a note the owner added AFTER share creation (live recompute, not the frozen snapshot)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    // Frozen snapshot has NO timestamps and reviewedMomentsCount 0 — the
    // live match got a note afterward. A frozen read would show nothing.
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: { postShareNote: { seconds: 33, note: 'added after sharing' } },
      },
    });

    const session = await rtdb.getEditSessionByToken(EDIT_TOKEN);

    expect(session).not.toBeNull();
    expect(session!.reviewedMomentsCount).toBe(1);
    expect(session!.timestamps).toHaveLength(1);
    expect(session!.timestamps![0]).toMatchObject({
      id: 'postShareNote',
      seconds: 33,
      note: 'added after sharing',
    });
  });

  it('includedNotes=false hides owner notes but ALWAYS keeps coach-authored notes (own-notes carve-out)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      redaction: { includedNotes: false, includedTags: false, showDisplayName: false },
      matchOverrides: {
        vodTimestamps: {
          ownerNote: { seconds: 10, note: 'owner secret note' },
          coachNote: { seconds: 20, note: 'my own note', coach: COACH },
        },
      },
    });

    const session = await rtdb.getEditSessionByToken(EDIT_TOKEN);

    expect(session).not.toBeNull();
    expect(session!.timestamps).toHaveLength(1);
    expect(session!.timestamps![0]).toMatchObject({
      id: 'coachNote',
      note: 'my own note',
      coach: { displayName: 'Coach Person' },
    });
  });

  it('REGRESSION (CR-02): a corrupt note entry never 500s the session read — the session resolves with the entry dropped', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          bad: { seconds: 'x', note: 'corrupt entry' },
          good: { seconds: 12, note: 'healthy entry' },
        },
      },
    });

    const session = await rtdb.getEditSessionByToken(EDIT_TOKEN);

    expect(session).not.toBeNull();
    expect(session!.timestamps).toHaveLength(1);
    expect(session!.timestamps![0]).toMatchObject({ id: 'good', seconds: 12 });
  });

  it('returns null for an unknown token', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database);

    expect(await rtdb.getEditSessionByToken('someUnknownTokenABCDEFGH')).toBeNull();
  });

  it('returns null for a revoked token', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { revokedAt: 1700000200000 } });

    expect(await rtdb.getEditSessionByToken(EDIT_TOKEN)).toBeNull();
  });

  it('returns null for an expired token (identical treatment to revoked — no oracle)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { expiresAt: Date.now() - 1000 } });

    expect(await rtdb.getEditSessionByToken(EDIT_TOKEN)).toBeNull();
  });

  it('returns null for a view-tier token (view stays on getShareByToken)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { permissions: 'view' } });

    expect(await rtdb.getEditSessionByToken(EDIT_TOKEN)).toBeNull();
  });
});

describe('RtdbService.getShareByToken — expiry parity with revocation', () => {
  it('returns null for an expired token (expiresAt re-checked on every read, same as revokedAt)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { expiresAt: Date.now() - 1000 } });

    expect(await rtdb.getShareByToken(EDIT_TOKEN)).toBeNull();
  });
});

describe('RtdbService.createCoachNote — anonymous coach create (token-resolved, capped)', () => {
  it('creates a coach-attributed note through a valid edit token', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database);

    const note = await rtdb.createCoachNote(EDIT_TOKEN, COACH_SESSION, 'Coach Person', {
      seconds: 42,
      note: 'work on ledge trapping',
    });

    expect(note.coach).toEqual(COACH);
    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps[note.id]).toMatchObject({
      seconds: 42,
      note: 'work on ledge trapping',
      coach: COACH,
    });
  });

  it('throws NotFoundError for a revoked token (re-checked on the write itself, never cached)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { revokedAt: 1700000200000 } });

    await expect(
      rtdb.createCoachNote(EDIT_TOKEN, COACH_SESSION, 'Coach Person', { seconds: 1, note: 'x' }),
    ).rejects.toThrow('This share is no longer available');
  });

  it('throws NotFoundError for an EXPIRED token on a write', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { expiresAt: Date.now() - 1000 } });

    await expect(
      rtdb.createCoachNote(EDIT_TOKEN, COACH_SESSION, 'Coach Person', { seconds: 1, note: 'x' }),
    ).rejects.toThrow('This share is no longer available');
  });

  it('throws NotFoundError for a view-tier token (wrong tier — no oracle)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, { tokenOverrides: { permissions: 'view' } });

    await expect(
      rtdb.createCoachNote(EDIT_TOKEN, COACH_SESSION, 'Coach Person', { seconds: 1, note: 'x' }),
    ).rejects.toThrow('This share is no longer available');
  });

  it('aborts at the shared 20-note cap', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    const twenty = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, { seconds: i, note: `note ${i}` }]),
    );
    seedEditShare(database, { matchOverrides: { vodTimestamps: twenty } });

    await expect(
      rtdb.createCoachNote(EDIT_TOKEN, COACH_SESSION, 'Coach Person', {
        seconds: 999,
        note: 'one too many',
      }),
    ).rejects.toThrow(/already has 20 notes/);
  });
});

describe('RtdbService.updateCoachNote / deleteCoachNote — sessionId ownership guard', () => {
  it("updateCoachNote edits the caller's own note, merging absent fields from the existing entry", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          myNote: { seconds: 20, note: 'original', tags: ['punish'], coach: COACH },
        },
      },
    });

    const updated = await rtdb.updateCoachNote(EDIT_TOKEN, COACH_SESSION, 'myNote', {
      note: 'edited by me',
    });

    // Partial PATCH: seconds/tags absent from the input are preserved, and
    // the coach attribution is never touched.
    expect(updated).toMatchObject({
      id: 'myNote',
      seconds: 20,
      note: 'edited by me',
      tags: ['punish'],
      coach: COACH,
    });
  });

  it("updateCoachNote throws NotFoundError for another session's note (indistinguishable from missing)", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          theirNote: {
            seconds: 20,
            note: 'someone else wrote this',
            coach: { sessionId: OTHER_SESSION, displayName: 'Other Coach' },
          },
        },
      },
    });

    await expect(
      rtdb.updateCoachNote(EDIT_TOKEN, COACH_SESSION, 'theirNote', { note: 'hijack' }),
    ).rejects.toThrow('This share is no longer available');
  });

  it('updateCoachNote throws NotFoundError for an OWNER note (no coach sub-object — untouchable)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: { ownerNote: { seconds: 10, note: 'owner note' } },
      },
    });

    await expect(
      rtdb.updateCoachNote(EDIT_TOKEN, COACH_SESSION, 'ownerNote', { note: 'hijack' }),
    ).rejects.toThrow('This share is no longer available');
  });

  it("deleteCoachNote deletes the caller's own note", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          myNote: { seconds: 20, note: 'mine', coach: COACH },
          ownerNote: { seconds: 10, note: 'owner note' },
        },
      },
    });

    await rtdb.deleteCoachNote(EDIT_TOKEN, COACH_SESSION, 'myNote');

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps).not.toHaveProperty('myNote');
    expect(vodTimestamps).toHaveProperty('ownerNote');
  });

  it("deleteCoachNote throws NotFoundError for another session's note and leaves it stored", async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      matchOverrides: {
        vodTimestamps: {
          theirNote: {
            seconds: 20,
            note: 'not yours',
            coach: { sessionId: OTHER_SESSION, displayName: 'Other Coach' },
          },
        },
      },
    });

    await expect(rtdb.deleteCoachNote(EDIT_TOKEN, COACH_SESSION, 'theirNote')).rejects.toThrow(
      'This share is no longer available',
    );

    const stored = database.dump().matches as Record<string, Record<string, unknown>>;
    const vodTimestamps = (stored[UID]!.m1 as Record<string, unknown>).vodTimestamps as Record<
      string,
      unknown
    >;
    expect(vodTimestamps).toHaveProperty('theirNote');
  });

  it('deleteCoachNote throws NotFoundError for an expired token (revoke/expiry re-checked per write)', async () => {
    const database = new FakeDatabase();
    const rtdb = new RtdbService(database as never);
    seedEditShare(database, {
      tokenOverrides: { expiresAt: Date.now() - 1000 },
      matchOverrides: {
        vodTimestamps: { myNote: { seconds: 20, note: 'mine', coach: COACH } },
      },
    });

    await expect(rtdb.deleteCoachNote(EDIT_TOKEN, COACH_SESSION, 'myNote')).rejects.toThrow(
      'This share is no longer available',
    );
  });
});
