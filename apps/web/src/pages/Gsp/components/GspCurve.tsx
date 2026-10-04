import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GspPoint, GspSettings, ValueSeriesReading } from '@smash-tracker/shared';
import { GSP_MODEL, buildValueSeries } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  TrendLine,
  type TrendValuePoint,
  type TrendValueReference,
} from '@/components/charts/TrendLine';
import { CHART_H_COMPACT, CHART_H_DEFAULT } from '@/components/charts/tokens';
import { referencePlacement } from '@/components/charts/valueTrendGeometry';
import { SegmentedControl } from '@/components/analytics/SegmentedControl';
import { formatCompact, formatDate, formatGrouped } from '@/lib/format';
import { computedEliteThreshold, toMmrSeries } from '../lib/gspMmrModel';
import { useModelCalibration } from '../lib/useModelCalibration';
import { useNowMs } from '../lib/useNowMs';

/** Minimum GSP readings before the curve renders instead of the locked/empty state. */
export const GSP_CURVE_UNLOCK_THRESHOLD = 2;

/** The two y-axis scales the curve can plot (V10.1 adds the converted-MMR view). */
export type GspCurveView = 'gsp' | 'mmr';

/** A plot under 520px re-grains to a series of this many points (UI-SPEC E3 overflow). */
const GSP_CURVE_NARROW_TARGET = 30;
/** The default line-chart mark bound (UI-SPEC §9.1): at most this many points are drawn. */
const GSP_CURVE_TARGET = 60;
/** Below Tailwind's `sm` breakpoint the plot is the compact height with the thin stroke. */
const NARROW_VIEWPORT_QUERY = '(max-width: 639px)';

/** jsdom has no `matchMedia`, so a test always sees the desktop height. */
function useIsNarrowViewport(): boolean {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches
      : false,
  );
  return isNarrow;
}

/**
 * GSP-over-time trend for the selected fighter (plan 41-06, A1 / parent §12 row 7): the kit's value-mode
 * `TrendLine` over shared `buildValueSeries` points — one point per reading up to 60 readings, then
 * close-of-day / week / month / quarter points, the grain named in the head overline. The GSP | Est. MMR
 * switch plots the same readings converted through the community model (V10.1), where flat skill shows as a
 * flat line instead of the steady inflation GSP's rising ceiling bakes in.
 *
 * Clicks (A2 / DD-41-12 - the one enumerated non-URL click): GSP readings are not games, so no URL axis is
 * ever written. At reading grain a point click raises `onSelectReading` with the reading's index into the
 * `series` (index-aligned with `getGspEntries`, which the page resolves into the edit dialog); at a coarser
 * grain a close click raises `onSelectPeriod` with the close's `memberIndexes` (identity, never a time
 * window), which the page hands to the GSP Log.
 *
 * DD-41-13: the Elite threshold is drawn as the one dashed reference only when `referencePlacement` says it
 * sits near the readings; otherwise the head legend states it as above / below the range.
 */
