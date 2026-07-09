import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getMonthlyRecords, type MonthlyRecord } from '@/lib/stats';
import { chartColors, darkChartOptions } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

/** Below this many games in a month, the bar renders at reduced opacity as a small-sample cue. */
export const SMALL_SAMPLE_THRESHOLD = 3;

/** Formats a `YYYY-MM` month key as a short human label in the given locale, e.g. '2021-01' -> 'Jan 2021'. */
export function formatMonthLabel(month: string, locale: string): string {
  const [year, monthNum] = month.split('-').map(Number);
  if (!year || !monthNum) return month;
  const date = new Date(Date.UTC(year, monthNum - 1, 1));
  return date.toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Builds the chart.js dataset for the monthly win-rate bar chart. Exported so
 * the bucketing + opacity + tooltip-detail math can be unit-tested without
 * rendering chart.js. Bars for months under `SMALL_SAMPLE_THRESHOLD` games
 * get a reduced-opacity fill as a small-sample visual cue.
 */
export function buildMonthlyChartData(records: MonthlyRecord[], t: TFunction, locale: string) {
  return {
    labels: records.map((r) => formatMonthLabel(r.month, locale)),
    datasets: [
      {
        label: t('trends.monthly.winRateLabel'),
        data: records.map((r) => r.winRate),
        backgroundColor: records.map((r) =>
          r.total < SMALL_SAMPLE_THRESHOLD ? chartColors.redSoft : chartColors.red,
        ),
        borderColor: chartColors.red,
        borderWidth: 1,
        borderRadius: 4,
        // Carried through purely for the tooltip callback below.
        games: records.map((r) => r.total),
      },
    ],
  };
}

function buildMonthlyChartOptions(records: MonthlyRecord[], t: TFunction): ChartOptions<'bar'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: theme.scales?.x,
      y: {
        ...theme.scales?.y,
        suggestedMax: 100,
        beginAtZero: true,
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: chartColors.tooltipBg,
        borderColor: chartColors.tooltipBorder,
        borderWidth: 1,
        callbacks: {
          label: (item) => t('trends.monthly.tooltipRate', { value: item.formattedValue }),
          afterLabel: (item) => {
            const record = records[item.dataIndex];
            return record ? t('trends.monthly.tooltipGames', { count: record.total }) : '';
          },
        },
      },
    },
  };
}

/**
 * V3 Phase F: monthly performance bar chart (win rate per month) plus a
 * compact table below it. Months under `SMALL_SAMPLE_THRESHOLD` games render
 * at reduced opacity, called out in a caption.
 */
export function MonthlyPerformance({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const records = getMonthlyRecords(matches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.monthly.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        ) : (
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex flex-col gap-2 lg:w-3/5">
              <div className="h-64">
                <Bar
                  data={buildMonthlyChartData(records, t, i18n.language)}
                  options={buildMonthlyChartOptions(records, t)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('trends.monthly.caption', { count: SMALL_SAMPLE_THRESHOLD })}
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto lg:w-2/5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('trends.monthly.month')}</TableHead>
                    <TableHead>{t('trends.monthly.wl')}</TableHead>
                    <TableHead>{t('common.rate')}</TableHead>
                    <TableHead>{t('trends.monthly.games')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...records].reverse().map((record) => (
                    <TableRow key={record.month}>
                      <TableCell>{formatMonthLabel(record.month, i18n.language)}</TableCell>
                      <TableCell>
                        {record.wins}-{record.losses}
                      </TableCell>
                      <TableCell>{record.winRate}%</TableCell>
                      <TableCell
                        className={
                          record.total < SMALL_SAMPLE_THRESHOLD
                            ? 'text-muted-foreground'
                            : undefined
                        }
                      >
                        {record.total}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
