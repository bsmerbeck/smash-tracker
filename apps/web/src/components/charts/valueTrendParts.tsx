import { useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { formatDate } from '@/lib/format';
import { CHART_TOKENS } from './tokens';
import type { ValueTrendHeadItem, ValueTrendHeadKind } from './valueTrendGeometry';
import type { TrendValueLocked, TrendValuePoint } from './TrendLine';

/**
 * Plan 41-02 (UI-SPEC §7.1): the plain-DOM parts of `TrendLine mode="value"` — the head (overline +
 * swatch legend), the locked inset and the table twin. Deliberately NO Recharts import, so this
 * file needs no `KIT_CHART_PRIMITIVES` entry; it composes only the `Collapsible` / `Button` shells
 * the period mode's twin already uses.
 */

/** The legend swatches, drawn from `CHART_TOKENS` only (§7.1: line, diamond, the one licensed dashed line). */
function ValueLegendSwatch({ kind }: { kind: ValueTrendHeadKind }): ReactElement | null {
  if (kind === 'series') {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-0.5 w-3.5 shrink-0 rounded-full"
        style={{ backgroundColor: CHART_TOKENS.series1 }}
      />
    );
  }
  if (kind === 'calibration') {
    return (
      <span
        aria-hidden="true"
        className="inline-block size-2 shrink-0 rotate-45"
        style={{ backgroundColor: CHART_TOKENS.deemphasis }}
      />
    );
  }
  if (kind === 'reference') {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-0 w-3.5 shrink-0 border-t border-dashed"
        style={{ borderColor: CHART_TOKENS.deemphasis }}
      />
    );
  }
  // An out-of-range reference draws no line, so its legend item carries no swatch.
  return null;
}

/** The head: the grain overline, then the swatch legend on one wrapping line. */
export function ValueTrendHead({
  title,
  items,
}: {
  title: string;
  items: ValueTrendHeadItem[];
}): ReactElement {
  return (
    <div data-slot="trend-value-head" className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5">
      <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </p>
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-xs leading-4 text-muted-foreground">
          {items.map((item) => (
            <span
              key={item.kind}
              data-slot="trend-value-legend-item"
              data-kind={item.kind}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <ValueLegendSwatch kind={item.kind} />
              {item.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** UI-SPEC §7.1 locked state: an L2 inset with the sentence and the `UnlocksNext`-form meter. */
export function ValueTrendLockedInset({ locked }: { locked: TrendValueLocked }): ReactElement {
  const fillPercent =
    locked.need > 0
      ? Math.min(100, Math.max(0, Math.round((locked.have / locked.need) * 100)))
      : 100;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-3"
      data-slot="trend-value-locked"
    >
      <p className="text-sm leading-5">{locked.sentence}</p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <div
          role="img"
          aria-label={locked.meterLabel}
          className="h-1.5 min-w-[60px] flex-[1_1_80px] overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${fillPercent}%`, backgroundColor: CHART_TOKENS.steady }}
          />
        </div>
        <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
          {locked.meterLabel}
        </span>
      </div>
    </div>
  );
}

/** "View as table" twin: date · value · readings, one `scope="col"` header row (UI-SPEC §13.3). */
export function ValueTrendTableTwin({
  points,
  toggle,
  headers,
  formatValueFull,
}: {
  points: readonly TrendValuePoint[];
  toggle: string;
  headers: { date: string; value: string; readings: string };
  formatValueFull: (n: number) => string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { i18n } = useTranslation();
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="trend-value-table">
      {/* The trigger sets aria-expanded and aria-controls and toggles the content (WR-07). */}
      <CollapsibleTrigger asChild>
        <Button type="button" variant="link" size="sm" className={MUTED_LINK_TONE}>
          {toggle}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col" className="text-left font-medium">
                {headers.date}
              </th>
              <th scope="col" className="text-left font-medium">
                {headers.value}
              </th>
              <th scope="col" className="text-left font-medium">
                {headers.readings}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.key}>
                <td>{formatDate(point.xMs, i18n.language)}</td>
                <td className="tabular-nums">{formatValueFull(point.value)}</td>
                <td className="tabular-nums">{point.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CollapsibleContent>
    </Collapsible>
  );
}
