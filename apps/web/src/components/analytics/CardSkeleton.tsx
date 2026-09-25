import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type CardSkeletonVariant = 'stat-row' | 'chart' | 'list' | 'insight';

export interface CardSkeletonProps {
  variant: CardSkeletonVariant;
  /** Number of pairs (`stat-row`) or rows (`list`) — ignored by `chart`/`insight`. */
  rows?: number;
  /** Visually hidden label for the `role="status"` wrapper — reuses the page's existing `…loading` key, never a new one. */
  statusLabel: string;
}

const BLOCK_CLASS = 'rounded-md bg-muted/40 motion-reduce:animate-none animate-pulse';

function Block({ className }: { className: string }) {
  return (
    <div data-slot="skeleton-block" aria-hidden="true" className={cn(BLOCK_CLASS, className)} />
  );
}

function variantBlocks(variant: CardSkeletonVariant, rows: number): ReactNode {
  switch (variant) {
    case 'stat-row':
      return (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Block className="h-3 w-16" />
              <Block className="h-6 w-12" />
            </div>
          ))}
        </div>
      );
    case 'chart':
      return (
        <div className="flex flex-col gap-4">
          <Block className="h-4 w-32" />
          <Block className="h-[288px] w-full" />
        </div>
      );
    case 'list':
      return (
        <div className="flex flex-col gap-3">
          <Block className="h-4 w-32" />
          {Array.from({ length: rows }, (_, i) => (
            <Block key={i} className="h-10 w-full" />
          ))}
        </div>
      );
    case 'insight':
      return (
        <div className="flex flex-col gap-3">
          <Block className="h-5 w-20 rounded-full" />
          <Block className="h-4 w-full" />
          <Block className="h-4 w-3/4" />
          <Block className="h-8 w-24" />
        </div>
      );
  }
}

/**
 * The one loading pattern (UIX-07, DD-16): a plain `Card` (compact) holding
 * content-shaped pulsing blocks. No shadcn `Skeleton` — this IS the
 * primitive, not a wrapper over the registry component.
 */
export function CardSkeleton({ variant, rows = 3, statusLabel }: CardSkeletonProps) {
  return (
    <Card role="status" aria-busy="true" className="gap-4 p-5 shadow-none">
      <span className="sr-only">{statusLabel}</span>
      {variantBlocks(variant, rows)}
    </Card>
  );
}

/**
 * A thin wrapper composing hosts use from the SAME `PageGrid` spans as the
 * loaded page, so nothing shifts when data lands.
 */
export function PageSkeleton({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
