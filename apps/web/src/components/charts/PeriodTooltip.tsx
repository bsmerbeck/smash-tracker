import { useTranslation } from 'react-i18next';
import type { PeriodPoint } from '@smash-tracker/shared';
import { formatPeriodRowLabel } from './periodTicks';

/**
 * All-optional for the same reason as `ChartTooltip`'s props: Recharts fills
 * `active`/`payload` in via `cloneElement`, so `<PeriodTooltip points={…} />`
 * is a valid `Tooltip content` element.
 */
interface PeriodTooltipProps {
  points: readonly PeriodPoint[];
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}

function hoveredKey(payload: PeriodTooltipProps['payload']): string | undefined {
  const row = payload?.[0]?.payload;
  if (typeof row !== 'object' || row === null || !('key' in row)) return undefined;
  return typeof row.key === 'string' ? row.key : undefined;
}

/**
 * Plan 37-08 (CHRT-02, UI-SPEC 39.1 §10.1 'one tooltip'): the period trend's
 * tooltip — the hovered period's TRUE rate, its label and its W–L. The row is
 * resolved by its `key` (never an index), so a pinned sub-floor dot states its
 * real rate rather than its clamped draw position. Same surface as
 * `ChartTooltip`; reuses its keys.
 */
export function PeriodTooltip({ points, active, payload }: PeriodTooltipProps) {
  const { t, i18n } = useTranslation();
  if (!active) return null;
  const key = hoveredKey(payload);
  const point = key === undefined ? undefined : points.find((p) => p.key === key);
  if (!point) return null;
  return (
    <div className="rounded-md border border-border bg-card p-2 text-xs">
      <p className="text-sm font-semibold">
        {t('shared.chartTooltip.rate', { rate: Math.round(point.rate * 100) })}
      </p>
      <p className="text-muted-foreground">{formatPeriodRowLabel(point, i18n.language)}</p>
      <p className="text-muted-foreground">
        {t('shared.chartTooltip.periodScore', { wins: point.wins, losses: point.losses })}
      </p>
    </div>
  );
}
