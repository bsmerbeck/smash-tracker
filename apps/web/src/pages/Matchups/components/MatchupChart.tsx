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
import { getRunningWinRateSeries } from '@/lib/stats';
import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/** Ports legacy/src/screens/Matchups/components/MatchupChart — win rate over time for the specific matchup. */
export function MatchupChart({ matchupMatches }: { matchupMatches: Match[] }) {
  const series = getRunningWinRateSeries(matchupMatches);

  if (series.length === 0) {
    return <p className="text-sm text-muted-foreground">Submit a match to see the match chart.</p>;
  }

  return <Line data={buildData(series)} options={buildOptions(series)} />;
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

/** Builds chart options with tooltip callbacks closed over `series`, mirroring legacy MatchChart's tooltip title/footer (date + opponent's fighter name). */
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
        },
      },
    },
  };
}
