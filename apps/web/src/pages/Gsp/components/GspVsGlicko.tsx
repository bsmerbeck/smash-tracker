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
import type { GspPoint, GspSettings, Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { chartColors, darkChartOptions, redLineDataset } from '@/lib/chartTheme';
import { computeRatingHistory } from '@/lib/glicko';
import { GSP_VS_GLICKO_MIN_POINTS, buildGspVsGlickoData } from '../lib/gspVsGlicko';
import { useModelCalibration } from '../lib/useModelCalibration';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

function buildChartData(
  mmr: { time: number; value: number }[],
  glicko: { time: number; value: number }[],
  t: TFunction,
  locale: string,
) {
  const allTimes = [...new Set([...mmr.map((p) => p.time), ...glicko.map((p) => p.time)])].sort(
    (a, b) => a - b,
  );
  const labels = allTimes.map((time) =>
    new Date(time).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
  );

  const mmrByTime = new Map(mmr.map((p) => [p.time, p.value]));
  const glickoByTime = new Map(glicko.map((p) => [p.time, p.value]));

  return {
    labels,
    datasets: [
      {
        label: t('gsp.vsGlicko.mmrLabel'),
        ...redLineDataset(),
        spanGaps: true,
        data: allTimes.map((t) => mmrByTime.get(t) ?? null),
      },
      {
        label: t('gsp.vsGlicko.glickoLabel'),
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
 * Dual-line overlay of the selected fighter's ESTIMATED MMR curve (V10.1 —
 * GSP readings converted through the community reverse-engineered model,
 * rating vs. rating) against the player's OVERALL Glicko-2 rating history
 * (all fighters — `computeRatingHistory`). Both series remain independently
 * min-max normalized to 0-100 — their raw scales are still unrelated — but
 * comparing two drift-free ratings makes the SHAPES honestly comparable,
 * where V10's raw GSP baked ceiling-inflation into its line (see
 * `buildGspVsGlickoData` for the full rationale). Skipped entirely when
 * either series has fewer than `GSP_VS_GLICKO_MIN_POINTS` points — there's
 * nothing meaningful to compare yet.
 */
export function GspVsGlicko({
  gspSeries,
  allMatches,
  settings,
}: {
  gspSeries: GspPoint[];
  allMatches: Match[];
  settings: GspSettings;
}) {
  const { t, i18n } = useTranslation();
  // Hook must run before the early return below.
  const calibration = useModelCalibration(settings);
  const { periods } = computeRatingHistory(allMatches);

  if (gspSeries.length < GSP_VS_GLICKO_MIN_POINTS || periods.length < GSP_VS_GLICKO_MIN_POINTS) {
    return null;
  }

  const { mmr, glicko } = buildGspVsGlickoData(gspSeries, periods, calibration);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('gsp.vsGlicko.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="h-64">
          <Line
            data={buildChartData(mmr, glicko, t, i18n.language)}
            options={buildChartOptions()}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('gsp.vsGlicko.caption')}</p>
      </CardContent>
    </Card>
  );
}
