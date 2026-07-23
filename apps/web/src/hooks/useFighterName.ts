import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedFighterName } from '@/lib/fighterNames';

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
