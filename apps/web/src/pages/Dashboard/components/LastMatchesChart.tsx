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
import { getRunningWinRateSeries } from '@/lib/stats';
import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';
import { getFighterById } from '@/data/sprites';
import { useDashboardContext } from '../DashboardContext';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/** Ports legacy/src/screens/Dashboard/components/LastMatchesChart. */
export function LastMatchesChart({ matches }: { matches: Match[] }) {
  const { fighter } = useDashboardContext();
  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];
  const series = getRunningWinRateSeries(fighterMatches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Match History</CardTitle>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="text-sm text-muted-foreground">Submit a match to see the match chart.</p>
        ) : (
          <Line data={buildData(series)} options={buildOptions(series)} />
        )}
      </CardContent>
    </Card>
  );
}

function buildData(series: ReturnType<typeof getRunningWinRateSeries>) {
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

/** Builds chart options with tooltip callbacks closed over `series` so they can look up the underlying Match for the hovered point (date + opponent), mirroring legacy MatchChart's tooltip title/footer. */
function buildOptions(series: ReturnType<typeof getRunningWinRateSeries>): ChartOptions<'line'> {
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
          footer: (items) => {
            const point = series[items[0]?.dataIndex ?? -1];
            if (!point) return '';
            const opponent = getFighterById(point.match.opponent_id);
            return `Opponent: ${opponent?.name ?? 'Unknown'}`;
          },
        },
      },
    },
  };
}
