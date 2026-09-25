import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';

/** The whole cap ladder (UI-SPEC §3/§6.4), exported so every host reads the same constants. */
export const LIST_CAP = 8;
export const LIST_CAP_RAIL = 5;
export const LIST_INLINE_MAX = 25;
export const LIST_PASS_MAX = 100;
export const LIST_PASS_STEP = 50;

export type BoundedListMode = 'default' | 'full-page';

export interface BoundedListLabels {
  /** e.g. "Show all 42" — fully composed by the host (Track B rule B1). */
  showAll: string;
  showFewer: string;
  /** e.g. "Show 50 more" (full-page mode). */
  showMore: string;
  /** e.g. "All 42 opponents →" (terminus mode). */
  terminus: string;
}

export interface BoundedListProps {
  /** The rows to render, in the exact order given — this primitive never sorts. */
  rows: ReactNode[];
  /** `LIST_CAP` or `LIST_CAP_RAIL`. */
  cap: number;
  /** `'full-page'` for a standalone list page (100 rows per pass); `'default'` for a card/rail. */
  mode?: BoundedListMode;
  /** Total row count, if different from `rows.length`. Defaults to `rows.length`. */
  totalCount?: number;
  labels: BoundedListLabels;
  /** Rendered instead of any rows/controls when the total is zero. */
  empty: ReactNode;
  onTerminus?: () => void;
  terminusHref?: string;
}

/**
 * The one bounded-list primitive (UIX-02). Renders NO scroll container of
 * any kind — no maximum height, no vertical-overflow utility — because a
 * nested scroller inside an analytics card is exactly what this primitive
 * bans (§6.4).
 */
export function BoundedList({
  rows,
  cap,
  mode = 'default',
  totalCount,
  labels,
  empty,
  onTerminus,
  terminusHref,
}: BoundedListProps) {
  const total = totalCount ?? rows.length;
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(() => Math.min(LIST_PASS_MAX, total));

  if (total === 0) {
    return <>{empty}</>;
  }

  if (mode === 'full-page') {
    const visibleRows = rows.slice(0, Math.min(visibleCount, total));
    const hasMore = visibleCount < total;
    return (
      <div className="flex flex-col gap-3" data-slot="bounded-list">
        <ul className="flex flex-col gap-2">{visibleRows}</ul>
        {hasMore && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => setVisibleCount((v) => Math.min(v + LIST_PASS_STEP, total))}
          >
            {labels.showMore}
          </Button>
        )}
      </div>
    );
  }

  if (total <= cap) {
    return (
      <ul className="flex flex-col gap-2" data-slot="bounded-list">
        {rows}
      </ul>
    );
  }

  // total > cap: the ladder branches on whether the WHOLE list fits within
  // LIST_INLINE_MAX once expanded, or must hand off to a terminus link. The
  // capped rows always render; `Collapsible` gates only the ADDITIONAL rows
  // between `cap` and the inline max.
  const fitsInline = total <= LIST_INLINE_MAX;
  const inlineCount = Math.min(total, LIST_INLINE_MAX);
  const extraRows = rows.slice(cap, inlineCount);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} data-slot="bounded-list">
      <ul className="flex flex-col gap-2">{rows.slice(0, cap)}</ul>
      <CollapsibleContent>
        <ul className="flex flex-col gap-2">{extraRows}</ul>
      </CollapsibleContent>
      {!expanded && (
        <Button type="button" variant="link" size="sm" onClick={() => setExpanded(true)}>
          {labels.showAll}
        </Button>
      )}
      {expanded && fitsInline && (
        <Button type="button" variant="link" size="sm" onClick={() => setExpanded(false)}>
          {labels.showFewer}
        </Button>
      )}
      {expanded &&
        !fitsInline &&
        (terminusHref ? (
          <Button asChild variant="link" size="sm">
            <a href={terminusHref} onClick={onTerminus}>
              {labels.terminus}
            </a>
          </Button>
        ) : (
          <Button type="button" variant="link" size="sm" onClick={onTerminus}>
            {labels.terminus}
          </Button>
        ))}
    </Collapsible>
  );
}
