/**
 * V9-B Feature 3: a static, deterministic Super Smash Bros. Ultimate meta
 * dataset — ZERO added AI/API cost. Used by `matchupAdvisor.ts` to blend the
 * user's own head-to-head record against tier placement + archetype counters
 * when recommending which of the user's characters to reach for against a
 * given opponent character.
 *
 * TIER SOURCE: adapted from the tier list published at
 * https://beatcopgame.com/smash-ultimate-tier-list/ (captured 2026-07-06),
 * itself derived from the UltRank 2026 community rankings
 * (https://www.ssbwiki.com/UltRank_2026, 4th list, released 2026-05-06).
 * Tier placements are inherently approximate/subjective community consensus,
 * not a precise measurement — encoded honestly as a coarse 0-10 scale (S+ ~
 * 10 down to D ~ 1) rather than false per-character precision. `SpriteList`
 * groups a few in-game "echo"/multi-character entries the tier list treats
 * as one line already (e.g. Peach/Daisy, Simon/Richter, Ryu/Ken, Pyra/Mythra)
 * — those share a tier score here, matching how this roster models them as
 * one fighter id. `Pokemon Trainer` (id 38) is scored as the trainer's
 * overall placement (its three Pokemon aren't separate roster entries in
 * `SpriteList`).
 *
 * This is a ONE-FILE edit point: updating for a future tier list means
 * editing `TIER_SCORE_BY_FIGHTER_ID` below (and the source-of-truth comment
 * above) — no other module needs to change.
 */

/** A small, deliberately coarse set of playstyle archetypes. A fighter may have more than one. */
export type Archetype =
  'zoner' | 'rushdown' | 'swordfighter' | 'grappler' | 'heavy' | 'trapper' | 'allRounder';

export interface FighterMeta {
  fighterId: number;
  /** 0 (bottom of the list) - 10 (top of the list), see module doc for source. */
  tierScore: number;
  archetypes: Archetype[];
}

/**
 * Tier score by `SpriteList` fighter id. Derived from the July 2026
 * beatcopgame.com list (see module doc): S+ = 10, S = 8.7, A+ = 7.5, A = 6.5,
 * A- = 5.7, B+ = 5, B = 4.2, B- = 3.5, C+ = 2.8, C = 2, D+ = 1.2, D = 0.5 —
 * evenly spaced buckets standing in for the list's own tier bands, not a
 * claim of finer precision than the source supports.
 */
const S_PLUS = 10;
const S = 8.7;
const A_PLUS = 7.5;
const A = 6.5;
const A_MINUS = 5.7;
const B_PLUS = 5;
const B = 4.2;
const B_MINUS = 3.5;
const C_PLUS = 2.8;
const C = 2;
const D_PLUS = 1.2;
const D = 0.5;

