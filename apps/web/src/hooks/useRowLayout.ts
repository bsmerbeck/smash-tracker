import { useState } from 'react';

/**
 * Plan 39.1-49 (UI-SPEC §6.6 "< 640 tables become stacked rows"): which of a
 * table host's two mutually exclusive roots mounts — the `<table>` or the
 * stacked two-line `<ul>`.
 */
export type RowLayout = 'table' | 'stack';

/** Tailwind's `sm` breakpoint (640px): below it a table becomes stacked rows. */
export const NARROW_LAYOUT_QUERY = '(max-width: 639px)';

/**
 * The shared, provider-free form of the read-once `matchMedia` mechanism
 * FilteredMatchList, MatrixHeat and StageDetailPage each carry locally: an
 * explicit `override` wins (the host / test affordance that reaches both
 * branches under jsdom); otherwise the query is read ONCE on mount (no change
 * listener, so a render never flips roots mid-session), defaulting to the
 * table when `matchMedia` is unavailable. Imports React only — safe for the
 * Scout multi-host components (no router, no query client).
 */
export function useRowLayout(override?: RowLayout): RowLayout {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_LAYOUT_QUERY).matches
      : false,
  );
  return override ?? (isNarrow ? 'stack' : 'table');
}
