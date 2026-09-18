import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { parseExternalId } from '@smash-tracker/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getRollingWinRate,
  getRunningWinRateSeries,
  type RollingWinRatePoint,
  type RunningWinRatePoint,
} from '@/lib/stats';
import { TrendLine, type TrendChartPoint } from '@/components/charts/TrendLine';

export type TrendMode = '5' | '10' | 'cumulative';

const TREND_OPTIONS: { value: TrendMode; labelKey: string }[] = [
  { value: '5', labelKey: 'matchups.chart.rolling5' },
  { value: '10', labelKey: 'matchups.chart.rolling10' },
  { value: 'cumulative', labelKey: 'matchups.chart.cumulative' },
];

type TrendPoint = RollingWinRatePoint | RunningWinRatePoint;

/**
 * Builds the trend series for the given mode — the pure part of the chart,
 * factored out so window-switching logic is unit-testable without mounting
 * Recharts. 'cumulative' mirrors the original all-time running win rate;
 * '5'/'10' use the trailing-window "form curve" from the v3 stats engine.
 */
export function buildTrendSeries(matches: Match[], mode: TrendMode): TrendPoint[] {
  if (mode === 'cumulative') {
    return getRunningWinRateSeries(matches);
  }
  return getRollingWinRate(matches, Number(mode));
}

/**
 * Maps each trend series point to the kit's `TrendChartPoint` — the tooltip
 * context (who/where/when/score) carried on the point object, never
 * re-derived in the chart layer. `opponentTag` is already alias-resolved by
 * `useFilteredMatches` (the single choke point for opponent identity
 * merging), so this function does not re-resolve it.
 */
export function buildTrendChartPoints(series: TrendPoint[], t: TFunction): TrendChartPoint[] {
  return series.map((point) => {
    const stageName =
      point.match.map && point.match.map.id !== 0 ? point.match.map.name : t('common.unknown');
    const parsedExternalId = parseExternalId(point.match.externalId);
    return {
      index: point.index,
      winRate: point.winRate,
      context: {
        matchId: point.match.id,
        opponentTag: point.match.opponent || t('common.unknown'),
        stageName,
        eventName: point.match.eventName ?? point.match.tournamentName ?? null,
        dateMs: point.match.time,
        win: point.match.win,
        gameNumber: parsedExternalId?.game ?? null,
      },
    };
  });
}

/**
 * Ports legacy/src/screens/Matchups/components/MatchupChart — win rate over
 * time for the specific matchup, upgraded with a rolling-window selector
 * (default 5) and a cumulative fallback. Renders on the chart kit's
 * `TrendLine` (Recharts) — the host owns the data and the point context, the
 * kit owns the chrome. This component no longer owns a card or an
 * empty-state paragraph: its host, `MatchupsPage`, wraps it in `ChartCard`,
 * which is why this file legitimately imports a kit primitive without
 * importing `ChartCard` itself (the kit boundary rule is structural, not a
 * co-import grep).
 *
 * D-04 applied to hosts: `width`/`height` are forwarded straight through to
 * `TrendLine` so every test can render at an explicit size — jsdom's no-op
 * ResizeObserver stub plus a zero-size bounding rect make a responsive
 * render produce a 0x0 SVG with no marks to assert on.
 */
export function MatchupChart({
  matchupMatches,
  width,
  height,
}: {
  matchupMatches: Match[];
  width?: number;
  height?: number;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TrendMode>('5');
  const series = buildTrendSeries(matchupMatches, mode);
  const points = buildTrendChartPoints(series, t);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <span className="text-sm text-muted-foreground">{t('matchups.chart.window')}</span>
        <Select value={mode} onValueChange={(value) => setMode(value as TrendMode)}>
          <SelectTrigger className="w-[140px]" aria-label={t('matchups.chart.windowAria')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TREND_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TrendLine points={points} width={width} height={height} />
    </div>
  );
}
