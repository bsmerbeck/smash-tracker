import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ABSTENTION_FLOOR_GAMES,
  buildTierSplitStatsFromResolved,
  resolveEntryTiers,
  toRateValue,
  type Match,
} from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { CardSkeleton, PageSkeleton } from '@/components/analytics/CardSkeleton';
import { GridCell, PageGrid } from '@/components/analytics/PageGrid';
import { PageShell } from '@/components/analytics/PageShell';
import { INLINE_LINK_TONE } from '@/components/analytics/linkTone';
import { resolveInsightClaim } from '@/components/analytics/insightDoors';
import { ByTierCard } from '@/components/analytics/tier/ByTierCard';
import { TierInsightCard } from '@/components/analytics/tier/TierInsightCard';
import { buildTierGapInsight } from '@/components/analytics/tier/tierGapInsight';
import { TierFilterChips } from '@/components/analytics/tier/TierFilterChips';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';
import { filterEntriesByRange, useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useLandingScroll } from '@/hooks/useLandingScroll';
import { useMatches } from '@/hooks/useMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { stagesById } from '@/data/stages';
import {
  DRILL_DOWN_CLAIM_PARAM,
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_TO_PARAM,
  DRILL_DOWN_VS_PARAM,
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { isAdminImportedEntry } from '@/lib/historicalTournament';
import {
  applyTierFilters,
  buildTierFilterSearch,
  facetedSettingCounts,
  facetedTierCounts,
  readTierFilterParams,
} from '@/lib/tierFilterParams';
import { buildTournamentEntryRows } from '@/lib/tournamentEntryRows';
import { HiddenByRangeNotice } from '@/pages/Tournaments/components/HiddenByRangeNotice';
import {
  TournamentsTable,
  type TournamentTableRow,
} from '@/pages/Tournaments/components/TournamentsTable';

const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

const GAMES_ANCHOR_ID = 'games';

/** Every drill-down axis the `#games` terminus narrows by — what Clear filters removes. */
const DRILL_AXIS_PARAMS = [
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_VS_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_TO_PARAM,
  DRILL_DOWN_CLAIM_PARAM,
] as const;

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
 * Row A is the By-tier card (TIER-03), fed by `buildTierSplitStats` over the
 * rows the filters leave. Row C is the `#games` terminus, mounted ONLY while a
 * drill-down axis (including `claim=`) is in the URL (39.1 §10.3, DD-12).
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
  const location = useLocation();

  const filters = useMemo(() => readTierFilterParams(searchParams), [searchParams]);
  const allEntries = useMemo(() => entries ?? [], [entries]);

  // Every entry resolves ONCE, over ALL entries and ALL matches: the card and the
  // table read this one resolution, so a filter that hides a same-named event can
  // never hand its games to the one that stays.
  const resolvedEntries = useMemo(
    () => resolveEntryTiers(allEntries, allMatches),
    [allEntries, allMatches],
  );
  const resolutionByEntry = useMemo(
    () => new Map(resolvedEntries.map((r) => [r.entry, r.resolution])),
    [resolvedEntries],
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

  const rows = useMemo(() => applyTierFilters(inRangeRows, filters), [inRangeRows, filters]);
  // Faceted counts (UI-SPEC §7.3): each facet ignores its own selection, so a chip
  // says how many events pressing it would show.
  const tierCounts = useMemo(() => facetedTierCounts(inRangeRows, filters), [inRangeRows, filters]);
  const settingCounts = useMemo(
    () => facetedSettingCounts(inRangeRows, filters),
    [inRangeRows, filters],
  );

  // TIER-03: the by-tier split over the rows the filters leave, from ALL of
  // the subject's matches (the evidence must not move with the date filter,
  // exactly as the per-row tier above). Side events join only on `side=include`.
  const includeSideEvents = filters.side === 'include';
  const tierStats = useMemo(() => {
    const shown = new Set<object>(rows.map(({ entry }) => entry));
    return buildTierSplitStatsFromResolved({
      resolved: resolvedEntries.filter((item) => shown.has(item.entry)),
      includeSideEvents,
    });
  }, [rows, resolvedEntries, includeSideEvents]);
  const sideEventCount = useMemo(
    () => rows.filter(({ resolution }) => resolution.eventKind === 'side-event').length,
    [rows],
  );
  // The reference tick: the account's overall rate, drawn only from the abstention floor up.
  const overallRate = useMemo(() => {
    const overall = toRateValue(allMatches);
    return overall.total >= ABSTENTION_FLOOR_GAMES ? overall.rate : null;
  }, [allMatches]);

  // TIER-03: the tier insight, computed once and shared by its card and by the
  // `#games` terminus, so a rendered door's `claim=` id and the resolved list are
  // one object's `countedMatchIds`. React Compiler forbids a bare `Date.now()` in
  // render; the lazy state initializer is the codebase's one-time-read hatch.
  const [nowMs] = useState(() => Date.now());
  const tierInsight = useMemo(
    () => buildTierGapInsight({ stats: tierStats, matches: allMatches, includeSideEvents, nowMs }),
    [tierStats, allMatches, includeSideEvents, nowMs],
  );
  const pageInsights = useMemo(() => (tierInsight ? [tierInsight] : []), [tierInsight]);
  const { dismissedIds, dismiss } = useInsightDismissals();
  const shownTierInsight =
    tierInsight != null && !dismissedIds.includes(tierInsight.id) ? tierInsight : null;

  // D-05: a tolerant read of every drill-down axis in the URL. This page's
  // by-tier rows write none (they are filters, DD-12); the `#games` terminus is
  // the read half of the contract, mounted only when a door asks for it.
  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds }),
    [searchParams, stageIds],
  );
  const hasDrillAxis =
    axesFromUrl.fighterId != null ||
    axesFromUrl.vsFighterId != null ||
    axesFromUrl.stageId != null ||
    axesFromUrl.eventKey != null ||
    axesFromUrl.from != null ||
    axesFromUrl.to != null ||
    axesFromUrl.claimId != null;
  // `FilteredMatchList`'s D-16 memo keys on reference identity, so the axes
  // object, the sorted array and `resolveClaim` are all memoised, above every
  // early return (Rules of Hooks).
  const terminusAxes: DrillDownAxes = useMemo(
    () => ({
      fighterId: axesFromUrl.fighterId,
      vsFighterId: axesFromUrl.vsFighterId,
      stageId: axesFromUrl.stageId,
      eventKey: axesFromUrl.eventKey,
      from: axesFromUrl.from,
      to: axesFromUrl.to,
      claimId: axesFromUrl.claimId,
    }),
    [
      axesFromUrl.fighterId,
      axesFromUrl.vsFighterId,
      axesFromUrl.stageId,
      axesFromUrl.eventKey,
      axesFromUrl.from,
      axesFromUrl.to,
      axesFromUrl.claimId,
    ],
  );
  // A claim resolves against ALL of the subject's matches: the insight counted
  // from them (the tier evidence does not move with the date or source filter),
  // so the list must hold exactly the games its door promised. Every other axis
  // still narrows the globally filtered set.
  const claimInUrl = axesFromUrl.claimId != null;
  const sortedMatches = useMemo(
    () => sortMatchesNewestFirst(claimInUrl ? allMatches : matches),
    [claimInUrl, allMatches, matches],
  );
  const resolveClaimForTerminus = useCallback(
    (claimId: string, ms: Match[]) =>
      resolveInsightClaim({ claimId, insights: pageInsights, matches: ms }),
    [pageInsights],
  );
  const claimedInsight =
    axesFromUrl.claimId != null
      ? pageInsights.find((insight) => insight.id === axesFromUrl.claimId)
      : undefined;
  const claimSummary = claimedInsight
    ? t(claimedInsight.copy.key, claimedInsight.copy.values)
    : undefined;
  // `BrowserRouter` performs no hash scroll of its own and the terminus mounts
  // conditionally, so an effect once the data has landed is the only place the
  // scroll can happen (WR-02, 39.1-REVIEW).
  useLandingScroll({
    anchorId: GAMES_ANCHOR_ID,
    ready: !isLoading && !entriesLoading && hasDrillAxis,
  });

  if (isLoading || entriesLoading) {
    return (
      <PageShell>
        <PageSkeleton>
          <PageGrid>
            {/* Row A's placeholder is decorative: the table skeleton below owns the one status announcement. */}
            <GridCell span={12}>
              <div aria-hidden="true">
                <CardSkeleton variant="list" rows={5} statusLabel={t('tournaments.listLoading')} />
              </div>
            </GridCell>
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

  /** Clear filters on the terminus: drops every drill axis (and the `#games` hash), which unmounts it. */
  function handleClearDrillFilters(): void {
    const params = new URLSearchParams(searchParams);
    for (const key of DRILL_AXIS_PARAMS) {
      params.delete(key);
    }
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' });
  }

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
        <TournamentsTable rows={rows} />
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
    <PageShell
      filterRow={
        inRangeRows.length > 0 ? (
          <TierFilterChips tierCounts={tierCounts} settingCounts={settingCounts} />
        ) : undefined
      }
    >
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}
      {/* data-slot="tournaments-body": present only once the loading gate
          above has cleared — the layout oracle's page-loaded marker. */}
      <div data-slot="tournaments-body" className="flex flex-col gap-4">
        {/* A chip change re-keys this wrapper: the results fade in over 120ms
            (instant under prefers-reduced-motion, UI-SPEC §10.4) and the table's
            paging progress restarts with the new row set. */}
        <div
          key={searchParams.toString()}
          data-slot="tournaments-results"
          className="flex animate-in flex-col gap-8 fade-in-0 duration-[120ms] motion-reduce:animate-none"
        >
          {/* Row A (D-14): the By-tier card at 8 columns with the tier insight at 4
              from 1280px up. From 1024 to 1279 the insight is its own 12-column row
              ABOVE the card; below that everything is 12 and the insight comes
              first. Rendered only while rows are visible: no card computes over
              nothing (§8.1); a dismissed or absent insight gives the card all 12. */}
          {rows.length > 0 && (
            <PageGrid>
              <GridCell
                span={shownTierInsight ? 8 : 12}
                className={shownTierInsight ? 'lg:col-span-12 xl:col-span-8' : undefined}
              >
                <ByTierCard
                  stats={tierStats}
                  sideEventCount={sideEventCount}
                  overallRate={overallRate}
                />
              </GridCell>
              {shownTierInsight && (
                <GridCell
                  span={4}
                  className="order-first lg:col-span-12 xl:order-none xl:col-span-4"
                >
                  <TierInsightCard
                    insight={shownTierInsight}
                    coverage={tierStats.coverage}
                    onDismiss={() => dismiss(shownTierInsight.id)}
                  />
                </GridCell>
              )}
            </PageGrid>
          )}
          <div className="flex flex-col gap-4">
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
              {/* Row C (39.1 §10.3, DD-12): the scoped games terminus, only when a door asked for one. */}
              {hasDrillAxis && (
                <GridCell span={12}>
                  <Card id={GAMES_ANCHOR_ID} className="scroll-mt-16">
                    <CardHeader>
                      <CardTitle>{t('matchups.results')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <FilteredMatchList
                        matches={sortedMatches}
                        axes={terminusAxes}
                        resolveClaim={resolveClaimForTerminus}
                        claimSummary={claimSummary}
                        onClearFilters={handleClearDrillFilters}
                        showDelete
                      />
                    </CardContent>
                  </Card>
                </GridCell>
              )}
            </PageGrid>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
