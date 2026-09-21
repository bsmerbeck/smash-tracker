import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfidenceTier, SampleMeta } from '@smash-tracker/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * D-09/OPP-02: the matrix-heat vocabulary member (pulled forward from its
 * Phase 41 sketch, per the kit README). Plain DOM: this file imports NO
 * chart library, so it is deliberately ABSENT from `chartKitBoundary.test.ts`'s
 * `KIT_CHART_PRIMITIVES` array — that list's structural frame rule scopes to
 * kit files that render a Recharts element, the same reasoning the sibling
 * plain-DOM member `ComparisonBars.tsx` already carries.
 *
 * The tint scale is a DISCRETE four-step function (sub-floor, low, medium,
 * high), never a continuous blend: a continuous interpolation (the existing
 * `matchupCellBackground` this member deliberately does NOT reuse) cannot
 * express the sub-floor step as a distinct CATEGORY — it can only render it
 * as "a paler version of a verdict," which is exactly the wrong reading. The
 * component recomputes no tier and declares no bound of its own: every tint
 * step reads the engine's own `confidenceTier` value on the cell.
 */

export interface MatrixHeatAxis {
  key: string;
  /** Already-localized display text the host supplies (e.g. a cross-tab row's "Fox vs Falco", or a stage name). This component resolves no name of its own. */
  label: string;
  /** Forces this axis entry to render LAST, regardless of its own total, with every cell in it forced to the sub-floor neutral treatment (D-09/36 D-09) — the axis itself is the caveat, never a count the axis could earn its way out of. */
  isUnknown?: boolean;
}

export interface MatrixHeatCell {
  rowKey: string;
  colKey: string;
  wins: number;
  losses: number;
  total: number;
  /** `null` below the engine's abstention floor — the component reads this value only, it never recomputes a tier from `total`. */
  confidenceTier: ConfidenceTier | null;
  sample: SampleMeta;
}

export type MatrixHeatLayout = 'grid' | 'stack';

export interface MatrixHeatProps {
  /** Ordered row descriptors — no entry for a pairing that was never played. */
  rows: MatrixHeatAxis[];
  /** Ordered column descriptors — no entry for an axis value that was never played. */
  cols: MatrixHeatAxis[];
  /** Sparse: no entry for a row/column combination with zero games. */
  cells: MatrixHeatCell[];
  onSelectCell?: (cell: MatrixHeatCell) => void;
  /** Rendered instead of the table when `rows` or `cols` is empty. */
  emptyMessage: ReactNode;
  /**
   * Test/host affordance forcing which of the two layout forms renders,
   * bypassing the `matchMedia` check below. See this component's own
   * `useIsNarrowViewport` doc comment for why this override is what makes
   * the narrow (stack) branch reachable and testable at all under jsdom.
   */
  layout?: MatrixHeatLayout;
}

/** Tailwind's `sm` breakpoint (640px) — below this the grid becomes unreadable as a table (per the UI-SPEC's Matrix Responsive Behaviour section) and switches to the per-row Tabs stack. */
const NARROW_LAYOUT_QUERY = '(max-width: 639px)';

/**
 * **The responsive mechanism is named, not left open, because the cell count
 * is asserted (C2-H-06).** A `matchMedia`-backed check, the SAME shape
 * `ReviewComposerPage.tsx:64-85` already uses (guard-before-use, default to
 * the safe/existing — here, desktop grid — behaviour when the API is
 * unavailable). `apps/web/src/test/setup.ts` stubs `ResizeObserver`,
 * `scrollIntoView` and the Pointer Capture API but never `window.matchMedia`,
 * so under jsdom this hook ALWAYS resolves to the desktop grid branch — the
 * component therefore always renders exactly ONE of its two forms under
 * test, and the cell-count assertion in `MatrixHeat.test.tsx` is well-defined.
 *
 * Two mechanisms this component deliberately does NOT use, both of which
 * would make that same assertion ill-posed:
 * - The paired `sm:hidden` / `hidden sm:` class idiom (`Topbar.tsx`'s own
 *   pattern) renders BOTH subtrees into the DOM at once, so a button count
 *   would come back at roughly double the supplied cell count.
 * - The Tabs primitive's own mounting behaviour alone: `TabsContent` only
 *   mounts the ACTIVE panel, so a stack rendered under jsdom would
 *   contribute exactly one row's worth of cells — a different wrong number.
 *   The Tabs primitive is what the stack branch is BUILT from; this
 *   `matchMedia` check is what SELECTS the branch.
 */
