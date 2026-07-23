import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { NotFoundError } from '../services/rtdb.js';
import {
  createSession,
  getSession,
  listSessions,
  toggleHomeworkItem,
  updateSession,
} from './sessions.js';

const TENANT_ID = 'tenant-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

describe('createSession', () => {
  it('creates a session with generated homework item ids and createdAt === lastEditedAt', async () => {
    const database = new FakeDatabase();

    const session = await createSession(asDatabase(database), TENANT_ID, {
      date: 1000,
      characterTags: [1, 2],
      summary: 'Worked on shield pressure.',
      homework: [{ text: 'Practice out-of-shield options' }],
    });

    expect(session.sessionId).toBeTruthy();
    expect(session.characterTags).toEqual([1, 2]);
    expect(session.homework).toHaveLength(1);
    expect(session.homework[0]?.id).toBeTruthy();
    expect(session.homework[0]?.done).toBe(false);
    expect(session.createdAt).toBe(session.lastEditedAt);
  });

  it('creates a session with zero tags and zero homework', async () => {
    const database = new FakeDatabase();

    const session = await createSession(asDatabase(database), TENANT_ID, {
      date: 1000,
      summary: 'Free session, no tags.',
    });

    expect(session.characterTags).toEqual([]);
    expect(session.homework).toEqual([]);
  });
});

describe('getSession', () => {
  it('fetches a created session by id', async () => {
    const database = new FakeDatabase();
    const created = await createSession(asDatabase(database), TENANT_ID, {
      date: 1000,
      summary: 'Session one.',
    });

    const fetched = await getSession(asDatabase(database), TENANT_ID, created.sessionId);
    expect(fetched).toEqual(created);
  });

  it('throws NotFoundError for an unknown session id', async () => {
    const database = new FakeDatabase();
    await expect(getSession(asDatabase(database), TENANT_ID, 'ghost-session')).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('listSessions', () => {
  it('lists sessions most-recent-first by date', async () => {
    const database = new FakeDatabase();
    await createSession(asDatabase(database), TENANT_ID, { date: 1000, summary: 'Older' });
    await createSession(asDatabase(database), TENANT_ID, { date: 3000, summary: 'Newest' });
    await createSession(asDatabase(database), TENANT_ID, { date: 2000, summary: 'Middle' });

    const rows = await listSessions(asDatabase(database), TENANT_ID);

    expect(rows.map((row) => row.summary)).toEqual(['Newest', 'Middle', 'Older']);
  });

  it('returns an empty array for a tenant with no sessions', async () => {
    const database = new FakeDatabase();
    await expect(listSessions(asDatabase(database), TENANT_ID)).resolves.toEqual([]);
  });

  it('skips a corrupt session record rather than throwing (safeParse-and-skip)', async () => {
    const database = new FakeDatabase();
    await createSession(asDatabase(database), TENANT_ID, { date: 1000, summary: 'Valid session' });
    database.seed(`trainingSessions/${TENANT_ID}/corrupt-session`, { garbage: true });

    const rows = await listSessions(asDatabase(database), TENANT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe('Valid session');
  });
});

describe('updateSession', () => {
  it('applies a partial patch in place, bumping lastEditedAt, preserving unset fields', async () => {
    const database = new FakeDatabase();
    const created = await createSession(asDatabase(database), TENANT_ID, {
      date: 1000,
      characterTags: [1],
      summary: 'Original summary',
    });

    const updated = await updateSession(asDatabase(database), TENANT_ID, created.sessionId, {
      summary: 'Updated summary',
    });

    expect(updated.summary).toBe('Updated summary');
    expect(updated.characterTags).toEqual([1]);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.lastEditedAt).toBeGreaterThanOrEqual(created.lastEditedAt);
  });

  it('throws NotFoundError when updating an unknown session', async () => {
    const database = new FakeDatabase();
    await expect(
      updateSession(asDatabase(database), TENANT_ID, 'ghost-session', { summary: 'x' }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('toggleHomeworkItem', () => {
  it('flips one homework item done-state in place, leaving others untouched', async () => {
    const database = new FakeDatabase();
    const created = await createSession(asDatabase(database), TENANT_ID, {
      date: 1000,
      summary: 'Session with homework',
      homework: [{ text: 'Item A' }, { text: 'Item B' }],
    });
    const [itemA, itemB] = created.homework;

    const toggled = await toggleHomeworkItem(
      asDatabase(database),
      TENANT_ID,
      created.sessionId,
      itemA!.id,
      true,
    );

    expect(toggled.homework.find((item) => item.id === itemA!.id)?.done).toBe(true);
    expect(toggled.homework.find((item) => item.id === itemB!.id)?.done).toBe(false);
  });

  it('throws NotFoundError for an unknown item id', async () => {
    const database = new FakeDatabase();
    const created = await createSession(asDatabase(database), TENANT_ID, {
      date: 1000,
      summary: 'Session with homework',
      homework: [{ text: 'Item A' }],
    });

    await expect(
      toggleHomeworkItem(asDatabase(database), TENANT_ID, created.sessionId, 'ghost-item', true),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for an unknown session id', async () => {
    const database = new FakeDatabase();
    await expect(
      toggleHomeworkItem(asDatabase(database), TENANT_ID, 'ghost-session', 'item-1', true),
    ).rejects.toThrow(NotFoundError);
  });
});
