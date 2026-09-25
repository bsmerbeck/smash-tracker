import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { InsightCardErrorBoundary } from './InsightCardErrorBoundary';

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
  /** Rendered as the ONLY content when every remaining candidate crashed (UI-SPEC §9.5). */
  railError: ReactNode;
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
 * Filters excluded (dismissed OR crashed) candidates out of
 * `rail.cards`/`rail.unlocksNext`, then promotes from `rail.promotionQueue`
 * to refill the freed slot(s) up to `cap`. Never re-sorts — `cards` and
 * `promotionQueue` are consumed in the exact order given.
 */
function selectVisible(
  rail: InsightRailShape,
  excludedIds: string[],
  cap: number,
): VisibleSelection {
  const isExcluded = (id: string) => excludedIds.includes(id);

  const unlocksNext =
    rail.unlocksNext && !isExcluded(rail.unlocksNext.id) ? rail.unlocksNext : null;
  const budget = cap - (unlocksNext ? 1 : 0);

  const cards: InsightRailCard[] = [];
  for (const card of rail.cards) {
    if (cards.length >= budget) break;
    if (!isExcluded(card.id)) cards.push(card);
  }
  if (cards.length < budget) {
    for (const card of rail.promotionQueue) {
      if (cards.length >= budget) break;
      if (isExcluded(card.id)) continue;
      if (cards.some((c) => c.id === card.id)) continue;
      cards.push(card);
    }
  }

  return { unlocksNext, cards };
}

/**
 * A plain function component wrapping a card's factory call. The factory
 * MUST be invoked inside a component's own render (not the rail's) for
 * `InsightCardErrorBoundary` to catch a throw from it — calling
 * `card.render(...)` directly inline in the rail's JSX would run it during
 * the RAIL's render phase, before React ever reaches the boundary.
 */
function CardSlot({ card, onDismiss }: { card: InsightRailCard; onDismiss: () => void }) {
  return <>{card.render({ onDismiss })}</>;
}

/**
 * The insight rail (INS-04, UI-SPEC §7.8, D-07/D-14, T-39.1-07-01..04): at
 * most `cap` cards, never empty, promotes the next candidate on dismiss OR
 * on a per-card crash, and cannot leak the engine's internal ordering score
 * — it reads only the already-ordered `rail` shape it is handed, never a
 * numeric ranking field of its own.
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
  const [crashedIds, setCrashedIds] = useState<string[]>([]);

  const handleCrash = useCallback((id: string) => {
    setCrashedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const excludedIds = useMemo(() => [...dismissedIds, ...crashedIds], [dismissedIds, crashedIds]);

  const { unlocksNext, cards } = useMemo(
    () => selectVisible(rail, excludedIds, cap),
    [rail, excludedIds, cap],
  );

  const allOriginalIds = useMemo(
    () => [
      ...rail.cards.map((c) => c.id),
      ...rail.promotionQueue.map((c) => c.id),
      ...(rail.unlocksNext ? [rail.unlocksNext.id] : []),
    ],
    [rail],
  );

  const totalOriginalCandidates = allOriginalIds.length;
  const visibleTotal = cards.length + (unlocksNext ? 1 : 0);
  const isEmpty = totalOriginalCandidates === 0;
  // Every candidate the engine offered crashed (regardless of dismissedIds) —
  // a system fault, distinct from a user dismissing everything.
  const allCrashed = !isEmpty && allOriginalIds.every((id) => crashedIds.includes(id));
  const allExcluded = !isEmpty && !allCrashed && visibleTotal === 0;

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

        {allCrashed && (
          <div data-slot="insight-rail-card" data-card-kind="rail-error">
            {labels.railError}
          </div>
        )}

        {allExcluded && (
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
          !allCrashed &&
          !allExcluded &&
          cards.map((card) => (
            <div
              key={card.id}
              className="transition-opacity duration-200 motion-reduce:transition-none"
              data-slot="insight-rail-card"
              data-card-kind="regular"
            >
              <InsightCardErrorBoundary templateId={card.id} onError={handleCrash}>
                <CardSlot card={card} onDismiss={() => onDismiss(card.id)} />
              </InsightCardErrorBoundary>
            </div>
          ))}

        {!isEmpty && !allCrashed && !allExcluded && unlocksNext && (
          <div
            className="transition-opacity duration-200 motion-reduce:transition-none"
            data-slot="insight-rail-card"
            data-card-kind="unlocks-next"
          >
            <InsightCardErrorBoundary templateId={unlocksNext.id} onError={handleCrash}>
              <CardSlot card={unlocksNext} onDismiss={() => onDismiss(unlocksNext.id)} />
            </InsightCardErrorBoundary>
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

      {!allCrashed && !allExcluded && dismissedIds.length > 0 && (
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
