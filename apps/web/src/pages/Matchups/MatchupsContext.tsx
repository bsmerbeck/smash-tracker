import { createContext, useContext } from 'react';
import type { Fighter } from '@smash-tracker/shared';
import type { FighterUsage } from '@/lib/playerTrueDefaults';

/**
 * Replaces legacy's `MatchupsContext` (Matchups.js). Holds the two picker
 * selections this screen shares across its widgets: "your fighter" (drawn
 * from the user's primary+secondary selections, like Dashboard) and
 * "opponent fighter" (any of the 85 fighters — legacy's SelectOpponent
 * showed the full SpriteList, not just fighters the user has faced).
 *
 * Phase 35 (D-13/D-14): `fighterSprites` arrives PRE-ORDERED by usage
 * (most-to-least games, most-recent tiebreak) via
 * `usePersistedSelection`'s `orderedFighterSprites` — never alphabetical,
 * and this context performs no ordering of its own. `fighterUsageById` and
 * `opponentUsage` carry the counts the pickers render alongside each row.
 */
export interface MatchupsContextValue {
  /** All fighters available to select from as "you": primary + secondary selections combined, usage-ordered (D-13). */
  fighterSprites: Fighter[];
  fighter: Fighter | undefined;
  setFighter: (fighter: Fighter) => void;
  opponent: Fighter | undefined;
  setOpponent: (fighter: Fighter) => void;
  /** Games played per fighter id, all-time — the fighter picker's trailing count (D-13). */
  fighterUsageById: Map<number, number>;
  /** The resolved fighter's faced opponents, most-faced first — the opponent picker's "Faced" group (D-14). */
  opponentUsage: FighterUsage[];
}

export const MatchupsContext = createContext<MatchupsContextValue | undefined>(undefined);

export function useMatchupsContext(): MatchupsContextValue {
  const context = useContext(MatchupsContext);
  if (!context) {
    throw new Error('useMatchupsContext must be used within a MatchupsContext.Provider');
  }
  return context;
}
