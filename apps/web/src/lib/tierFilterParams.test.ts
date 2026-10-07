import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIER_WORDS, type TierResolution } from '@smash-tracker/shared';
import {
  TIER_FILTER_SETTING_PARAM,
  TIER_FILTER_SIDE_PARAM,
  TIER_FILTER_TIER_PARAM,
  activeTierFilterCount,
  applyTierFilters,
  facetedSettingCounts,
  facetedTierCounts,
  buildTierFilterSearch,
  readTierFilterParams,
} from './tierFilterParams';

describe('readTierFilterParams (G7: tolerant reader)', () => {
  it('names the three params', () => {
    expect([TIER_FILTER_TIER_PARAM, TIER_FILTER_SETTING_PARAM, TIER_FILTER_SIDE_PARAM]).toEqual([
      'tier',
      'setting',
      'side',
    ]);
  });

  it('drops an unknown tier word and keeps the valid one', () => {
    expect(readTierFilterParams(new URLSearchParams('tier=foo,major')).tiers).toEqual(['major']);
  });

  it('reads an empty or all-unknown tier list as absent', () => {
    expect(readTierFilterParams(new URLSearchParams('tier=')).tiers).toEqual([]);
    expect(readTierFilterParams(new URLSearchParams('tier=foo,bar')).tiers).toEqual([]);
    expect(readTierFilterParams(new URLSearchParams('')).tiers).toEqual([]);
  });

  it('reads an unknown setting or side value as absent', () => {
    const filters = readTierFilterParams(new URLSearchParams('setting=x&side=y'));
    expect(filters.setting).toBeUndefined();
    expect(filters.side).toBeUndefined();
    expect('setting' in filters).toBe(false);
    expect('side' in filters).toBe(false);
  });

  it('reads the valid setting and side values', () => {
    expect(readTierFilterParams(new URLSearchParams('setting=online&side=hide'))).toEqual({
      tiers: [],
      setting: 'online',
      side: 'hide',
    });
    expect(readTierFilterParams(new URLSearchParams('setting=offline&side=include'))).toEqual({
      tiers: [],
      setting: 'offline',
      side: 'include',
    });
  });

  it('is case-sensitive: a shouted value is unknown, not coerced', () => {
    const filters = readTierFilterParams(new URLSearchParams('tier=MAJOR&setting=ONLINE'));
    expect(filters.tiers).toEqual([]);
    expect(filters.setting).toBeUndefined();
  });

  it('de-duplicates and returns words in vocabulary order', () => {
    expect(
      readTierFilterParams(new URLSearchParams('tier=unknown,major,major,supermajor')).tiers,
    ).toEqual(['supermajor', 'major', 'unknown']);
  });

  it('never throws on hostile input', () => {
    const hostile = '%E0%A4%A&tier=%00,,,&setting=%s&side=__proto__';
    expect(() => readTierFilterParams(new URLSearchParams(hostile))).not.toThrow();
    expect(readTierFilterParams(new URLSearchParams('tier=__proto__,constructor')).tiers).toEqual(
      [],
    );
  });
});

describe('buildTierFilterSearch (the single writer)', () => {
  it('round-trips every filter combination to identity', () => {
    const cases = [
      { tiers: [] },
      { tiers: ['major'] },
      { tiers: ['supermajor', 'major', 'unknown'] },
      { tiers: [...TIER_WORDS] },
      { tiers: [], setting: 'offline' },
      { tiers: ['minor'], setting: 'online', side: 'hide' },
      { tiers: [], side: 'include' },
    ] as const;
    for (const filters of cases) {
      const built = buildTierFilterSearch({ ...filters, tiers: [...filters.tiers] });
      expect(readTierFilterParams(built)).toEqual(filters);
    }
  });

  it('omits every absent filter', () => {
    expect(buildTierFilterSearch({ tiers: [] }).toString()).toBe('');
  });

  it('keeps unrelated params (drill-down axes, claim) and replaces the three filter params', () => {
    const base = new URLSearchParams(
      'claim=tierGap%3Aall&from=10&tier=local&setting=online&side=hide',
    );
    const built = buildTierFilterSearch({ tiers: ['major'] }, base);
    expect(built.get('claim')).toBe('tierGap:all');
    expect(built.get('from')).toBe('10');
    expect(built.get('tier')).toBe('major');
    expect(built.has('setting')).toBe(false);
    expect(built.has('side')).toBe(false);
  });

  it('does not mutate the base params', () => {
    const base = new URLSearchParams('tier=local');
    buildTierFilterSearch({ tiers: ['major'] }, base);
    expect(base.get('tier')).toBe('local');
  });

  it('writes tiers in vocabulary order, dropping duplicates', () => {
    const built = buildTierFilterSearch({ tiers: ['unknown', 'major', 'major'] });
    expect(built.get('tier')).toBe('major,unknown');
  });
});

