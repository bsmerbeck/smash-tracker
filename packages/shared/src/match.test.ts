import { describe, expect, it } from 'vitest';
import {
  coachAttributionSchema,
  createMatchInputSchema,
  matchRecordSchema,
  normalizeVodTimestampsNode,
  updateMatchInputSchema,
  vodTimestampEntrySchema,
} from './match.js';

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    fighter_id: 1,
    opponent_id: 2,
    time: 1000,
    win: true,
    ...overrides,
  };
}

const COACH_SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('normalizeVodTimestampsNode', () => {
  it('normalizes a legacy dense array, sorted by seconds, with synthesized legacy ids', () => {
    const result = normalizeVodTimestampsNode([
      { seconds: 300, note: 'a' },
      { seconds: 5, note: 'b' },
    ]);

    expect(result).toHaveLength(2);
    // seconds:5 was originally at index 1, seconds:300 at index 0 — after the
    // unconditional seconds-ascending sort, the index-1 element comes first.
    expect(result[0]).toMatchObject({ id: 'legacy-1', seconds: 5, note: 'b' });
    expect(result[1]).toMatchObject({ id: 'legacy-0', seconds: 300, note: 'a' });
    expect(result[0]!.coach).toBeUndefined();
    expect(result[1]!.coach).toBeUndefined();
  });

  it('normalizes a keyed push-key object, using the RTDB key as id, preserving coach attribution', () => {
    const result = normalizeVodTimestampsNode({
      '-Nx1': { seconds: 300, note: 'a' },
      '-Nx2': {
        seconds: 5,
        note: 'b',
        coach: { sessionId: COACH_SESSION_ID, displayName: 'Coach A' },
      },
    });

    expect(result).toHaveLength(2);
    // sorted by seconds ascending: the coach's seconds:5 note comes first.
    expect(result[0]).toMatchObject({ id: '-Nx2', seconds: 5, note: 'b' });
    expect(result[0]!.coach).toEqual({ sessionId: COACH_SESSION_ID, displayName: 'Coach A' });
    expect(result[1]).toMatchObject({ id: '-Nx1', seconds: 300, note: 'a' });
    expect(result[1]!.coach).toBeUndefined();
  });

  it('normalizes null/undefined to an empty array', () => {
    expect(normalizeVodTimestampsNode(null)).toEqual([]);
    expect(normalizeVodTimestampsNode(undefined)).toEqual([]);
  });

  it('normalizes an empty legacy array and an empty keyed object to an empty array', () => {
    expect(normalizeVodTimestampsNode([])).toEqual([]);
    expect(normalizeVodTimestampsNode({})).toEqual([]);
  });

  it('SKIPS (never throws on) a note whose text exceeds the 200-char cap (inherited from vodTimestampSchema, not re-declared)', () => {
    expect(
      normalizeVodTimestampsNode([
        { seconds: 1, note: 'x'.repeat(201) },
        { seconds: 2, note: 'kept' },
      ]),
    ).toMatchObject([{ id: 'legacy-1', seconds: 2, note: 'kept' }]);
  });

  it('SKIPS (never throws on) a note carrying more than 5 tags (inherited from vodTimestampSchema, not re-declared)', () => {
    expect(
      normalizeVodTimestampsNode([
        { seconds: 1, note: 'ok', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
        { seconds: 2, note: 'kept' },
      ]),
    ).toMatchObject([{ id: 'legacy-1', seconds: 2, note: 'kept' }]);
  });

  // Review CR-02: this normalizer runs inside matchRecordSchema's
  // z.preprocess, and Zod v4 does NOT convert an exception thrown inside a
  // preprocess callback into a validation issue — it escapes safeParse.
  // The normalizer must therefore be TOTAL: corrupt entries are skipped.
  it('REGRESSION (CR-02): skips a corrupt entry (string-typed seconds) in the legacy-array shape', () => {
    expect(
      normalizeVodTimestampsNode([
        { seconds: 'x', note: 'corrupt' },
        { seconds: 2, note: 'kept' },
      ]),
    ).toMatchObject([{ id: 'legacy-1', seconds: 2, note: 'kept' }]);
  });

  it('REGRESSION (CR-02): skips a corrupt entry in the keyed shape, plus non-object and null values', () => {
    expect(
      normalizeVodTimestampsNode({
        bad1: { seconds: 'x', note: 'corrupt' },
        bad2: 'not-an-object',
        bad3: null,
        good: { seconds: 7, note: 'kept' },
      }),
    ).toMatchObject([{ id: 'good', seconds: 7, note: 'kept' }]);
  });

  it('REGRESSION (CR-02): normalizes a legacy array with null holes (RTDB array coercion) by skipping the holes', () => {
    expect(
      normalizeVodTimestampsNode([null, { seconds: 3, note: 'kept' }, undefined]),
    ).toMatchObject([{ id: 'legacy-1', seconds: 3, note: 'kept' }]);
  });

  it('REGRESSION (CR-02): normalizes a wholesale-corrupt scalar node to an empty array', () => {
    expect(normalizeVodTimestampsNode('garbage')).toEqual([]);
    expect(normalizeVodTimestampsNode(42)).toEqual([]);
    expect(normalizeVodTimestampsNode(true)).toEqual([]);
  });

  it('sorts a mixed-order keyed object strictly by seconds, ignoring push-key iteration order', () => {
    const result = normalizeVodTimestampsNode({
      '-Nnewer': { seconds: 5, note: 'earlier moment, added later' },
      '-Nolder': { seconds: 300, note: 'later moment, added earlier' },
    });

    expect(result.map((entry) => entry.seconds)).toEqual([5, 300]);
  });
});

describe('vodTimestampEntrySchema', () => {
  it('extends vodTimestampSchema with id and optional coach', () => {
    const parsed = vodTimestampEntrySchema.parse({
      id: 'legacy-0',
      seconds: 10,
      note: 'a note',
    });
    expect(parsed.id).toBe('legacy-0');
    expect(parsed.coach).toBeUndefined();
  });
});

describe('coachAttributionSchema', () => {
  it('requires a uuid sessionId and a 1-60 char displayName', () => {
    const parsed = coachAttributionSchema.parse({
      sessionId: COACH_SESSION_ID,
      displayName: 'Coach A',
    });
    expect(parsed.sessionId).toBe(COACH_SESSION_ID);
    expect(parsed.displayName).toBe('Coach A');
  });

  it('rejects a non-uuid sessionId', () => {
    const result = coachAttributionSchema.safeParse({
      sessionId: 'not-a-uuid',
      displayName: 'Coach A',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty displayName', () => {
    const result = coachAttributionSchema.safeParse({
      sessionId: COACH_SESSION_ID,
      displayName: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('matchRecordSchema.vodTimestamps dual-read', () => {
  it('reads a legacy-array vodTimestamps node as a sorted, id-bearing VodTimestamp[]', () => {
    const parsed = matchRecordSchema.parse(
      baseRecord({
        vodTimestamps: [
          { seconds: 300, note: 'a' },
          { seconds: 5, note: 'b' },
        ],
      }),
    );
    expect(parsed.vodTimestamps).toHaveLength(2);
    expect(parsed.vodTimestamps![0]).toMatchObject({ id: 'legacy-1', seconds: 5 });
    expect(parsed.vodTimestamps![1]).toMatchObject({ id: 'legacy-0', seconds: 300 });
  });

  it('reads a keyed-object vodTimestamps node as a sorted, id-bearing VodTimestamp[] with coach attribution', () => {
    const parsed = matchRecordSchema.parse(
      baseRecord({
        vodTimestamps: {
          '-Nx1': { seconds: 300, note: 'a' },
          '-Nx2': {
            seconds: 5,
            note: 'b',
            coach: { sessionId: COACH_SESSION_ID, displayName: 'Coach A' },
          },
        },
      }),
    );
    expect(parsed.vodTimestamps).toHaveLength(2);
    expect(parsed.vodTimestamps![0]).toMatchObject({ id: '-Nx2', seconds: 5 });
    expect(parsed.vodTimestamps![0]!.coach).toEqual({
      sessionId: COACH_SESSION_ID,
      displayName: 'Coach A',
    });
    expect(parsed.vodTimestamps![1]).toMatchObject({ id: '-Nx1', seconds: 300 });
  });

  it('leaves vodTimestamps absent (not []) when the raw field is absent', () => {
    const parsed = matchRecordSchema.parse(baseRecord());
    expect(parsed.vodTimestamps).toBeUndefined();
  });

  it('rejects more than 20 normalized entries (max cap still enforced after the preprocess)', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ seconds: i, note: `n${i}` }));
    const result = matchRecordSchema.safeParse(baseRecord({ vodTimestamps: many }));
    expect(result.success).toBe(false);
  });

  // Review CR-02: a throw inside z.preprocess escapes safeParse entirely in
  // Zod v4 — the pre-fix normalizer's per-entry .parse() turned one corrupt
  // note entry into an uncaught ZodError, 500ing GET /api/matches, the
  // anonymous /session read, and every match PATCH for that user.
  it('REGRESSION (CR-02): safeParse NEVER throws for a corrupt legacy-array entry — it succeeds with the entry skipped', () => {
    const result = matchRecordSchema.safeParse(
      baseRecord({
        vodTimestamps: [
          { seconds: 'x', note: 'corrupt' },
          { seconds: 9, note: 'kept' },
        ],
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data!.vodTimestamps).toMatchObject([
      { id: 'legacy-1', seconds: 9, note: 'kept' },
    ]);
  });

  it('REGRESSION (CR-02): safeParse NEVER throws for a corrupt keyed-shape entry — it succeeds with the entry skipped', () => {
    const result = matchRecordSchema.safeParse(
      baseRecord({
        vodTimestamps: {
          bad: { seconds: 'x', note: 'corrupt' },
          good: { seconds: 9, note: 'kept' },
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data!.vodTimestamps).toMatchObject([{ id: 'good', seconds: 9, note: 'kept' }]);
  });
});

describe('createMatchInputSchema / updateMatchInputSchema no longer accept vodTimestamps', () => {
  function validCreateInput(overrides: Record<string, unknown> = {}) {
    return {
      fighter_id: 1,
      opponent_id: 2,
      map: { id: 0, name: 'no selection' },
      opponent: 'rival',
      matchType: 'none' as const,
      win: true,
      ...overrides,
    };
  }

  it('strips/ignores a client-sent vodTimestamps field on create input', () => {
    const parsed = createMatchInputSchema.parse(
      validCreateInput({ vodTimestamps: [{ seconds: 1, note: 'x' }] }),
    );
    expect('vodTimestamps' in parsed).toBe(false);
  });

  it('strips/ignores a client-sent vodTimestamps field on update input', () => {
    const parsed = updateMatchInputSchema.parse(validCreateInput({ vodTimestamps: [] }));
    expect('vodTimestamps' in parsed).toBe(false);
  });
});
