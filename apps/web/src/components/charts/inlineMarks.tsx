import type { ReactNode } from 'react';
import { CHART_TOKENS } from './tokens';

/**
 * RED-phase stub (39.1-08 Task 2, tdd="true"): a placeholder implementation
 * so the target tests fail on real assertions rather than a module-resolution
 * error. Replaced by the real implementation in the GREEN commit.
 */

export interface ShareBarSegment {
  key: string;
  label: ReactNode;
  count: number;
  record?: ReactNode;
  delta?: ReactNode;
  href?: string;
}

export interface ShareBarProps {
  segments: ShareBarSegment[];
  total: number;
  headerLabel: ReactNode;
  shareSuffix: (percent: number) => ReactNode;
  onSelectSegment?: (segment: ShareBarSegment) => void;
  emptyNode: ReactNode;
  ariaSummary: string;
  foldedLabel?: ReactNode;
}

export interface MiniStripGame {
  key: string;
  won: boolean;
}

// Referenced here only to keep this stub's import list identical to the
// GREEN implementation's for the boundary/consumption source scans.
void CHART_TOKENS;

export function RecordBar(_props: { wins: number; losses: number }): ReactNode {
  return null;
}

export function ShareBar(_props: ShareBarProps): ReactNode {
  return null;
}

export function MiniStrip(_props: { games: MiniStripGame[]; ariaLabel: string }): ReactNode {
  return null;
}
