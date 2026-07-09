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
import type { GspPoint, GspSettings, TCalibration } from '@smash-tracker/shared';
import { GSP_MODEL } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { chartColors, darkChartOptions, redLineDataset } from '@/lib/chartTheme';
import { calibrationFromSettings, computedEliteThreshold, toMmrSeries } from '../lib/gspMmrModel';
import { useModelCalibration } from '../lib/useModelCalibration';
import { useNowMs } from '../lib/useNowMs';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/** Minimum GSP readings before the curve renders instead of the locked/empty state. */
export const GSP_CURVE_UNLOCK_THRESHOLD = 2;

/** The two y-axis scales the curve can plot (V10.1 adds the converted-MMR view). */
export type GspCurveView = 'gsp' | 'mmr';

function formatPointLabel(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * Per-point marker styling: calibration readings (`win: null` — V17's "set
 * GSP without a match") render as rotated squares, slightly larger than the
 * round match points, so re-baselines are visually distinct on the line.
 */
function calibrationPointStyling(series: GspPoint[]) {
  return {
    pointStyle: series.map((p) => (p.win === null ? ('rectRot' as const) : ('circle' as const))),
    pointRadius: series.map((p) => (p.win === null ? 5 : 3)),
  };
}

/**
 * Builds the chart.js dataset: the GSP line plus a flat "Elite threshold"
 * reference line at the same value across every point, so it renders as a
 * horizontal line regardless of x-axis spacing. Exported as a pure builder so
 * it's unit-testable without rendering chart.js.
 */
export function buildGspCurveData(
  series: GspPoint[],
  eliteThreshold: number,
  t: TFunction,
  locale: string,
) {
  const labels = series.map((p) => formatPointLabel(p.time, locale));
  return {
    labels,
    datasets: [
      {
        label: t('gsp.curve.gspLabel'),
        ...redLineDataset(),
        ...calibrationPointStyling(series),
        data: series.map((p) => p.gsp),
      },
      {
        label: t('gsp.curve.eliteLine'),
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

/**
 * V10.1: the MMR view — every GSP reading converted through the community
 * reverse-engineered model at its own log-time t (see
 * ../lib/gspMmrModel.ts), with a flat Elite line at the fixed Elite entry
 * MMR (1142). Same pure-builder convention as `buildGspCurveData`.
 */
export function buildMmrCurveData(
  series: GspPoint[],
  settings: GspSettings,
  t: TFunction,
  locale: string,
  /** V17.1: pass `useModelCalibration`'s value to fold in the live gsptiers.com reading; defaults to the manual-edit-only calibration. */
  calibration: TCalibration | undefined = calibrationFromSettings(settings),
) {
  const mmrSeries = toMmrSeries(series, calibration);
  return {
    labels: mmrSeries.map((p) => formatPointLabel(p.time, locale)),
    datasets: [
      {
        label: t('gsp.curve.estMmrLabel'),
        ...redLineDataset(),
        ...calibrationPointStyling(series),
        data: mmrSeries.map((p) => Math.round(p.mmr)),
      },
      {
        label: t('gsp.curve.eliteMmrLine', { mmr: GSP_MODEL.ELITE_MMR }),
        data: mmrSeries.map(() => GSP_MODEL.ELITE_MMR),
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

export function buildGspCurveOptions(
  series: GspPoint[],
  locale: string,
  onPointClick?: (index: number) => void,
  /** Optional translator — when given, calibration points get a "(set manually)" tooltip suffix. */
  t?: TFunction,
): ChartOptions<'line'> {
  const theme = darkChartOptions();
  return {
    responsive: theme.responsive,
    maintainAspectRatio: theme.maintainAspectRatio,
    // Same column-wise resolution the tooltip uses, so a click anywhere near
    // a reading's x-position selects that reading (points are small; exact
    // intersection would make click-to-edit feel broken).
    interaction: { mode: 'index', intersect: false },
    ...(onPointClick
      ? {
          onClick: (_event, elements) => {
            const gspPoint = elements.find((el) => el.datasetIndex === 0);
            if (gspPoint) {
              onPointClick(gspPoint.index);
            }
          },
          onHover: (_event, elements, chart) => {
            chart.canvas.style.cursor = elements.some((el) => el.datasetIndex === 0)
              ? 'pointer'
              : 'default';
          },
        }
      : {}),
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
            return point ? new Date(point.time).toLocaleDateString(locale) : '';
          },
          label: (item) => {
            const base = `${item.dataset.label}: ${Number(item.parsed.y).toLocaleString()}`;
            const point = series[item.dataIndex];
            // Only the reading line (dataset 0) carries calibration points —
            // the flat Elite reference line must not inherit the suffix.
            if (t && item.datasetIndex === 0 && point?.win === null) {
              return `${base} (${t('gsp.curve.setManually')})`;
            }
            return base;
          },
        },
      },
    },
  };
}

/**
 * GSP-over-time line chart for the selected fighter (V10.1: with a GSP | MMR
 * view toggle). The GSP view keeps V10's dashed line at the (now computed)
 * Elite threshold; the MMR view plots the same readings converted to the
 * hidden-MMR scale, where flat skill shows as a flat line instead of the
 * steady inflation GSP's rising ceiling bakes in. Responsive per
 * `chartTheme`'s `maintainAspectRatio: false` convention (V9-C) — needs a
 * fixed-height wrapper div to actually fill.
 */
export function GspCurve({
  series,
  settings,
  onPointClick,
}: {
  series: GspPoint[];
  settings: GspSettings;
  /** V14: click a reading on the curve to act on it (the page opens the match or calibration-reading edit dialog). Index-aligned with `series`/`getGspEntries`. */
  onPointClick?: (index: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const nowMs = useNowMs();
  const [view, setView] = useState<GspCurveView>('gsp');
  const hasEnoughReadings = series.length >= GSP_CURVE_UNLOCK_THRESHOLD;

  const calibration = useModelCalibration(settings);
  const eliteThreshold = computedEliteThreshold(nowMs, calibration);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          {t('gsp.curve.title')}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view}
            onValueChange={(value) => {
              if (value === 'gsp' || value === 'mmr') setView(value);
            }}
          >
            <ToggleGroupItem value="gsp" aria-label={t('gsp.curve.gspViewAria')}>
              GSP
            </ToggleGroupItem>
            <ToggleGroupItem value="mmr" aria-label={t('gsp.curve.mmrViewAria')}>
              MMR
            </ToggleGroupItem>
          </ToggleGroup>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {hasEnoughReadings ? (
          <>
            <div className="h-64">
              <Line
                data={
                  view === 'mmr'
                    ? buildMmrCurveData(series, settings, t, i18n.language, calibration)
                    : buildGspCurveData(series, eliteThreshold, t, i18n.language)
                }
                options={buildGspCurveOptions(series, i18n.language, onPointClick, t)}
              />
            </div>
            {view === 'mmr' ? (
              <p className="text-xs text-muted-foreground">
                {t('gsp.curve.mmrCaption', { mmr: GSP_MODEL.ELITE_MMR })}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('gsp.curve.gspCaption')}
                {onPointClick && ` ${t('gsp.curve.clickHint')}`}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('gsp.curve.locked', { count: GSP_CURVE_UNLOCK_THRESHOLD })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
