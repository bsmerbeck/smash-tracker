import { describe, expect, it } from 'vitest';
import {
  clientVisibleSessionSchema,
  homeworkItemSchema,
  MAX_SESSION_CHARACTER_TAGS,
  MAX_SESSION_HOMEWORK_ITEMS,
  sessionPatchInputSchema,
  trainingSessionSchema,
} from './coachingSession.js';

function makeHomeworkItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'hw-1',
    text: 'Practice out-of-shield options',
    done: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: 1000,
    characterTags: [1, 2],
    summary: 'Solid neutral game, worked on shield pressure.',
    homework: [makeHomeworkItem()],
    createdAt: 1000,
    lastEditedAt: 1000,
    ...overrides,
  };
}

describe('trainingSessionSchema', () => {
  it('accepts a valid full session', () => {
    const session = trainingSessionSchema.parse(makeSession());
    expect(session.characterTags).toEqual([1, 2]);
    expect(session.homework).toHaveLength(1);
  });

  it('accepts a session with zero tags, zero homework, and absent coachPrivateNotes', () => {
    const session = trainingSessionSchema.parse(makeSession({ characterTags: [], homework: [] }));
    expect(session.characterTags).toEqual([]);
    expect(session.homework).toEqual([]);
    expect(session.coachPrivateNotes).toBeUndefined();
  });

  it('accepts coachPrivateNotes and linkedMatchIds when present', () => {
    const session = trainingSessionSchema.parse(
      makeSession({
        coachPrivateNotes: 'Watch their neutral habits.',
        linkedMatchIds: ['match-1'],
      }),
    );
    expect(session.coachPrivateNotes).toBe('Watch their neutral habits.');
    expect(session.linkedMatchIds).toEqual(['match-1']);
  });

  it('rejects a homework array over the MAX_SESSION_HOMEWORK_ITEMS cap', () => {
    const tooMany = Array.from({ length: MAX_SESSION_HOMEWORK_ITEMS + 1 }, (_, i) =>
      makeHomeworkItem({ id: `hw-${i}` }),
    );
    expect(() => trainingSessionSchema.parse(makeSession({ homework: tooMany }))).toThrow();
  });

  it('rejects a summary over the 4000-char safe-Markdown cap', () => {
    expect(() => trainingSessionSchema.parse(makeSession({ summary: 'x'.repeat(4001) }))).toThrow();
  });

  it('rejects a characterTags array over the MAX_SESSION_CHARACTER_TAGS cap', () => {
    const tooMany = Array.from({ length: MAX_SESSION_CHARACTER_TAGS + 1 }, (_, i) => i + 1);
    expect(() => trainingSessionSchema.parse(makeSession({ characterTags: tooMany }))).toThrow();
  });

  it('rejects a homework item text over the 200-char cap', () => {
    expect(() =>
      trainingSessionSchema.parse(
        makeSession({ homework: [makeHomeworkItem({ text: 'x'.repeat(201) })] }),
      ),
    ).toThrow();
  });
});

describe('clientVisibleSessionSchema', () => {
  it('parse drops coachPrivateNotes even when the input object carries it (structural omission)', () => {
    const parsed = clientVisibleSessionSchema.parse({
      date: 1000,
      characterTags: [1],
      summary: 'Great set overall.',
      homework: [{ text: 'Practice out-of-shield options', done: false }],
      // Extra field a caller might mistakenly spread in — must never survive parse.
      coachPrivateNotes: 'This must never appear in the parsed output.',
    });
    expect(parsed).not.toHaveProperty('coachPrivateNotes');
    expect(Object.keys(parsed).sort()).toEqual(['characterTags', 'date', 'homework', 'summary']);
    expect(JSON.stringify(parsed)).not.toContain('coachPrivateNotes');
  });

  it('drops the coach-only homework item id (schema has no field for it)', () => {
    const parsed = clientVisibleSessionSchema.parse({
      date: 1000,
      characterTags: [],
      summary: 'text',
      homework: [{ id: 'hw-1', text: 'do the thing', done: true }],
    });
    expect(parsed.homework[0]).not.toHaveProperty('id');
    expect(parsed.homework[0]).toEqual({ text: 'do the thing', done: true });
  });

  it('accepts a nullish linkedMatchIds', () => {
    const parsed = clientVisibleSessionSchema.parse({
      date: 1000,
      characterTags: [],
      summary: 'text',
      homework: [],
    });
    expect(parsed.linkedMatchIds).toBeUndefined();
  });
});

describe('homeworkItemSchema', () => {
  it('accepts a valid item', () => {
    expect(() => homeworkItemSchema.parse(makeHomeworkItem())).not.toThrow();
  });

  it('requires a non-empty id', () => {
    expect(() => homeworkItemSchema.parse(makeHomeworkItem({ id: '' }))).toThrow();
  });
});

describe('sessionPatchInputSchema', () => {
  it('allows a fully empty patch', () => {
    expect(() => sessionPatchInputSchema.parse({})).not.toThrow();
  });

  it('allows a partial patch of just summary, or just coachPrivateNotes', () => {
    expect(() => sessionPatchInputSchema.parse({ summary: 'updated summary' })).not.toThrow();
    expect(() =>
      sessionPatchInputSchema.parse({ coachPrivateNotes: 'private update' }),
    ).not.toThrow();
  });

  it('validates homework/characterTags caps on a partial patch too', () => {
    const tooMany = Array.from({ length: MAX_SESSION_HOMEWORK_ITEMS + 1 }, (_, i) =>
      makeHomeworkItem({ id: `hw-${i}` }),
    );
    expect(() => sessionPatchInputSchema.parse({ homework: tooMany })).toThrow();
  });
});
