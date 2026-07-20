import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ONBOARDING_ORIGIN_STORAGE_KEY,
  stamp,
  read,
  clear,
  isSafeReturnPath,
} from './onboardingOrigin';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe('onboardingOrigin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('stamp / read round-trip', () => {
    it('read() returns the same object for a fresh stamp within TTL', () => {
      stamp({ kind: 'coachReview', returnPath: '/r/abc-123' });
      expect(read()).toMatchObject({ kind: 'coachReview', returnPath: '/r/abc-123' });
    });

    it('persists under the documented smash-tracker.* storage key, independently of shareReferral', () => {
      stamp({ kind: 'vodShare', returnPath: '/s/tok-1' });
      const raw = window.localStorage.getItem(ONBOARDING_ORIGIN_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toMatchObject({ kind: 'vodShare', returnPath: '/s/tok-1' });
      expect(ONBOARDING_ORIGIN_STORAGE_KEY).toBe('smash-tracker.onboardingOrigin');
    });

    it('read() returns null when nothing has been stamped', () => {
      expect(read()).toBeNull();
    });

    it('read() returns null and clears when the stamp is older than the TTL', () => {
      const now = Date.now();
      window.localStorage.setItem(
        ONBOARDING_ORIGIN_STORAGE_KEY,
        JSON.stringify({
          kind: 'recap',
          returnPath: '/s/old-token',
          timestamp: now - (TWO_HOURS_MS + 1000),
        }),
      );

      expect(read()).toBeNull();
      expect(window.localStorage.getItem(ONBOARDING_ORIGIN_STORAGE_KEY)).toBeNull();
    });

    it('read() still returns the stamp just under the TTL', () => {
      const now = Date.now();
      window.localStorage.setItem(
        ONBOARDING_ORIGIN_STORAGE_KEY,
        JSON.stringify({
          kind: 'recap',
          returnPath: '/s/fresh-token',
          timestamp: now - (TWO_HOURS_MS - 1000),
        }),
      );

      expect(read()).toMatchObject({ kind: 'recap', returnPath: '/s/fresh-token' });
    });

    it('read() returns null for a corrupt JSON value without throwing', () => {
      window.localStorage.setItem(ONBOARDING_ORIGIN_STORAGE_KEY, '{not json');
      expect(() => read()).not.toThrow();
      expect(read()).toBeNull();
    });

    it('read() returns null for a malformed (missing fields) stored object', () => {
      window.localStorage.setItem(ONBOARDING_ORIGIN_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
      expect(read()).toBeNull();
    });

    it('read() returns null for an unrecognized kind value', () => {
      window.localStorage.setItem(
        ONBOARDING_ORIGIN_STORAGE_KEY,
        JSON.stringify({ kind: 'somethingElse', returnPath: '/s/tok', timestamp: Date.now() }),
      );
      expect(read()).toBeNull();
    });
  });

  describe('returnPath open-redirect validation', () => {
    it('isSafeReturnPath accepts /s/:token and /r/:token shapes', () => {
      expect(isSafeReturnPath('/s/abc_123-XYZ')).toBe(true);
      expect(isSafeReturnPath('/r/tok-456')).toBe(true);
    });

    it('isSafeReturnPath rejects absolute URLs, protocol-relative paths, and non-/s//r paths', () => {
      expect(isSafeReturnPath('https://evil.example')).toBe(false);
      expect(isSafeReturnPath('//evil.example')).toBe(false);
      expect(isSafeReturnPath('javascript:alert(1)')).toBe(false);
      expect(isSafeReturnPath('/dashboard')).toBe(false);
      expect(isSafeReturnPath('/s/')).toBe(false);
    });

    it('read() returns null (and never a navigable value) for a stamp whose returnPath fails validation', () => {
      window.localStorage.setItem(
        ONBOARDING_ORIGIN_STORAGE_KEY,
        JSON.stringify({
          kind: 'coachReview',
          returnPath: 'https://evil.example',
          timestamp: Date.now(),
        }),
      );

      expect(read()).toBeNull();
      // Consumed/cleared as a side effect — never left around to be retried.
      expect(window.localStorage.getItem(ONBOARDING_ORIGIN_STORAGE_KEY)).toBeNull();
    });
  });

  describe('clear', () => {
    it('removes the stamp', () => {
      stamp({ kind: 'vodShare', returnPath: '/s/tok' });
      clear();
      expect(read()).toBeNull();
      expect(window.localStorage.getItem(ONBOARDING_ORIGIN_STORAGE_KEY)).toBeNull();
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
      expect(() => stamp({ kind: 'vodShare', returnPath: '/s/tok' })).not.toThrow();
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
