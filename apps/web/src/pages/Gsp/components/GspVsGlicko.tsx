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
import type { GspPoint, Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { chartColors, darkChartOptions, redLineDataset } from '@/lib/chartTheme';
import { computeRatingHistory } from '@/lib/glicko';
import { GSP_VS_GLICKO_MIN_POINTS, buildGspVsGlickoData } from '../lib/gspVsGlicko';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

function buildChartData(
  gsp: { time: number; value: number }[],
  glicko: { time: number; value: number }[],
) {
  const allTimes = [...new Set([...gsp.map((p) => p.time), ...glicko.map((p) => p.time)])].sort(
    (a, b) => a - b,
  );
  const labels = allTimes.map((t) =>
    new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  );

  const gspByTime = new Map(gsp.map((p) => [p.time, p.value]));
  const glickoByTime = new Map(glicko.map((p) => [p.time, p.value]));

  return {
    labels,
    datasets: [
      {
        label: 'GSP (normalized)',
        ...redLineDataset(),
        spanGaps: true,
        data: allTimes.map((t) => gspByTime.get(t) ?? null),
      },
      {
        label: 'Glicko-2 (normalized)',
        borderColor: chartColors.tick,
        backgroundColor: chartColors.tick,
        pointBackgroundColor: chartColors.tick,
        pointBorderColor: chartColors.tick,
        borderDash: [4, 4],
        pointRadius: 3,
        fill: false,
        tension: 0.1,
        spanGaps: true,
        data: allTimes.map((t) => glickoByTime.get(t) ?? null),
      },
    ],
  };
}

function buildChartOptions(): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: theme.scales?.x,
      y: { ...theme.scales?.y, min: 0, max: 100 },
    },
    plugins: {
      legend: { display: true, labels: theme.plugins?.legend?.labels },
      tooltip: { ...theme.plugins?.tooltip, mode: 'index', intersect: false },
    },
  };
}

/**
 * Dual-line overlay of the selected fighter's GSP curve against the player's
 * OVERALL Glicko-2 rating history (all fighters — `computeRatingHistory`),
 * both independently min-max normalized to 0-100 (see `buildGspVsGlickoData`)
 * so they're visually comparable despite being on completely different
 * scales. Skipped entirely when either series has fewer than
 * `GSP_VS_GLICKO_MIN_POINTS` points — there's nothing meaningful to compare
 * yet.
 */
export function GspVsGlicko({
  gspSeries,
  allMatches,
}: {
  gspSeries: GspPoint[];
  allMatches: Match[];
}) {
  const { periods } = computeRatingHistory(allMatches);

  if (gspSeries.length < GSP_VS_GLICKO_MIN_POINTS || periods.length < GSP_VS_GLICKO_MIN_POINTS) {
    return null;
  }

  const { gsp, glicko } = buildGspVsGlickoData(gspSeries, periods);

  return (
    <Card>
      <CardHeader>
        <CardTitle>GSP vs Glicko-2</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="h-64">
          <Line data={buildChartData(gsp, glicko)} options={buildChartOptions()} />
        </div>
        <p className="text-xs text-muted-foreground">
          Both lines are normalized to 0-100 over this window so their shapes are comparable despite
          very different scales. Divergence usually means your quickplay form (GSP, this fighter
          only) differs from your overall form (Glicko-2, across every fighter/session).
        </p>
      </CardContent>
    </Card>
  );
}
