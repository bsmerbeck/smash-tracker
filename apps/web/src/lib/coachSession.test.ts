import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  COACH_SESSION_STORAGE_KEY,
  getOrCreateSessionId,
  getStoredDisplayName,
  parseStoredCoachSession,
  setDisplayName,
} from './coachSession';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('coachSession', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('getOrCreateSessionId', () => {
    it('generates a fresh uuid on first use and persists it under the documented key', () => {
      const id = getOrCreateSessionId();
      expect(id).toMatch(UUID_RE);
      const raw = window.localStorage.getItem(COACH_SESSION_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toMatchObject({ sessionId: id });
    });

    it('returns a stable id across repeated calls', () => {
      const first = getOrCreateSessionId();
      const second = getOrCreateSessionId();
      expect(second).toBe(first);
    });

    it('returns a fresh id after storage is cleared', () => {
      const first = getOrCreateSessionId();
      window.localStorage.clear();
      const second = getOrCreateSessionId();
      expect(second).not.toBe(first);
    });

    it('returns a fresh id when storage holds malformed content', () => {
      window.localStorage.setItem(COACH_SESSION_STORAGE_KEY, '{not json');
      const id = getOrCreateSessionId();
      expect(id).toMatch(UUID_RE);
    });

    it('returns a fresh id when storage holds a non-object JSON value', () => {
      window.localStorage.setItem(COACH_SESSION_STORAGE_KEY, '"just a string"');
      expect(() => getOrCreateSessionId()).not.toThrow();
      expect(getOrCreateSessionId()).toMatch(UUID_RE);
    });

    it('never throws when localStorage access fails', () => {
      const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      expect(() => getOrCreateSessionId()).not.toThrow();
      spy.mockRestore();
    });
  });

  describe('setDisplayName / getStoredDisplayName round-trip', () => {
    it('returns null before any name has been captured', () => {
      expect(getStoredDisplayName()).toBeNull();
    });

    it('round-trips a set display name', () => {
      setDisplayName('Coach Ken');
      expect(getStoredDisplayName()).toBe('Coach Ken');
    });

    it('trims the stored display name', () => {
      setDisplayName('  Coach Ken  ');
      expect(getStoredDisplayName()).toBe('Coach Ken');
    });

    it('preserves the existing session id when setting a display name', () => {
      const id = getOrCreateSessionId();
      setDisplayName('Coach Ken');
      expect(getOrCreateSessionId()).toBe(id);
    });

    it('generates a session id as a side effect if none existed yet', () => {
      setDisplayName('Coach Ken');
      const raw = window.localStorage.getItem(COACH_SESSION_STORAGE_KEY);
      expect(JSON.parse(raw!)).toMatchObject({ sessionId: expect.stringMatching(UUID_RE) });
    });

    it('never throws when localStorage.setItem fails', () => {
      const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      expect(() => setDisplayName('Coach Ken')).not.toThrow();
      spy.mockRestore();
    });
  });

  describe('parseStoredCoachSession', () => {
    it('returns null for null input', () => {
      expect(parseStoredCoachSession(null)).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(parseStoredCoachSession('{not json')).toBeNull();
    });

    it('returns null for a stored object missing sessionId', () => {
      expect(parseStoredCoachSession(JSON.stringify({ displayName: 'Coach Ken' }))).toBeNull();
    });

    it('parses a valid record with a displayName', () => {
      expect(
        parseStoredCoachSession(JSON.stringify({ sessionId: 'abc', displayName: 'Coach Ken' })),
      ).toEqual({ sessionId: 'abc', displayName: 'Coach Ken' });
    });

    it('drops a non-string displayName rather than failing the whole record', () => {
      expect(
        parseStoredCoachSession(JSON.stringify({ sessionId: 'abc', displayName: 42 })),
      ).toEqual({ sessionId: 'abc' });
    });
  });
});
