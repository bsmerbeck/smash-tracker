import { createContext, useContext } from 'react';
import type { Fighter } from '@smash-tracker/shared';

/**
 * Replaces legacy's `DashboardContext` (a plain `React.createContext({})`
 * exported from Dashboard.js and consumed by its child components). Holds
 * only the "which of my fighters is selected right now" state that widgets
 * on this screen share — everything else (matches, opponents) comes from
 * TanStack Query hooks called directly by each widget.
 */
export interface DashboardContextValue {
  /** All fighters available to select from: the user's primary + secondary selections combined, in that order (matches legacy). */
  fighterSprites: Fighter[];
  /** The currently selected fighter, or undefined if the user has no fighters selected yet. */
  fighter: Fighter | undefined;
  setFighter: (fighter: Fighter) => void;
}

export const DashboardContext = createContext<DashboardContextValue | undefined>(undefined);

export function useDashboardContext(): DashboardContextValue {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboardContext must be used within a DashboardContext.Provider');
  }
  return context;
}
