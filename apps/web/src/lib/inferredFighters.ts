import type { Match } from '@smash-tracker/shared';

/**
 * Phase 30.3 (Gate 4, fighter-preference fallback): the fighter ids OBSERVED
 * in a user's own match history (`match.fighter_id`), most-played first, for
 * accounts whose imported history exists but whose saved primary/secondary
 * favorites are empty. Match Data and Matchups feed this into the same
 * sprite pipeline saved favorites use, so imported demo histories render
 * instead of dead-ending on the "choose fighters" gate — choosing favorites
 * stays available as a non-blocking prompt, never a gate.
 *
 * Pure derivation from real rows only: an empty match list infers nothing
 * (no default fighter is ever fabricated).
 */
export function inferFighterIdsFromMatches(matches: Match[]): number[] {
  const counts = new Map<number, number>();
  for (const match of matches) {
    counts.set(match.fighter_id, (counts.get(match.fighter_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([fighterId]) => fighterId);
}