const TIER_SCORE_BY_FIGHTER_ID: Readonly<Record<number, number>> = {
  1: A_MINUS, // Mario
  2: C, // Donkey Kong
  3: C_PLUS, // Link
  4: C, // Samus
  5: C_PLUS, // Dark Samus
  6: S, // Yoshi
  7: C, // Kirby
  8: S, // Fox
  9: S, // Pikachu
  10: A_MINUS, // Luigi
  11: A_MINUS, // Ness
  12: A_MINUS, // Captain Falcon
  13: C, // Jigglypuff
  14: S, // Peach
  15: S, // Daisy (shares Peach's tier line)
  16: B_PLUS, // Bowser
  17: B, // Ice Climbers (unlisted on source; placed at B, mid-pack grapple/pair archetype)
  18: A, // Sheik
  19: B, // Zelda
  20: A_MINUS, // Dr. Mario (shares Mario's tier line)
  21: B_PLUS, // Pichu
  22: A_MINUS, // Falco
  23: A, // Marth
  24: A_PLUS, // Lucina
  25: C_PLUS, // Young Link
  26: D_PLUS, // Ganondorf
  27: B, // Mewtwo
  28: A, // Roy
  29: B_PLUS, // Chrom (shares Roy's swordfighter family, one band below Roy per source split)
  30: S_PLUS, // Mr. Game & Watch
  31: C, // Meta Knight
  32: B, // Pit (Palutena family placement, unlisted directly)
  33: B, // Dark Pit
  34: A, // Zero Suit Samus
  35: A_PLUS, // Wario
  36: S_PLUS, // Snake
  37: B_PLUS, // Ike
  38: B, // Pokemon Trainer
  39: S, // Diddy Kong
  40: B, // Lucas
  41: S, // Sonic
  42: B, // King Dedede
  43: A_PLUS, // Olimar
  44: A_MINUS, // Lucario
  45: S, // R.O.B.
  46: A_MINUS, // Toon Link
  47: A_PLUS, // Wolf
  48: B, // Villager
  49: A, // Mega Man
  50: A_MINUS, // Wii Fit Trainer
  51: C_PLUS, // Rosalina & Luma
  52: D_PLUS, // Little Mac
  53: A, // Greninja
  54: B_PLUS, // Mii Brawler
  55: B, // Mii Swordfighter
  56: B, // Mii Gunner
  57: A_PLUS, // Palutena
  58: A, // Pac-Man
  59: B, // Robin
  60: A, // Shulk
  61: B_MINUS, // Bowser Jr.
  62: B_MINUS, // Duck Hunt
  63: A, // Ryu
  64: A, // Ken (shares Ryu's tier line)
  65: A_PLUS, // Cloud
  66: B_MINUS, // Corrin
  67: C, // Bayonetta
  68: A, // Inkling
  69: B_PLUS, // Ridley
  70: C_PLUS, // Simon
  71: C_PLUS, // Richter (shares Simon's tier line)
  72: C, // King K. Rool
  73: B, // Isabelle
  74: D_PLUS, // Incineroar
  75: D, // Piranha Plant
  76: S, // Joker
  77: B_PLUS, // Hero
  78: B, // Banjo & Kazooie
  79: B, // Terry
  80: B, // Byleth (unlisted directly, placed with the mid-pack swordfighter cluster)
  81: S_PLUS, // Min Min
  82: S_PLUS, // Steve
  83: B_PLUS, // Sephiroth
  84: S, // Pyra/Mythra
  85: S, // Kazuya
};

/**
 * Archetypes by fighter id. Kept intentionally coarse — most fighters get
 * one or two tags reflecting their dominant, widely-agreed-upon playstyle,
 * not an exhaustive character study.
 */
