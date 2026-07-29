import type { Match } from '@smash-tracker/shared';

/**
 * Phase 26 (PREP-02, D-17): the deterministic likely-opponent suggestion
 * ranking. `matches` MUST already be alias-resolved (via
 * `applyOpponentAliases`, the single choke point for opponent-name
 * canonicalization) and MUST be the all-time, all-source set from
 * `useMatches()` — never the Dashboard's globally-filtered match hook.
 * Sourcing this from that global source/time-range filter (RESEARCH
 * Pitfall 1) would let whatever filter state the user last left active on
 * an unrelated page silently shrink a prep brief's head-to-head history: a
 * player could see a zeroed record against someone they have actually
 * played a dozen times.
 */
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface LikelyOpponentSuggestion {
  opponent: string;
  /** Count of matches against this opponent within the trailing 90-day window (relative to `now`). */
  last90DayCount: number;
  /** Epoch ms of the most recent match against this opponent, all-time. */
  lastPlayedAt: number;
  /** All-time match count against this opponent — the add-picker's muted match-count hint. */
  totalCount: number;
}

/**
 * Deterministic order per D-17: `last90DayCount` DESC, then `lastPlayedAt`
 * (all-time, most recent) DESC, then canonical `opponent` name ASC. Every
 * level is broken deterministically — the comparator never returns 0 as its
 * final word, so the result is a total order for any given input.
 *
 * Pure: matches with no `opponent` value are ignored entirely; the input
 * array is never mutated; calling this twice with the same inputs returns
 * an equal result.
 */
export function rankLikelyOpponentSuggestions(
  matches: Match[],
  now = Date.now(),
): LikelyOpponentSuggestion[] {
  const cutoff = now - NINETY_DAYS_MS;
  const byOpponent = new Map<string, Match[]>();

  for (const match of matches) {
    if (!match.opponent) continue;
    const group = byOpponent.get(match.opponent);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(match.opponent, [match]);
    }
  }

  return [...byOpponent.entries()]
    .map(([opponent, opponentMatches]) => ({
      opponent,
      last90DayCount: opponentMatches.filter((m) => m.time >= cutoff).length,
      lastPlayedAt: Math.max(...opponentMatches.map((m) => m.time)),
      totalCount: opponentMatches.length,
    }))
    .sort(
      (a, b) =>
        b.last90DayCount - a.last90DayCount ||
        b.lastPlayedAt - a.lastPlayedAt ||
        a.opponent.localeCompare(b.opponent),
    );
}
