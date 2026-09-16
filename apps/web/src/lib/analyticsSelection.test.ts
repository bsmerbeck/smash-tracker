import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANALYTICS_SELECTION_KEY_PREFIX,
  DEFAULT_MIN_STAGE_MATCHES,
  MIN_STAGE_MATCHES_OPTIONS,
  analyticsSelectionStorageKey,
  parseStoredSelection,
  persistSelection,
  readStoredSelection,
} from './analyticsSelection';

const MARIO_ID = 1; // a real SpriteList id — must resolve via getFighterById
const LUIGI_ID = 10; // a second real SpriteList id, distinct from Mario
const UNKNOWN_FIGHTER_ID = 999_999; // not present in SpriteList

beforeEach(() => {
  window.localStorage.clear();
});

describe('analyticsSelectionStorageKey', () => {
  it('composes uid + "personal" for a nullish clientId', () => {
    expect(analyticsSelectionStorageKey('u1', null)).toBe(
      `${ANALYTICS_SELECTION_KEY_PREFIX}.u1.personal`,
    );
  });

  it('composes uid + "client:<id>" for a non-null clientId', () => {
    expect(analyticsSelectionStorageKey('u1', 'c1')).toBe(
      `${ANALYTICS_SELECTION_KEY_PREFIX}.u1.client:c1`,
    );
  });
});

describe('MIN_STAGE_MATCHES_OPTIONS / DEFAULT_MIN_STAGE_MATCHES', () => {
  it('is the converged union of the two existing threshold option lists', () => {
    expect(MIN_STAGE_MATCHES_OPTIONS).toEqual([1, 2, 3, 5, 10]);
  });

  it('defaults to 3', () => {
    expect(DEFAULT_MIN_STAGE_MATCHES).toBe(3);
  });
});

describe('parseStoredSelection', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '"just a string"'],
  ])('returns an empty object for %s', (_label, raw) => {
    expect(parseStoredSelection(raw)).toEqual({});
  });

  it('admits a valid fighterId and opponentId', () => {
    expect(
      parseStoredSelection(JSON.stringify({ fighterId: MARIO_ID, opponentId: LUIGI_ID })),
    ).toEqual({ fighterId: MARIO_ID, opponentId: LUIGI_ID });
  });

  it('drops a fighterId that no sprite resolves', () => {
    expect(parseStoredSelection(JSON.stringify({ fighterId: UNKNOWN_FIGHTER_ID }))).toEqual({});
  });

  it.each([
    ['a fractional id', 1.5],
    ['a negative id', -1],
    ['a zero id', 0],
  ])('drops %s', (_label, badId) => {
    expect(parseStoredSelection(JSON.stringify({ fighterId: badId }))).toEqual({});
  });

  it('keeps a minStageMatches of 10 and drops 4, 0, and 2.5', () => {
    expect(parseStoredSelection(JSON.stringify({ minStageMatches: 10 }))).toEqual({
      minStageMatches: 10,
    });
    expect(parseStoredSelection(JSON.stringify({ minStageMatches: 4 }))).toEqual({});
    expect(parseStoredSelection(JSON.stringify({ minStageMatches: 0 }))).toEqual({});
    expect(parseStoredSelection(JSON.stringify({ minStageMatches: 2.5 }))).toEqual({});
  });
});

describe('readStoredSelection / persistSelection', () => {
  it('round-trips a patch through localStorage', () => {
    persistSelection('u1', null, { fighterId: MARIO_ID });

    expect(readStoredSelection('u1', null)).toEqual({ fighterId: MARIO_ID });
  });

  it('merges a second patch without dropping the first field', () => {
    persistSelection('u1', null, { fighterId: MARIO_ID });
    persistSelection('u1', null, { opponentId: LUIGI_ID });

    expect(readStoredSelection('u1', null)).toEqual({
      fighterId: MARIO_ID,
      opponentId: LUIGI_ID,
    });
  });

  it('writes byte-identical content when the same selection is written twice', () => {
    const key = analyticsSelectionStorageKey('u1', null);

    persistSelection('u1', null, { fighterId: MARIO_ID, opponentId: LUIGI_ID });
    const first = window.localStorage.getItem(key);
    persistSelection('u1', null, { fighterId: MARIO_ID, opponentId: LUIGI_ID });
    const second = window.localStorage.getItem(key);

    expect(second).toBe(first);
  });

  it('writes nothing when uid is null', () => {
    persistSelection(null, null, { fighterId: MARIO_ID });

    expect(window.localStorage.length).toBe(0);
  });

  it('reads {} when uid is null', () => {
    expect(readStoredSelection(null, null)).toEqual({});
  });

  it('isolates four distinct (uid, subject) keys with no shared content', () => {
    persistSelection('u1', null, { fighterId: 2 }); // u1 / personal
    persistSelection('u1', 'c1', { fighterId: 3 }); // u1 / client:c1
    persistSelection('u1', 'c2', { fighterId: 4 }); // u1 / client:c2
    persistSelection('u2', null, { fighterId: 6 }); // u2 / personal

    expect(readStoredSelection('u1', null)).toEqual({ fighterId: 2 });
    expect(readStoredSelection('u1', 'c1')).toEqual({ fighterId: 3 });
    expect(readStoredSelection('u1', 'c2')).toEqual({ fighterId: 4 });
    expect(readStoredSelection('u2', null)).toEqual({ fighterId: 6 });
  });
});
