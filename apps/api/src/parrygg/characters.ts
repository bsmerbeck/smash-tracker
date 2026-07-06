import { SpriteList, type Fighter } from '@smash-tracker/shared';

/**
 * parry.gg identifies SSBU characters by a `character_slug` string (e.g.
 * "captain-falcon"), never a numeric id — unlike start.gg, which has a
 * stable per-character database id (see ../startgg/characterMap.ts). There
 * is no bulk "list all characters with slugs" probe result to build an
 * exhaustive table from (parry.gg is young; real SSBU match data hasn't
 * been observed with populated `matchGamesList` yet — see sync.ts), so this
 * resolves slugs the same way stageMap.ts resolves stage names: normalize
 * both sides (strip dashes/punctuation, lowercase) and match against the
 * app's fighter roster, with a curated overrides table for the handful of
 * fighters whose slug can't be expected to normalize onto their display
 * name automatically.
 */
function normalizeSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const fightersByNormalizedSlug = new Map<string, Fighter>();
for (const fighter of SpriteList) {
  const key = normalizeSlug(fighter.name);
  if (!fightersByNormalizedSlug.has(key)) {
    fightersByNormalizedSlug.set(key, fighter);
  }
}

/**
 * Explicit slug overrides for fighters whose likely parry.gg slug does NOT
 * normalize onto their `SpriteList` display name directly (mirrors the
 * manual aliases start.gg's characterMap.ts needed for the same handful of
 * awkward names — see its "Rosalina" -> "Rosalina & Luma", "Simon Belmont"
 * -> "Simon" comments). Everything else — including most multi-word or
 * punctuated names like "Captain Falcon", "R.O.B.", or "Mr. Game & Watch" —
 * normalizes onto its `SpriteList` name just fine via `normalizeSlug` and
 * needs no entry here; only genuine mismatches are listed: echo fighters
 * likely keyed by their own name rather than the base character's, combined
 * multi-character names likely split into their own slugs, and one
 * ampersand-dropping abbreviation. Keys are pre-normalized (lowercase, no
 * punctuation) so they match however `normalizeSlug` transforms the
 * incoming slug, regardless of whether parry.gg uses hyphens, underscores,
 * or spaces.
 */
const SLUG_OVERRIDES: Readonly<Record<string, number>> = {
  rosalina: 51, // parry.gg likely uses "rosalina" alone -> Rosalina & Luma
  rosalinaandluma: 51, // "and" spelled out instead of "&" (see mrgameandwatch below)
  simonbelmont: 70, // parry.gg likely uses "simon-belmont" -> Simon
  pyra: 84, // either half of the combined fighter -> Pyra/Mythra
  mythra: 84,
  banjokazooie: 78, // parry.gg likely omits the "&" -> Banjo & Kazooie
  banjoandkazooie: 78, // "and" spelled out instead of "&"
  gameandwatch: 30, // parry.gg likely omits "Mr." -> Mr. Game & Watch
  // "and" spelled out instead of "&" -- normalizeSlug strips "&" to nothing
  // ("Mr. Game & Watch" -> "mrgamewatch"), so any slug spelling out "and"
  // for one of this roster's three "&" fighters needs an explicit entry
  // (this app's own sprite asset filenames use exactly this "and" spelling
  // for all three, e.g. "26-mrgameandwatch-sprite.png" — see fighterData.ts).
  mrgameandwatch: 30,
  kingkoopa: 16, // alternate common name -> Bowser
};

/**
 * Resolves a parry.gg `character_slug` to this app's `SpriteList` fighter
 * id, or `undefined` when unmappable (unmapped slugs are skipped at import
 * and counted in the sync summary — same "unknown sentinel avoidance"
 * convention as start.gg's `startggCharacterToFighterId`, which simply
 * omits ids it can't place rather than importing a wrong pick).
 */
export function parryggCharacterSlugToFighterId(
  slug: string | null | undefined,
): number | undefined {
  if (!slug) {
    return undefined;
  }
  const key = normalizeSlug(slug);
  const override = SLUG_OVERRIDES[key];
  if (override !== undefined) {
    return override;
  }
  return fightersByNormalizedSlug.get(key)?.id;
}
