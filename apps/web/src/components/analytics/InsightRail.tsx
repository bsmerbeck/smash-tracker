import { useMemo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * One card's stable identity plus a factory that builds its content, given
 * the `onDismiss` handler the rail wires up. The factory pattern (rather
 * than a static `ReactNode`) is what lets the rail own promotion/back-fill
 * while the host stays in full control of a card's copy, doors and mark —
 * the rail never builds an `InsightCard` itself.
 */
export interface InsightRailCard {
  id: string;
  render: (helpers: { onDismiss: () => void }) => ReactNode;
}

/**
 * Generic reshaping of `assembleRail`'s `{ cards, lines, unlocksNext,
 * promotionQueue }` return (`@smash-tracker/shared`'s `AssembleRailResult`)
 * with `Insight` replaced by `InsightRailCard` — the host maps each engine
 * `Insight` into a `{ id, render }` pair (real copy, real doors, real i18n)
 * before handing this shape to `InsightRail`. `cards` and `unlocksNext` are
 * already ordered/capped by the engine; this component re-ranks nothing.
 */
export interface InsightRailShape {
  cards: InsightRailCard[];
  unlocksNext: InsightRailCard | null;
  lines: ReactNode[];
  promotionQueue: InsightRailCard[];
}

export interface InsightRailLabels {
  /** e.g. "3 dismissed on this device" — composed by the host from the live count. */
  dismissedCount: (count: number) => string;
  allDismissed: string;
  restore: string;
}

export interface InsightRailProps {
  rail: InsightRailShape;
  header: string;
  /** The three-`ClaimChip` decorative legend, built by the host. */
  legend: ReactNode;
  labels: InsightRailLabels;
  dismissedIds: string[];
  onDismiss: (id: string) => void;
  onRestore: () => void;
  /** Rendered instead of any card when the rail truly has nothing — the rendered card count is never 0. */
  fallbackCard: ReactNode;
  cap?: number;
}

const DEFAULT_CAP = 3;

interface VisibleSelection {
  unlocksNext: InsightRailCard | null;
  cards: InsightRailCard[];
}

/**
 * Filters dismissed candidates out of `rail.cards`/`rail.unlocksNext`, then
 * promotes from `rail.promotionQueue` to refill the freed slot(s) up to
 * `cap`. Never re-sorts — `cards`/`promotionQueue` are consumed in the exact
 * order given.
 */
function selectVisible(
  rail: InsightRailShape,
  dismissedIds: string[],
  cap: number,
): VisibleSelection {
  const isDismissed = (id: string) => dismissedIds.includes(id);

  const unlocksNext =
    rail.unlocksNext && !isDismissed(rail.unlocksNext.id) ? rail.unlocksNext : null;
  const budget = cap - (unlocksNext ? 1 : 0);

  const cards: InsightRailCard[] = [];
  for (const card of rail.cards) {
    if (cards.length >= budget) break;
    if (!isDismissed(card.id)) cards.push(card);
  }
  if (cards.length < budget) {
    for (const card of rail.promotionQueue) {
      if (cards.length >= budget) break;
      if (isDismissed(card.id)) continue;
      if (cards.some((c) => c.id === card.id)) continue;
      cards.push(card);
    }
  }

  return { unlocksNext, cards };
}

/**
 * The insight rail (INS-04, UI-SPEC §7.8, D-07/D-14): at most `cap` cards,
 * never empty, promotes the next candidate on dismiss, and cannot leak the
 * engine's internal ordering score — it reads only the already-ordered
 * `rail` shape it is handed, never a numeric ranking field of its own.
 */
export function InsightRail({
  rail,
  header,
  legend,
  labels,
  dismissedIds,
  onDismiss,
  onRestore,
  fallbackCard,
  cap = DEFAULT_CAP,
}: InsightRailProps) {
  const { unlocksNext, cards } = useMemo(
    () => selectVisible(rail, dismissedIds, cap),
    [rail, dismissedIds, cap],
  );

  const totalOriginalCandidates =
    rail.cards.length + rail.promotionQueue.length + (rail.unlocksNext ? 1 : 0);
  const visibleTotal = cards.length + (unlocksNext ? 1 : 0);
  const isEmpty = totalOriginalCandidates === 0;
  const allDismissed = !isEmpty && visibleTotal === 0;

  return (
    <div data-slot="insight-rail">
      <div className="flex items-center justify-between gap-2" data-slot="insight-rail-header">
        <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
          {header}
        </p>
        <div aria-hidden="true" data-slot="insight-rail-legend" className="flex items-center gap-1">
          {legend}
        </div>
      </div>

      <div className="flex flex-col gap-4" data-slot="insight-rail-cards">
        {isEmpty && (
          <div data-slot="insight-rail-card" data-card-kind="fallback">
            {fallbackCard}
          </div>
        )}

        {allDismissed && (
          <div
            className="flex flex-col gap-2 rounded-xl border border-border p-5"
            data-slot="insight-rail-card"
            data-card-kind="all-dismissed"
          >
            <p className="text-sm leading-5 text-muted-foreground">{labels.allDismissed}</p>
            <Button type="button" variant="link" size="sm" onClick={onRestore}>
              {labels.restore}
            </Button>
          </div>
        )}

        {!isEmpty &&
          !allDismissed &&
          cards.map((card) => (
            <div
              key={card.id}
              className="transition-opacity duration-200 motion-reduce:transition-none"
              data-slot="insight-rail-card"
              data-card-kind="regular"
            >
              {card.render({ onDismiss: () => onDismiss(card.id) })}
            </div>
          ))}

        {!isEmpty && !allDismissed && unlocksNext && (
          <div
            className="transition-opacity duration-200 motion-reduce:transition-none"
            data-slot="insight-rail-card"
            data-card-kind="unlocks-next"
          >
            {unlocksNext.render({ onDismiss: () => onDismiss(unlocksNext.id) })}
          </div>
        )}
      </div>

      {rail.lines.length > 0 && (
        <div className="flex flex-col gap-2" data-slot="insight-rail-lines">
          {rail.lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}

      {!allDismissed && dismissedIds.length > 0 && (
        <div className="flex items-center gap-2" data-slot="insight-rail-foot">
          <span className="text-xs leading-4 text-muted-foreground tabular-nums">
            {labels.dismissedCount(dismissedIds.length)}
          </span>
          <Button type="button" variant="link" size="sm" onClick={onRestore}>
            {labels.restore}
          </Button>
        </div>
      )}
    </div>
  );
}
