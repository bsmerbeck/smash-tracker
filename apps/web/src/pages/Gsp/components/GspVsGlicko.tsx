import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { GspPoint, GspSettings, Match, ValueSeries } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  SmallMultiplesGrid,
  type SmallMultiplesPanel,
} from '@/components/charts/SmallMultiplesGrid';
import type { TrendValuePoint } from '@/components/charts/TrendLine';
import { formatDate, formatGrouped } from '@/lib/format';
import { computeRatingHistory } from '@/lib/glicko';
import { toMmrSeries } from '../lib/gspMmrModel';
import { buildGspVsGlickoPanels, shouldShowGspVsGlicko } from '../lib/gspVsGlicko';
import { useModelCalibration } from '../lib/useModelCalibration';

/**
 * Plan 41-07 (A3 / parent 12 row 9, UI-SPEC 7.6): the selected fighter's ESTIMATED MMR (V10.1 - GSP readings
 * through the community reverse-engineered model) and the player's OVERALL Glicko-2 rating history (every
 * fighter - `computeRatingHistory`) as two STACKED small-multiples panels. The two scales are unrelated, so
 * nothing is rescaled onto a shared 0-100 axis any more (that min-max overlay was the anti-pattern this plan
 * retires): the panels share ONE time axis, ONE crosshair and ONE readout, and each keeps its own fitted y.
 * Both are binned by shared `buildValueSeries` at the SAME grain (the coarser of the two natural picks), which
 * the head overline names.
 *
 * Clicks: the MMR panel follows the GSP curve's rule (DD-41-12) - a reading-grain point opens that reading's
 * edit dialog (`onSelectReading`, an index into `gspSeries` and so the page's `entries`), a coarser-grain
 * close marks its readings in the GSP Log (`onSelectPeriod`, the close's `memberIndexes`). The Glicko panel has
 * no click: a rating period is a session, not a reading.
 *
 * Skipped entirely when `shouldShowGspVsGlicko` says either series is too thin - the page reads the same gate
 * to give the Rating-model note the whole row.
 */
export function GspVsGlicko({
  gspSeries,
  allMatches,
  settings,
  onSelectReading,
  onSelectPeriod,
  chartWidth,
}: {
  gspSeries: GspPoint[];
  allMatches: Match[];
  settings: GspSettings;
  /** DD-41-12: a reading-grain MMR-panel click - the index into `gspSeries` of that reading. */
  onSelectReading?: (entryIndex: number) => void;
  /** DD-41-12: a coarser-grain MMR-panel close click - the indexes into `gspSeries` the close summarises. */
  onSelectPeriod?: (entryIndexes: number[]) => void;
  /** D-04 test affordance: an explicit plot width in px (Recharts renders 0x0 under jsdom's no-op ResizeObserver). */
  chartWidth?: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  // Hooks run before the early return below. `useModelCalibration` builds a fresh object each render, so the
  // memos key on its two numbers instead.
  const liveCalibration = useModelCalibration(settings);
  const calibrationElite = liveCalibration?.eliteThresholdGsp;
  const calibrationAtMs = liveCalibration?.atMs;
  const calibration = useMemo(
    () =>
      calibrationElite === undefined || calibrationAtMs === undefined
        ? undefined
        : { eliteThresholdGsp: calibrationElite, atMs: calibrationAtMs },
    [calibrationElite, calibrationAtMs],
  );
  const periods = useMemo(() => computeRatingHistory(allMatches).periods, [allMatches]);
  const mmrSeries = useMemo(() => toMmrSeries(gspSeries, calibration), [gspSeries, calibration]);
  const built = useMemo(
    () => buildGspVsGlickoPanels({ mmr: mmrSeries, periods }),
    [mmrSeries, periods],
  );

  if (!shouldShowGspVsGlicko(gspSeries.length, periods.length)) return null;

  const { grain, xDomain } = built;

  const toPoints = (
    series: ValueSeries,
    secondLine: (point: ValueSeries['points'][number]) => string,
  ): TrendValuePoint[] =>
    series.points.map((point) => ({
      ...point,
      context: {
        valueKey: 'value' as const,
        title: formatDate(point.xMs, locale, { dateStyle: 'medium' }),
        lines: [secondLine(point)],
      },
    }));

  const mmrPoints = toPoints(built.mmr, (point) =>
    t('gsp.vsGlicko.readout.mmr', { value: formatGrouped(point.value, locale) }),
  );
  const glickoPoints = toPoints(built.glicko, (point) => {
    // A close's rd is its last member period's rd (the close is the last member).
    const rd = periods[point.memberIndexes[point.memberIndexes.length - 1]!]?.rd ?? 0;
    return t('gsp.vsGlicko.readout.glicko', {
      value: formatGrouped(point.value, locale),
      rd: formatGrouped(rd, locale),
    });
  });

  const handleSelectMmrPoint = (point: TrendValuePoint) => {
    if (point.kind === 'close') {
      onSelectPeriod?.(point.memberIndexes);
    } else {
      const index = point.memberIndexes[0];
      if (index !== undefined) onSelectReading?.(index);
    }
  };
  const mmrClickable = built.mmr.grain === 'reading' ? onSelectReading : onSelectPeriod;

  const panelAria = (title: string, points: TrendValuePoint[]) =>
    t('analytics.valueTrend.aria', {
      title,
      count: points.length,
      value: formatGrouped(points[points.length - 1]?.value ?? 0, locale),
    });
  const mmrTitle = t('gsp.vsGlicko.panel.mmr');
  const glickoTitle = t('gsp.vsGlicko.panel.glicko');

  const panels: SmallMultiplesPanel[] = [
    {
      key: 'mmr',
      title: mmrTitle,
      points: mmrPoints,
      grain,
      formatTick: (n) => formatGrouped(n, locale),
      formatValueFull: (n) => formatGrouped(n, locale),
      readoutLine: (point) => point.context.lines[0] ?? '',
      labels: { aria: panelAria(mmrTitle, mmrPoints) },
      ...(mmrClickable ? { onSelectPoint: handleSelectMmrPoint } : {}),
    },
    {
      key: 'glicko',
      title: glickoTitle,
      points: glickoPoints,
      grain,
      formatTick: (n) => formatGrouped(n, locale),
      formatValueFull: (n) => formatGrouped(n, locale),
      readoutLine: (point) => point.context.lines[0] ?? '',
      labels: { aria: panelAria(glickoTitle, glickoPoints) },
    },
  ];

  return (
    <ChartCard
      title={t('gsp.vsGlicko.title')}
      density="compact"
      headerRight={
        <span
          data-slot="gsp-vs-glicko-grain"
          className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {t(`gsp.vsGlicko.overline.${grain}`)}
        </span>
      }
      footer={
        <p className="mt-2 text-xs leading-4 text-muted-foreground">
          {t('gsp.vsGlicko.captionPanels')}
        </p>
      }
    >
      <SmallMultiplesGrid
        panels={panels}
        layout="stacked"
        xDomain={xDomain}
        noReadingLine={(title) => t('gsp.vsGlicko.noReading', { title })}
        caption={t('analytics.multiples.caption')}
        aria={t('analytics.multiples.aria', { count: panels.length })}
        tableLabels={{
          toggle: t('analytics.trend.tableToggle'),
          date: t('analytics.valueTrend.table.headers.date'),
        }}
        {...(chartWidth !== undefined ? { width: chartWidth } : {})}
      />
    </ChartCard>
  );
}
