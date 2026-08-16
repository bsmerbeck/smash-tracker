import { SpriteList, spritesById } from './fighterData.js';

/**
 * Phase 30.3 Gate 5 (owner corrective directive — character/stock evidence):
 * the REVIEWED map from Liquipedia character strings to the app's OWN
 * fighter vocabulary (`fighterData.ts`'s `SpriteList` ids — the ids stored
 * in production `fighter_id`/`opponent_id` members).
 *
 * Liquipedia bracket templates record characters as short input codes
 * (`{{Chars|gw,2}}`, `char1=zss`), not display names — the committed bracket
 * fixtures contain codes like `gw`, `mm`, `palu`, `pam`, `zss`, `bayo`,
 * `diddy`, `oli`, `brawler` alongside full-word codes (`sonic`, `cloud`,
 * `steve`). This module therefore maps TWO vocabularies onto the fighter
 * ids: every canonical fighter NAME (normalized), and a hand-reviewed alias
 * table for the wiki's short codes.
 *
 * THE UNMAPPED RULE (directive, verbatim): an unmapped name stays RAW and
 * FLAGGED, never guessed. `resolveLiquipediaFighterId` returns `undefined`
 * for anything not in the reviewed map — no fuzzy matching, no prefix
 * matching, no "closest name" heuristics — because a wrong character on a
 * scouting surface is worse than an honest blank. Additions to the alias
 * table below must be individually reviewed against the Liquipedia smash
 * wiki's character input codes, exactly like `startgg/characterMap.ts`'s
 * id table on the provider side.
 *
 * Pure data + pure functions; no I/O. Load-time cross-checks (mirroring
 * `researchEnrichment.ts`'s vocabulary cross-check) make an alias that
 * names a nonexistent fighter id, or collides with a canonical name under
 * normalization, fail loudly at import time.
 */

/**
 * Normalizes a raw character string for lookup: Unicode-decomposes and
 * strips diacritics (`Pokémon` -> `pokemon`), lowercases, and drops every
 * non-alphanumeric character (`R.O.B.` -> `rob`, `Pyra/Mythra` ->
 * `pyramythra`, `Mr. Game & Watch` -> `mrgamewatch`). The SAME
 * normalization is applied to both the canonical fighter names and the
 * lookup input, so the two can never disagree about punctuation or case.
 */
export function normalizeLiquipediaCharacterName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The hand-reviewed alias table: Liquipedia character input codes and
 * common wiki spellings that do NOT normalize onto a canonical fighter
 * name. Keys are ALREADY normalized (the load-time check below enforces
 * it). Every entry carries the fighter it was reviewed to mean.
 */
export const LIQUIPEDIA_CHARACTER_ALIASES: Readonly<Record<string, number>> = {
  // --- codes observed in the committed bracket fixtures -------------------
  bayo: 67, // Bayonetta
  brawler: 54, // Mii Brawler
  diddy: 39, // Diddy Kong
  gw: 30, // Mr. Game & Watch
  mm: 49, // Mega Man (the wiki's long-standing `mm` code; Min Min is `minmin`)
  oli: 43, // Olimar
  palu: 57, // Palutena
  pam: 84, // Pyra/Mythra ("Pyra and Mythra")
  zss: 34, // Zero Suit Samus
  // --- reviewed wiki shorthand / alternate spellings ----------------------
  banjo: 78, // Banjo & Kazooie
  banjoandkazooie: 78,
  charizard: 38, // Pokemon Trainer form — the app's vocabulary has ONE id
  ddd: 42, // King Dedede
  dedede: 42,
  dk: 2, // Donkey Kong
  doc: 20, // Dr. Mario
  duckhuntduo: 62,
  falcon: 12, // Captain Falcon
  gameandwatch: 30,
  ganon: 26, // Ganondorf
  gnw: 30,
  gunner: 56, // Mii Gunner
  ics: 17, // Ice Climbers
  icies: 17,
  ivysaur: 38, // Pokemon Trainer form
  jiggs: 13, // Jigglypuff
  kkrool: 72, // King K. Rool
  krool: 72,
  metaknight: 31,
  mk: 31, // Meta Knight (smash-wiki convention)
  mrgameandwatch: 30,
  plant: 75, // Piranha Plant
  pt: 38, // Pokemon Trainer
  puff: 13,
  pyra: 84, // Pyra/Mythra — either half names the pair in the app's vocabulary
  mythra: 84,
  pyraandmythra: 84,
  aegis: 84,
  rosa: 51, // Rosalina & Luma
  rosalina: 51,
  rosalinaandluma: 51,
  squirtle: 38, // Pokemon Trainer form
  swordfighter: 55, // Mii Swordfighter
  tink: 46, // Toon Link
  wft: 50, // Wii Fit Trainer
  wiifit: 50,
};

function buildLookup(): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const fighter of SpriteList) {
    const key = normalizeLiquipediaCharacterName(fighter.name);
    if (!lookup.has(key)) {
      lookup.set(key, fighter.id);
    }
  }
  for (const [alias, fighterId] of Object.entries(LIQUIPEDIA_CHARACTER_ALIASES)) {
    if (alias !== normalizeLiquipediaCharacterName(alias)) {
      throw new Error(`LIQUIPEDIA_CHARACTER_ALIASES key "${alias}" is not normalized`);
    }
    if (!spritesById.has(fighterId)) {
      throw new Error(
        `LIQUIPEDIA_CHARACTER_ALIASES entry "${alias}" names fighter id ${fighterId}, which is not in SpriteList`,
      );
    }
    const existing = lookup.get(alias);
    if (existing !== undefined && existing !== fighterId) {
      throw new Error(
        `LIQUIPEDIA_CHARACTER_ALIASES entry "${alias}" collides with a canonical name mapping to fighter id ${existing}`,
      );
    }
    lookup.set(alias, fighterId);
  }
  return lookup;
}

/** The complete normalized-string -> fighter-id lookup (canonical names ∪ reviewed aliases). */
export const liquipediaCharacterToFighterId: ReadonlyMap<string, number> = buildLookup();

/**
 * Resolves a raw Liquipedia character string to a fighter id through the
 * reviewed map, or `undefined` when the string is absent, empty, or
 * unmapped — the caller keeps the raw string and flags it, never guesses.
 */
export function resolveLiquipediaFighterId(raw: string | null | undefined): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const normalized = normalizeLiquipediaCharacterName(raw);
  if (normalized.length === 0) {
    return undefined;
  }
  return liquipediaCharacterToFighterId.get(normalized);
}
