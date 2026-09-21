import type { HorizonKey, Match } from '@smash-tracker/shared';

export interface FighterInsightRailProps {
  fighterId: number;
  fighterMatches: Match[];
  horizon: HorizonKey;
}

/** RED-phase stub — replaced by the real implementation in the GREEN commit. */
export function FighterInsightRail(_props: FighterInsightRailProps) {
  return null;
}