const ARCHETYPES_BY_FIGHTER_ID: Readonly<Record<number, Archetype[]>> = {
  1: ['allRounder'], // Mario
  2: ['heavy', 'grappler'], // Donkey Kong
  3: ['zoner', 'trapper'], // Link
  4: ['zoner'], // Samus
  5: ['zoner'], // Dark Samus
  6: ['rushdown', 'allRounder'], // Yoshi
  7: ['rushdown'], // Kirby
  8: ['rushdown'], // Fox
  9: ['rushdown'], // Pikachu
  10: ['rushdown', 'grappler'], // Luigi
  11: ['trapper'], // Ness
  12: ['rushdown'], // Captain Falcon
  13: ['rushdown'], // Jigglypuff
  14: ['zoner', 'allRounder'], // Peach
  15: ['zoner', 'allRounder'], // Daisy
  16: ['heavy', 'grappler'], // Bowser
  17: ['grappler', 'trapper'], // Ice Climbers
  18: ['rushdown', 'zoner'], // Sheik
  19: ['zoner', 'trapper'], // Zelda
  20: ['allRounder'], // Dr. Mario
  21: ['rushdown'], // Pichu
  22: ['rushdown'], // Falco
  23: ['swordfighter'], // Marth
  24: ['swordfighter'], // Lucina
  25: ['zoner', 'rushdown'], // Young Link
  26: ['heavy'], // Ganondorf
  27: ['zoner'], // Mewtwo
  28: ['swordfighter'], // Roy
  29: ['swordfighter'], // Chrom
  30: ['trapper', 'zoner'], // Mr. Game & Watch
  31: ['rushdown', 'swordfighter'], // Meta Knight
  32: ['swordfighter', 'zoner'], // Pit
  33: ['swordfighter', 'zoner'], // Dark Pit
  34: ['rushdown', 'zoner'], // Zero Suit Samus
  35: ['allRounder', 'rushdown'], // Wario
  36: ['zoner', 'trapper'], // Snake
  37: ['swordfighter', 'heavy'], // Ike
  38: ['zoner', 'allRounder'], // Pokemon Trainer
  39: ['rushdown'], // Diddy Kong
  40: ['trapper'], // Lucas
  41: ['rushdown'], // Sonic
  42: ['heavy', 'grappler'], // King Dedede
  43: ['zoner', 'trapper'], // Olimar
  44: ['allRounder'], // Lucario
  45: ['zoner', 'allRounder'], // R.O.B.
  46: ['zoner', 'rushdown'], // Toon Link
  47: ['zoner', 'allRounder'], // Wolf
  48: ['trapper', 'zoner'], // Villager
  49: ['zoner', 'trapper'], // Mega Man
  50: ['allRounder', 'trapper'], // Wii Fit Trainer
  51: ['zoner', 'trapper'], // Rosalina & Luma
  52: ['rushdown', 'grappler'], // Little Mac
  53: ['rushdown'], // Greninja
  54: ['allRounder'], // Mii Brawler
  55: ['swordfighter'], // Mii Swordfighter
  56: ['zoner'], // Mii Gunner
  57: ['zoner', 'allRounder'], // Palutena
  58: ['zoner', 'trapper'], // Pac-Man
  59: ['zoner', 'trapper'], // Robin
  60: ['swordfighter', 'allRounder'], // Shulk
  61: ['trapper', 'heavy'], // Bowser Jr.
  62: ['zoner', 'trapper'], // Duck Hunt
  63: ['rushdown', 'allRounder'], // Ryu
  64: ['rushdown', 'allRounder'], // Ken
  65: ['swordfighter', 'allRounder'], // Cloud
  66: ['grappler', 'swordfighter'], // Corrin
  67: ['rushdown'], // Bayonetta
  68: ['zoner', 'trapper'], // Inkling
  69: ['heavy', 'grappler'], // Ridley
  70: ['zoner', 'trapper'], // Simon
  71: ['zoner', 'trapper'], // Richter
  72: ['heavy', 'grappler'], // King K. Rool
  73: ['trapper'], // Isabelle
  74: ['heavy', 'grappler'], // Incineroar
  75: ['trapper', 'zoner'], // Piranha Plant
  76: ['zoner', 'trapper'], // Joker
  77: ['zoner', 'trapper'], // Hero
  78: ['zoner', 'trapper'], // Banjo & Kazooie
  79: ['zoner', 'rushdown'], // Terry
  80: ['swordfighter', 'allRounder'], // Byleth
  81: ['zoner'], // Min Min
  82: ['zoner', 'trapper'], // Steve
  83: ['swordfighter'], // Sephiroth
  84: ['swordfighter', 'zoner'], // Pyra/Mythra
  85: ['rushdown', 'grappler'], // Kazuya
};

const DEFAULT_TIER_SCORE = B; // Mid-pack fallback for any fighter id not explicitly listed above.
const DEFAULT_ARCHETYPES: Archetype[] = ['allRounder'];

/** Looks up meta (tier score + archetypes) for a fighter id, degrading gracefully for unknown ids. */
export function getFighterMeta(fighterId: number): FighterMeta {
  return {
    fighterId,
    tierScore: TIER_SCORE_BY_FIGHTER_ID[fighterId] ?? DEFAULT_TIER_SCORE,
    archetypes: ARCHETYPES_BY_FIGHTER_ID[fighterId] ?? DEFAULT_ARCHETYPES,
  };
}

