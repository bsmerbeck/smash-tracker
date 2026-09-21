import type { Match } from '@smash-tracker/shared';

export interface VsPlayersListProps {
  fighterId: number;
  fighterMatches: Match[];
  aliasMap: Record<string, string>;
}

/** RED-phase stub — replaced by the real implementation in the GREEN commit. */
export function VsPlayersList(_props: VsPlayersListProps) {
  return null;
}
