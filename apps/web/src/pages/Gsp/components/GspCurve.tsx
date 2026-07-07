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
import type { GspPoint } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { chartColors, darkChartOptions, redLineDataset } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/** Minimum GSP readings before the curve renders instead of the locked/empty state. */
export const GSP_CURVE_UNLOCK_THRESHOLD = 2;

function formatPointLabel(time: number): string {
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Builds the chart.js dataset: the GSP line plus a flat "Elite threshold"
 * reference line at the same value across every point, so it renders as a
 * horizontal line regardless of x-axis spacing. Exported as a pure builder so
 * it's unit-testable without rendering chart.js.
 */
export function buildGspCurveData(series: GspPoint[], eliteThreshold: number) {
  const labels = series.map((p) => formatPointLabel(p.time));
  return {
    labels,
    datasets: [
      {
        label: 'GSP',
        ...redLineDataset(),
        data: series.map((p) => p.gsp),
      },
      {
        label: 'Elite threshold',
        data: series.map(() => eliteThreshold),
        borderColor: chartColors.grid,
        backgroundColor: chartColors.grid,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 1.5,
        fill: false,
        tension: 0,
      },
    ],
  };
}

function buildGspCurveOptions(series: GspPoint[]): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    scales: {
      x: theme.scales?.x,
      y: {
        ...theme.scales?.y,
        ticks: {
          ...theme.scales?.y?.ticks,
          callback: (value) => Number(value).toLocaleString(),
        },
      },
    },
    plugins: {
      legend: { display: true, labels: theme.plugins?.legend?.labels },
      tooltip: {
        ...theme.plugins?.tooltip,
        mode: 'index',
        intersect: false,
        callbacks: {
          title: (items) => {
            const point = series[items[0]?.dataIndex ?? -1];
            return point ? new Date(point.time).toLocaleDateString('en-US') : '';
          },
          label: (item) => `${item.dataset.label}: ${Number(item.parsed.y).toLocaleString()}`,
        },
      },
    },
  };
}

/**
 * GSP-over-time line chart for the selected fighter, with a dashed horizontal
 * line at the user's Elite Smash threshold setting (V10). Responsive per
 * `chartTheme`'s `maintainAspectRatio: false` convention (V9-C) — needs a
 * fixed-height wrapper div to actually fill.
 */
export function GspCurve({
  series,
  eliteThreshold,
}: {
  series: GspPoint[];
  eliteThreshold: number;
}) {
  const hasEnoughReadings = series.length >= GSP_CURVE_UNLOCK_THRESHOLD;

  return (
    <Card>
      <CardHeader>
        <CardTitle>GSP Curve</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {hasEnoughReadings ? (
          <>
            <div className="h-64">
              <Line
                data={buildGspCurveData(series, eliteThreshold)}
                options={buildGspCurveOptions(series)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Every point is a logged post-match GSP reading for this fighter. The dashed line is
              your Elite Smash threshold setting — an estimate, not a Nintendo-published value.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Log at least {GSP_CURVE_UNLOCK_THRESHOLD} matches with a GSP reading for this fighter to
            see the curve.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
