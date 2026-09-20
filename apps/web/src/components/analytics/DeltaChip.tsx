export type DeltaChipState = 'up' | 'down' | 'steady' | 'thin' | 'none' | 'collapsed';

export interface DeltaChipProps {
  state: DeltaChipState;
  valueLabel: string;
  horizonLabel?: string;
  ariaLabel: string;
  horizonOwnedByParent?: boolean;
}

/** RED-phase stub (TDD Task 2) — replaced by the real implementation in the GREEN commit. */
export function DeltaChip(_props: DeltaChipProps) {
  return null;
}