/**
 * Archetype-vs-archetype counter matrix: `COUNTER_MATRIX[a][b]` is how well
 * archetype `a` fares against archetype `b` — `1` favors `a`, `-1` favors
 * `b`, `0` is roughly even. Deliberately coarse rationale, encoded once:
 *
 * - zoner beats rushdown (space control punishes approach) and grappler
 *   (grapplers must close distance through zoning tools), loses to trapper
 *   (traps neutralize projectile-based space control) and swordfighter
 *   (disjointed range matches/beats zoning tools).
 * - rushdown beats trapper (constant pressure denies setup time) and heavy
 *   (speed exploits poor mobility), loses to zoner and grappler (grabs
 *   punish committed approaches).
 * - swordfighter beats zoner (superior disjoint range) and heavy (range keeps
 *   heavies out), loses to grappler (once inside disjoint range, grabs
 *   bypass a sword) and rushdown is even (mirror of spacing vs. speed).
 * - grappler beats rushdown (punishes approach with a single grab) and
 *   swordfighter (closes the disjoint-range gap), loses to zoner (can't
 *   close distance) and trapper (traps punish the grappler's approach).
 * - heavy beats grappler (weight/disjoint hitboxes blunt combo-grab
 *   pressure) even with trapper (both are patient, positional styles),
 *   loses to rushdown and swordfighter (range/speed exploit poor mobility).
 * - trapper beats zoner (traps outlast projectiles) and rushdown (setups
 *   punish predictable approaches), loses to swordfighter (range invalidates
 *   traps before they matter) and grappler (a single read closes the gap).
 * - allRounder is even against everything — no single tool defines the
 *   matchup enough to call a clean edge either way.
 */
const COUNTER_MATRIX: Readonly<Record<Archetype, Readonly<Record<Archetype, number>>>> = {
  zoner: {
    zoner: 0,
    rushdown: 1,
    swordfighter: -1,
    grappler: 1,
    heavy: 0,
    trapper: -1,
    allRounder: 0,
  },
  rushdown: {
    zoner: -1,
    rushdown: 0,
    swordfighter: 0,
    grappler: -1,
    heavy: 1,
    trapper: 1,
    allRounder: 0,
  },
  swordfighter: {
    zoner: 1,
    rushdown: 0,
    swordfighter: 0,
    grappler: -1,
    heavy: 1,
    trapper: 1,
    allRounder: 0,
  },
  grappler: {
    zoner: -1,
    rushdown: 1,
    swordfighter: 1,
    grappler: 0,
    heavy: -1,
    trapper: -1,
    allRounder: 0,
  },
  heavy: {
    zoner: 0,
    rushdown: -1,
    swordfighter: -1,
    grappler: 1,
    heavy: 0,
    trapper: 0,
    allRounder: 0,
  },
  trapper: {
    zoner: 1,
    rushdown: -1,
    swordfighter: -1,
    grappler: 1,
    heavy: 0,
    trapper: 0,
    allRounder: 0,
  },
  allRounder: {
    zoner: 0,
    rushdown: 0,
    swordfighter: 0,
    grappler: 0,
    heavy: 0,
    trapper: 0,
    allRounder: 0,
  },
};

/**
 * Best archetype-vs-archetype edge for `mine` against `theirs` — when a
 * fighter has multiple archetypes, takes the most favorable pairing (a
 * multi-archetype fighter can lean on whichever tool applies best in a given
 * matchup). Returns a value in [-1, 1].
 */
export function archetypeEdge(mine: Archetype[], theirs: Archetype[]): number {
  let best = 0;
  let bestAbs = -1;
  for (const a of mine) {
    for (const b of theirs) {
      const value = COUNTER_MATRIX[a][b];
      if (Math.abs(value) > bestAbs) {
        bestAbs = Math.abs(value);
        best = value;
      }
    }
  }
  return best;
}