function useIsNarrowViewport(): boolean {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_LAYOUT_QUERY).matches
      : false,
  );
  return isNarrow;
}

const TIER_WIN_CLASSES: Record<ConfidenceTier, string> = {
  low: 'bg-emerald-500/15 text-emerald-300',
  medium: 'bg-emerald-500/30 text-emerald-200',
  high: 'bg-emerald-500/50 text-emerald-50',
};

const TIER_LOSS_CLASSES: Record<ConfidenceTier, string> = {
  low: 'bg-destructive/15 text-destructive-foreground',
  medium: 'bg-destructive/30 text-destructive-foreground',
  high: 'bg-destructive/50 text-destructive-foreground',
};

/** An exactly-even tiered cell — no win-or-loss hue either direction (D-09). */
const NEUTRAL_TIER_CLASSES = 'bg-muted text-foreground';

/**
 * The sub-floor step: neutral background, muted foreground, and
 * DELIBERATELY `font-normal` (not the tiered cells' `font-semibold`) — the
 * sub-floor cell is visually DEMOTED, not merely a lighter shade of a
 * verdict, because it states a different CATEGORY of fact ("not enough
 * evidence yet") than a tiered cell ("here is a graded record").
 */
const SUB_FLOOR_CLASSES = 'bg-muted/50 text-muted-foreground font-normal';

/** 48px — comfortably clears the 44px minimum touch target the UI-SPEC requires on coarse pointers. Hover is a brightness bump (`hover:brightness-110`), never a scale transform: a cell scaling up inside a dense grid risks visually colliding with its neighbour, which `hover:brightness-110` cannot do. Focus ring copied verbatim from `MatchupMatrix`'s existing cell contract — an established pattern, not invented here. */
const CELL_BASE_CLASSES =
  'flex size-12 items-center justify-center rounded text-sm font-semibold transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Fixed header cell width with truncation — matches the UI-SPEC's `w-32` header cell figure. */
const HEADER_CELL_CLASSES = 'w-32 truncate px-2 py-1 text-left text-xs text-muted-foreground';

function isSubFloorTreatment(cell: MatrixHeatCell, rowUnknown: boolean, colUnknown: boolean) {
  return rowUnknown || colUnknown || cell.confidenceTier == null;
}

function cellToneClasses(cell: MatrixHeatCell, rowUnknown: boolean, colUnknown: boolean): string {
  if (isSubFloorTreatment(cell, rowUnknown, colUnknown)) {
    return SUB_FLOOR_CLASSES;
  }
  const tier = cell.confidenceTier;
  if (tier == null) {
    return SUB_FLOOR_CLASSES;
  }
  if (cell.wins === cell.losses) {
    return NEUTRAL_TIER_CLASSES;
  }
  return cell.wins > cell.losses ? TIER_WIN_CLASSES[tier] : TIER_LOSS_CLASSES[tier];
}

function cellDisplayValue(cell: MatrixHeatCell, rowUnknown: boolean, colUnknown: boolean): string {
  if (isSubFloorTreatment(cell, rowUnknown, colUnknown)) {
    return String(cell.total);
  }
  return `${cell.wins}–${cell.losses}`;
}

function MatrixHeatCellButton({
  cell,
  row,
  col,
  onSelectCell,
}: {
  cell: MatrixHeatCell;
  row: MatrixHeatAxis;
  col: MatrixHeatAxis;
  onSelectCell?: (cell: MatrixHeatCell) => void;
}) {
  const { t } = useTranslation();
  const rowUnknown = row.isUnknown === true;
  const colUnknown = col.isUnknown === true;
  const subFloor = isSubFloorTreatment(cell, rowUnknown, colUnknown);

  // `subFloor` is false in the branch below, so `confidenceTier` is non-null (isSubFloorTreatment's
  // other check). UI-SPEC §9.2 rule 8: the tier word is part of the key, never interpolated
  // (Phase 39.1 Plan 11) — moved above the ternary so the guard's exclusive-branch-selector
  // exclusion (a bare `:` between the two calls) still matches.
  const hintText = subFloor
    ? t('opponents.hub.matrix.notEnoughData', { count: cell.total })
    : t(`shared.evidence.sampleCue.${cell.confidenceTier}`, {
        count: cell.sample.eligibleDenominator,
      });

  return (
    <button
      type="button"
      className={cn(CELL_BASE_CLASSES, cellToneClasses(cell, rowUnknown, colUnknown))}
      aria-label={t('matchups.matrix.cellAria4', {
        row: row.label,
        col: col.label,
        wins: cell.wins,
        losses: cell.losses,
      })}
      title={hintText}
      onClick={onSelectCell ? () => onSelectCell(cell) : undefined}
    >
      {cellDisplayValue(cell, rowUnknown, colUnknown)}
    </button>
  );
}

