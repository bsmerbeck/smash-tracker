import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { Tournaments } from '@/pages/Trends/components/Tournaments';

/**
 * `/tournaments` — standalone tournament list (Phase 7 walkthrough finding:
 * the list only existed embedded in Trends, leaving Generate-recap with no
 * discoverable entry point). Reuses the Trends `Tournaments` card as the
 * whole page, honoring the global source/time-range filter like every other
 * analytics page; rows link into `/tournaments/:entryKey` where the
 * Generate-recap action lives.
 *
 * Phase 30.3 (Gate 4): the no-matches empty state only renders when the
 * registry is ALSO empty — an account whose history was admin-imported must
 * see its historical tournaments wherever they exist, never a "no matches"
 * dead end that hides real registry rows.
 */
export function TournamentsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();
  const { data: entries, isLoading: entriesLoading } = useTournamentEntries();

  if (isLoading || entriesLoading) {
    return <div className="text-muted-foreground">{t('tournaments.listLoading')}</div>;
  }

  if (allMatches.length === 0 && (entries ?? []).length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('tournaments.noMatches')}</h2>
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
