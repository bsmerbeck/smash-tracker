import { useTranslation } from 'react-i18next';
import type { TrendChartPoint, TrendEventPoint } from './TrendLine';

/**
 * Deliberately NOT typed against Recharts' `TooltipContentProps` — that type
 * marks `payload`/`coordinate`/`accessibilityLayer`/`activeIndex` as
 * non-optional (the shape the library computes internally before cloning
 * this element), which would force a JSX author to supply them, but
 * `<Tooltip content={<ChartTooltip />} />` — and this component's own
 * default in `TrendLine.tsx` — legitimately passes none of them; Recharts
 * fills them in via `cloneElement` at render time. This narrower,
 * all-optional shape is what every custom Recharts tooltip content
 * component is written against for exactly that reason, and is structurally
 * compatible with the full computed props Recharts actually injects.
 */
interface ChartTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}

/**
 * The kit's ONE shared tooltip content component (D-06, CHRT-02) — no chart
 * type grows its own. Every field rendered here arrives PRE-RESOLVED on the
 * host-built point object (`payload[0].payload`, a `TrendChartPoint`): this
 * component performs no alias resolution, no stage lookup, and no arithmetic
 * beyond rounding a rate that was computed upstream. That cross-cutting rule
 * is load-bearing — it is what keeps a rate from ever rendering stripped of
 * the game it came from (T-37-01-04).
 */
/** True for a `TrendEventPoint` (has an `eventKey`), false for the numeric-mode `TrendChartPoint` — the ONLY branch this component makes on point shape. */
function isEventPoint(point: TrendChartPoint | TrendEventPoint): point is TrendEventPoint {
  return 'eventKey' in point;
}

export function ChartTooltip({ active, payload }: ChartTooltipProps) {
  const { t, i18n } = useTranslation();

  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const point = payload[0]?.payload as TrendChartPoint | TrendEventPoint | undefined;
  if (!point) {
    return null;
  }

  if (isEventPoint(point)) {
    const { context } = point;
    const date = new Date(context.dateMs).toLocaleDateString(i18n.language);
    return (
      <div className="rounded-md border border-border bg-card p-2 text-xs">
        <p className="text-sm font-semibold">
          {t('shared.chartTooltip.rate', { rate: Math.round(point.cumulativeWinRate) })}
        </p>
        <p className="text-muted-foreground">
          {t('shared.chartTooltip.whoWhereEvent', {
            opponent: context.opponentTag,
            event: context.eventLabel,
          })}
        </p>
        <p className="text-muted-foreground">{t('shared.chartTooltip.whenOnly', { date })}</p>
        <p className="text-muted-foreground">
          {t('shared.chartTooltip.eventScore', { wins: point.wins, losses: point.losses })}
        </p>
      </div>
    );
  }

  const { context } = point;
  const date = new Date(context.dateMs).toLocaleDateString(i18n.language);
  const result = context.win ? t('common.win') : t('common.loss');

  return (
    <div className="rounded-md border border-border bg-card p-2 text-xs">
      <p className="text-sm font-semibold">
        {t('shared.chartTooltip.rate', { rate: Math.round(point.winRate) })}
      </p>
      <p className="text-muted-foreground">
        {t('shared.chartTooltip.whoWhere', {
          opponent: context.opponentTag,
          stage: context.stageName,
        })}
      </p>
      <p className="text-muted-foreground">
        {context.eventName != null
          ? t('shared.chartTooltip.whenEvent', { event: context.eventName, date })
          : t('shared.chartTooltip.whenOnly', { date })}
      </p>
      <p className="text-muted-foreground">
        {context.gameNumber != null
          ? t('shared.chartTooltip.score', {
              result,
              score: t('shared.chartTooltip.gameNumber', { game: context.gameNumber }),
            })
          : t('shared.chartTooltip.resultOnly', { result })}
      </p>
    </div>
  );
}
