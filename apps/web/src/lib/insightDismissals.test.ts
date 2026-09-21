import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSIGHT_DISMISSALS_KEY_PREFIX,
  MAX_DISMISSED_INSIGHTS,
  capDismissedIds,
  insightDismissalsStorageKey,
  parseStoredDismissals,
  readStoredDismissals,
  writeStoredDismissals,
} from './insightDismissals';

beforeEach(() => {
  window.localStorage.clear();
});

describe('insightDismissalsStorageKey', () => {
  it('composes uid + "personal" for a nullish clientId, distinct from the selection key prefix', () => {
    expect(insightDismissalsStorageKey('u1', null)).toBe(
      `${INSIGHT_DISMISSALS_KEY_PREFIX}.u1.personal`,
    );
  });

  it('composes uid + "client:<id>" for a non-null clientId', () => {
    expect(insightDismissalsStorageKey('u1', 'c1')).toBe(
      `${INSIGHT_DISMISSALS_KEY_PREFIX}.u1.client:c1`,
    );
  });

  it('differs from the analyticsSelection storage key for the same (uid, subject)', async () => {
    const { analyticsSelectionStorageKey } = await import('./analyticsSelection');
    expect(insightDismissalsStorageKey('u1', null)).not.toBe(
      analyticsSelectionStorageKey('u1', null),
    );
    expect(insightDismissalsStorageKey('u1', 'c1')).not.toBe(
      analyticsSelectionStorageKey('u1', 'c1'),
    );
  });
});

describe('parseStoredDismissals', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['a JSON object', '{"a":1}'],
    ['a JSON scalar', '"just a string"'],
  ])('returns an empty list for %s', (_label, raw) => {
    expect(parseStoredDismissals(raw)).toEqual([]);
  });

  it('admits a valid array of string ids', () => {
    expect(parseStoredDismissals(JSON.stringify(['a:b:c', 'd:e:f']))).toEqual(['a:b:c', 'd:e:f']);
  });

  it('drops non-string entries from an otherwise-valid array, keeping the string ones', () => {
    expect(parseStoredDismissals(JSON.stringify(['a:b:c', 42, null, 'd:e:f']))).toEqual([
      'a:b:c',
      'd:e:f',
    ]);
  });
});

describe('readStoredDismissals / writeStoredDismissals', () => {
  it('round-trips a list of ids through localStorage', () => {
    writeStoredDismissals('u1', null, ['formNow:account:last30']);

    expect(readStoredDismissals('u1', null)).toEqual(['formNow:account:last30']);
  });

  it('writes nothing when uid is null', () => {
    writeStoredDismissals(null, null, ['formNow:account:last30']);

    expect(window.localStorage.length).toBe(0);
  });

  it('reads [] when uid is null', () => {
    expect(readStoredDismissals(null, null)).toEqual([]);
  });

  it('isolates two distinct (uid, subject) keys with no shared content', () => {
    writeStoredDismissals('u1', null, ['id-personal']);
    writeStoredDismissals('u1', 'c1', ['id-client-a']);

    expect(readStoredDismissals('u1', null)).toEqual(['id-personal']);
    expect(readStoredDismissals('u1', 'c1')).toEqual(['id-client-a']);
  });

  it('a throwing storage stub leaves readStoredDismissals returning [] and writeStoredDismissals silent, no throw', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => writeStoredDismissals('u1', null, ['id-1'])).not.toThrow();
    expect(readStoredDismissals('u1', null)).toEqual([]);

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it('a non-array stored value reads back as an empty list', () => {
    window.localStorage.setItem(
      insightDismissalsStorageKey('u1', null),
      JSON.stringify({ oops: true }),
    );

    expect(readStoredDismissals('u1', null)).toEqual([]);
  });
});

describe('capDismissedIds', () => {
  it('leaves a list at or under the maximum unchanged', () => {
    const ids = Array.from({ length: MAX_DISMISSED_INSIGHTS }, (_, i) => `id-${i}`);
    expect(capDismissedIds(ids)).toEqual(ids);
  });

  it('evicts the OLDEST entries at one over the maximum, keeping the newest', () => {
    const ids = Array.from({ length: MAX_DISMISSED_INSIGHTS + 1 }, (_, i) => `id-${i}`);

    const capped = capDismissedIds(ids);

    expect(capped).toHaveLength(MAX_DISMISSED_INSIGHTS);
    expect(capped).not.toContain('id-0');
    expect(capped[capped.length - 1]).toBe(`id-${MAX_DISMISSED_INSIGHTS}`);
  });

  it('writeStoredDismissals applies the cap before persisting', () => {
    const ids = Array.from({ length: MAX_DISMISSED_INSIGHTS + 1 }, (_, i) => `id-${i}`);

    writeStoredDismissals('u1', null, ids);

    const stored = readStoredDismissals('u1', null);
    expect(stored).toHaveLength(MAX_DISMISSED_INSIGHTS);
    expect(stored).not.toContain('id-0');
  });
});
