import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { resolveEntryTiers } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { CardSkeleton, PageSkeleton } from '@/components/analytics/CardSkeleton';
import { GridCell, PageGrid } from '@/components/analytics/PageGrid';
import { PageShell } from '@/components/analytics/PageShell';
import { INLINE_LINK_TONE } from '@/components/analytics/linkTone';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { filterEntriesByRange, useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useMatches } from '@/hooks/useMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { isAdminImportedEntry } from '@/lib/historicalTournament';
import { buildTierFilterSearch, readTierFilterParams } from '@/lib/tierFilterParams';
import { buildTournamentEntryRows } from '@/lib/tournamentEntryRows';
import { HiddenByRangeNotice } from '@/pages/Tournaments/components/HiddenByRangeNotice';
import {
  TournamentsTable,
  type TournamentTableRow,
} from '@/pages/Tournaments/components/TournamentsTable';

const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

/**
 * `/tournaments` — the tier-aware tournament list (TIER-02 / T-08). Every row
 * shows its tier AND how that tier was established, placement, seed delta and
 * record, grouped by year; the tier / setting / side-event filters live only
 * in URL params (D-13).
 *
 * V4 Phase B: per-tournament results come from `useTournamentEntries` (the
 * start.gg / parry.gg registry) rather than grouping matches by name, which
 * gives every row a stable `entryKey` to link to `/tournaments/:entryKey`.
 * Entries only start showing up after a sync that populates the registry, so
 * the resync hint is preserved for accounts with matches but no entries yet.
 *
 * Phase 30.3 (Gate 4): the no-matches empty state only renders when the
 * registry is ALSO empty — an account whose history was admin-imported must
 * see its historical tournaments wherever they exist, never a "no matches"
 * dead end that hides real registry rows.
 *
 * Quick 260902-bm9: registry rows filter on the same global time range the
 * matches do, and the hidden count is surfaced with a one-click widen so the
 * narrowing is never silent. The source filter is deliberately not applied to
 * registry rows — tournament entries are inherently competitive (D-02).
 *
 * The tier resolves ONCE per entry through the shared resolver, from ALL of
 * the subject's matches (never the range-filtered set), because the evidence
 * for an event's setting must not move with the date filter.
 */
export function TournamentsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();
  const { isError: matchesError } = useMatches();
  const {
    data: entries,
    isLoading: entriesLoading,
    isError: entriesError,
  } = useTournamentEntries();
  const { range } = useAnalyticsFilter();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const filters = useMemo(() => readTierFilterParams(searchParams), [searchParams]);
  const allEntries = useMemo(() => entries ?? [], [entries]);

  const resolutionByEntry = useMemo(
    () => new Map(resolveEntryTiers(allEntries, allMatches).map((r) => [r.entry, r.resolution])),
    [allEntries, allMatches],
  );

  const visibleEntries = useMemo(
    () => filterEntriesByRange(allEntries, range),
    [allEntries, range],
  );
  const hiddenCount = allEntries.length - visibleEntries.length;

  const inRangeRows = useMemo<TournamentTableRow[]>(
    () =>
      buildTournamentEntryRows(visibleEntries, matches).flatMap(({ entry, record }) => {
        const resolution = resolutionByEntry.get(entry);
        return resolution ? [{ entry, record, resolution }] : [];
      }),
    [visibleEntries, matches, resolutionByEntry],
  );

  const rows = useMemo(
    () =>
      inRangeRows.filter(({ resolution }) => {
        if (filters.tiers.length > 0 && !filters.tiers.includes(resolution.tier)) {
          return false;
        }
        if (filters.setting != null && resolution.setting !== filters.setting) {
          return false;
        }
        return !(filters.side === 'hide' && resolution.eventKind === 'side-event');
      }),
    [inRangeRows, filters],
  );

  if (isLoading || entriesLoading) {
    return (
      <PageShell>
        <PageSkeleton>
          <PageGrid>
            <GridCell span={12}>
              <CardSkeleton variant="list" rows={6} statusLabel={t('tournaments.listLoading')} />
            </GridCell>
          </PageGrid>
        </PageSkeleton>
      </PageShell>
    );
  }

  if (entriesError || matchesError) {
    return (
      <PageShell>
        <div role="alert" className="text-sm text-muted-foreground">
          {t('tournaments.table.loadError')}
        </div>
      </PageShell>
    );
  }

  if (allMatches.length === 0 && allEntries.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <h2 className="text-xl font-semibold tracking-tight">{t('tournaments.noMatches')}</h2>
          <Button asChild className="mt-2">
            <Link to="/dashboard">{t('common.goToDashboard')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const filtersOn = filters.tiers.length > 0 || filters.setting != null || filters.side === 'hide';
  const clearFilters = () =>
    navigate(
      { search: buildTierFilterSearch({ tiers: [] }, searchParams).toString() },
      { replace: true },
    );

  let content;
  if (allEntries.length === 0) {
    content = (
      <p className="text-sm text-muted-foreground">
        {t('trends.tournaments.resyncPrefix')}{' '}
        <Link to="/settings/integrations" className={`font-medium ${INLINE_LINK_TONE}`}>
          {t('nav.integrations')}
        </Link>{' '}
        {t('trends.tournaments.resyncSuffix')}
      </p>
    );
  } else if (inRangeRows.length === 0 && range !== 'all') {
    content = <HiddenByRangeNotice hiddenCount={hiddenCount} range={range} />;
  } else if (rows.length === 0) {
    content = (
      <div
        data-slot="tournaments-filter-empty"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/50 px-4 py-3 text-sm"
      >
        <span className="text-muted-foreground">{t('tiers.filter.empty')}</span>
        {filtersOn && (
          <Button variant="outline" size="sm" onClick={clearFilters}>
            {t('tiers.filter.clear')}
          </Button>
        )}
      </div>
    );
  } else {
    content = (
      <>
        <TournamentsTable key={searchParams.toString()} rows={rows} />
        {hiddenCount > 0 && range !== 'all' && (
          <HiddenByRangeNotice hiddenCount={hiddenCount} range={range} className="mt-3" />
        )}
        {rows.some(({ entry }) => isAdminImportedEntry(entry)) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('tournaments.imported.listFootnote')}
          </p>
        )}
      </>
    );
  }

  return (
    <PageShell>
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}
      {/* data-slot="tournaments-body": present only once the loading gate
          above has cleared — the layout oracle's page-loaded marker. */}
      <div data-slot="tournaments-body" className="flex flex-col gap-4">
        {rows.length > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className={OVERLINE}>
              {t('tournaments.table.sectionLabel', { count: rows.length })}
              {' · '}
              {t('tournaments.table.sortNote')}
            </h2>
          </div>
        )}
        <PageGrid>
          <GridCell span={12}>{content}</GridCell>
        </PageGrid>
      </div>
    </PageShell>
  );
}
