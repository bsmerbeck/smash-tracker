import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { localizedFighterName, sortFightersByLocalizedName } from '@/lib/fighterNames';
import { SpriteList } from '@/data/sprites';

/** Resolves a single fighter id's display name in the active locale. */
export function useFighterName(id: number): string {
  const { t } = useTranslation();
  return localizedFighterName(id, t);
}

/**
 * Returns a stable `(id) => string` resolver bound to the current locale's
 * `t` — for grids, tables, and `.map()` loops where calling `useFighterName`
 * per-item would violate the rules of hooks.
 */
export function useFighterNameResolver(): (id: number) => string {
  const { t } = useTranslation();
  return useCallback((id: number) => localizedFighterName(id, t), [t]);
}

/**
 * 260725-Q1: sorts any list of fighters by localized display name for the
 * active locale — the shared implementation behind every fighter-selection
 * surface in the app (character select grids, "your fighter"/"opponent"
 * pickers, GSP selectors, etc). Re-sorts when `fighters`, the active
 * locale, or its translation bundle changes.
 */
export function useSortedFighters<T extends { id: number }>(fighters: T[]): T[] {
  const { i18n } = useTranslation();
  const localizedName = useFighterNameResolver();
  return useMemo(
    () => sortFightersByLocalizedName(fighters, localizedName, i18n.resolvedLanguage),
    [fighters, localizedName, i18n.resolvedLanguage],
  );
}

/**
 * The full 86-fighter roster (`SpriteList`), sorted by localized display
 * name for the active locale — replaces the old locale-blind
 * `alphaSpriteList` (English-name-only sort) everywhere an "opponent" or
 * "any fighter" picker offers the whole roster.
 */
export function useAlphaFighters(): Fighter[] {
  return useSortedFighters(SpriteList);
}
