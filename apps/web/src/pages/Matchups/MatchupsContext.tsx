import { createContext, useContext } from 'react';
import type { Fighter } from '@smash-tracker/shared';

/**
 * Replaces legacy's `MatchupsContext` (Matchups.js). Holds the two picker
 * selections this screen shares across its widgets: "your fighter" (drawn
 * from the user's primary+secondary selections, like Dashboard) and
 * "opponent fighter" (any of the 85 fighters — legacy's SelectOpponent
 * showed the full SpriteList, not just fighters the user has faced).
 */
export interface MatchupsContextValue {
  /** All fighters available to select from as "you": primary + secondary selections combined, in that order. */
  fighterSprites: Fighter[];
  fighter: Fighter | undefined;
  setFighter: (fighter: Fighter) => void;
  opponent: Fighter | undefined;
  setOpponent: (fighter: Fighter) => void;
}

export const MatchupsContext = createContext<MatchupsContextValue | undefined>(undefined);

export function useMatchupsContext(): MatchupsContextValue {
  const context = useContext(MatchupsContext);
  if (!context) {
    throw new Error('useMatchupsContext must be used within a MatchupsContext.Provider');
  }
  return context;
}
