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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Match } from '@smash-tracker/shared';
import {
  getRollingWinRate,
  getRunningWinRateSeries,
  type RollingWinRatePoint,
  type RunningWinRatePoint,
} from '@/lib/stats';
import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { useDashboardContext } from '../DashboardContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const WINDOW_OPTIONS = [5, 10, 20] as const;
type WindowOption = (typeof WINDOW_OPTIONS)[number];
type WindowValue = WindowOption | 'cumulative';

type SeriesPoint = RollingWinRatePoint | RunningWinRatePoint;

/**
 * Builds the chart series for the selected window. `'cumulative'` falls back
 * to `getRunningWinRateSeries` (the original all-time running rate) and
 * plots every match. A numeric window (5/10/20) uses `getRollingWinRate`
 * (the v3 form curve's trailing-average smoothing) but then SLICES to only
 * the trailing `window` points.
 *
 * Phase 11 fix round 3 (FB-10, BUG): before this fix, a numeric window only
 * changed the trailing-average smoothing width — every match still plotted,
 * so picking "Last 5" and "Last 20" produced curves of identical length
 * (only the y-values differed), reading to the owner as "plots ALL data
 * regardless of the selected window." The slice below makes the window
 * selector also limit which matches are shown, matching its plain-language
 * "Last N" label. `matches` itself already carries the global analytics
 * source/time-range filter (applied by the caller via `useFilteredMatches`
 * before it ever reaches this component) — that coupling was already
 * correct and is unchanged here.
 */
export function buildSeries(matches: Match[], window: WindowValue): SeriesPoint[] {
  if (window === 'cumulative') {
    return getRunningWinRateSeries(matches);
  }
  return getRollingWinRate(matches, window).slice(-window);
}

/** Ports legacy/src/screens/Dashboard/components/LastMatchesChart; upgraded to a rolling win-rate form curve with a window selector (V3 Phase C). */
export function LastMatchesChart({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const { fighter } = useDashboardContext();
  const [window, setWindow] = useState<WindowValue>(10);
  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];
  const series = buildSeries(fighterMatches, window);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('dashboard.formCurve.title')}</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('dashboard.formCurve.window')}</span>
          <Select value={String(window)} onValueChange={(v) => setWindow(parseWindow(v))}>
            <SelectTrigger className="w-[130px]" aria-label={t('dashboard.formCurve.windowAria')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {t('dashboard.formCurve.lastN', { count: option })}
                </SelectItem>
              ))}
              <SelectItem value="cumulative">{t('dashboard.formCurve.cumulative')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboard.formCurve.empty')}</p>
        ) : (
          <div className="h-64">
            <Line data={buildData(series, t)} options={buildOptions(series, t, i18n.language)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function parseWindow(value: string): WindowValue {
  if (value === 'cumulative') {
    return value;
  }
  const parsed = Number(value);
  return (WINDOW_OPTIONS as readonly number[]).includes(parsed) ? (parsed as WindowOption) : 10;
}

function buildData(series: SeriesPoint[], t: TFunction) {
  return {
    labels: series.map((point) => point.index.toString()),
    datasets: [
      {
        label: t('dashboard.formCurve.winRate'),
        ...redLineDataset(),
        data: series.map((point) => point.winRate),
      },
    ],
  };
}

/** Builds chart options with tooltip callbacks closed over `series` so they can look up the underlying Match for the hovered point (date + opponent), mirroring legacy MatchChart's tooltip title/footer. */
function buildOptions(series: SeriesPoint[], t: TFunction, locale: string): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: theme.scales?.x,
      y: {
        ...theme.scales?.y,
        position: 'right',
        suggestedMax: 100,
      },
    },
    plugins: {
      legend: {
        display: true,
        labels: theme.plugins?.legend?.labels,
      },
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
