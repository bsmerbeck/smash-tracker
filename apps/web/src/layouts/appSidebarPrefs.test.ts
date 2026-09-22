import { describe, expect, it, beforeEach, vi } from 'vitest';
import { VOD_SIDEBAR_COLLAPSED_STORAGE_KEY } from '@/pages/VodManager/lib/vodPrefs';
import {
  APP_SIDEBAR_COLLAPSED_STORAGE_KEY,
  parseStoredAppSidebarCollapsed,
  readStoredAppSidebarCollapsed,
  persistAppSidebarCollapsed,
} from './appSidebarPrefs';

describe('APP_SIDEBAR_COLLAPSED_STORAGE_KEY', () => {
  it('is distinct from the VOD Manager rail collapse key — the two preferences cannot alias', () => {
    expect(APP_SIDEBAR_COLLAPSED_STORAGE_KEY).not.toBe(VOD_SIDEBAR_COLLAPSED_STORAGE_KEY);
  });
});

describe('parseStoredAppSidebarCollapsed', () => {
  it('returns false for null input', () => {
    expect(parseStoredAppSidebarCollapsed(null)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(parseStoredAppSidebarCollapsed('')).toBe(false);
  });

  it('returns true for the exact stored "true" value', () => {
    expect(parseStoredAppSidebarCollapsed('true')).toBe(true);
  });

  it('returns false for the exact stored "false" value', () => {
    expect(parseStoredAppSidebarCollapsed('false')).toBe(false);
  });

  it('returns false for a case-mismatched "TRUE" (exact match only)', () => {
    expect(parseStoredAppSidebarCollapsed('TRUE')).toBe(false);
  });

  it('returns false for "1"', () => {
    expect(parseStoredAppSidebarCollapsed('1')).toBe(false);
  });

  it('returns false for malformed content', () => {
    expect(parseStoredAppSidebarCollapsed('{not json')).toBe(false);
  });
});

describe('readStoredAppSidebarCollapsed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads a persisted "true" back as true', () => {
    window.localStorage.setItem(APP_SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');
    expect(readStoredAppSidebarCollapsed()).toBe(true);
  });

  it('returns false when nothing has been persisted', () => {
    expect(readStoredAppSidebarCollapsed()).toBe(false);
  });

  it('returns false when localStorage.getItem throws', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(readStoredAppSidebarCollapsed()).toBe(false);
    spy.mockRestore();
  });
});

describe('persistAppSidebarCollapsed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('writes the string "true" under the documented key', () => {
    persistAppSidebarCollapsed(true);
    expect(window.localStorage.getItem(APP_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');
  });

  it('writes the string "false" under the documented key', () => {
    persistAppSidebarCollapsed(false);
    expect(window.localStorage.getItem(APP_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('false');
  });

  it('never throws when localStorage.setItem fails', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => persistAppSidebarCollapsed(true)).not.toThrow();
    spy.mockRestore();
  });
});

describe('round-trip through localStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persist then read returns the same value', () => {
    persistAppSidebarCollapsed(true);
    expect(readStoredAppSidebarCollapsed()).toBe(true);

    persistAppSidebarCollapsed(false);
    expect(readStoredAppSidebarCollapsed()).toBe(false);
  });
});
