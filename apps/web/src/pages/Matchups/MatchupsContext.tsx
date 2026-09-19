import { createContext, useContext } from 'react';
import type { Fighter } from '@smash-tracker/shared';
import type { FighterUsage } from '@/lib/playerTrueDefaults';
import type { DrillDownAxes } from '@/lib/drillDownParams';

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
 *
 * Phase 38-04 (D-05/D-07/DRL-02): `fighter`/`opponent` below are now the
 * EFFECTIVE pairing (`URL axis ?? persisted selection`, composed once in
 * `MatchupsPage`) rather than the raw persisted value — every consumer of
 * this context (the pickers, the matrix, the chart, the advisor) sees the
 * same pairing the URL claims. `setFighter`/`setOpponent` still point at the
 * EXPLICIT picker handlers, which persist the selection AND write the URL
 * (Phase 35 D-06, preserved). The retired in-page `selectedMatchIds` field —
 * this doc comment's own prior revision reserved exactly this replacement —
 * is gone; `drillDownAxes`/`setDrillDown` below are its URL-addressable
 * successor, scoped to the FILTER axes (stage/event/window) only, since the
 * character axes already live on `fighter`/`opponent`.
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
  /** The FILTER drill-down axes (stage/event/window) currently active in the URL — never the character axes, which live on `fighter`/`opponent` above. */
  drillDownAxes: Pick<DrillDownAxes, 'stageId' | 'eventKey' | 'from' | 'to'>;
  /**
   * Writes filter axes (stage/event/window) to the URL, REPLACING whichever
   * of those three axes were previously active (an omitted axis is
   * cleared, not left as-is) — never touches the character axes or any
   * unrelated search param. `CounterpickAdvisor`'s stage-row click and
   * `MatchupChart`'s trend-point click both call this.
   */
  setDrillDown: (
    axes: Partial<Pick<DrillDownAxes, 'stageId' | 'eventKey' | 'from' | 'to'>>,
  ) => void;
}

export const MatchupsContext = createContext<MatchupsContextValue | undefined>(undefined);

export function useMatchupsContext(): MatchupsContextValue {
  const context = useContext(MatchupsContext);
  if (!context) {
    throw new Error('useMatchupsContext must be used within a MatchupsContext.Provider');
  }
  return context;
}
