import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';

/**
 * Inline notice shown when the user has matches, but the active global
 * analytics filter (source + time range) excludes all of them. Distinct from
 * the "no matches at all" hero — that page-level empty state should still be
 * driven off `allMatches.length === 0`, not this.
 */
export function FilteredEmptyNotice() {
  const { t } = useTranslation();
  const { resetFilters } = useAnalyticsFilter();

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/50 px-4 py-3 text-sm">
      <span className="text-muted-foreground">{t('shared.filteredNotice.message')}</span>
      <Button variant="outline" size="sm" onClick={resetFilters}>
        {t('shared.filteredNotice.clear')}
      </Button>
    </div>
  );
}
