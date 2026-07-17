import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { Tournaments } from '@/pages/Trends/components/Tournaments';

/**
 * `/tournaments` — standalone tournament list (Phase 7 walkthrough finding:
 * the list only existed embedded in Trends, leaving Generate-recap with no
 * discoverable entry point). Reuses the Trends `Tournaments` card as the
 * whole page, honoring the global source/time-range filter like every other
 * analytics page; rows link into `/tournaments/:entryKey` where the
 * Generate-recap action lives.
 */
export function TournamentsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();

  if (isLoading) {
    return <div className="text-muted-foreground">{t('trends.loading')}</div>;
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('trends.noMatches')}</h2>
        <Button asChild className="mt-2">
          <Link to="/dashboard">{t('common.goToDashboard')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}
      <Tournaments matches={matches} />
    </div>
  );
}
