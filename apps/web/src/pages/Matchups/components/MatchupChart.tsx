import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getRollingWinRate,
  getRunningWinRateSeries,
  type RollingWinRatePoint,
  type RunningWinRatePoint,
} from '@/lib/stats';
import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

export type TrendMode = '5' | '10' | 'cumulative';

const TREND_OPTIONS: { value: TrendMode; label: string }[] = [
  { value: '5', label: 'Rolling 5' },
  { value: '10', label: 'Rolling 10' },
  { value: 'cumulative', label: 'Cumulative' },
];

type TrendPoint = RollingWinRatePoint | RunningWinRatePoint;

/**
 * Builds the trend series for the given mode — the pure part of the chart,
 * factored out so window-switching logic is unit-testable without mounting
 * chart.js. 'cumulative' mirrors the original all-time running win rate;
 * '5'/'10' use the trailing-window "form curve" from the v3 stats engine.
 */
export function buildTrendSeries(matches: Match[], mode: TrendMode): TrendPoint[] {
  if (mode === 'cumulative') {
    return getRunningWinRateSeries(matches);
  }
  return getRollingWinRate(matches, Number(mode));
}

/** Ports legacy/src/screens/Matchups/components/MatchupChart — win rate over time for the specific matchup, upgraded with a rolling-window selector (default 5) and a cumulative fallback. */
export function MatchupChart({ matchupMatches }: { matchupMatches: Match[] }) {
  const [mode, setMode] = useState<TrendMode>('5');
  const series = buildTrendSeries(matchupMatches, mode);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <span className="text-sm text-muted-foreground">Window</span>
        <Select value={mode} onValueChange={(value) => setMode(value as TrendMode)}>
          <SelectTrigger className="w-[140px]" aria-label="Trend window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TREND_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {series.length === 0 ? (
        <p className="text-sm text-muted-foreground">Submit a match to see the match chart.</p>
      ) : (
        <Line data={buildData(series)} options={buildOptions(series)} />
      )}
    </div>
  );
}

function buildData(series: TrendPoint[]) {
  return {
    labels: series.map((point) => point.index.toString()),
    datasets: [
      {
        label: 'Win Rate',
        ...redLineDataset(),
        data: series.map((point) => point.winRate),
      },
    ],
  };
}

/** Builds chart options with tooltip callbacks closed over `series`, mirroring legacy MatchChart's tooltip title/footer (date + opponent's fighter name). */
function buildOptions(series: TrendPoint[]): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
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
            return new Date(point.match.time).toLocaleDateString('en-US');
          },
          label: (item) => `: ${Math.round(Number(item.formattedValue) * 100) / 100}%`,
        },
      },
    },
  };
}