function EmptyCell() {
  return <div className="size-12" aria-hidden="true" />;
}

function MatrixHeatGrid({
  rows,
  cols,
  cellByKey,
  onSelectCell,
}: {
  rows: MatrixHeatAxis[];
  cols: MatrixHeatAxis[];
  cellByKey: Map<string, MatrixHeatCell>;
  onSelectCell?: (cell: MatrixHeatCell) => void;
}) {
  return (
    <div className="overflow-x-auto" data-slot="matrix-heat-grid">
      <table className="mx-auto w-max border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 w-32 border-r border-border bg-card p-2 text-left" />
            {cols.map((col) => (
              <th key={col.key} className={HEADER_CELL_CLASSES} title={col.label}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th
                scope="row"
                className={`sticky left-0 z-10 border-r border-border bg-card p-2 text-left font-normal ${HEADER_CELL_CLASSES}`}
                title={row.label}
              >
                {row.label}
              </th>
              {cols.map((col) => {
                const cell = cellByKey.get(`${row.key}:${col.key}`);
                return (
                  <td key={col.key} className="p-1 text-center">
                    {cell ? (
                      <MatrixHeatCellButton
                        cell={cell}
                        row={row}
                        col={col}
                        onSelectCell={onSelectCell}
                      />
                    ) : (
                      <EmptyCell />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixHeatStack({
  rows,
  cols,
  cellByKey,
  onSelectCell,
}: {
  rows: MatrixHeatAxis[];
  cols: MatrixHeatAxis[];
  cellByKey: Map<string, MatrixHeatCell>;
  onSelectCell?: (cell: MatrixHeatCell) => void;
}) {
  const { t } = useTranslation();
  const firstRow = rows[0];
  if (!firstRow) {
    return null;
  }
  return (
    <Tabs defaultValue={firstRow.key} data-slot="matrix-heat-stack">
      <TabsList>
        {rows.map((row) => (
          <TabsTrigger
            key={row.key}
            value={row.key}
            aria-label={t('opponents.hub.matrix.tabAria', { row: row.label })}
          >
            {row.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {rows.map((row) => (
        <TabsContent key={row.key} value={row.key}>
          <ul className="flex flex-col gap-2">
            {cols.map((col) => {
              const cell = cellByKey.get(`${row.key}:${col.key}`);
              if (!cell) {
                return null;
              }
              return (
                <li key={col.key} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">{col.label}</span>
                  <MatrixHeatCellButton
                    cell={cell}
                    row={row}
                    col={col}
                    onSelectCell={onSelectCell}
                  />
                </li>
              );
            })}
          </ul>
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * The kit's cross-tab member: an ordered `rows` x `cols` grid of sparse
 * `cells`, sized by what actually happened rather than by a dense roster.
 * Desktop (or under jsdom, whose missing `matchMedia` always resolves this
 * branch): one horizontally-scrollable `<table>` with a sticky first column
 * and no artificial cap. Narrow viewport (or the `layout="stack"` override):
 * one tab per row, each tab's panel a vertical list of that row's cells —
 * the SAME record/tint/hint/activation contract, a layout change only.
 */
export function MatrixHeat({
  rows,
  cols,
  cells,
  onSelectCell,
  emptyMessage,
  layout,
}: MatrixHeatProps) {
  const isNarrowViewport = useIsNarrowViewport();
  const resolvedLayout: MatrixHeatLayout = layout ?? (isNarrowViewport ? 'stack' : 'grid');

  if (rows.length === 0 || cols.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const cellByKey = new Map(cells.map((cell) => [`${cell.rowKey}:${cell.colKey}`, cell]));

  if (resolvedLayout === 'stack') {
    return (
      <MatrixHeatStack rows={rows} cols={cols} cellByKey={cellByKey} onSelectCell={onSelectCell} />
    );
  }

  return (
    <MatrixHeatGrid rows={rows} cols={cols} cellByKey={cellByKey} onSelectCell={onSelectCell} />
  );
}
