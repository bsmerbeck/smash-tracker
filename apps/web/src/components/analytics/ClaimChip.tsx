export type ClaimChipKind = 'fact' | 'trend' | 'suggestion';

export interface ClaimChipProps {
  kind: ClaimChipKind;
  locked?: boolean;
  label: string;
}

/** RED-phase stub (TDD Task 2) — replaced by the real implementation in the GREEN commit. */
export function ClaimChip(_props: ClaimChipProps) {
  return null;
}
