import type { ReactNode } from 'react';

export type CardSkeletonVariant = 'stat-row' | 'chart' | 'list' | 'insight';

export interface CardSkeletonProps {
  variant: CardSkeletonVariant;
  rows?: number;
  statusLabel: string;
}

/** RED-phase stub (TDD Task 3) — replaced by the real implementation in the GREEN commit. */
export function CardSkeleton(_props: CardSkeletonProps) {
  return null;
}

export function PageSkeleton({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
