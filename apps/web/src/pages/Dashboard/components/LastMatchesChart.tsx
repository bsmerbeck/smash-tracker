import { useState } from 'react';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  TILE_CARD_CLASS,
  TILE_CONTENT_CLASS,
  TILE_HEADER_CLASS,
} from '@/components/analytics/cardDensity';
import {
  ABSTENTION_FLOOR_GAMES,
  resolveWindow,
  type HorizonKey,
  type Match,
} from '@smash-tracker/shared';
import { getRunningWinRateSeries, type RunningWinRatePoint } from '@/lib/stats';
import { chartColors, darkChartOptions, seriesLineDataset } from '@/lib/chartTheme';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { useDashboardContext } from '../DashboardContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

type SeriesPoint = RunningWinRatePoint;

/**
 * Plan 39.1-39 (UI-SPEC §10.4 "never a per-chart control", D-06): the Form
 * Curve plots the page horizon's window of the selected fighter's games —
 * the page-level window `resolveWindow({ scoped: false })` resolves (Trends'
 * convention; a chart asserts no direction, so D-15's 12-month bound does
 * not apply) — as a running win rate from the window's FIRST game. No
 * rolling-N smoothing (CHRT-03).
 *
 * Phase 11 FB-10's intent survives in the horizon form: the chosen window
 * LIMITS which games plot, so two horizons plot different game sets (the
 * card's own "Window: Last N / Cumulative" select, which FB-10 fixed, is
 * gone). `matches` already carries the global analytics source/time-range
 * filter (the caller's `useFilteredMatches`).
 */
export function buildFormCurveSeries(
  matches: Match[],
  horizon: HorizonKey,
  nowMs: number,
): SeriesPoint[] {
  const { matches: windowed } = resolveWindow({ matches, horizon, scoped: false, nowMs });
  return getRunningWinRateSeries(windowed);
}

/**
 * The chart.js data: one line on the tokenised series ink (DD-11 — brand red
 * is never a data mark). Not exported (a second non-component export would
 * add a react-refresh lint warning); its test reads the `data` prop through a
 * file-local react-chartjs-2 mock.
 */
function buildFormCurveData(series: SeriesPoint[], label: string) {
  return {
    labels: series.map((point) => point.index.toString()),
    datasets: [
      {
        label,
        ...seriesLineDataset(),
        data: series.map((point) => point.winRate),
      },
    ],
  };
}

/** Ports legacy/src/screens/Dashboard/components/LastMatchesChart; a running win-rate form curve over the page horizon's window (plan 39.1-39). */
export function LastMatchesChart({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { t, i18n } = useTranslation();
  const { fighter } = useDashboardContext();
  // The window's "now" is fixed for the page's life (the codebase's lazy
  // initializer pattern) so a re-render never shifts the last-90-days edge.
  const [nowMs] = useState(() => Date.now());
  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];
  const series = buildFormCurveSeries(fighterMatches, horizon, nowMs);
  const showChart = series.length >= ABSTENTION_FLOOR_GAMES;

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardHeader className={TILE_HEADER_CLASS}>
        <CardTitle>{t('dashboard.formCurve.title')}</CardTitle>
        {showChart && (
          <p data-slot="form-curve-caption" className="text-xs text-muted-foreground">
            {/* Plan 39.1-50 (owner: no text legends; sketches 001-C / 002-C):
                the series is named by this caption's series-ink swatch. */}
            <span
              aria-hidden="true"
              data-slot="form-curve-swatch"
              className="mr-1.5 inline-block h-0.5 w-3 align-middle"
              style={{ backgroundColor: chartColors.series }}
            />
            {t(`dashboard.formCurve.caption.${horizon}`)}
          </p>
        )}
      </CardHeader>
      <CardContent className={TILE_CONTENT_CLASS}>
        {fighterMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboard.formCurve.empty')}</p>
        ) : !showChart ? (
          <p data-slot="form-curve-window-empty" className="text-sm text-muted-foreground">
            {t(`dashboard.formCurve.windowEmpty.${horizon}`)}
          </p>
        ) : (
          // h-40 = CHART_H_COMPACT (160px, below 640); sm:h-72 = CHART_H_DEFAULT (288px, 640 up).
          <div className="h-40 sm:h-72">
            <Line
              data={buildFormCurveData(series, t('dashboard.formCurve.winRate'))}
              options={buildOptions(series, t, i18n.language)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Builds chart options with tooltip callbacks closed over `series` so they can look up the underlying Match for the hovered point (date + opponent), mirroring legacy MatchChart's tooltip title/footer. */
function buildOptions(series: SeriesPoint[], t: TFunction, locale: string): ChartOptions<'line'> {
  const theme = darkChartOptions();
  // Plan 39.1-50 (owner: no rotated index ticks): only the two ends are
  // labelled, each with its plotted game's date — and only the right end
  // when both fall on the same calendar day.
  const endDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const first = series[0];
  const last = series[series.length - 1];
  const sameDay =
    first != null &&
    last != null &&
    new Date(first.match.time).toDateString() === new Date(last.match.time).toDateString();
  const endTick = (index: number): string => {
    const lastIndex = series.length - 1;
    if (index === lastIndex && last) return endDate.format(new Date(last.match.time));
    if (index === 0 && first && !sameDay) return endDate.format(new Date(first.match.time));
    return '';
  };
  const themeX = theme.scales?.x;
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: {
        ...themeX,
        grid: { display: false },
        ticks: {
          ...themeX?.ticks,
          maxRotation: 0,
          minRotation: 0,
          autoSkip: false,
          align: 'inner',
          callback: (_value, index) => endTick(index),
        },
      },
      y: {
        ...theme.scales?.y,
        position: 'right',
        suggestedMax: 100,
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...theme.plugins?.tooltip,
        mode: 'nearest',
        intersect: true,
        callbacks: {
          title: (items) => {
            const point = series[items[0]?.dataIndex ?? -1];
            if (!point) return '';
            return new Date(point.match.time).toLocaleDateString(locale);
          },
          label: (item) => `: ${Math.round(Number(item.formattedValue) * 100) / 100}%`,
          footer: (items) => {
            const point = series[items[0]?.dataIndex ?? -1];
            if (!point) return '';
            const opponent = getFighterById(point.match.opponent_id);
            return t('dashboard.formCurve.opponent', {
              name: opponent
                ? localizedFighterName(point.match.opponent_id, t)
                : t('common.unknown'),
            });
          },
        },
      },
    },
  };
}
