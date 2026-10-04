import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ValueSeriesGrain } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { formatDate } from '@/lib/format';
import { CAREER_TIMELINE_READOUT_MAX_WIDTH_PX, clampReadoutLeft } from './careerTimelineLayout';
import { CHART_H_MULTIPLE, CHART_H_MULTIPLE_NARROW } from './tokens';
import { TrendLine, type TrendValuePoint } from './TrendLine';
import {
  VALUE_MARGIN_RIGHT_PX,
  VALUE_MARGIN_TOP_PX,
  buildValueYAxis,
  nearestPointIndex,
  nearestPointWithinGrain,
  valueChartHeight,
} from './valueTrendGeometry';

/**
 * Plan 41-02 (A3 / DD-41-02, UI-SPEC §7.2): the small-multiples vocabulary member — N value-mode
 * panels STACKED on one time axis, each with its own fitted y (never normalised), one drawn x axis
 * (under the last panel) and ONE crosshair + readout shared by every panel.
 *
 * Plain DOM: this file imports no Recharts symbol, so — like `MatrixHeat.tsx` and
 * `ComparisonBars.tsx` — it is deliberately ABSENT from `chartKitBoundary.test.ts`'s
 * `KIT_CHART_PRIMITIVES`; each panel is a `TrendLine mode="value"`, which is.
 *
 * Why the crosshair is host-controlled state and not the chart library's built-in cross-chart
 * synchronisation (RESEARCH correction 1): that mechanism matches a hovered point in the other charts
 * by an exact string comparison of the x value, so two panels whose x values differ (the GSP vs Glicko
 * panels are built from different readings) would silently show NO crosshair in the second panel. Here
 * the grid owns one `cursorXMs`, every panel draws its crosshair at that same x and converts its own
 * pointer position into the nearest of ITS points' x — so the line lands on one vertical in every panel
 * whether or not the panels share an x value. The panels' y gutters are equalised (the widest measured
 * gutter wins) so one x means one pixel column across the stack.
 */

/** One stacked panel. Everything the host passes is pre-binned and pre-formatted — the grid never bins or localises. */
export interface SmallMultiplesPanel {
  key: string;
  /** The panel's overline, e.g. "Est. MMR". */
  title: string;
  points: TrendValuePoint[];
  grain: ValueSeriesGrain;
  formatTick: (n: number, step: number) => string;
  formatValueFull: (n: number) => string;
  /** The panel's line of the shared readout for ITS point nearest the crosshair ("Est. MMR · 1,096"): value leads, label follows. */
  readoutLine: (point: TrendValuePoint) => string;
  labels: { aria: string };
  onSelectPoint?: (point: TrendValuePoint) => void;
}

export interface SmallMultiplesProps {
  panels: SmallMultiplesPanel[];
  layout: 'stacked';
  /** Computed by the host from the union of the panels' points; every panel shares it. */
  xDomain: [number, number];
  /** One panel's plot height (px). Default `CHART_H_MULTIPLE` (`CHART_H_MULTIPLE_NARROW` below 640px). */
  height?: number;
  /** D-04 test affordance: an explicit container width; omitted at runtime (each panel measures itself). */
  width?: number;
  /**
   * A panel's readout line when it has no point within one bucket of the shared grain of the crosshair
   * ("Glicko-2 · no reading") — the grid never localises, the host supplies the sentence.
   */
  noReadingLine: (panelTitle: string) => string;
  /** The `meta` caption under the grid ("Each panel keeps its own scale…"). */
  caption: string;
  /** The grid's accessible name (`analytics.multiples.aria_*`). */
  aria: string;
  tableLabels: { toggle: string; date: string };
}

/** Below Tailwind's `sm` breakpoint the panels are 96px; jsdom has no `matchMedia`, so a test always sees the desktop height. */
const NARROW_VIEWPORT_QUERY = '(max-width: 639px)';
const GRID_RESPONSIVE_FALLBACK_WIDTH = 800;
const READOUT_CLASSES =
  'pointer-events-none absolute z-10 w-max max-w-[min(280px,100%)] rounded-md border border-border bg-card p-2 text-xs tabular-nums';

function useIsNarrowViewport(): boolean {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches
      : false,
  );
  return isNarrow;
}

type CursorSource = 'pointer' | 'keyboard';

