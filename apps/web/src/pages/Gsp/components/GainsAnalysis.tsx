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
import type { GspGainStats } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { chartColors, darkChartOptions } from '@/lib/chartTheme';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

function buildPerWinGainsData(perWinGains: number[]) {
  return {
    labels: perWinGains.map((_, i) => String(i + 1)),
    datasets: [
      {
        label: 'GSP gained',
        data: perWinGains,
        backgroundColor: chartColors.red,
        borderRadius: 2,
      },
    ],
  };
}

function buildPerWinGainsOptions(): ChartOptions<'bar'> {
  const theme = darkChartOptions();
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { ...theme.scales?.x, display: false },
      y: {
        ...theme.scales?.y,
        ticks: { ...theme.scales?.y?.ticks, callback: (value) => Number(value).toLocaleString() },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: chartColors.tooltipBg,
        borderColor: chartColors.tooltipBorder,
        borderWidth: 1,
        callbacks: {
          title: (items) => `Win #${items[0]?.label ?? ''}`,
          label: (item) => `+${Number(item.parsed.y).toLocaleString()} GSP`,
        },
      },
    },
  };
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}

function formatGsp(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString();
}

/**
 * Win/loss GSP gain analysis for the selected fighter: lifetime vs. last-20
 * average gain/drop, the single biggest gain observed, and a bar of per-win
 * gains over time visualizing the shrink documented at the top of
 * `packages/shared/src/gsp.ts` (gains per win shrink as GSP climbs — the
 * bell-curve tail effect).
 */
export function GainsAnalysis({ stats }: { stats: GspGainStats }) {
  const hasData = stats.perWinGains.length > 0 || stats.avgDropPerLossLifetime !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gains Analysis</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {hasData ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <StatBlock
                label="Avg gain/win (lifetime)"
                value={formatGsp(stats.avgGainPerWinLifetime)}
              />
              <StatBlock
                label="Avg drop/loss (lifetime)"
                value={formatGsp(stats.avgDropPerLossLifetime)}
              />
              <StatBlock label="Biggest single gain" value={formatGsp(stats.biggestGain)} />
              <StatBlock
                label="Avg gain/win (last 20)"
                value={formatGsp(stats.avgGainPerWinLast20)}
              />
              <StatBlock
                label="Avg drop/loss (last 20)"
                value={formatGsp(stats.avgDropPerLossLast20)}
              />
              <StatBlock label="Biggest single drop" value={formatGsp(stats.biggestDrop)} />
            </div>

            {stats.perWinGains.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-muted-foreground">
                  Per-win gains over time
                  {stats.gainTrend === 'shrinking' && ' — shrinking as your GSP climbs'}
                  {stats.gainTrend === 'growing' && ' — trending up'}
                </p>
                <div className="h-32">
                  <Bar
                    data={buildPerWinGainsData(stats.perWinGains)}
                    options={buildPerWinGainsOptions()}
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Log a few wins and losses with GSP readings to see your gain/loss trends.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
