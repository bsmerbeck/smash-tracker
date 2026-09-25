import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PageGridProps {
  children?: ReactNode;
  className?: string;
}

/**
 * The 12-column grid primitive (UIX-01). `items-start` is hardcoded — there
 * is NO prop that disables top alignment, because a card stretched to a
 * sibling's height is exactly the defect this primitive exists to remove
 * (the fix for the owner's "garbage spacing" notes). Below `lg` (1024px)
 * every row collapses to a single column per UI-SPEC §6.6; a page composing
 * specific content classes (chart cell vs. rail row) applies its own
 * breakpoint overrides on top of this default via `GridCell`'s span classes.
 */
export function PageGrid({ children, className }: PageGridProps) {
  return (
    <div data-slot="page-grid" className={cn('grid grid-cols-12 items-start gap-4', className)}>
      {children}
    </div>
  );
}

/** The closed span set (UI-SPEC §6.1) — never an arbitrary number. */
export type GridCellSpan = 3 | 4 | 6 | 8 | 12;

/**
 * Literal lookup, never a template-interpolated class name (Tailwind's
 * static analysis cannot see `col-span-${span}`). Below `lg` every span
 * collapses to a full-width row (UI-SPEC §6.6, 640–1023: "every `GridCell`
 * spans 12").
 */
const SPAN_CLASSES: Record<GridCellSpan, string> = {
  3: 'col-span-12 lg:col-span-3',
  4: 'col-span-12 lg:col-span-4',
  6: 'col-span-12 lg:col-span-6',
  8: 'col-span-12 lg:col-span-8',
  12: 'col-span-12',
};

export interface GridCellProps {
  span: GridCellSpan;
  /**
   * Renders a column stack (`flex flex-col gap-4`) so two short cards sit
   * beside one tall sibling instead of each being stretched to it.
   */
  stack?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * A single grid cell. `min-w-0` prevents a long unbroken string (a tag, an
 * opponent name) from blowing out the column's intrinsic width. Declares no
 * height of its own — an empty `GridCell` renders a zero-height element that
 * never stretches its row siblings, because `PageGrid`'s `items-start` never
 * grows any cell to match another.
 */
export function GridCell({ span, stack = false, children, className }: GridCellProps) {
  return (
    <div
      data-span={span}
      className={cn('min-w-0', SPAN_CLASSES[span], stack && 'flex flex-col gap-4', className)}
    >
      {children}
    </div>
  );
}
