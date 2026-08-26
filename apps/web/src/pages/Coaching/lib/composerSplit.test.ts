import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampSplitPercent,
  COMPOSER_SPLIT_DEFAULT_PERCENT,
  COMPOSER_SPLIT_MAX_PERCENT,
  COMPOSER_SPLIT_MIN_PERCENT,
  COMPOSER_SPLIT_STORAGE_KEY,
  computeSplitPercent,
  parseStoredSplitPercent,
  persistSplitPercent,
  readStoredSplitPercent,
} from './composerSplit';

describe('clampSplitPercent', () => {
  it('a value below the minimum returns the minimum', () => {
    expect(clampSplitPercent(10)).toBe(COMPOSER_SPLIT_MIN_PERCENT);
  });

  it('a value above the maximum returns the maximum', () => {
    expect(clampSplitPercent(90)).toBe(COMPOSER_SPLIT_MAX_PERCENT);
  });

  it('a value inside the range returns itself rounded to a whole number', () => {
    expect(clampSplitPercent(45.4)).toBe(45);
    expect(clampSplitPercent(45.6)).toBe(46);
  });

  it('a non-finite value (NaN / Infinity) returns the default', () => {
    expect(clampSplitPercent(NaN)).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
    expect(clampSplitPercent(Infinity)).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
    expect(clampSplitPercent(-Infinity)).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
  });
});

describe('computeSplitPercent', () => {
  it('a pointer x one quarter across a 1000px-wide container starting at left 100 clamps up to the minimum', () => {
    expect(computeSplitPercent(350, { left: 100, width: 1000 })).toBe(COMPOSER_SPLIT_MIN_PERCENT);
  });

  it('halfway across returns 50', () => {
    expect(computeSplitPercent(600, { left: 100, width: 1000 })).toBe(50);
  });

  it('a zero-width container returns the default', () => {
    expect(computeSplitPercent(600, { left: 100, width: 0 })).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
  });
});

describe('parseStoredSplitPercent', () => {
  it('null returns the default', () => {
    expect(parseStoredSplitPercent(null)).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
  });

  it('unparseable text returns the default', () => {
    expect(parseStoredSplitPercent('not-a-number')).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
  });

  it('an in-range numeric string returns that number', () => {
    expect(parseStoredSplitPercent('45')).toBe(45);
  });

  it('an out-of-range numeric string returns the clamped bound', () => {
    expect(parseStoredSplitPercent('90')).toBe(COMPOSER_SPLIT_MAX_PERCENT);
    expect(parseStoredSplitPercent('10')).toBe(COMPOSER_SPLIT_MIN_PERCENT);
  });

  it('a fractional string rounds', () => {
    expect(parseStoredSplitPercent('55.6')).toBe(56);
  });
});

describe('readStoredSplitPercent / persistSplitPercent', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads back a persisted value', () => {
    persistSplitPercent(55);
    expect(readStoredSplitPercent()).toBe(55);
    expect(window.localStorage.getItem(COMPOSER_SPLIT_STORAGE_KEY)).toBe('55');
  });

  it('returns the default when localStorage.getItem throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(readStoredSplitPercent()).toBe(COMPOSER_SPLIT_DEFAULT_PERCENT);
  });

  it('swallows a throwing setItem without propagating', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => persistSplitPercent(50)).not.toThrow();
  });
});