describe('activeTierFilterCount', () => {
  it('counts each pressed tier chip, the setting chip and Hide side events', () => {
    expect(activeTierFilterCount({ tiers: [] })).toBe(0);
    expect(
      activeTierFilterCount({ tiers: ['major', 'minor'], setting: 'online', side: 'hide' }),
    ).toBe(4);
    // `side=include` is a stats setting, not a pressed table chip.
    expect(activeTierFilterCount({ tiers: [], side: 'include' })).toBe(0);
  });
});

describe('G7: nothing is ever written to device-local storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes zero calls on localStorage or sessionStorage while reading and building', () => {
    const spies = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const read = readTierFilterParams(new URLSearchParams('tier=major&setting=online&side=hide'));
    buildTierFilterSearch(read, new URLSearchParams('claim=x'));
    activeTierFilterCount(read);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('the module source names neither storage object in code', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'tierFilterParams.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe('faceted counts (UI-SPEC §7.3)', () => {
  function row(
    tier: TierResolution['tier'],
    setting: TierResolution['setting'],
    eventKind: TierResolution['eventKind'] = 'main',
  ) {
    return { resolution: { tier, setting, eventKind } as TierResolution };
  }
  const rows = [
    row('supermajor', 'offline'),
    row('major', 'offline'),
    row('major', 'offline'),
    row('major', 'online'),
    row('unknown', 'online'),
    row('unknown', 'online', 'side-event'),
    row('unknown', 'unknown'),
  ];

  it('lists every tier word, zeros included, in a stable vocabulary', () => {
    const counts = facetedTierCounts(rows, { tiers: [] });
    expect(Object.keys(counts)).toEqual([...TIER_WORDS]);
    expect(counts).toEqual({
      supermajor: 1,
      major: 3,
      minor: 0,
      regional: 0,
      local: 0,
      unknown: 3,
    });
  });

  it('tier counts follow the setting filter but never the tier selection itself', () => {
    const online = facetedTierCounts(rows, { tiers: [], setting: 'online' });
    expect(online).toMatchObject({ supermajor: 0, major: 1, unknown: 2 });
    const withTier = facetedTierCounts(rows, { tiers: ['supermajor'], setting: 'online' });
    expect(withTier).toEqual(online);
  });

  it('tier counts follow the side filter', () => {
    expect(facetedTierCounts(rows, { tiers: [], side: 'hide' }).unknown).toBe(2);
    expect(facetedTierCounts(rows, { tiers: [], side: 'include' }).unknown).toBe(3);
  });

  it('setting counts follow the tier filter but never the setting selection itself', () => {
    expect(facetedSettingCounts(rows, { tiers: [] })).toEqual({ offline: 3, online: 3 });
    expect(facetedSettingCounts(rows, { tiers: ['major'] })).toEqual({ offline: 2, online: 1 });
    expect(facetedSettingCounts(rows, { tiers: ['major'], setting: 'offline' })).toEqual({
      offline: 2,
      online: 1,
    });
  });

  it('applyTierFilters keeps side events by default and drops an unknown setting under a setting filter', () => {
    expect(applyTierFilters(rows, { tiers: [] })).toHaveLength(7);
    expect(applyTierFilters(rows, { tiers: [], side: 'hide' })).toHaveLength(6);
    expect(applyTierFilters(rows, { tiers: [], setting: 'online' })).toHaveLength(3);
    expect(applyTierFilters(rows, { tiers: ['major', 'unknown'], setting: 'online' })).toHaveLength(
      3,
    );
  });
});
