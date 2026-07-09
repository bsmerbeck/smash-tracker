import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GlickoExplainer } from '@/components/GlickoExplainer';
import { computeRatingHistory, type RatingPeriodResult } from '@/lib/glicko';
import { chartColors, darkChartOptions, redLineDataset } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/** Minimum total games before the curve renders instead of the locked state — mirrors the Dashboard Rating card's `RATING_UNLOCK_THRESHOLD`. */
export const RATING_CURVE_UNLOCK_THRESHOLD = 5;

/** Formats a rating period's end date as a short x-axis label in the given locale, e.g. "Jan 5". */
export function formatPeriodLabel(period: RatingPeriodResult, locale: string): string {
  return new Date(period.end).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * Builds the chart.js dataset for the rating curve: the rating line plus a
 * muted upper/lower ±RD line pair (chart.js `fill`-based banding between two
 * datasets is fussy to theme correctly on this dark palette, so per the task
 * spec we render the band as a plain line pair instead — still reads clearly
 * as an uncertainty envelope around the rating line). Exported as a pure
 * builder so the series math can be unit-tested without rendering chart.js.
 */
export function buildRatingCurveData(periods: RatingPeriodResult[], t: TFunction, locale: string) {
  const labels = periods.map((p) => formatPeriodLabel(p, locale));
  return {
    labels,
    datasets: [
      {
        label: t('trends.ratingCurve.ratingLabel'),
        ...redLineDataset(),
        data: periods.map((p) => p.rating),
      },
      {
        label: '+RD',
        data: periods.map((p) => p.rating + p.rd),
        borderColor: chartColors.grid,
        backgroundColor: chartColors.grid,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 1,
        fill: false,
        tension: 0.1,
      },
      {
        label: '-RD',
        data: periods.map((p) => p.rating - p.rd),
        borderColor: chartColors.grid,
        backgroundColor: chartColors.grid,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 1,
        fill: false,
        tension: 0.1,
      },
    ],
  };
}

function buildRatingCurveOptions(
  periods: RatingPeriodResult[],
  t: TFunction,
  locale: string,
): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: theme.scales?.x,
      y: {
        ...theme.scales?.y,
      },
    },
    plugins: {
      legend: {
        display: true,
        labels: theme.plugins?.legend?.labels,
      },
      tooltip: {
        ...theme.plugins?.tooltip,
        mode: 'index',
        intersect: false,
        callbacks: {
          title: (items) => {
            const period = periods[items[0]?.dataIndex ?? -1];
            if (!period) return '';
            return new Date(period.end).toLocaleDateString(locale);
          },
          afterBody: (items) => {
            const period = periods[items[0]?.dataIndex ?? -1];
            return period ? t('trends.ratingCurve.tooltipGames', { count: period.games }) : '';
          },
        },
      },
    },
  };
}

/**
 * V6-W2: session-based Glicko-2 rating curve across the account's full
 * history (respects the global source/time-range filter, like the rest of
 * Trends). Mirrors the Dashboard hero Rating card's data source
 * (`computeRatingHistory`) and unlock threshold, but plots the full curve
 * (one point per rating period/session) instead of just the current value,
 * with a muted +/-RD line pair as a lightweight uncertainty band and a
 * current-rating callout.
 */
export function RatingCurve({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const hasEnoughGames = matches.length >= RATING_CURVE_UNLOCK_THRESHOLD;
  const { periods, current } = computeRatingHistory(matches);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {t('trends.ratingCurve.title')}
          <GlickoExplainer />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {hasEnoughGames && current && periods.length > 0 ? (
          <>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold">
                {current.rating} <span className="text-lg font-normal">&plusmn;{current.rd}</span>
              </span>
              <span className="pb-1 text-sm text-muted-foreground">
                {t('trends.ratingCurve.current')}
              </span>
            </div>
            <div className="h-64">
              <Line
                data={buildRatingCurveData(periods, t, i18n.language)}
                options={buildRatingCurveOptions(periods, t, i18n.language)}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('trends.ratingCurve.caption')}</p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t('trends.ratingCurve.locked', { count: RATING_CURVE_UNLOCK_THRESHOLD })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('trends.ratingCurve.progress', {
                played: matches.length,
                threshold: RATING_CURVE_UNLOCK_THRESHOLD,
              })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
