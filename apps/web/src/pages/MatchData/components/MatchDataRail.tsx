import type { HorizonKey, Match } from '@smash-tracker/shared';

export interface MatchDataRailProps {
  matches: Match[];
  horizon: HorizonKey;
}

/** RED-phase stub (T-39.1-16, Task 3) — replaced by the real implementation in the GREEN commit. */
export function MatchDataRail(_props: MatchDataRailProps) {
  return null;
}
