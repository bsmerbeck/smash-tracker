import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildActivityHeat, type ActivityHeat, type Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { ChartCard } from '@/components/charts/ChartCard';
import { MatrixHeat } from '@/components/charts/MatrixHeat';
import { formatGrouped, formatMonthName } from '@/lib/format';

export interface PlayRhythmHeatProps {
  /** The page's range- and source-filtered matches: the SAME base the terminus and `PlayRhythm` read. */
  matches: Match[];
  /** A month cell was activated: that UTC month's inclusive range, for the page's `from` / `to` drill. */
  onSelectMonth: (range: { fromMs: number; toMs: number }) => void;
}

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

const TWIN_TABLE_CLASSES = 'w-full border-collapse text-xs leading-4 tabular-nums';
const TWIN_HEAD_CELL_CLASSES =
  'border-b border-border px-1.5 py-1.5 text-right text-[0.6875rem] font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase first:text-left';
const TWIN_CELL_CLASSES =
  'border-b border-border px-1.5 py-1.5 text-right whitespace-nowrap first:text-left';

/** The first two characters of a month label (`März` becomes `Mä`, `3月` stays `3月`), by code point so no glyph is split. */
function narrowMonthLabel(label: string): string {
  return Array.from(label).slice(0, 2).join('');
}

/** "View as table": every year (the heat itself draws at most the newest nine), months as counts, a year total. */
function HeatTableTwin({
  heat,
  months,
  caption,
  headers,
  toggle,
}: {
  heat: ActivityHeat;
  months: readonly string[];
  caption: string;
  headers: { year: string; total: string };
  toggle: string;
}) {
  const [open, setOpen] = useState(false);
  const { i18n } = useTranslation();
  const locale = i18n.language;

  // Every year, not only the shown ones: the table is where the older years live.
  const countByYearMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const cell of heat.cells) map.set(`${cell.year}:${cell.month}`, cell.total);
    return map;
  }, [heat.cells]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 font-normal"
        data-slot="play-rhythm-table-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {toggle}
      </Button>
      <CollapsibleContent>
        <div data-slot="play-rhythm-table" className="overflow-x-auto">
          <table className={TWIN_TABLE_CLASSES}>
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                  {headers.year}
                </th>
                {months.map((month) => (
                  <th key={month} scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                    {month}
                  </th>
                ))}
                <th scope="col" className={TWIN_HEAD_CELL_CLASSES}>
                  {headers.total}
                </th>
              </tr>
            </thead>
            <tbody>
              {heat.yearTotals.map(({ year, total }) => (
                <tr key={year}>
                  <th scope="row" className={`${TWIN_CELL_CLASSES} font-semibold`}>
                    {year}
                  </th>
                  {MONTHS.map((month) => {
                    const count = countByYearMonth.get(`${year}:${month}`);
                    return (
                      <td
                        key={month}
                        className={`${TWIN_CELL_CLASSES}${count === undefined ? ' text-muted-foreground' : ''}`}
                      >
                        {count === undefined ? '—' : formatGrouped(count, locale)}
                      </td>
                    );
                  })}
                  <td className={TWIN_CELL_CLASSES}>{formatGrouped(total, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The Play rhythm heat (B1, DD-41-05/06, UI-SPEC 7.3): games per UTC month as year rows by month
 * columns, in the 8-col cell beside the `PlayRhythm` read. A month is a button that drills `#games` to
 * exactly that month. At most nine years are drawn (108 cells); older years stay in the table twin.
 */
export function PlayRhythmHeat({ matches, onSelectMonth }: PlayRhythmHeatProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const heat = useMemo(() => buildActivityHeat(matches), [matches]);

  const shortMonths = useMemo(
    () => MONTHS.map((month) => formatMonthName(month, locale, 'short')),
    [locale],
  );
  const narrowMonths = useMemo(() => shortMonths.map(narrowMonthLabel), [shortMonths]);

  const caption =
    heat.totalYears > heat.shownYears
      ? t('trends.rhythm.caption.shownOf', { shown: heat.shownYears, total: heat.totalYears })
      : t('trends.rhythm.caption.years', { count: heat.totalYears });

  return (
    <ChartCard title={t('trends.rhythm.title')} caption={caption} density="compact">
      <MatrixHeat
        scale="volume"
        years={heat.years}
        cells={heat.cells}
        maxCellValue={heat.maxCellValue}
        monthLabels={shortMonths}
        monthLabelsNarrow={narrowMonths}
        yearLabel={(year, narrow) => (narrow ? `'${String(year).slice(-2)}` : String(year))}
        cellAria={(cell) =>
          t('analytics.heat.cellAria', {
            month: formatMonthName(cell.month, locale, 'long'),
            year: cell.year,
            count: cell.total,
          })
        }
        emptyAria={(year, month) =>
          t('analytics.heat.noGames', { month: formatMonthName(month, locale, 'long'), year })
        }
        formatCount={(n) => formatGrouped(n, locale)}
        legend={{
          fewer: t('analytics.heat.legend.fewer'),
          more: t('analytics.heat.legend.more'),
          unit: t('analytics.heat.legend.unit'),
        }}
        onSelectCell={(cell) => onSelectMonth({ fromMs: cell.fromMs, toMs: cell.toMs })}
      />
      <HeatTableTwin
        heat={heat}
        months={shortMonths}
        caption={t('analytics.heat.table.caption')}
        headers={{
          year: t('analytics.timeline.table.headers.year'),
          total: t('analytics.timeline.table.headers.total'),
        }}
        toggle={t('analytics.trend.tableToggle')}
      />
    </ChartCard>
  );
}
