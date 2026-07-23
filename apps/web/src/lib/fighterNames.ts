import type { TFunction } from 'i18next';
import { getFighterById } from '@/data/sprites';

/**
 * I18N-01/I18N-02: fighter-name localization.
 *
 * Every locale carries an id-keyed `fighterNames.<id>` translation resource
 * (added in Task 1) sourced from Nintendo's official localized rosters
 * (19-RESEARCH.md Appendix B). Two documented deliberate exceptions:
 *
 * - `es` uses `es_ES` (Spain Spanish) values, per the orchestrator's
 *   discretion call (Assumptions Log A1) over the `es_LA` alternative.
 * - `pt` has NO official Super Smash Bros. Ultimate Portuguese localization
 *   (per Assumptions Log A2), so every one of its 86 entries is the
 *   canonical English name — an intentional fallback, not a missing
 *   translation. `localizedFighterName` below reaches the same English
 *   value for pt through its own `fighterNames.<id>` key (not through the
 *   `defaultValue` fallback), since pt.json's values are English by design.
 */

/**
 * Resolves a fighter's display name in the active locale. Falls back to the
 * canonical English `SpriteList` name (via i18next's `defaultValue`) if the
 * id is missing from the active bundle, and to '' if the id is unknown
 * entirely.
 *
 * Pure `(id, t)` function — NOT a hook — so it can be called from `.map()`
 * callbacks, react-table `accessorFn` closures, and other places where React
 * hooks are illegal. Components in render position should prefer
 * `useFighterName`/`useFighterNameResolver` from `@/hooks/useFighterName`,
 * which wrap this with a live `t` bound to the active language.
 */
export function localizedFighterName(id: number, t: TFunction): string {
  return t(`fighterNames.${id}`, { defaultValue: getFighterById(id)?.name ?? '' });
}

/**
 * Strips combining diacritical marks via Unicode NFD decomposition, e.g.
 * `foldDiacritics('Héroe') === 'Heroe'`. Idempotent (folding an already-folded
 * string is a no-op) and safe to call before or after `.toLowerCase()`.
 */
export function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * True when the (diacritics-folded, lower-cased) query is a prefix of EITHER
 * the localized name or the English name — so search matches localized
 * names (e.g. fr 'rond' -> Rondoudou) as well as English ones (e.g. fr
 * 'jigg' -> Jigglypuff, the same fighter). An empty query matches everything.
 */
export function matchesFighterQuery(
  query: string,
  localizedName: string,
  englishName: string,
): boolean {
  const foldedQuery = foldDiacritics(query).toLowerCase();
  if (foldedQuery === '') return true;
  const foldedLocalized = foldDiacritics(localizedName).toLowerCase();
  const foldedEnglish = foldDiacritics(englishName).toLowerCase();
  return foldedLocalized.startsWith(foldedQuery) || foldedEnglish.startsWith(foldedQuery);
}
