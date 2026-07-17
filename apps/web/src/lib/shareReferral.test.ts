import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { SHARE_REFERRAL_STORAGE_KEY, stamp, read, clear } from './shareReferral';

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

describe('shareReferral', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('stamp / read round-trip', () => {
    it('read() returns the shareId for a fresh stamp', () => {
      stamp('share-abc');
      expect(read()).toBe('share-abc');
    });

    it('persists under the documented smash-tracker.* storage key', () => {
      stamp('share-abc');
      const raw = window.localStorage.getItem(SHARE_REFERRAL_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toMatchObject({ shareId: 'share-abc' });
    });

    it('read() returns null when nothing has been stamped', () => {
      expect(read()).toBeNull();
    });

    it('read() returns null for a 31-day-old stamp and clears it', () => {
      const now = Date.now();
      window.localStorage.setItem(
        SHARE_REFERRAL_STORAGE_KEY,
        JSON.stringify({ shareId: 'stale-share', timestamp: now - THIRTY_ONE_DAYS_MS }),
      );

      expect(read()).toBeNull();
      expect(window.localStorage.getItem(SHARE_REFERRAL_STORAGE_KEY)).toBeNull();
    });

    it('read() still returns the shareId for a stamp just under 30 days old', () => {
      const now = Date.now();
      window.localStorage.setItem(
        SHARE_REFERRAL_STORAGE_KEY,
        JSON.stringify({ shareId: 'fresh-enough', timestamp: now - 29 * 24 * 60 * 60 * 1000 }),
      );

      expect(read()).toBe('fresh-enough');
    });

    it('read() returns null for a corrupt JSON value without throwing', () => {
      window.localStorage.setItem(SHARE_REFERRAL_STORAGE_KEY, '{not json');
      expect(() => read()).not.toThrow();
      expect(read()).toBeNull();
    });

    it('read() returns null for a malformed (missing fields) stored object', () => {
      window.localStorage.setItem(SHARE_REFERRAL_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
      expect(read()).toBeNull();
    });

    it('read() returns null for a non-object JSON value', () => {
      window.localStorage.setItem(SHARE_REFERRAL_STORAGE_KEY, '"just a string"');
      expect(read()).toBeNull();
    });
  });

  describe('clear', () => {
    it('removes the stamp', () => {
      stamp('share-abc');
      clear();
      expect(read()).toBeNull();
      expect(window.localStorage.getItem(SHARE_REFERRAL_STORAGE_KEY)).toBeNull();
    });

    it('never throws when nothing is stored', () => {
      expect(() => clear()).not.toThrow();
    });
  });

  describe('storage-failure resilience', () => {
    it('never throws when localStorage.setItem fails', () => {
      const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      expect(() => stamp('share-abc')).not.toThrow();
      spy.mockRestore();
    });

    it('never throws when localStorage.getItem fails', () => {
      const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      expect(() => read()).not.toThrow();
      expect(read()).toBeNull();
      spy.mockRestore();
    });

    it('never throws when localStorage.removeItem fails', () => {
      const spy = vi.spyOn(window.localStorage.__proto__, 'removeItem').mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      expect(() => clear()).not.toThrow();
      spy.mockRestore();
    });
  });
});