interface CursorState {
  xMs: number | null;
  source: CursorSource;
}

/** The sorted union of every panel's point times — what ← / → step. */
function unionOfXs(panels: readonly SmallMultiplesPanel[]): number[] {
  return [...new Set(panels.flatMap((panel) => panel.points.map((point) => point.xMs)))].sort(
    (a, b) => a - b,
  );
}

export function SmallMultiplesGrid({
  panels,
  layout,
  xDomain,
  height,
  width,
  noReadingLine,
  caption,
  aria,
  tableLabels,
}: SmallMultiplesProps): ReactElement | null {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const narrowViewport = useIsNarrowViewport();
  const [cursor, setCursor] = useState<CursorState>({ xMs: null, source: 'pointer' });
  const [measuredWidth, setMeasuredWidth] = useState(GRID_RESPONSIVE_FALLBACK_WIDTH);
  const [readoutWidth, setReadoutWidth] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const [tableOpen, setTableOpen] = useState(false);

  // The grid's own width (the readout is positioned from it); an explicit `width` wins under test.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof width === 'number' || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setMeasuredWidth(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);

  const cursorKey = cursor.xMs;
  useLayoutEffect(() => {
    const el = readoutRef.current;
    if (!el) return undefined;
    function measure() {
      if (el) setReadoutWidth(el.offsetWidth);
    }
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursorKey]);

  const drawnPanels = panels.filter((panel) => panel.points.length > 0);
  if (layout !== 'stacked' || drawnPanels.length === 0) return null;

  const containerWidth = typeof width === 'number' ? width : measuredWidth;
  const plotPx = height ?? (narrowViewport ? CHART_H_MULTIPLE_NARROW : CHART_H_MULTIPLE);
  // One y gutter for every panel: the widest measured one, so one x is one pixel column in all of them.
  const gutterPx = Math.max(
    0,
    ...drawnPanels.map(
      (panel) =>
        buildValueYAxis(
          panel.points.map((point) => point.value),
          panel.formatTick,
        )?.gutterPx ?? 0,
    ),
  );
  const unionXs = unionOfXs(drawnPanels);
  const lastPanelIndex = drawnPanels.length - 1;

  function move(xMs: number | null, source: CursorSource) {
    setCursor({ xMs, source });
  }

  /** A pointer left a panel: clear only a pointer-driven crosshair, never a keyboard-driven one. */
  function onPointerCursor(xMs: number | null) {
    if (xMs === null) {
      setCursor((previous) =>
        previous.source === 'pointer' ? { xMs: null, source: 'pointer' } : previous,
      );
      return;
    }
    move(xMs, 'pointer');
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const lastIndex = unionXs.length - 1;
    const current =
      cursor.xMs !== null
        ? nearestPointIndex(
            unionXs.map((xMs) => ({ xMs })),
            cursor.xMs,
          )
        : null;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = current === null ? lastIndex : Math.max(0, current - 1);
        break;
      case 'ArrowRight':
        next = current === null ? lastIndex : Math.min(lastIndex, current + 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = lastIndex;
        break;
      case 'Enter':
      case ' ': {
        if (cursor.xMs === null) return;
        const panelKey = (event.target as HTMLElement)
          .closest('[data-panel-key]')
          ?.getAttribute('data-panel-key');
        const panel = drawnPanels.find((candidate) => candidate.key === panelKey);
        if (!panel?.onSelectPoint) return;
        // WR-03: only a point within one grain bucket of the crosshair is "at" it.
        const point = nearestPointWithinGrain(panel.points, cursor.xMs, panel.grain);
        if (!point) return;
        event.preventDefault();
        panel.onSelectPoint(point);
        return;
      }
      case 'Escape':
        if (cursor.xMs === null) return;
        event.preventDefault();
        move(null, 'keyboard');
        return;
      default:
        return;
    }
    event.preventDefault();
    move(unionXs[next] ?? null, 'keyboard');
  }

  // The ONE readout: a date title, then each panel's line for its point nearest the crosshair — or
  // "no reading" when that point is more than one grain bucket away (WR-03), never a value from
  // another season presented as if it stood at the cursor's date.
  const readoutRows =
    cursor.xMs === null
      ? []
      : drawnPanels.map((panel) => {
          const point = nearestPointWithinGrain(panel.points, cursor.xMs!, panel.grain);
          return {
            key: panel.key,
            line: point ? panel.readoutLine(point) : noReadingLine(panel.title),
          };
        });
  const xSpan = xDomain[1] - xDomain[0];
  const plotWidthPx = Math.max(0, containerWidth - gutterPx - VALUE_MARGIN_RIGHT_PX);
  const anchorX =
    gutterPx + (((cursor.xMs ?? xDomain[0]) - xDomain[0]) / (xSpan || 1)) * plotWidthPx;
  const readoutLeft = clampReadoutLeft({
    anchorX,
    readoutWidth: Math.min(readoutWidth, CAREER_TIMELINE_READOUT_MAX_WIDTH_PX),
    containerWidth,
  });
  const readoutBody = (
    <>
      <p className="text-sm font-semibold">
        {cursor.xMs !== null ? formatDate(cursor.xMs, locale) : ''}
      </p>
      {readoutRows.map((row) => (
        <p key={row.key} data-slot="multiples-readout-line" className="text-muted-foreground">
          {row.line}
        </p>
      ))}
    </>
  );

  return (
    <div data-slot="small-multiples" className="flex min-w-0 flex-col gap-2">
      <div
        ref={frameRef}
        data-slot="multiples-frame"
        role="group"
        aria-label={aria}
        className="relative flex flex-col gap-2"
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          // Focus left the grid entirely: a keyboard-driven crosshair goes with it.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setCursor((previous) =>
            previous.source === 'keyboard' ? { xMs: null, source: 'keyboard' } : previous,
          );
        }}
      >
        {drawnPanels.map((panel, index) => {
          const isLast = index === lastPanelIndex;
          return (
            <div
              key={panel.key}
              data-slot="multiples-panel"
              data-panel-key={panel.key}
              className="min-w-0"
            >
              <p
                data-slot="multiples-panel-title"
                className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
                style={{ paddingLeft: gutterPx }}
              >
                {panel.title}
              </p>
              <TrendLine
                mode="value"
                points={panel.points}
                grain={panel.grain}
                xDomain={xDomain}
                formatTick={panel.formatTick}
                formatValueFull={panel.formatValueFull}
                directLabels="last"
                lineWidth="thin"
                drawXAxis={isLast}
                gutterPx={gutterPx}
                cursor={{ xMs: cursor.xMs, onChange: onPointerCursor }}
                {...(panel.onSelectPoint ? { onSelectPoint: panel.onSelectPoint } : {})}
                labels={{ aria: panel.labels.aria }}
                {...(typeof width === 'number' ? { width } : {})}
                height={valueChartHeight(plotPx, isLast)}
              />
            </div>
          );
        })}
        {readoutRows.length > 0 && (
          <div
            ref={readoutRef}
            data-slot="multiples-readout"
            aria-hidden="true"
            className={READOUT_CLASSES}
            style={{ left: readoutLeft, top: VALUE_MARGIN_TOP_PX }}
          >
            {readoutBody}
          </div>
        )}
        {/* Keyboard steps are announced politely; a pointer hover never is. */}
        <div data-slot="multiples-live" aria-live="polite" className="sr-only">
          {cursor.source === 'keyboard' && readoutRows.length > 0 ? readoutBody : null}
        </div>
      </div>
      <p data-slot="multiples-caption" className="text-xs leading-4 text-muted-foreground">
        {caption}
      </p>
      <Collapsible open={tableOpen} onOpenChange={setTableOpen} data-slot="multiples-table">
        {/* The trigger sets aria-expanded and aria-controls and toggles the content (WR-07). */}
        <CollapsibleTrigger asChild>
          <Button type="button" variant="link" size="sm" className={MUTED_LINK_TONE}>
            {tableLabels.toggle}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="text-left font-medium">
                  {tableLabels.date}
                </th>
                {drawnPanels.map((panel) => (
                  <th key={panel.key} scope="col" className="text-left font-medium">
                    {panel.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {unionXs.map((xMs) => (
                <tr key={xMs}>
                  <td>{formatDate(xMs, locale)}</td>
                  {drawnPanels.map((panel) => {
                    // Blank when this panel has no point at exactly that time.
                    const point = panel.points.find((candidate) => candidate.xMs === xMs);
                    return (
                      <td key={panel.key} className="tabular-nums">
                        {point ? panel.formatValueFull(point.value) : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
