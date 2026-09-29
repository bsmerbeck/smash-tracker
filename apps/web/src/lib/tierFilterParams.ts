import { TIER_WORDS, type TierResolution, type TierWord } from '@smash-tracker/shared';

/**
 * Phase 39.2 (D-13, UI-SPEC §7.3 / §10.1): the ONE module declaring the three
 * Tournaments-page filter params and the ONE tolerant reader / single builder
 * for them — the `drillDownParams.ts` model.
 *
 * - `tier` — a comma list of tier words drawn from `TIER_WORDS`. Words outside
 *   the vocabulary are dropped; an empty list is "absent" (all tiers).
 * - `setting` — `offline` or `online`; anything else is absent (both).
 * - `side` — `hide` or `include`; anything else is absent. Absent shows side
 *   events in the table (with their badge) while the by-tier stats exclude
 *   them; `hide` removes them from the table; `include` adds them to the stats.
 *
 * The reader never throws and the URL is the ONLY carrier of these filters:
 * this module touches no `localStorage` / `sessionStorage`, and neither does a
 * chip press (D-13). Reading a pasted link must never persist anything.
 */

export const TIER_FILTER_TIER_PARAM = 'tier';
export const TIER_FILTER_SETTING_PARAM = 'setting';
export const TIER_FILTER_SIDE_PARAM = 'side';

export type TierFilterSetting = 'offline' | 'online';
export type TierFilterSide = 'hide' | 'include';

/** Resolved, validated filters — every field is a trusted value or absent (`tiers: []` is absent). */
export interface TierFilters {
  tiers: TierWord[];
  setting?: TierFilterSetting;
  side?: TierFilterSide;
}

const TIER_WORD_SET: ReadonlySet<string> = new Set(TIER_WORDS);

function isTierWord(value: string): value is TierWord {
  return TIER_WORD_SET.has(value);
}

/** Reads the three filter params tolerantly; unknown values read as the filter being absent. */
export function readTierFilterParams(searchParams: URLSearchParams): TierFilters {
  const requested = new Set<TierWord>();
  for (const raw of (searchParams.get(TIER_FILTER_TIER_PARAM) ?? '').split(',')) {
    const word = raw.trim();
    if (isTierWord(word)) {
      requested.add(word);
    }
  }
  // Canonical vocabulary order, whatever order the URL spelled them in.
  const filters: TierFilters = { tiers: TIER_WORDS.filter((word) => requested.has(word)) };

  const setting = searchParams.get(TIER_FILTER_SETTING_PARAM);
  if (setting === 'offline' || setting === 'online') {
    filters.setting = setting;
  }
  const side = searchParams.get(TIER_FILTER_SIDE_PARAM);
  if (side === 'hide' || side === 'include') {
    filters.side = side;
  }
  return filters;
}

/**
 * The single writer. Starts from a copy of `base` (so unrelated params — the
 * drill-down axes, `claim` — survive), drops the three filter params, then
 * writes back only those present in `filters`.
 */
export function buildTierFilterSearch(
  filters: Partial<TierFilters>,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base);
  params.delete(TIER_FILTER_TIER_PARAM);
  params.delete(TIER_FILTER_SETTING_PARAM);
  params.delete(TIER_FILTER_SIDE_PARAM);

  const wanted = new Set(filters.tiers ?? []);
  const tiers = TIER_WORDS.filter((word) => wanted.has(word));
  if (tiers.length > 0) {
    params.set(TIER_FILTER_TIER_PARAM, tiers.join(','));
  }
  if (filters.setting != null) {
    params.set(TIER_FILTER_SETTING_PARAM, filters.setting);
  }
  if (filters.side != null) {
    params.set(TIER_FILTER_SIDE_PARAM, filters.side);
  }
  return params;
}

/** How many of the three chip groups are on — the "Filters (n)" badge and the Clear affordance read this. */
export function activeTierFilterCount(filters: TierFilters): number {
  return (
    filters.tiers.length + (filters.setting != null ? 1 : 0) + (filters.side === 'hide' ? 1 : 0)
  );
}

/** Anything carrying a resolved tier — the filter and the faceted counts read only this. */
export interface TierFilterable {
  resolution: TierResolution;
}

type FilterFacet = 'tier' | 'setting';

function passesFilters(
  row: TierFilterable,
  filters: TierFilters,
  ignore: FilterFacet | null,
): boolean {
  const { resolution } = row;
  if (ignore !== 'tier' && filters.tiers.length > 0 && !filters.tiers.includes(resolution.tier)) {
    return false;
  }
  if (ignore !== 'setting' && filters.setting != null && resolution.setting !== filters.setting) {
    return false;
  }
  // The table shows side events unless `side=hide` (T-06); `side=include` is a stats setting.
  return !(filters.side === 'hide' && resolution.eventKind === 'side-event');
}

/** The rows the table shows: every present filter applied (an unknown setting never matches a setting filter). */
export function applyTierFilters<T extends TierFilterable>(rows: T[], filters: TierFilters): T[] {
  return rows.filter((row) => passesFilters(row, filters, null));
}

/**
 * Faceted counts (UI-SPEC §7.3): each tier chip counts the rows that pass the
 * setting and side filters while IGNORING the tier selection itself, so a chip
 * says how many events pressing it would show. Every word is present, zeros
 * included, so the chip vocabulary is stable across accounts.
 */
export function facetedTierCounts<T extends TierFilterable>(
  rows: T[],
  filters: TierFilters,
): Record<TierWord, number> {
  const counts = Object.fromEntries(TIER_WORDS.map((word) => [word, 0])) as Record<
    TierWord,
    number
  >;
  for (const row of rows) {
    if (passesFilters(row, filters, 'tier')) {
      counts[row.resolution.tier] += 1;
    }
  }
  return counts;
}

/** Setting chips count the rows that pass the tier and side filters, ignoring the setting selection. */
export function facetedSettingCounts<T extends TierFilterable>(
  rows: T[],
  filters: TierFilters,
): Record<TierFilterSetting, number> {
  const counts: Record<TierFilterSetting, number> = { offline: 0, online: 0 };
  for (const row of rows) {
    if (!passesFilters(row, filters, 'setting')) {
      continue;
    }
    const { setting } = row.resolution;
    if (setting === 'offline' || setting === 'online') {
      counts[setting] += 1;
    }
  }
  return counts;
}
