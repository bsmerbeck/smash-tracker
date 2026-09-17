import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RATING_MODEL_NOTE_KEY_PREFIX,
  dismissRatingModelNote,
  isRatingModelNoteDismissed,
  ratingModelNoteStorageKey,
} from './ratingModelNote';

beforeEach(() => {
  window.localStorage.clear();
});

describe('ratingModelNoteStorageKey', () => {
  it('composes uid + version', () => {
    expect(ratingModelNoteStorageKey('u1', 2)).toBe(`${RATING_MODEL_NOTE_KEY_PREFIX}.u1.v2`);
  });
});

describe('isRatingModelNoteDismissed', () => {
  it('returns false for a nullish uid and performs no storage access', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem');

    expect(isRatingModelNoteDismissed(null, 2)).toBe(false);

    expect(spy).not.toHaveBeenCalled();
  });

  it('returns true once the exact key holds the literal string "1"', () => {
    window.localStorage.setItem(ratingModelNoteStorageKey('u1', 2), '1');

    expect(isRatingModelNoteDismissed('u1', 2)).toBe(true);
  });

  it('returns false for a stored value that is not "1", and never throws', () => {
    window.localStorage.setItem(ratingModelNoteStorageKey('u1', 2), '{"broken');

    expect(isRatingModelNoteDismissed('u1', 2)).toBe(false);
  });

  it('scopes dismissal by rating-model version — a v1 dismissal does not carry over to v2', () => {
    window.localStorage.setItem(ratingModelNoteStorageKey('u1', 1), '1');

    expect(isRatingModelNoteDismissed('u1', 2)).toBe(false);
  });

  it('returns false when a localStorage read throws', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });

    expect(isRatingModelNoteDismissed('u1', 2)).toBe(false);

    spy.mockRestore();
  });
});

describe('dismissRatingModelNote', () => {
  it('is a no-op for a nullish uid', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem');

    dismissRatingModelNote(null, 2);

    expect(spy).not.toHaveBeenCalled();
  });

  it('writes the literal string "1" under the uid+version key', () => {
    dismissRatingModelNote('u1', 2);

    expect(window.localStorage.getItem(ratingModelNoteStorageKey('u1', 2))).toBe('1');
  });

  it('returns normally when a localStorage write throws — leaves state to the session only', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => dismissRatingModelNote('u1', 2)).not.toThrow();

    spy.mockRestore();
  });
});
