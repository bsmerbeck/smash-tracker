import type { HorizonKey, Match } from '@smash-tracker/shared';

/** RED-phase stub (plan 39.1-13, tdd="true") — replaced by the real implementation in the GREEN commit. */
export function MatchupOrPlayerCard({
  matchupMatches: _matchupMatches,
  horizon: _horizon,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
}) {
  return null;
}
