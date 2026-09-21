import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { cn } from '@/lib/utils';
import { TrendsHero } from './components/TrendsHero';
import { TrendsReadsRail } from './components/TrendsReadsRail';
import { CareerTimelineSlot } from './components/CareerTimelineSlot';
import { SessionsAndTilt } from './components/SessionsAndTilt';
import { RecentEvents } from './components/RecentEvents';
import { SettingComparison } from './components/SettingComparison';
import { MatchTypeMix } from './components/MatchTypeMix';

/**
 * Trends, recomposed onto the insight-first Pro-desk grid contract (UI-SPEC
 * §8.2, TRND-02, INS-05): `PageShell` -> one filter row (title + `HorizonSwitch`)
 * -> `PageGrid` rows. Own-account only (38 D-04) — every link this page
 * builds is an own-account link, never branched on coach state.
 *
 * Row 1 is the five-figure `StatRow` hero. Row 2 is the interim
 * career-timeline slot (`CareerTimelineSlot`: the existing `RatingCurve`/
 * `MonthlyPerformance` charts at 6+6, D-02/D-13 — Phase 41 replaces this with
 * the bound career-timeline chart, UI-SPEC §12.1). Row 3 is the three 4-col
 * rails: left (Sessions & Tilt, Recent events), centre (`TrendsReadsRail`,
 * the engine-backed reads), right (Setting comparison, Match-type mix). The
 * six-column `Tournaments` table is removed from this page (UI-SPEC §8.2) —
 * `Tournaments.tsx` itself stays committed, since `TournamentsPage.tsx`
 * still imports it.
 *
 * The page-level `RatingModelNote` banner is REMOVED here (UI-SPEC §8.2): it
 * is demoted to a secondary door on `TrendsReadsRail`'s rating-move card.
 */
export function TrendsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, isFetching, filterActive } = useFilteredMatches();
  const { horizon } = useHorizon();

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern — a page
  // skeleton built from the SAME PageGrid spans as the loaded
  // hero(12)/timeline(12)/rails(4+4+4) layout, so nothing shifts when data
  // lands. The filter row here is only a static title + HorizonSwitch (no
  // data-derived props), but is still omitted for consistency with every
  // other page in this plan.
  if (isLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('trends.loading')}</span>
          <PageGrid>
            <GridCell span={12}>
              <CardSkeleton variant="stat-row" rows={5} statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={12}>
              <CardSkeleton variant="chart" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} stack>
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4}>
              <CardSkeleton variant="insight" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} stack>
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
            </GridCell>
          </PageGrid>
        </div>
      </PageShell>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = isFetching && !isLoading;

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

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('trends.title')}</h1>
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <PageGrid
        className={cn(
          isRefetching &&
            'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
        )}
      >
        <GridCell span={12}>
          <TrendsHero matches={matches} horizon={horizon} />
        </GridCell>

        <GridCell span={12}>
          <CareerTimelineSlot matches={matches} />
        </GridCell>

        <GridCell span={4} stack>
          <SessionsAndTilt matches={matches} />
          <RecentEvents matches={matches} />
        </GridCell>

        <GridCell span={4}>
          <TrendsReadsRail matches={matches} horizon={horizon} />
        </GridCell>

        <GridCell span={4} stack>
          <SettingComparison matches={matches} horizon={horizon} />
          <MatchTypeMix matches={matches} horizon={horizon} />
        </GridCell>
      </PageGrid>
    </PageShell>
  );
}
