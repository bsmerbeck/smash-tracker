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
import { chartColors, darkChartOptions } from '@/lib/chartTheme';
import { formatMonthLabel } from './MonthlyPerformance';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

/** The four buckets matches are grouped into for the mix chart, in stack/legend order. */
export const MATCH_TYPE_BUCKETS = ['tourney', 'friendly', 'quickplay', 'unspecified'] as const;
export type MatchTypeBucket = (typeof MATCH_TYPE_BUCKETS)[number];

const BUCKET_COLORS: Record<MatchTypeBucket, string> = {
  tourney: '#e60012',
  friendly: '#3b82f6',
  quickplay: '#eab308',
  unspecified: '#71717a',
};

const BUCKET_LABEL_KEYS: Record<MatchTypeBucket, string> = {
  tourney: 'trends.mix.tourney',
  friendly: 'trends.mix.friendly',
  quickplay: 'trends.mix.quickplay',
  unspecified: 'trends.mix.unspecified',
};

/** Buckets a stored `matchType` literal into one of the four mix categories. */
export function bucketMatchType(matchType: Match['matchType']): MatchTypeBucket {
  const type = matchType ?? '';
  if (type === 'online-tourney' || type === 'offline-tourney') return 'tourney';
  if (type === 'online-friendly' || type === 'offline-friendly') return 'friendly';
  if (type === 'quickplay') return 'quickplay';
  return 'unspecified';
}

export interface MonthlyMatchTypeMix {
  month: string;
  counts: Record<MatchTypeBucket, number>;
}

/**
 * Games played per month, split by match-type bucket. Exported as a pure
 * builder so the bucketing + monthly grouping is unit-testable without
 * rendering chart.js. Months are chronological ascending (same convention as
 * `getMonthlyRecords`).
 */
export function buildMonthlyMatchTypeMix(matches: Match[]): MonthlyMatchTypeMix[] {
  const byMonth = new Map<string, Record<MatchTypeBucket, number>>();
  for (const match of matches) {
    const d = new Date(match.time);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = bucketMatchType(match.matchType);
    const counts = byMonth.get(month) ?? {
      tourney: 0,
      friendly: 0,
      quickplay: 0,
      unspecified: 0,
    };
    counts[bucket] += 1;
    byMonth.set(month, counts);
  }
  return [...byMonth.entries()]
    .map(([month, counts]) => ({ month, counts }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function buildChartData(mix: MonthlyMatchTypeMix[], t: TFunction, locale: string) {
  return {
    labels: mix.map((m) => formatMonthLabel(m.month, locale)),
    datasets: MATCH_TYPE_BUCKETS.map((bucket) => ({
      label: t(BUCKET_LABEL_KEYS[bucket]),
      data: mix.map((m) => m.counts[bucket]),
      backgroundColor: BUCKET_COLORS[bucket],
      stack: 'games',
    })),
  };
}

function buildChartOptions(): ChartOptions<'bar'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: { ...theme.scales?.x, stacked: true },
      y: { ...theme.scales?.y, stacked: true, beginAtZero: true },
    },
    plugins: {
      legend: { display: true, labels: theme.plugins?.legend?.labels },
      tooltip: {
        backgroundColor: chartColors.tooltipBg,
        borderColor: chartColors.tooltipBorder,
        borderWidth: 1,
      },
    },
  };
}

/**
 * V3 Phase F (item 5): games played per month, stacked by match-type bucket
 * (tourney/friendly/quickplay/unspecified). Kept intentionally simple — no
 * interactivity beyond the chart.js default tooltip.
 */
export function MatchTypeMix({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const mix = buildMonthlyMatchTypeMix(matches);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('trends.mix.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {mix.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        ) : (
          <div className="h-56">
            <Bar data={buildChartData(mix, t, i18n.language)} options={buildChartOptions()} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
