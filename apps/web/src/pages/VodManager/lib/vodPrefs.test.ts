import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NOTE_PRESET_TAGS } from '@/lib/tags';
import {
  VOD_QUICK_TAGS_STORAGE_KEY,
  VOD_PLAYER_SIZE_STORAGE_KEY,
  parseStoredQuickTags,
  readStoredQuickTags,
  persistQuickTags,
  parseStoredPlayerSize,
  readStoredPlayerSize,
  persistPlayerSize,
} from './vodPrefs';

describe('parseStoredQuickTags', () => {
  it('returns the NOTE_PRESET_TAGS default for null input', () => {
    expect(parseStoredQuickTags(null)).toEqual([...NOTE_PRESET_TAGS]);
  });

  it('returns the NOTE_PRESET_TAGS default for malformed JSON', () => {
    expect(parseStoredQuickTags('{not json')).toEqual([...NOTE_PRESET_TAGS]);
  });

  it('returns the NOTE_PRESET_TAGS default for a non-array JSON value', () => {
    expect(parseStoredQuickTags('{"tag":"punish"}')).toEqual([...NOTE_PRESET_TAGS]);
  });

  it('returns the NOTE_PRESET_TAGS default for an empty array', () => {
    expect(parseStoredQuickTags('[]')).toEqual([...NOTE_PRESET_TAGS]);
  });

  it('returns a valid array of non-empty strings unchanged, preserving order', () => {
    expect(parseStoredQuickTags('["punish","my-custom-tag","edgeguard"]')).toEqual([
      'punish',
      'my-custom-tag',
      'edgeguard',
    ]);
  });

  it('dedupes a valid array, preserving first-seen order', () => {
    expect(parseStoredQuickTags('["punish","edgeguard","punish"]')).toEqual([
      'punish',
      'edgeguard',
    ]);
  });

  it('drops non-string and empty-string entries from an otherwise-valid array', () => {
    expect(parseStoredQuickTags('["punish","",42,"edgeguard"]')).toEqual(['punish', 'edgeguard']);
  });
});

describe('persistQuickTags / readStoredQuickTags', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips through localStorage', () => {
    persistQuickTags(['punish', 'my-custom-tag']);
    expect(readStoredQuickTags()).toEqual(['punish', 'my-custom-tag']);
  });

  it('persists under the documented storage key', () => {
    persistQuickTags(['punish']);
    expect(window.localStorage.getItem(VOD_QUICK_TAGS_STORAGE_KEY)).toBe('["punish"]');
  });

  it('reads the NOTE_PRESET_TAGS default when nothing has been persisted', () => {
    expect(readStoredQuickTags()).toEqual([...NOTE_PRESET_TAGS]);
  });

  it('never throws when localStorage.setItem fails', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => persistQuickTags(['punish'])).not.toThrow();
    spy.mockRestore();
  });

  it('never throws when localStorage.getItem fails', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(() => readStoredQuickTags()).not.toThrow();
    spy.mockRestore();
  });
});

describe('parseStoredPlayerSize', () => {
  it('returns "compact" only for the exact stored "compact" value', () => {
    expect(parseStoredPlayerSize('compact')).toBe('compact');
  });

  it('returns "fill" for null input', () => {
    expect(parseStoredPlayerSize(null)).toBe('fill');
  });

  it('returns "fill" for malformed/unknown input', () => {
    expect(parseStoredPlayerSize('huge')).toBe('fill');
    expect(parseStoredPlayerSize('')).toBe('fill');
    expect(parseStoredPlayerSize('"compact"')).toBe('fill');
  });
});

describe('persistPlayerSize / readStoredPlayerSize', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips through localStorage', () => {
    persistPlayerSize('compact');
    expect(readStoredPlayerSize()).toBe('compact');
  });

  it('persists under the documented storage key', () => {
    persistPlayerSize('compact');
    expect(window.localStorage.getItem(VOD_PLAYER_SIZE_STORAGE_KEY)).toBe('compact');
  });

  it('reads the "fill" default when nothing has been persisted', () => {
    expect(readStoredPlayerSize()).toBe('fill');
  });

  it('never throws when localStorage.setItem fails', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => persistPlayerSize('compact')).not.toThrow();
    spy.mockRestore();
  });
});
