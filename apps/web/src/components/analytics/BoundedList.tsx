import type { ReactNode } from 'react';

export const LIST_CAP = 8;
export const LIST_CAP_RAIL = 5;
export const LIST_INLINE_MAX = 25;
export const LIST_PASS_MAX = 100;
export const LIST_PASS_STEP = 50;

export type BoundedListMode = 'default' | 'full-page';

export interface BoundedListLabels {
  showAll: string;
  showFewer: string;
  showMore: string;
  terminus: string;
}

export interface BoundedListProps {
  rows: ReactNode[];
  cap: number;
  mode?: BoundedListMode;
  totalCount?: number;
  labels: BoundedListLabels;
  empty: ReactNode;
  onTerminus?: () => void;
  terminusHref?: string;
}

/** RED-phase stub (TDD Task 3) — replaced by the real implementation in the GREEN commit. */
export function BoundedList(_props: BoundedListProps) {
  return null;
}
