import type { ReactNode } from 'react';

export interface InsightRailCard {
  id: string;
  render: (helpers: { onDismiss: () => void }) => ReactNode;
}

export interface InsightRailShape {
  cards: InsightRailCard[];
  unlocksNext: InsightRailCard | null;
  lines: ReactNode[];
  promotionQueue: InsightRailCard[];
}

export interface InsightRailLabels {
  dismissedCount: (count: number) => string;
  allDismissed: string;
  restore: string;
}

export interface InsightRailProps {
  rail: InsightRailShape;
  header: string;
  legend: ReactNode;
  labels: InsightRailLabels;
  dismissedIds: string[];
  onDismiss: (id: string) => void;
  onRestore: () => void;
  fallbackCard: ReactNode;
  cap?: number;
}

// RED stub (#3770): types compile so the named target test fails on a real
// assertion, not a module-resolution error. GREEN implements this next.
export function InsightRail(props: InsightRailProps) {
  void props;
  return null;
}
