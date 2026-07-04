import { describe, expect, it, beforeEach } from 'vitest';
import {
  MATCH_TABLE_COLUMNS_STORAGE_KEY,
  parseStoredColumnVisibility,
  persistColumnVisibility,
  readStoredColumnVisibility,
} from './columnVisibility';

describe('parseStoredColumnVisibility', () => {
  it('returns an empty object for null input', () => {
    expect(parseStoredColumnVisibility(null)).toEqual({});
  });

  it('returns an empty object for malformed JSON', () => {
    expect(parseStoredColumnVisibility('{not json')).toEqual({});
  });

  it('returns an empty object for a JSON array', () => {
    expect(parseStoredColumnVisibility('[1,2,3]')).toEqual({});
  });

  it('returns an empty object for a JSON primitive', () => {
    expect(parseStoredColumnVisibility('42')).toEqual({});
  });

  it('parses a valid visibility map', () => {
    expect(parseStoredColumnVisibility('{"notes":false,"stage":true}')).toEqual({
      notes: false,
      stage: true,
    });
  });

  it('drops non-boolean values from an otherwise-valid object', () => {
    expect(parseStoredColumnVisibility('{"notes":false,"stage":"yes"}')).toEqual({
      notes: false,
    });
  });
});

describe('persistColumnVisibility / readStoredColumnVisibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips through localStorage', () => {
    persistColumnVisibility({ notes: false, tournament: true });
    expect(readStoredColumnVisibility()).toEqual({ notes: false, tournament: true });
  });

  it('persists under the documented storage key', () => {
    persistColumnVisibility({ notes: false });
    expect(window.localStorage.getItem(MATCH_TABLE_COLUMNS_STORAGE_KEY)).toBe('{"notes":false}');
  });

  it('reads an empty object when nothing has been persisted', () => {
    expect(readStoredColumnVisibility()).toEqual({});
  });
});
