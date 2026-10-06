import { useTranslation } from 'react-i18next';
import { ABSTENTION_FLOOR_GAMES, type GspGainBand, type GspGainStats } from '@smash-tracker/shared';
import { StatFigure, StatRow } from '@/components/analytics/StatRow';
import { ChartCard } from '@/components/charts/ChartCard';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { formatCompact, formatSigned } from '@/lib/format';

/**
 * Win/loss GSP gain analysis for the selected fighter (plan 41-05, A4 / DD-41-16):
 * four figures — the lifetime average gain per win and drop per loss (each with
 * the last-N-wins / last-N-losses average as its support line), the biggest gain and the
 * biggest drop — over one neutral bar per GSP band showing the average gain of
 * the wins that started in it. The band edges and averages come from the shared
 * `getGspGainStats` (`gainsByBand`); this component never bins.
 */
export function GainsAnalysis({ stats }: { stats: GspGainStats }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const hasWins = stats.perWinGains.length > 0;
  const hasData = hasWins || stats.avgDropPerLossLifetime !== null;

  if (!hasData) {
    return (
      <ChartCard title={t('gsp.gains.title')} density="compact">
        <p className="text-sm text-muted-foreground">{t('gsp.gains.empty')}</p>
      </ChartCard>
    );
  }

  // UAT 41 test 9 / F19: each support line counts the steps behind its own average — the wins inside the
  // last 20 steps ARE the last N wins (and likewise losses), so the trailing-N wording is exact.
  const recent = (value: number | null, sign: 1 | -1): string | undefined =>
    value === null
      ? undefined
      : sign === 1
        ? t('gsp.gains.figure.recentWins', {
            count: stats.recentWinStepCount,
            value: formatSigned(value, locale),
          })
        : t('gsp.gains.figure.recentLosses', {
            count: stats.recentLossStepCount,
            value: formatSigned(-value, locale),
          });

  const figure = (props: {
    key: string;
    label: string;
    value: number | null;
    sign: 1 | -1;
    last?: number | null;
  }) => (
    <StatFigure
      key={props.key}
      label={props.label}
      state={props.value === null ? 'empty' : 'populated'}
      value={props.value === null ? undefined : formatSigned(props.sign * props.value, locale)}
      support={props.last === undefined ? undefined : recent(props.last, props.sign)}
    />
  );

  const figures = [
    ...(hasWins
      ? [
          figure({
            key: 'avgGain',
            label: t('gsp.gains.figure.avgGain'),
            value: stats.avgGainPerWinLifetime,
            sign: 1,
            last: stats.avgGainPerWinLast20,
          }),
        ]
      : []),
    figure({
      key: 'avgDrop',
      label: t('gsp.gains.figure.avgDrop'),
      value: stats.avgDropPerLossLifetime,
      sign: -1,
      last: stats.avgDropPerLossLast20,
    }),
    ...(hasWins
      ? [
          figure({
            key: 'biggestGain',
            label: t('gsp.gains.figure.biggestGain'),
            value: stats.biggestGain,
            sign: 1,
          }),
        ]
      : []),
    figure({
      key: 'biggestDrop',
      label: t('gsp.gains.figure.biggestDrop'),
      value: stats.biggestDrop,
      sign: -1,
    }),
  ];

  const bands = stats.gainsByBand;
  const width = bands[0] ? bands[0].toGsp - bands[0].fromGsp : undefined;
  const maxGain = bands.reduce((max, band) => Math.max(max, band.avgGain), 0);

  const bandRow = (band: GspGainBand): ComparisonBarsRow => {
    const range = t('gsp.gains.byBand.range', {
      from: formatCompact(band.fromGsp, locale, { stepHint: width }),
      to: formatCompact(band.toGsp, locale, { stepHint: width }),
    });
    const gain = formatSigned(band.avgGain, locale);
    const subFloor = band.wins < ABSTENTION_FLOOR_GAMES;
    return {
      key: String(band.fromGsp),
      label: range,
      labelTitle: subFloor
        ? `${range} — ${t('gsp.gains.byBand.subFloor', {
            count: band.wins,
            floor: ABSTENTION_FLOOR_GAMES,
          })}`
        : range,
      value: maxGain > 0 ? (Math.max(band.avgGain, 0) / maxGain) * 100 : 0,
      valueNode: gain,
      valueLabel: t('gsp.gains.byBand.rowAria', { band: range, gain, count: band.wins }),
      subFloor,
    };
  };

  const rows = bands.map((band) => bandRow(band));

  return (
    <ChartCard title={t('gsp.gains.title')} density="compact">
      <div className="flex flex-col gap-4">
        <StatRow figures={figures} />
        {rows.length > 0 && (
          <div className="flex flex-col gap-1" data-slot="gains-by-band">
            <p className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
              {t('gsp.gains.byBand.title')}
            </p>
            <ComparisonBars tone="series" divided rows={rows} />
            <p className="text-xs leading-4 text-muted-foreground tabular-nums">
              {t('gsp.gains.byBand.caption', { floor: ABSTENTION_FLOOR_GAMES })}
            </p>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
