import { describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';

const ENTRY_KEY = 'manual-locals-42-abc123';
const EVENT_DATE = 1_700_000_000_000;

function seedBrief(
  database: ReturnType<typeof buildTestApp>['database'],
  likelyOpponents: Record<string, true> = {},
): void {
  database.seed(`prepBriefs/${TEST_UID}/${ENTRY_KEY}`, {
    eventDate: EVENT_DATE,
    activatedAt: EVENT_DATE,
    lastOpenedAt: EVENT_DATE,
    ...(Object.keys(likelyOpponents).length > 0 ? { likelyOpponents } : {}),
  });
}

interface SeedMatchInput {
  time: number;
  win: boolean;
  opponent?: string;
  opponentUserSlug?: string;
  opponentParryUserId?: string;
}

function seedMatches(
  database: ReturnType<typeof buildTestApp>['database'],
  matches: SeedMatchInput[],
): void {
  const record: Record<string, unknown> = {};
  matches.forEach((match, index) => {
    record[`match-${index}`] = {
      fighter_id: 1,
      opponent_id: 2,
      time: match.time,
      win: match.win,
      ...(match.opponent !== undefined ? { opponent: match.opponent } : {}),
      ...(match.opponentUserSlug !== undefined ? { opponentUserSlug: match.opponentUserSlug } : {}),
      ...(match.opponentParryUserId !== undefined
        ? { opponentParryUserId: match.opponentParryUserId }
        : {}),
    };
  });
  database.seed(`matches/${TEST_UID}`, record);
}

function seedAliases(
  database: ReturnType<typeof buildTestApp>['database'],
  aliases: Record<string, string>,
): void {
  database.seed(`opponentAliases/${TEST_UID}`, aliases);
}

// ---------------------------------------------------------------------------
// Task 2: GET .../binding-candidates
// ---------------------------------------------------------------------------

describe('GET /api/prep/:entryKey/opponents/:name/binding-candidates', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('three matches carrying the SAME start.gg slug return exactly one candidate with matchCount 3', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 2, win: false, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 3, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      candidates: Array<{ provider: string; startggUserSlug?: string; matchCount: number }>;
    };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      provider: 'startgg',
      startggUserSlug: 'user/abc123',
      matchCount: 3,
    });
  });

  it('two DIFFERENT provider identities for the same canonical name return two candidates in a deterministic, non-popularity order', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    // The parry.gg identity has fewer matches than the start.gg identity —
    // if the sort were popularity-based, start.gg would sort first by
    // count; the assertion below proves it sorts by identity, not count.
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 2, win: false, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 3, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      {
        time: 4,
        win: true,
        opponent: 'Rival',
        opponentParryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    const body = response.json() as {
      candidates: Array<{ provider: string; matchCount: number }>;
    };
    expect(body.candidates).toHaveLength(2);
    // startgg sorts before parrygg by the module's fixed provider order,
    // regardless of which identity has more matches.
    expect(body.candidates.map((c) => c.provider)).toEqual(['startgg', 'parrygg']);

    // Reordering the input matches so the LOWER-count identity (parrygg)
    // comes first in storage must not change the output order.
    const { app: app2, database: database2 } = buildTestApp();
    seedBrief(database2, { rival: true });
    seedMatches(database2, [
      {
        time: 4,
        win: true,
        opponent: 'Rival',
        opponentParryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      },
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 2, win: false, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
      { time: 3, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
    ]);
    const response2 = await app2.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });
    const body2 = response2.json() as { candidates: Array<{ provider: string }> };
    expect(body2.candidates.map((c) => c.provider)).toEqual(['startgg', 'parrygg']);
  });

  it('matches carrying no provider identity contribute NO candidate, even when tag-only matches exist', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival' },
      { time: 2, win: false, opponent: 'Rival' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    expect(response.json()).toEqual({ candidates: [] });
  });

  it('a canonical name reached only through an alias still groups correctly', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedAliases(database, { r1val_alt_tag: 'rival' });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'R1val_Alt_Tag', opponentUserSlug: 'user/abc123' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    const body = response.json() as { candidates: Array<{ startggUserSlug?: string }> };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.startggUserSlug).toBe('user/abc123');
  });

  it('a name NOT curated on the brief returns an empty candidate list rather than leaking the wider match history', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, {}); // rival is NOT curated
    seedMatches(database, [
      { time: 1, win: true, opponent: 'rival', opponentUserSlug: 'user/abc123' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidates: [] });
  });

  it('performs ZERO writes: the whole fake database is byte-identical before and after', async () => {
    const { app, database } = buildTestApp();
    seedBrief(database, { rival: true });
    seedMatches(database, [
      { time: 1, win: true, opponent: 'Rival', opponentUserSlug: 'user/abc123' },
    ]);

    const before = JSON.stringify(database.dump());
    const response = await app.inject({
      method: 'GET',
      url: `/api/prep/${ENTRY_KEY}/opponents/rival/binding-candidates`,
      headers: authHeader(),
    });
    const after = JSON.stringify(database.dump());

    expect(response.statusCode).toBe(200);
    expect(after).toEqual(before);
  });
});
