import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import type { AnalyticsRangeFilter } from '@/context/AnalyticsFilterContext';
import { cn } from '@/lib/utils';

/**
 * Quick 260902-bm9: mirrors — rather than shares — the identical private
 * label maps in `AnalyticsFilterControls.tsx` and `useAutoWidenEmptyRange.ts`.
 * Exporting from either would violate scope (D-06: `useAutoWidenEmptyRange`
 * stays untouched) or trip `react-refresh/only-export-components` on a
 * component module; quick 260901-tj7 already established this local-mirror
 * precedent for exactly this map. `RANGE_DAYS` (the actual cutoff math) is a
 * different matter and IS genuinely shared, via `useFilteredMatches.ts`.
 */
const RANGE_LABEL_KEYS: Record<Exclude<AnalyticsRangeFilter, 'all'>, string> = {
  '3m': 'filters.months3',
  '6m': 'filters.months6',
  '12m': 'filters.months12',
};

/**
 * Quick 260902-bm9 (D-03): shown both as a footer under a partially-hidden
 * table and in place of the table when the range hides every entry — one
 * component, one visual language (the same dashed-box/outline-button chrome
 * `FilteredEmptyNotice` uses), so there is one test target instead of two
 * near-identical variants. Moved out of the Trends `Tournaments` component in
 * Phase 39.2 (F8) so the tier-aware Tournaments page keeps the behaviour.
 */
export function HiddenByRangeNotice({
  hiddenCount,
  range,
  className,
}: {
  hiddenCount: number;
  range: Exclude<AnalyticsRangeFilter, 'all'>;
  className?: string;
}) {
  const { t } = useTranslation();
  const { setRange } = useAnalyticsFilter();

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/50 px-4 py-3 text-sm',
        className,
      )}
    >
      <span className="text-muted-foreground">
        {t('trends.tournaments.hiddenByRange', {
          count: hiddenCount,
          range: t(RANGE_LABEL_KEYS[range]),
        })}
      </span>
      <Button variant="outline" size="sm" onClick={() => setRange('all')}>
        {t('trends.tournaments.showAllTime')}
      </Button>
    </div>
  );
}