export function GspCurve({
  series,
  settings,
  onSelectReading,
  onSelectPeriod,
  chartWidth,
}: {
  series: GspPoint[];
  settings: GspSettings;
  /** V14 / A2: a reading-grain point click - the index into `series` (and the page's `entries`) of that reading. */
  onSelectReading?: (entryIndex: number) => void;
  /** DD-41-12: a coarser-grain close click - the indexes into `series` of the readings the close summarises. */
  onSelectPeriod?: (entryIndexes: number[]) => void;
  /** D-04 test affordance: an explicit plot width in px (Recharts renders 0x0 under jsdom's no-op ResizeObserver). */
  chartWidth?: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const nowMs = useNowMs();
  const isNarrowViewport = useIsNarrowViewport();
  const [view, setView] = useState<GspCurveView>('gsp');
  // WR-05: whether the kit is drawing the narrow series (a plot under 520px). The hint, the aria count and
  // the reference placement describe the series that is on screen, not always the wide one.
  const [drawnNarrow, setDrawnNarrow] = useState(false);
  const handleDrawnChange = useCallback(
    (drawn: { narrow: boolean }) => setDrawnNarrow(drawn.narrow),
    [],
  );
  const liveCalibration = useModelCalibration(settings);
  // `useModelCalibration` builds a fresh object each render; key the memos on its two numbers instead.
  const calibrationElite = liveCalibration?.eliteThresholdGsp;
  const calibrationAtMs = liveCalibration?.atMs;
  const calibration = useMemo(
    () =>
      calibrationElite === undefined || calibrationAtMs === undefined
        ? undefined
        : { eliteThresholdGsp: calibrationElite, atMs: calibrationAtMs },
    [calibrationElite, calibrationAtMs],
  );
  const eliteThreshold = computedEliteThreshold(nowMs, calibration);

  const mmrSeries = useMemo(() => toMmrSeries(series, calibration), [series, calibration]);

  const readings = useMemo<ValueSeriesReading[]>(
    () =>
      series.map((point, i) => ({
        atMs: point.time,
        value: view === 'gsp' ? point.gsp : Math.round(mmrSeries[i]!.mmr),
        // V17: a calibration reading (`win: null`) is a manual re-baseline, drawn as a diamond.
        calibration: point.win === null,
      })),
    [series, view, mmrSeries],
  );

  const wide = useMemo(() => buildValueSeries(readings, { target: GSP_CURVE_TARGET }), [readings]);
  const narrow = useMemo(
    () => buildValueSeries(readings, { target: GSP_CURVE_NARROW_TARGET }),
    [readings],
  );

  const toPoints = useMemo(
    () =>
      (points: typeof wide.points): TrendValuePoint[] =>
        points.map((point) => {
          const valueLine = t(view === 'gsp' ? 'gsp.curve.readout.gsp' : 'gsp.curve.readout.mmr', {
            value: formatGrouped(point.value, locale),
          });
          let secondLine: string;
          if (point.kind === 'close') {
            secondLine = t('analytics.valueTrend.readings', { count: point.n });
          } else if (point.kind === 'calibration') {
            secondLine = t('gsp.curve.setManually');
          } else {
            secondLine = series[point.memberIndexes[0]!]?.win ? t('common.win') : t('common.loss');
          }
          return {
            ...point,
            context: {
              valueKey: 'value' as const,
              title: formatDate(point.xMs, locale, { dateStyle: 'medium' }),
              lines: [valueLine, secondLine],
            },
          };
        }),
    [t, view, locale, series],
  );
  const widePoints = useMemo(() => toPoints(wide.points), [toPoints, wide]);
  const narrowPoints = useMemo(() => toPoints(narrow.points), [toPoints, narrow]);

  if (series.length === 0) {
    // E3 empty: no reading at all - the kit draws no empty frame, so the card keeps the unlock sentence
    // (the fighter picker offers the user's mains before any reading exists).
    return (
      <ChartCard title={t('gsp.curve.title')} density="compact">
        <p className="text-sm text-muted-foreground">
          {t('gsp.curve.locked', { count: GSP_CURVE_UNLOCK_THRESHOLD })}
        </p>
      </ChartCard>
    );
  }

  const isLocked = series.length < GSP_CURVE_UNLOCK_THRESHOLD;
  const referenceValue = view === 'gsp' ? eliteThreshold : GSP_MODEL.ELITE_MMR;
  // DD-41-13: the Elite line is drawn only near the readings; otherwise the head legend states it as above /
  // below this range and nothing is drawn (pulling it into the domain would squash the readings).
  const drawn = drawnNarrow ? narrow : wide;
  const drawnPoints = drawnNarrow ? narrowPoints : widePoints;
  const widePlacement = referencePlacement(
    widePoints.map((point) => point.value),
    referenceValue,
  );
  const placement = drawnNarrow
    ? referencePlacement(
        narrowPoints.map((point) => point.value),
        referenceValue,
      )
    : widePlacement;
  const referenceLabel =
    view === 'gsp'
      ? t('gsp.curve.legend.elite')
      : t('gsp.curve.legend.eliteMmr', { mmr: GSP_MODEL.ELITE_MMR });
  // The kit takes the placement against the WIDE points and re-places it against the narrow series itself.
  const reference: TrendValueReference = {
    value: referenceValue,
    label: referenceLabel,
    placement: widePlacement,
  };
  const legendKey =
    placement === 'line'
      ? 'analytics.valueTrend.legend.reference'
      : placement === 'above-range'
        ? 'analytics.valueTrend.legend.referenceAbove'
        : 'analytics.valueTrend.legend.referenceBelow';
  const referenceLegend = t(legendKey, {
    label: t('gsp.curve.legend.elite'),
    value: formatGrouped(referenceValue, locale),
  });

  const lastValue = drawnPoints[drawnPoints.length - 1]!.value;
  const grainIsReading = drawn.grain === 'reading';
  const hintShown = grainIsReading ? onSelectReading !== undefined : onSelectPeriod !== undefined;
  const handleSelectPoint = (point: TrendValuePoint) => {
    if (point.kind === 'close') {
      onSelectPeriod?.(point.memberIndexes);
    } else {
      const index = point.memberIndexes[0];
      if (index !== undefined) onSelectReading?.(index);
    }
  };

  return (
    <ChartCard
      title={t('gsp.curve.title')}
      density="compact"
      headerRight={
        <SegmentedControl
          label={t('gsp.curve.view')}
          value={view}
          onChange={(next) => {
            if (next === 'gsp' || next === 'mmr') setView(next);
          }}
          options={[
            { value: 'gsp', label: t('gsp.curve.gspLabel') },
            { value: 'mmr', label: t('gsp.curve.estMmrLabel') },
          ]}
        />
      }
      footer={
        // The caption and the click hint share one paragraph: the hint follows the caption's last line
        // instead of opening a third line (plan 41-07 reclaims the height the vs-Glicko multiples add).
        <p className="mt-4 text-xs text-muted-foreground">
          <span>
            {view === 'mmr'
              ? t('gsp.curve.mmrCaption', { mmr: GSP_MODEL.ELITE_MMR })
              : t('gsp.curve.gspCaption')}
          </span>
          {hintShown && (
            <>
              {' '}
              <span>
                {grainIsReading ? t('gsp.curve.clickHint') : t('gsp.curve.clickHintPeriod')}
              </span>
            </>
          )}
        </p>
      }
    >
      <TrendLine
        mode="value"
        points={widePoints}
        grain={wide.grain}
        narrowPoints={narrowPoints}
        narrowGrain={narrow.grain}
        formatTick={(n, step) => formatCompact(n, locale, { stepHint: step })}
        formatValueFull={(n) => formatGrouped(n, locale)}
        reference={reference}
        onDrawnChange={handleDrawnChange}
        directLabels="last-peak-low"
        {...(isLocked
          ? {
              locked: {
                have: series.length,
                need: GSP_CURVE_UNLOCK_THRESHOLD,
                sentence: t('gsp.curve.locked', { count: GSP_CURVE_UNLOCK_THRESHOLD }),
                meterLabel: t('gsp.curve.lockedMeter', {
                  have: series.length,
                  need: GSP_CURVE_UNLOCK_THRESHOLD,
                }),
              },
            }
          : {})}
        lineWidth={isNarrowViewport ? 'thin' : 'default'}
        height={isNarrowViewport ? CHART_H_COMPACT : CHART_H_DEFAULT}
        {...(chartWidth !== undefined ? { width: chartWidth } : {})}
        onSelectPoint={handleSelectPoint}
        labels={{
          overline: (grain) =>
            view === 'gsp' ? t(`gsp.curve.overline.${grain}`) : t(`gsp.curve.overlineMmr.${grain}`),
          aria: t('analytics.valueTrend.aria', {
            title: t('gsp.curve.title'),
            count: drawnPoints.length,
            value: formatGrouped(lastValue, locale),
          }),
          legend: {
            series: view === 'gsp' ? t('gsp.curve.legend.gsp') : t('gsp.curve.legend.mmr'),
            calibration: t('analytics.valueTrend.legend.calibration'),
            reference: referenceLegend,
          },
          tableToggle: t('analytics.trend.tableToggle'),
          tableHeaders: {
            date: t('analytics.valueTrend.table.headers.date'),
            value: view === 'gsp' ? t('gsp.curve.gspLabel') : t('gsp.curve.estMmrLabel'),
            readings: t('analytics.valueTrend.table.headers.readings'),
          },
        }}
      />
    </ChartCard>
  );
}
