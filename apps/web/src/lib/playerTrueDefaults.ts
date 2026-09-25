import type { Match } from '@smash-tracker/shared';

/**
 * Phase 35 (Player-True Defaults & Persistence): per-fighter (or
 * per-opponent) usage summary — games played and the most recent game's
 * timestamp — computed over a subject's ALL-TIME match history. Ranks the
 * "most-used fighter" (DFLT-01) and "most-faced opponent" (DFLT-03)
 * candidates; `mostRecentMs` breaks a tied game count (D-02/D-09).
 */
export interface FighterUsage {
  id: number;
  games: number;
  mostRecentMs: number;
}

/**
 * Accumulates `matches` into a per-`keyOf(match)` usage summary and returns
 * it sorted by games played descending, then most-recent game descending,
 * then `String(id)` ascending. The final `String(id)` tiebreak is
 * DELIBERATE — the phase's locked edge resolution for DFLT-01 adjacency is a
 * fully deterministic total order, not a numeric sort (do not "simplify"
 * this to `a.id - b.id`).
 *
 * A non-array `matches` returns an empty ranking rather than throwing or
 * inferring anything — an unloaded `Match[]` is "not yet known," never
 * "known to be empty" (D-16). Every call site in this phase already gates
 * on `isLoading` before calling this, so this guard is defence-in-depth for
 * future dependency-light reuse (e.g. Phase 36's evidence engine), not the
 * mechanism that closes production-gap item 8 itself — see
 * `usePersistedSelection.ts`'s loading gate and `persistSelection`'s
 * user-triggered-only write path for that.
 */
function rankByUsage(matches: Match[], keyOf: (match: Match) => number): FighterUsage[] {
  if (!Array.isArray(matches)) {
    return [];
  }
  const byId = new Map<number, FighterUsage>();
  for (const match of matches) {
    const id = keyOf(match);
    const entry = byId.get(id) ?? { id, games: 0, mostRecentMs: 0 };
    entry.games += 1;
    entry.mostRecentMs = Math.max(entry.mostRecentMs, match.time);
    byId.set(id, entry);
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.games - a.games ||
      b.mostRecentMs - a.mostRecentMs ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/** D-01/D-02: ranks fighters by games played (all-time), most-recent game breaking ties. */
export function rankFighterUsage(allMatches: Match[]): FighterUsage[] {
  return rankByUsage(allMatches, (match) => match.fighter_id);
}

/** D-09: ranks the opponents `fighterId` has faced (all-time), most-recent game breaking ties. */
export function rankOpponentUsage(allMatches: Match[], fighterId: number): FighterUsage[] {
  const forFighter = Array.isArray(allMatches)
    ? allMatches.filter((match) => match.fighter_id === fighterId)
    : [];
  return rankByUsage(forFighter, (match) => match.opponent_id);
}

/** D-01/D-02: the single most-used fighter id, or `undefined` when nothing has been played. */
export function computeMostUsedFighterId(allMatches: Match[]): number | undefined {
  return rankFighterUsage(allMatches)[0]?.id;
}

/**
 * D-09: the single most-faced opponent id for `fighterId`, or `undefined`
 * when that fighter has no matches.
 */
export function computeMostFacedOpponentId(
  allMatches: Match[],
  fighterId: number,
): number | undefined {
  return rankOpponentUsage(allMatches, fighterId)[0]?.id;
}

/**
 * D-13: returns a NEW array of `fighters` ordered by the SAME comparator
 * `rankByUsage` uses — games played descending, then most-recent game
 * descending, then `String(id)` ascending — so the picker's first row is
 * always `computeMostUsedFighterId`'s result. A fighter with zero matches
 * is treated as `{ games: 0, mostRecentMs: 0 }`, which sorts it after every
 * played fighter and orders unplayed fighters among themselves by
 * `String(id)` (the same deterministic tiebreak, never a first-seen or
 * roster-order fallback).
 */
export function orderFightersByUsage<T extends { id: number }>(
  fighters: T[],
  allMatches: Match[],
): T[] {
  const usageById = new Map(rankFighterUsage(allMatches).map((usage) => [usage.id, usage]));
  return [...fighters].sort((a, b) => {
    const usageA = usageById.get(a.id) ?? { games: 0, mostRecentMs: 0 };
    const usageB = usageById.get(b.id) ?? { games: 0, mostRecentMs: 0 };
    return (
      usageB.games - usageA.games ||
      usageB.mostRecentMs - usageA.mostRecentMs ||
      String(a.id).localeCompare(String(b.id))
    );
  });
}
