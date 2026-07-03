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
import type { Match } from '@smash-tracker/shared';
import { getRollingWinRate } from '@/lib/stats';
import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const ROLLING_WINDOW = 5;

/** Rolling (trailing-5) win-rate trend across all matches vs this opponent. */
export function ScoutingTrendChart({ matches }: { matches: Match[] }) {
  const series = getRollingWinRate(matches, ROLLING_WINDOW);

  return (
    <Card>
      <CardHeader>
        <CardTitle>H2H Trend</CardTitle>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not enough matches for a trend yet.</p>
        ) : (
          <Line data={buildData(series)} options={buildOptions(series)} />
        )}
      </CardContent>
    </Card>
  );
}

function buildData(series: ReturnType<typeof getRollingWinRate>) {
  return {
    labels: series.map((point) => point.index.toString()),
    datasets: [
      {
        label: `Rolling win rate (last ${ROLLING_WINDOW})`,
        ...redLineDataset(),
        data: series.map((point) => point.winRate),
      },
    ],
  };
}

function buildOptions(series: ReturnType<typeof getRollingWinRate>): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
    scales: {
      x: theme.scales?.x,
      y: {
        ...theme.scales?.y,
        position: 'right',
        suggestedMax: 100,
        suggestedMin: 0,
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
